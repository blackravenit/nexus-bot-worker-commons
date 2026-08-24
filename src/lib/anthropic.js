// =============================================================================
// lib/anthropic.js - Anthropic Messages API wrapper with tool-use loop
//
// Two exported functions:
//
//   callAnthropic(env, systemPrompt, messages, [options])
//     Basic call. Returns assistant text. No tools.
//
//   callAnthropicWithTools(env, systemPrompt, messages, tools, handlers, [ctx], [options])
//     Full tool-use loop. Calls Anthropic, executes tool_use blocks,
//     feeds results back, repeats until stop_reason is "end_turn" or
//     max iterations is reached. Returns final assistant text.
//
// Cache strategy. FOUR breakpoints, which is the API maximum:
//   1. System prompt, on the stable segments only.
//   2. Last tool definition, if tools present.
//   3. Last ASSISTANT message -- the newest byte-stable position in the array.
//   4. Last message, so this turn extends the cache.
//
// Nothing that changes between turns may sit in `system`. The cache prefix is
// ordered tools -> system -> messages, so a single changed byte up there
// invalidates the ENTIRE conversation behind it, and splitting the volatile
// text into its own uncached system block does not help: the bytes are still
// upstream of every message. Per-turn context goes through options.sessionContext
// instead, which hangs it off the newest user turn where it invalidates nothing.
//
// Why the TTL is 5m and not 1h (measured 2026-08-16). The two TTLs have very
// different break-evens, because a read saves 0.9x base input while a 5m write
// costs 0.25x and a 1h write costs 1.00x:
//
//     net = 0.9 * read - 0.25 * write5m - 1.00 * write1h
//
// Break-even is w:r < 3.60 on 5m but w:r < 0.90 on 1h -- a 4x tighter bar. Over
// 2026-08-09..15 the fleet ran w:r 0.81 and the cache EARNED $17.35 on a $52.19
// spend. Repricing that same traffic on 1h needs ~39% of writes to convert into
// reads just to match 5m, and the measured turn-gap distribution puts only ~26%
// of turns in the 5m-to-1h window where a longer TTL changes anything at all.
// The rest are either seconds apart (already cached) or hours apart (hopeless at
// either TTL). So 1h was a coin flip priced at roughly $900/yr of downside, and
// it went back to 5m before it ever saw production traffic.
//
// Worth re-pricing now that the volatile block has moved out of `system` and
// the assistant anchor is in place: measured on Sonnet 5 with 8 exchanges of
// history, the old shape wrote 5067 tokens and read 4711 per turn, the new one
// writes 15 and reads 9747. That drops w:r far under the 0.90 bar where 1h
// starts to win. Re-run scripts/cache-efficiency.mjs on a full week of the new
// shape before flipping any worker to ANTHROPIC_CACHE_TTL="1h".
//
// Tunable per worker via the ANTHROPIC_CACHE_TTL var without a fleet redeploy.
//
// Tool handler convention: handler(input, env, ctx). ALWAYS in this order.
//   input  = the tool_use block's .input object
//   env    = Worker environment bindings
//   ctx    = extra context { user_id, display_name, channel_slug }
//
// Available on env:
//   env.ANTHROPIC_API_KEY  - required
//   env.CLAUDE_MODEL       - optional; defaults to claude-opus-4-7
// =============================================================================

import { withRetry, isRetryableAnthropicError } from "./retry.js";
import { reportUsage } from "./usageReport.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-7";
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 60000;
const MAX_TOOL_ITERATIONS = 10;
// Cache TTL for the stable prefix. 5m, because a 1h write costs 1.00x base
// against the 5m write's 0.25x and the measured traffic does not read it back
// often enough to earn the difference (see the header note).
const DEFAULT_PREFIX_CACHE_TTL = "5m";
// ANTHROPIC_CACHE_TTL values that mean "do not cache at all on this worker".
// Spelling variants are accepted because getting this wrong fails SILENTLY:
// an unrecognised value would sail through as a literal ttl and the API would
// reject the request, or worse, keep caching while someone believes it stopped.
const CACHE_OFF_VALUES = new Set(["off", "none", "no", "false", "0", "disabled"]);
// Retry the idempotent HTTP POST (not tool execution) on transient failures.
// 3 attempts with 1s then 5s backoff; classifier retries 429/5xx + network tells.
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 5_000, 15_000];

