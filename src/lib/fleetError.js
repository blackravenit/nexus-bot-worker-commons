// =============================================================================
// lib/fleetError.js - Fleet error surface for Nexus bot workers
//
// reportFleetError(env, { bot, op, msg, ctx })
//   Posts a single alert line to the #fleet-errors channel so silent
//   infrastructure failures are visible to operators.
//
//   bot  - bot display name string (e.g. "Wren"). Falls back to
//          env.BOT_DISPLAY_NAME or "unknown-bot" when omitted.
//   op   - operation name (e.g. "attachButtons", "editNexusMessage")
//   msg  - error message string
//   ctx  - small object with debugging context; stringified + truncated
//          to 300 chars so one broken card can't flood the channel.
//
// Rate limiting:
//   Duplicate (bot, op, msg) combinations are silenced after the first
//   10 firings within a 5-minute window. The counter lives in an
//   in-memory Map on the module scope. Worker isolates are short-lived;
//   this is intentionally lightweight: the goal is burst suppression,
//   not cross-isolate coordination.
//
// Safety:
//   reportFleetError itself never throws and never recurses. If the
//   underlying postToNexus call fails, the error is written to
//   console.error and swallowed.
//
// Usage:
//   import { reportFleetError } from "./fleetError.js";
//   reportFleetError(env, { bot: "Wren", op: "attachButtons",
//     msg: err.message, ctx: { messageId, buttonCount: buttons.length } });
// =============================================================================

import { postToNexus } from "./nexus.js";

const FLEET_ERRORS_SLUG = "fleet-errors";
const RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_MAX = 10;
const CTX_TRUNCATE = 300;

/** @type {Map<string, { count: number, windowStart: number }>} */
const _rateBuckets = new Map();

/**
 * Suppress repeated identical errors within the rate window.
 * Returns true if the event should be suppressed (already over limit).
 *
 * @param {string} sig - dedup key
 * @returns {boolean}
 */
function _isRateLimited(sig) {
  const now = Date.now();
  const bucket = _rateBuckets.get(sig);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    _rateBuckets.set(sig, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  if (bucket.count === RATE_MAX + 1) {
    // Log once that we are entering suppression
    console.warn(`[fleetError] rate-limiting sig=${JSON.stringify(sig)} (${RATE_MAX}+ in 5 min)`);
  }
  return bucket.count > RATE_MAX;
}

/**
 * Resolve the bot display name from env or argument.
 *
 * @param {object} env
 * @param {string|undefined} bot
 * @returns {string}
 */
function _resolveBotName(env, bot) {
  if (bot && typeof bot === "string" && bot.trim()) return bot.trim();
  if (env && env.BOT_DISPLAY_NAME) return String(env.BOT_DISPLAY_NAME);
  return "unknown-bot";
}

/**
 * Post a fleet error alert to #fleet-errors.
 *
 * Best-effort: swallows all errors so a failure here never crashes the caller.
 * Never recurses into itself.
 *
 * @param {object} env - CF env bindings (needs NEXUS_BASE_URL + a resolvable key)
 * @param {object} params
 * @param {string} [params.bot]  - bot display name
 * @param {string} params.op     - operation that failed (e.g. "attachButtons")
 * @param {string} params.msg    - error message
 * @param {object} [params.ctx]  - small debug context object
 * @param {object} [options]     - forwarded to postToNexus (e.g. nexusKeyEnvVar)
 * @returns {Promise<void>}
 */
export async function reportFleetError(env, { bot, op, msg, ctx } = {}, options = {}) {
  try {
    const botName = _resolveBotName(env, bot);
    const opStr = String(op || "unknown");
    const msgStr = String(msg || "no message");

    const sig = `${botName}|${opStr}|${msgStr}`;
    if (_isRateLimited(sig)) return;

    let ctxStr = "";
    if (ctx !== undefined && ctx !== null) {
      try {
        const raw = typeof ctx === "string" ? ctx : JSON.stringify(ctx);
        ctxStr = raw.length > CTX_TRUNCATE ? raw.slice(0, CTX_TRUNCATE) + "…" : raw;
      } catch {
        ctxStr = "[unserializable ctx]";
      }
    }

    // Wrap ctx JSON in backticks so the renderer treats it as an inline
    // code chip, visually separating it from the prose error line.
    const body = ctxStr
      ? `\u{1F534} **${botName}** · \`${opStr}\` · ${msgStr}\n   \`${ctxStr}\``
      : `\u{1F534} **${botName}** · \`${opStr}\` · ${msgStr}`;

    await postToNexus(env, FLEET_ERRORS_SLUG, body, { provenance: "system-alert", ...options });
  } catch (err) {
    // Swallow unconditionally: this is the error reporter itself.
    console.error("[fleetError] reportFleetError itself failed:", err?.message);
  }
}
