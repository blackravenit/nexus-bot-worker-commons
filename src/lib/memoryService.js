// =============================================================================
// lib/memoryService.js - Client for the centralized memory-worker service
//
// Consumed via service binding (env.MEMORY). All calls are best-effort:
// a memory-worker outage must never break the chat pipeline.
//
// If env.MEMORY is not bound, all functions no-op silently.
//
// Usage in handleChatMessage:
//   After appendHistory, call persistTurnPair() to forward the user+assistant
//   turns to the memory service for structured storage and eventual fact
//   extraction.
// =============================================================================

import { buildMemoryAuthHeaders } from './memoryAuth.js';
import { stripQuotedReply, flattenEmailHtml } from './emailQuote.js';

const BOT_HEADER = 'X-Memory-Bot';

// opts.audience ('internal'|'external') tags a WRITE; opts.scope ('all'|'external')
// selects a READ view. Both are omitted by default, so the memory-worker applies
// its fail-safe defaults (write=internal, read=external). See migration 003.
function audienceHeaders(opts) {
  const h = {};
  if (opts?.audience) h['X-Memory-Audience'] = opts.audience;
  if (opts?.scope) h['X-Memory-Scope'] = opts.scope;
  return h;
}

async function memoryFetch(env, botId, path, body, opts) {
  if (!env.MEMORY) return null;
  try {
    const auth = await buildMemoryAuthHeaders(env, botId);
    const resp = await env.MEMORY.fetch(new Request(`https://internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [BOT_HEADER]: botId, ...audienceHeaders(opts), ...auth },
      body: JSON.stringify(body),
    }));
    if (!resp.ok) {
      console.warn(`[memoryService] ${path} ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`[memoryService] ${path}: ${err?.message}`);
    return null;
  }
}

async function memoryGet(env, botId, path, opts) {
  if (!env.MEMORY) return null;
  try {
    const auth = await buildMemoryAuthHeaders(env, botId);
    const resp = await env.MEMORY.fetch(new Request(`https://internal${path}`, {
      method: 'GET',
      headers: { [BOT_HEADER]: botId, ...audienceHeaders(opts), ...auth },
    }));
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.warn(`[memoryService] GET ${path}: ${err?.message}`);
    return null;
  }
}

/**
 * Persist a user+assistant turn pair to the memory service.
 * Called after appendHistory in the chat pipeline.
 *
 * @param {object} env - Worker env with MEMORY service binding
 * @param {string} botId - Bot identifier (e.g. 'jacob', 'courtney', 'wren')
 * @param {object} params
 * @param {string} params.sessionId - Conversation session identifier
 * @param {string} [params.entityId] - Memory entity ID for the user (if resolved)
 * @param {string} params.userText - The user's message
 * @param {string} params.assistantText - The bot's response
 * @param {string} [params.channel] - Channel name/slug
 */
export async function persistTurnPair(env, botId, { sessionId, entityId, userText, assistantText, channel }, opts) {
  if (!env.MEMORY) return;
  // An empty side would be a 400 from the worker; skip it instead (an inbound
  // email the bot chose not to answer still deserves its user turn).
  const turns = [['user', userText], ['assistant', assistantText]].filter(([, text]) => text);
  for (const [role, content] of turns) {
    await memoryFetch(env, botId, '/turns', {
      session_id: sessionId,
      entity_id: entityId || null,
      role,
      content,
      channel,
    }, opts);
  }
}

/**
 * Resolve or create a memory entity for a person, keyed by whichever stable
 * identifiers are known on this surface: Nexus user_id (chat), email (email
 * pollers), and/or phone (voice). The memory-worker merges by external_id, so
 * passing more than one id links them onto the SAME entity -- this is what
 * lets an email sender resolve to the entity the chat/voice surfaces built,
 * giving cross-surface recall parity. Returns the entity_id.
 *
 * @param {object} env
 * @param {string} botId
 * @param {object} params
 * @param {string} [params.userId] - Nexus user_id
 * @param {string} [params.email] - sender/author email (lowercased for stable match)
 * @param {string} [params.phone] - caller phone in E.164
 * @param {string} [params.displayName]
 * @param {string} [params.type] - Entity type (default: 'contact')
 * @returns {Promise<string|null>} entity_id or null
 */
export async function resolveEntity(env, botId, { userId, email, phone, displayName, type = 'contact' }, opts) {
  if (!env.MEMORY) return null;
  const externalIds = {};
  if (userId) externalIds.nexus_user_id = userId;
  if (email) externalIds.email = String(email).trim().toLowerCase();
  if (phone) externalIds.phone = phone;
  if (Object.keys(externalIds).length === 0) return null;
  const result = await memoryFetch(env, botId, '/entities', {
    type,
    display_name: displayName || userId || email || phone,
    external_ids: externalIds,
  }, opts);
  return result?.id || null;
}

/**
 * Get full context for an entity (facts, recent turns, sessions).
 *
 * @param {object} env
 * @param {string} botId
 * @param {string} entityId
 * @param {string} [query] - Optional query for semantic search
 * @param {object} [opts] - audience/scope, plus maxFacts/maxTurns candidate pool sizes
 * @returns {Promise<object|null>}
 */
export async function getEntityContext(env, botId, entityId, query, opts) {
  if (!env.MEMORY) return null;
  return await memoryFetch(env, botId, '/context', {
    entity_id: entityId,
    query: query || undefined,
    max_facts: Number(opts?.maxFacts) > 0 ? Number(opts.maxFacts) : undefined,
    max_turns: Number(opts?.maxTurns) > 0 ? Number(opts.maxTurns) : undefined,
  }, opts);
}

/**
 * Start a memory session.
 *
 * @param {object} env
 * @param {string} botId
 * @param {object} params
 * @param {string} [params.entityId]
 * @param {string} [params.channel]
 * @returns {Promise<string|null>} session_id
 */
export async function startMemorySession(env, botId, { entityId, channel } = {}) {
  if (!env.MEMORY) return null;
  const result = await memoryFetch(env, botId, '/sessions/start', {
    entity_id: entityId || null,
    channel: channel || null,
  });
  return result?.id || null;
}

/**
 * End a memory session with an optional summary.
 */
export async function endMemorySession(env, botId, sessionId, summary) {
  if (!env.MEMORY) return;
  await memoryFetch(env, botId, '/sessions/end', { session_id: sessionId, summary });
}

/**
 * Assert a structured fact about an entity.
 */
export async function assertFact(env, botId, { subjectId, predicate, object, confidence, sourceTurnId, critical, ttlDays }, opts) {
  if (!env.MEMORY) return null;
  return await memoryFetch(env, botId, '/facts', {
    subject_id: subjectId,
    predicate,
    object,
    confidence: confidence || 1.0,
    source_turn_id: sourceTurnId || null,
    // When critical is true the memory-worker stores the fact with no expiry
    // (kept indefinitely); otherwise it applies the default 90-day retention.
    critical: critical === true ? true : undefined,
    ttl_days: Number(ttlDays) > 0 ? Number(ttlDays) : undefined,
  }, opts);
}

/**
 * Get active facts for an entity.
 * @param {object} env
 * @param {string} botId
 * @param {string} entityId
 * @param {object} [opts] - opts.scope 'all' for the staff view (internal notes)
 * @returns {Promise<Array<object>>}
 */
export async function getEntityFacts(env, botId, entityId, opts) {
  if (!env.MEMORY) return [];
  const result = await memoryGet(env, botId, `/entities/${entityId}/facts`, opts);
  return result?.facts || [];
}

const EMAIL_BODY_MAX_CHARS = 4000;
// Flatten generously before the quote strip so the cut sees the whole chain.
const HTML_FLATTEN_MAX_CHARS = 100000;
const HTML_TAG_RE = /<(p|div|br|span|table|html|body)[\s/>]/i;

/**
 * Persist an inbound email and the bot's reply as an episodic turn pair on
 * the sender's shared memory entity (channel 'email'), so chat and voice
 * recall can see what was said by mail. Quoted history is stripped from both
 * bodies and each is capped at 4000 chars. Best-effort: never throws.
 *
 * @param {object} env - Worker env with MEMORY service binding
 * @param {string} botId
 * @param {object} params
 * @param {string} params.fromEmail - sender address (entity key)
 * @param {string} [params.fromName]
 * @param {string} [params.subject]
 * @param {string} [params.inboundText] - flattened inbound body
 * @param {string} [params.replyText] - reply body actually sent or staged ('' if none)
 * @param {'internal'|'external'} [params.audience] - omitted = worker default (internal)
 * @returns {Promise<string|null>} entity_id, or null when nothing was written
 */
export async function persistEmailExchange(env, botId, { fromEmail, fromName, subject, inboundText, replyText, audience } = {}) {
  if (!env?.MEMORY || !fromEmail) return null;
  const email = String(fromEmail).trim().toLowerCase();
  const inbound = clipEmailBody(inboundText);
  const reply = clipEmailBody(replyText);
  if (!inbound && !reply) return null;
  const opts = audience ? { audience } : undefined;
  try {
    const entityId = await resolveEntity(env, botId, { email, displayName: fromName || email }, opts);
    const subjectLine = subject ? `Subject: ${String(subject).trim()}\n\n` : '';
    await persistTurnPair(env, botId, {
      sessionId: `email:${email}`,
      entityId,
      userText: inbound ? subjectLine + inbound : '',
      assistantText: reply,
      channel: 'email',
    }, opts);
    return entityId;
  } catch (err) {
    console.error(`[memoryService] persistEmailExchange bot=${botId} from=${email}: ${err?.message}`);
    return null;
  }
}

// Flatten HTML (drafts are usually body_html), drop the quoted chain, cap.
function clipEmailBody(text) {
  if (!text) return '';
  const raw = String(text);
  const flat = HTML_TAG_RE.test(raw) ? flattenEmailHtml(raw, HTML_FLATTEN_MAX_CHARS) : raw;
  return stripQuotedReply(flat).slice(0, EMAIL_BODY_MAX_CHARS);
}