/**
 * Guarantee the messages array opens with a user turn. The Anthropic Messages
 * API requires messages[0] to have role "user" (a leading assistant turn 400s);
 * consecutive same-role turns are otherwise fine. The watercooler pipeline maps
 * a bot's own in-window posts to assistant turns, so when the oldest message in
 * the fetch window is the bot's own post the array would start with assistant
 * and the call would 400, silently dropping the reply. Prepend a minimal user
 * primer rather than dropping the assistant turn, so the bot still sees (and can
 * own) its own post. No-op when the array already starts with a user turn.
 *
 * @param {Array} messages
 * @returns {Array}
 */
function normalizeLeadingRole(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (messages[0].role === "user") return messages;
  return [{ role: "user", content: "(earlier in the conversation)" }, ...messages];
}

/**
 * Attach cache_control to the last content block of one message.
 *
 * @param {object} m - message
 * @param {object} cacheControl
 * @returns {object} cloned message
 */
function markMessage(m, cacheControl) {
  if (typeof m.content === "string") {
    return { role: m.role, content: [{ type: "text", text: m.content, cache_control: cacheControl }] };
  }
  if (Array.isArray(m.content) && m.content.length > 0) {
    const lastIdx = m.content.length - 1;
    return {
      role: m.role,
      content: m.content.map((b, j) => (j === lastIdx ? { ...b, cache_control: cacheControl } : b)),
    };
  }
  return m;
}

/**
 * Place the message-array cache breakpoints. Returns a shallow-cloned array;
 * safe to pass the original messages in.
 *
 * TWO breakpoints, and the second one is the whole point:
 *
 *   1. The last ASSISTANT message, on the stable prefix TTL. This is the newest
 *      position in the array that is guaranteed byte-identical on the next turn,
 *      because nothing is ever injected into an assistant turn. It is what lets
 *      the accumulated conversation be READ back instead of rewritten.
 *   2. The last message, so the turn just added extends the cache.
 *
 * With only the tail breakpoint (the shape before 2026-08-16) the cached prefix
 * moved every turn and the history behind it was rewritten rather than read.
 * Measured on Sonnet 5 with 8 exchanges of history: 5067 tokens written and 4711
 * read per turn, against 15 written and 9747 read once the anchor was added and
 * the volatile block moved out of `system`.
 *
 * @param {Array} messages
 * @param {object} [env] - Worker env; supplies ANTHROPIC_CACHE_TTL
 * @returns {Array}
 */
