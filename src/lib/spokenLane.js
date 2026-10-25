// =============================================================================
// lib/spokenLane.js: the "spoken reply" fast lane for FleetView voice turns.
//
// FleetView voice questions are read aloud and truncated for speech anyway, so
// they do not need the bot's big model, a long answer, a deep tool loop, or an
// unbounded memory recall. This module holds the small pure pieces the turn
// pipeline uses to run such a turn lean. Normal turns never touch any of it.
//
// Hard rules:
//   - No module-level I/O.
//   - No em dashes or en dashes.
//   - ES modules only.
// =============================================================================

/** Model used for spoken turns unless env.VOICE_MODEL overrides it. */
export const SPOKEN_DEFAULT_MODEL = "claude-sonnet-5-5";

/** Hard ceiling on output tokens for a spoken turn. */
export const SPOKEN_MAX_TOKENS = 400;

/** Tool-use rounds a spoken turn may run before it is forced to answer. */
export const SPOKEN_TOOL_BUDGET = 2;

/** Memory recall time budget for a spoken turn, in milliseconds. */
export const SPOKEN_RECALL_BUDGET_MS = 400;
// Typed FleetView turns: two sequential memory-worker hops fit comfortably.
export const FLEETVIEW_RECALL_BUDGET_MS = 4000;

/** System addendum appended to the session context on a spoken turn. */
export const SPOKEN_ADDENDUM =
  "\n\nThis reply will be spoken aloud. Answer in two to four sentences, plain words, " +
  "no markdown, no lists, no code. Lead with the answer. If the task needs real work, " +
  "say what you will do and that you are on it, then continue the work in the background as usual.";

/**
 * True when a chat-message payload asks for the spoken fast lane.
 *
 * @param {object|null|undefined} body - parsed chat-message JSON
 * @returns {boolean}
 */
export function isSpokenRequest(body) {
  return body?.voice === true || body?.reply_style === "spoken";
}

/**
 * Pick the model for a turn: the voice model on the spoken lane, otherwise
 * whatever the caller already resolved.
 *
 * @param {object} env - worker bindings (VOICE_MODEL optional)
 * @param {object} args
 * @param {boolean} [args.spoken] - spoken lane active
 * @param {string} args.defaultModel - the bot's normal model for this turn
 * @returns {string}
 */
export function pickTurnModel(env, { spoken, defaultModel }) {
  if (!spoken) return defaultModel;
  return env?.VOICE_MODEL || SPOKEN_DEFAULT_MODEL;
}

/**
 * Output token cap for a turn. The spoken lane caps at 400 but never raises a
 * lower cap the caller already set.
 *
 * @param {boolean} spoken - spoken lane active
 * @param {number} [existingCap] - cap the caller already had, if any
 * @returns {number|undefined} undefined means "leave the default alone"
 */
export function pickMaxTokens(spoken, existingCap) {
  if (!spoken) return existingCap;
  return existingCap && existingCap < SPOKEN_MAX_TOKENS ? existingCap : SPOKEN_MAX_TOKENS;
}

/**
 * Race a recall promise against a timer. On timeout resolves to the fallback
 * and logs one line; the late recall result is discarded.
 *
 * @param {Promise<string>} recallPromise - the recall in flight
 * @param {number} budgetMs - time budget in milliseconds
 * @param {string} [fallback] - value to continue with on timeout
 * @returns {Promise<string>}
 */
export async function raceRecallBudget(recallPromise, budgetMs, fallback = "") {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[turn] spoken lane: recall skipped after ${budgetMs}ms`);
      resolve(fallback);
    }, budgetMs);
  });
  try {
    return await Promise.race([recallPromise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Timing fields identifying the lane and model, merged into the timings object
 * the bot posts back to FleetView.
 *
 * @param {boolean} spoken - spoken lane active
 * @param {string} modelId - model the turn ran on
 * @returns {{lane: "spoken"|"normal", model_id: string}}
 */
export function laneTimings(spoken, modelId) {
  return { lane: spoken ? "spoken" : "normal", model_id: modelId };
}

const RECALL_TIMEOUT = Symbol("recall-timeout");

/**
 * Race a typed FleetView recall against its budget and log only what actually
 * happened. The earlier inline timer warned once the budget elapsed even when
 * recall had already won, which made every typed turn look recall-less.
 * @param {() => Promise<string>} recall
 * @param {number} budgetMs
 * @returns {Promise<string>} the recall block, or "" when the budget won
 */
export async function raceTypedRecall(recall, budgetMs) {
  const startedAt = Date.now();
  let timer;
  const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve(RECALL_TIMEOUT), budgetMs); });
  try {
    const block = await Promise.race([recall(), expiry]);
    if (block === RECALL_TIMEOUT) {
      console.warn(`[handleChatMessage] memory recall over ${budgetMs}ms on a typed FleetView turn, answering without it`);
      return "";
    }
    console.info(`[handleChatMessage] memory recall ready in ${Date.now() - startedAt}ms (${(block || "").length} chars)`);
    return block || "";
  } finally {
    clearTimeout(timer);
  }
}
