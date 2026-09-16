// =============================================================================
// lib/memoryRecall.js - Shared cross-surface memory recall for non-Nexus
// surfaces (email pollers, Twilio voice bridge).
//
// Nexus chat/voice already identify people by nexus_user_id (Nexus is internal
// staff only). Email and phone instead arrive with an address or a number, so
// those surfaces must MATCH the inbound identity to a known Black Raven user
// (their email or phone) before recalling memory. This helper does exactly
// that: resolve the contact's shared memory entity by email/phone/userId, then
// build a recall block of durable facts + recent cross-surface turns.
//
// The point is PARITY: a fact stated on a call or in Nexus chat ("Mike Roberts'
// favorite color is red") is then available when the same person is answered by
// email or phone too, because all surfaces resolve to ONE entity per person.
//
// Best-effort: returns { entityId: null, block: "" } when MEMORY is unbound,
// the contact cannot be matched, or nothing is known.
// =============================================================================

import { resolveEntity, getEntityContext } from "./memoryService.js";
import { selectRankedRecall, viaSuffix, latestSummaryLine } from "./memoryRanking.js";

const TURN_SNIPPET_CHARS = 200;
// Candidate pool asked of memory-worker; ranking then trims to the caps.
const CONTEXT_POOL_FACTS = 40;
const CONTEXT_POOL_TURNS = 30;

/**
 * Resolve a contact's memory entity by whichever identifier the surface knows
 * (email for mail, phone for Twilio, userId for completeness) and build a
 * recall block to inject into the model's system prompt.
 *
 * @param {object} env - worker env with MEMORY service binding
 * @param {string} botId - e.g. "courtney", "wren", "robert"
 * @param {object} contact
 * @param {string} [contact.userId] - Nexus user_id (if known)
 * @param {string} [contact.email] - sender email (mail surfaces)
 * @param {string} [contact.phone] - caller phone E.164 (Twilio)
 * @param {string} [contact.displayName]
 * @param {string} [query] - subject/body/utterance text for semantic ranking
 * @param {object} [opts]
 * @param {number} [opts.maxFacts=20]
 * @param {number} [opts.maxTurns=10]
 * @param {object} [opts.weights] - recency/importance/relevance ranking weights
 * @returns {Promise<{entityId: string|null, block: string}>}
 */
export async function buildContactRecall(env, botId, contact = {}, query, opts = {}) {
  if (!env || !env.MEMORY) return { entityId: null, block: "" };
  const { userId, email, phone, displayName } = contact;
  if (!userId && !email && !phone) return { entityId: null, block: "" };
  const maxFacts = opts.maxFacts ?? 20;
  const maxTurns = opts.maxTurns ?? 10;
  // Forward the audience membrane opts (opts.audience for the entity write,
  // opts.scope for the context read). Omitted => memory-worker fail-safe
  // defaults (write=internal, read=external), which is client-safe.
  const audOpts = { audience: opts.audience, scope: opts.scope };

  try {
    const entityId = await resolveEntity(env, botId, { userId, email, phone, displayName }, audOpts);
    if (!entityId) return { entityId: null, block: "" };
    const ctx = await getEntityContext(env, botId, entityId, query, { ...audOpts, maxFacts: CONTEXT_POOL_FACTS, maxTurns: CONTEXT_POOL_TURNS });
    if (!ctx) return { entityId, block: "" };

    const lines = renderContactRecallLines(ctx, { query, botId, maxFacts, maxTurns, weights: opts.weights });
    if (!lines.length) return { entityId, block: "" };

    const block =
      "\n\nWHAT YOU REMEMBER ABOUT THIS PERSON (your shared memory across chat, voice calls, " +
      "phone, and email; use it naturally for continuity, do NOT recite it verbatim or say you " +
      "looked it up). If it answers what they asked, just answer:\n" + lines.join("\n");
    return { entityId, block };
  } catch (err) {
    console.warn(`[memoryRecall] recall failed (${botId}): ${err?.message}`);
    return { entityId: null, block: "" };
  }
}

/**
 * Ranked recall lines for a contact: optional latest summary line, top facts
 * by score, then top turns oldest to newest. Format matches the pre-ranking
 * block so prompts that quote it keep working.
 *
 * @param {object} ctx - memory-worker /context payload
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string} opts.botId
 * @param {number} opts.maxFacts
 * @param {number} opts.maxTurns
 * @param {object} [opts.weights]
 * @returns {string[]}
 */
export function renderContactRecallLines(ctx, { query, botId, maxFacts, maxTurns, weights }) {
  const lines = [];
  const summary = latestSummaryLine(ctx);
  if (summary) lines.push(summary);
  const { facts, turns } = selectRankedRecall(ctx, { query, maxFacts, maxTurns, weights });
  if (facts.length) {
    if (lines.length) lines.push("");
    lines.push("Known facts:");
    for (const f of facts) {
      lines.push(`- ${String(f.predicate).replace(/_/g, " ")}: ${f.text}${viaSuffix(f, botId)}`);
    }
  }
  if (turns.length) {
    if (lines.length) lines.push("");
    lines.push("Recent across chat/voice/phone/email (oldest to newest):");
    for (const t of turns) {
      const who = t.role === "assistant" ? "you" : "them";
      lines.push(`- ${who}${viaSuffix(t, botId)}: ${String(t.text).replace(/\s+/g, " ").slice(0, TURN_SNIPPET_CHARS)}`);
    }
  }
  return lines;
}