export function applyMessageCache(messages, env) {
  if (!messages || messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  let anchorIdx = -1;
  for (let i = lastIdx; i >= 0; i--) {
    if (messages[i].role === "assistant") { anchorIdx = i; break; }
  }
  const anchorControl = prefixCacheControl(env);
  // Caching disabled for this worker: no anchor AND no tail breakpoint. The
  // tail one is what writes the cache, so leaving it behind would keep paying
  // the write surcharge on a worker that just opted out.
  if (!anchorControl) return messages;
  return messages.map((m, i) => {
    if (i === lastIdx) return markMessage(m, { type: "ephemeral" });
    if (i === anchorIdx) return markMessage(m, anchorControl);
    return m;
  });
}

/**
 * Hang the per-turn context (facts, current date/time, memory recall, channel
 * and thread context) off the newest user turn instead of the system prompt.
 *
 * The cache prefix is ordered tools -> system -> messages, so ANY byte that
 * changes inside `system` invalidates the entire message history behind it.
 * That is true even when the volatile text is split into its own uncached
 * system block, which is what commons used to do: the bytes still sit upstream
 * of every message. NEXUS_TODAY alone carries the current wall-clock time, so
 * it guaranteed a total history miss on every turn of every conversation.
 *
 * Moving it here puts it BEHIND the cached history, where it costs one small
 * uncached block per request and invalidates nothing.
 *
 * @param {Array} messages
 * @param {string} sessionContext
 * @returns {Array}
 */
export function withSessionContext(messages, sessionContext) {
  if (!sessionContext || !messages || messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  // Only ever a genuine user turn: this runs before the tool loop starts, and
  // a tool_result block must stay first in its message.
  if (last.role !== "user") return messages;
  const block = { type: "text", text: `<session_context>\n${sessionContext.trim()}\n</session_context>` };
  const rest = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : last.content;
  return [...messages.slice(0, lastIdx), { role: "user", content: [block, ...rest] }];
}

/**
 * Resolve the cache TTL for the STABLE prefix (system prompt + tool schemas).
 * Defaults to 5m, which is where the measured traffic makes money; set
 * ANTHROPIC_CACHE_TTL="1h" on a worker to opt that worker into the long TTL
 * once its write:read ratio is proven to sit under 0.90.
 *
 * ANTHROPIC_CACHE_TTL="off" disables caching for the worker entirely, and it
 * is the right setting for a bot whose calls are ONE-SHOT: a cron stage, a
 * nightly summary, a single FleetView question. Those read the cache back zero
 * times, so every write is a 1.25x surcharge on tokens that were never reused.
 * Measured 2026-08-24: dexter-worker wrote 31.9k cache tokens across a week
 * and read 0, a pure loss. A longer TTL does not fix that, it quadruples it.
 *
 * @param {object} env - Worker env
 * @returns {{type: "ephemeral", ttl?: string}|null} cache_control value, or
 *   null when caching is disabled for this worker
 */
function prefixCacheControl(env) {
  const ttl = (env?.ANTHROPIC_CACHE_TTL || DEFAULT_PREFIX_CACHE_TTL).trim();
  if (CACHE_OFF_VALUES.has(ttl.toLowerCase())) return null;
  // "5m" is the API default; sending it explicitly is legal but noisier in
  // request diffs, so collapse it to the bare form.
  return ttl === "5m" ? { type: "ephemeral" } : { type: "ephemeral", ttl };
}

/**
 * Apply cache_control to the last tool definition. Tool schemas are part of the
 * stable prefix, so they ride the long TTL.
 *
 * @param {Array} tools
 * @param {object} env - Worker env (for ANTHROPIC_CACHE_TTL)
 * @returns {Array}
 */
function applyCacheToTools(tools, env) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const cacheControl = prefixCacheControl(env);
  if (!cacheControl) return tools;
  return tools.map((t, i) =>
    i === tools.length - 1 ? { ...t, cache_control: cacheControl } : t
  );
}

/**
 * Resolve where Anthropic calls go. When env.AI_GATEWAY_ANTHROPIC_URL is set
 * (only on workers opted into the CF AI Gateway pilot, e.g. courtney-worker),
 * route through the gateway and tag the request; otherwise hit the direct API.
 * Fail-open: unset = today's behavior, so the whole fleet is unaffected.
 *
 * @param {object} env
 * @param {string} [surface] - dashboard tag (chat/attachment/watercooler)
 * @returns {{ url: string, metadata: object|null }}
 */
function resolveAnthropicRoute(env, surface) {
  const gw = env && env.AI_GATEWAY_ANTHROPIC_URL;
  if (!gw) return { url: API_URL, metadata: null };
  return {
    url: gw,
    metadata: { bot: env.AI_GATEWAY_BOT || env.WORKER_NAME || "bot", surface: surface || "chat" },
  };
}

/**
 * Raw POST to the Anthropic Messages API (or the AI Gateway when route.url set).
 *
 * @param {string} apiKey
 * @param {object} body
 * @param {{ url?: string, metadata?: object }} [route]
 * @returns {Promise<object>} Parsed JSON response
 */
async function _post(apiKey, body, route = {}) {
  const url = route.url || API_URL;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    "anthropic-beta": "prompt-caching-2024-07-31",
  };
  // Tag the request for the CF AI Gateway dashboard when routed through it.
  if (route.metadata) headers["cf-aig-metadata"] = JSON.stringify(route.metadata);

  // Retry the POST on transient failures (429/5xx/network). The status-check
  // throw lives INSIDE the retried closure so the classifier sees the status
  // and a 5xx/429 is retried while a 4xx fails fast. Only the idempotent HTTP
  // POST retries here; the tool-use loop never re-executes handlers.
  return withRetry(
    async () => {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`[anthropic] fetch failed: ${err.message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`[anthropic] API error ${res.status}: ${text}`);
      }
      try {
        return await res.json();
      } catch (err) {
        throw new Error(`[anthropic] JSON parse failed: ${err.message}`);
      }
    },
    {
      attempts: RETRY_ATTEMPTS,
      backoffMs: RETRY_BACKOFF_MS,
      isRetryable: isRetryableAnthropicError,
      onRetry: (err, attempt, delayMs) =>
        console.warn(`[anthropic] transient failure, retry ${attempt} in ${delayMs}ms: ${err.message}`),
    },
  );
}

/**
 * Extract the final text content from an Anthropic response.
 *
 * @param {object} data - Anthropic response object
 * @returns {string}
 */
function extractText(data) {
  return (data?.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

/**
 * Call the Anthropic Messages API and return the assistant response text.
 * No tool-use loop -- use callAnthropicWithTools for that.
 *
 * @param {object} env - Worker environment bindings
 * @param {string} systemPrompt - Full system prompt text
 * @param {Array<{role: string, content: string|Array}>} messages - Conversation turns
 * @param {object} [options]
 * @param {number} [options.maxTokens]
 * @param {string} [options.sessionContext] - Per-turn grounding (date/time,
 *   speaker, facts, memory recall, channel context). MUST go here rather than
 *   into systemPrompt: anything volatile in `system` invalidates the entire
 *   cached message history behind it. Injected as a <session_context> block on
 *   the newest user turn.
 * @param {Array} [options.serverTools] - SERVER-executed tool definitions only
 *   (e.g. web_search_20250305). Anthropic runs these itself, so no handler
 *   loop is needed; this function just continues the turn on "pause_turn".
 *   Client-executed tools still require callAnthropicWithTools.
 * @param {(content: Array) => void} [options.onServerToolContent] - Hook fed
 *   the accumulated content blocks (across pause_turn continuations) so
 *   callers can ground-check URLs against real web_search results.
 * @returns {Promise<string>} Assistant message text
 */
export async function callAnthropic(env, systemPrompt, messages, options = {}) {
  const model = options.model || env.CLAUDE_MODEL || DEFAULT_MODEL;
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) throw new Error("[anthropic] ANTHROPIC_API_KEY is not configured");

  const serverTools =
    Array.isArray(options.serverTools) && options.serverTools.length > 0 ? options.serverTools : null;

  const body = {
    model,
    max_tokens: options.maxTokens || MAX_TOKENS,
    // Sonnet 5 / Opus 4.7+ default to adaptive thinking when `thinking` is
    // omitted, which silently adds latency + token cost on chat/structured
    // paths that never wanted it. Pin disabled by default; a caller opts a
    // specific job into adaptive by passing options.thinking. No-op on the
    // Haiku/Sonnet-4.6 paths that already ran thinking-off. (2026-07-01 fleet bump.)
    thinking: options.thinking || { type: "disabled" },
    system: buildSystemBlocks(systemPrompt, env),
    messages: applyMessageCache(
      withSessionContext(normalizeLeadingRole(messages), options.sessionContext),
      env,
    ),
  };
  if (serverTools) body.tools = serverTools;

  const route = resolveAnthropicRoute(env, options.surface);
  let data = await _post(apiKey, body, route);

  let allContent = Array.isArray(data?.content) ? [...data.content] : [];
  if (serverTools) {
    // A long server-side tool run can pause the turn; resend the accumulated
    // content so the search continues where it left off. Bounded so a stuck
    // turn cannot loop.
    let continuations = 0;
    let workingMessages = withSessionContext(
      normalizeLeadingRole([...messages]),
      options.sessionContext,
    );
    while (data.stop_reason === "pause_turn" && continuations < 2) {
      continuations++;
      workingMessages = [...workingMessages, { role: "assistant", content: data.content }];
      data = await _post(apiKey, { ...body, messages: applyMessageCache(workingMessages, env) }, route);
      if (Array.isArray(data?.content)) allContent.push(...data.content);
    }
    if (typeof options.onServerToolContent === "function") {
      try { options.onServerToolContent(allContent); } catch (e) {
        console.warn("[anthropic] onServerToolContent hook failed:", e.message);
      }
    }
  }

  // With server tools the text can sit after tool_use/result blocks AND be
  // split into citation fragments, so join ALL text blocks of the final
  // response with no separator (a "\n" join would break lines mid-sentence).
  const text = serverTools
    ? (data?.content || []).filter(b => b.type === "text").map(b => b.text).join("")
    : data?.content?.[0]?.text;
  if (typeof text !== "string" || (serverTools && !text)) {
    throw new Error(`[anthropic] unexpected response shape: ${JSON.stringify(data).slice(0, 600)}`);
  }
  if (typeof options.onUsage === "function" && data.usage) {
    try { options.onUsage(data.usage); } catch (e) { /* never break main flow */ }
  } else if (data.usage) {
    // Default self-report (2026-08-03): callers that do not handle usage
    // themselves still land in Maxwell's per-bot counts. Callers that DO pass
    // onUsage (e.g. handleChatMessage) own reporting, so nothing double-counts.
    reportUsage(env, { usage: data.usage, model, surface: options.surface || "cron" });
  }
  return text;
}

/**
 * Call Anthropic with a tools array and execute the full tool-use loop.
 *
 * Pipeline:
 *   1. Call Anthropic with messages + tools.
 *   2. If stop_reason === "tool_use", execute each tool_use block.
 *   3. Append tool_result blocks to messages and call again.
 *   4. Repeat up to MAX_TOOL_ITERATIONS.
 *   5. Return final text response.
 *
 * Tool handlers are ALWAYS called as handler(input, env, ctx).
 *   input  = tool_use block .input object
 *   env    = CF Worker env bindings
 *   ctx    = extra context passed by caller (user_id, display_name, channel_slug, etc.)
 *
 * @param {object} env - Worker environment bindings
 * @param {string} systemPrompt
 * @param {Array} messages - Conversation turns (shallow-cloned internally; original not mutated)
 * @param {Array} tools - Anthropic tool definition objects
 * @param {object} handlers - { [toolName]: async (input, env, ctx) => any }
 * @param {object} [ctx] - Extra context passed to handlers
 * @param {object} [options]
 * @param {string} [options.sessionContext] - Per-turn grounding (date/time,
 *   speaker, facts, memory recall, channel context). MUST go here rather than
 *   into systemPrompt: anything volatile in `system` invalidates the entire
 *   cached message history behind it. Injected once, before the tool loop
 *   starts, as a <session_context> block on the newest user turn.
 * @param {(turnIndex: number) => (void|Promise<void>)} [options.onTurnStart] - Hook
 *   called immediately before each Anthropic POST. turnIndex starts at 0 for
 *   the initial call, then increments per tool-loop iteration. Used by
 *   handleChatMessage to re-arm the Nexus typing indicator across long
 *   tool loops (the indicator has a 90s TTL on the Nexus DO).
 * @param {(name: string, input: object, isError: boolean, result?: string|Array) => void} [options.onToolCall]
 *   Hook called once per executed tool_use block (after the handler runs).
 *   Used to accumulate an action breadcrumb for conversation memory. Errors
 *   in the hook are caught and never break the tool loop.
 * @returns {Promise<string>} Final assistant text
 */
/**
 * Build the `system` parameter, splitting the cached prefix from the volatile
 * tail when the caller supplies segments.
 *
 * A single system block means ONE cache entry covering everything, so any
 * volatile byte in it (the date, the user's name, a facts block, a memory
 * recall) invalidates the whole thing. That is how a 49k-token prompt ended up
 * rewriting 34k of cache on every single turn: slower than a cache read, and
 * billed at 1.25x for the privilege.
 *
 * Passing segments puts the breakpoint after the stable persona instead, so the
 * big half is read from cache and only the small volatile half is reprocessed.
 * Content and order are unchanged; only where the cache boundary sits moves.
 *
 * @param {string|Array<{text: string, cache?: boolean}>} systemPrompt
 * @param {object} [env] - Worker env; supplies ANTHROPIC_CACHE_TTL
 * @returns {Array<object>} Anthropic system blocks
 */
export function buildSystemBlocks(systemPrompt, env) {
  const cacheControl = prefixCacheControl(env);
  if (typeof systemPrompt === "string") {
    return cacheControl
      ? [{ type: "text", text: systemPrompt, cache_control: cacheControl }]
      : [{ type: "text", text: systemPrompt }];
  }

  return systemPrompt
    .filter((seg) => seg && seg.text)
    .map((seg) => (seg.cache && cacheControl
      ? { type: "text", text: seg.text, cache_control: cacheControl }
      : { type: "text", text: seg.text }));
}

export async function callAnthropicWithTools(env, systemPrompt, messages, tools, handlers, ctx = {}, options = {}) {
  // options.model first, matching callAnthropic. Without it a caller asking for
  // a specific model on the TOOL path was silently ignored and got the fleet
  // default, which is how FleetView's "run this turn on Haiku" did nothing at
  // all and every spoken turn kept paying Sonnet's 1.6s to first token.
  const model = options.model || env.CLAUDE_MODEL || DEFAULT_MODEL;
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) throw new Error("[anthropic] ANTHROPIC_API_KEY is not configured");

  const route = resolveAnthropicRoute(env, options.surface || "chat");
  const toolsWithCache = applyCacheToTools(tools, env);

  const baseParams = {
    model,
    max_tokens: options.maxTokens || MAX_TOKENS,
    // Pin thinking disabled by default (see callAnthropic note). Opt a job into
    // adaptive via options.thinking. No-op on Haiku/Sonnet-4.6 paths. (2026-07-01)
    thinking: options.thinking || { type: "disabled" },
    system: buildSystemBlocks(systemPrompt, env),
    tools: toolsWithCache,
  };

  // Inject once, before the loop starts: the last message is still a genuine
  // user turn here, and once the loop appends tool_result turns behind it the
  // context rides along in place.
  let workingMessages = withSessionContext(
    normalizeLeadingRole([...messages]),
    options.sessionContext,
  );
  let iterations = 0;
  let response;
  let turnIndex = 0;
  const usageAcc = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  const onTurnStart = typeof options.onTurnStart === "function" ? options.onTurnStart : null;
  if (onTurnStart) {
    try { await onTurnStart(turnIndex); } catch (err) {
      console.warn("[anthropic] onTurnStart hook failed:", err.message);
    }
  }

  response = await _post(apiKey, {
    ...baseParams,
    messages: applyMessageCache(workingMessages, env),
  }, route);
  if (response.usage) {
    usageAcc.input_tokens += response.usage.input_tokens || 0;
    usageAcc.output_tokens += response.usage.output_tokens || 0;
    usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
    usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
  }

  // Hosted server tools (web_search) pause the turn mid-run instead of
  // stopping on tool_use. Before this branch existed the loop treated
  // pause_turn as a final answer, so any bot with the hosted search tool in
  // its CHAT tool list shipped its own "Let me search..." narration as the
  // reply and every search result was dropped on the floor (Flynn,
  // 2026-08-15, #flynn-lab). Mirror the callAnthropic continuation: resend
  // the accumulated content so Anthropic resumes the search, bounded so a
  // stuck turn cannot loop.
  let pauseContinuations = 0;
  while (response.stop_reason === "tool_use" || response.stop_reason === "pause_turn") {
    if (response.stop_reason === "pause_turn") {
      pauseContinuations++;
      if (pauseContinuations > 4) {
        console.warn(`[anthropic] pause_turn limit reached after ${pauseContinuations} continuations; returning what we have`);
        break;
      }
      workingMessages.push({ role: "assistant", content: response.content || [] });
      response = await _post(apiKey, {
        ...baseParams,
        messages: applyMessageCache(workingMessages, env),
      }, route);
      if (response.usage) {
        usageAcc.input_tokens += response.usage.input_tokens || 0;
        usageAcc.output_tokens += response.usage.output_tokens || 0;
        usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
        usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
      }
      continue;
    }
    iterations++;
    if (iterations > MAX_TOOL_ITERATIONS) {
      // The model still wants tools but has spent its budget. Breaking here
      // leaves `response` holding only tool_use blocks, so extractText() returns
      // "" and the caller posts nothing -- the user watches the typing indicator
      // resolve to silence. Instead, feed the pending tool_use blocks a
      // "budget exhausted" result and make ONE final call with tool_choice
      // "none" so the model MUST answer in plain text from what it has.
      console.warn(`[anthropic] tool_loop_limit reached after ${iterations} iterations; forcing a final text answer`);
      const pendingAssistant = response.content || [];
      workingMessages.push({ role: "assistant", content: pendingAssistant });
      const pendingToolUses = pendingAssistant.filter(b => b.type === "tool_use");
      if (pendingToolUses.length > 0) {
        workingMessages.push({
          role: "user",
          content: pendingToolUses.map(b => ({
            type: "tool_result",
            tool_use_id: b.id,
            content:
              "Tool-call budget reached. Do not request any more tools. Answer the user " +
              "now in plain text using the information you already gathered.",
          })),
        });
      } else {
        workingMessages.push({
          role: "user",
          content:
            "Answer the user now in plain text using what you already have. Do not call any more tools.",
        });
      }
      try {
        response = await _post(apiKey, {
          ...baseParams,
          tool_choice: { type: "none" },
          messages: applyMessageCache(workingMessages, env),
        }, route);
        if (response.usage) {
          usageAcc.input_tokens += response.usage.input_tokens || 0;
          usageAcc.output_tokens += response.usage.output_tokens || 0;
          usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
          usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
        }
      } catch (err) {
        console.error("[anthropic] forced final-answer call failed:", err.message);
      }
      break;
    }

    const assistantContent = response.content || [];
    workingMessages.push({ role: "assistant", content: assistantContent });

    const toolCalls = assistantContent.filter(b => b.type === "tool_use");
    console.log(`[anthropic] tool iteration ${iterations}: ${toolCalls.map(b => b.name).join(", ")}`);

    const toolResults = [];
    for (const block of toolCalls) {
      const handler = handlers[block.name];
      let resultContent;
      let isError = false;
      try {
        if (!handler) throw new Error(`Unknown tool: ${block.name}`);
        const raw = await handler(block.input, env, ctx);
        // A handler may return { toolResultContent: [...blocks] } to hand the
        // model a multimodal tool result (e.g. an image block so it can SEE a
        // GIF the user referenced). Otherwise the result is text/JSON.
        if (raw && typeof raw === "object" && Array.isArray(raw.toolResultContent)) {
          resultContent = raw.toolResultContent;
        } else {
          resultContent = typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 20000);
        }
      } catch (err) {
        console.error(`[anthropic] tool_error tool=${block.name}:`, err.message);
        resultContent = `Error: ${err.message}`;
        isError = true;
      }
      const result = {
        type: "tool_result",
        tool_use_id: block.id,
        content: resultContent,
      };
      if (isError) result.is_error = true;
      toolResults.push(result);

      // Surface each executed tool call so callers can build an action
      // breadcrumb for conversation memory. Best-effort: a throwing hook
      // must never break the tool loop.
      if (typeof options.onToolCall === "function") {
        try {
          // Pass resultContent (4th arg) so callers can retain identifiers the
          // tool RETURNED (invoice id, contact id, ticket number), not just the
          // inputs. A follow-up turn ("authorise it") needs the id that came
          // back, which the input-only breadcrumb dropped. Multimodal results
          // (arrays) are passed as-is; the summarizer ignores non-objects.
          options.onToolCall(block.name, block.input, isError, resultContent);
        } catch (err) {
          console.warn("[anthropic] onToolCall hook failed:", err.message);
        }
      }
    }

    workingMessages.push({ role: "user", content: toolResults });

    turnIndex++;
    if (onTurnStart) {
      try { await onTurnStart(turnIndex); } catch (err) {
        console.warn("[anthropic] onTurnStart hook failed:", err.message);
      }
    }

    response = await _post(apiKey, {
      ...baseParams,
      messages: applyMessageCache(workingMessages, env),
    }, route);
    if (response.usage) {
      usageAcc.input_tokens += response.usage.input_tokens || 0;
      usageAcc.output_tokens += response.usage.output_tokens || 0;
      usageAcc.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
      usageAcc.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
    }
  }

  if (typeof options.onUsage === "function") {
    try { options.onUsage(usageAcc); } catch (e) { /* never break main flow */ }
  } else {
    // Default self-report (2026-08-03): see the callAnthropic counterpart.
    reportUsage(env, { usage: usageAcc, model, surface: options.surface || "cron" });
  }
  return extractText(response);
}
