// =============================================================================
// lib/contextBudget.js - Token budgets for the chat pipeline's working memory.
//
// Fixed row counts (30 history rows, 15 channel messages, 8 HITL cards) waste
// tokens on short chatter and starve long technical turns. With
// config.contextBudget.enabled the pipeline loads a generous window and keeps
// the NEWEST rows that fit a token budget instead. Tokens are estimated as
// chars/4, which is close enough for English prose and errs slightly high on
// code, the safe direction for a budget.
//
// Opt-in per bot: enabled defaults to false, and every caller keeps its old
// fixed-count path when it is off.
// =============================================================================

export const CHARS_PER_TOKEN = 4;
// A non-text block (image, document) has no useful char length; charge a flat
// rate so one screenshot cannot silently blow the whole history budget.
const MEDIA_BLOCK_TOKENS = 1500;

export const DEFAULT_CONTEXT_BUDGET = Object.freeze({
  enabled: false,
  history: 6000,
  channel: 2500,
  hitl: 1200,
  recall: 2000,
  historyWindow: 80,
  channelWindow: 40,
  hitlWindow: 20,
  foldMinRows: 10,
});

/**
 * Merge config.contextBudget over the defaults. Non-positive numbers fall back
 * to the default so a typo cannot zero out a budget.
 * @param {object} [config] - bot config
 * @returns {typeof DEFAULT_CONTEXT_BUDGET}
 */
export function resolveContextBudget(config) {
  const raw = config?.contextBudget || {};
  const merged = { ...DEFAULT_CONTEXT_BUDGET, enabled: raw.enabled === true };
  for (const key of Object.keys(DEFAULT_CONTEXT_BUDGET)) {
    if (key === "enabled") continue;
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n > 0) merged[key] = n;
  }
  return merged;
}

/**
 * Estimate tokens for a string or an Anthropic content array.
 * @param {string|Array<object>} content
 * @returns {number}
 */
export function estimateTokens(content) {
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block?.type === "text") total += Math.ceil(String(block.text || "").length / CHARS_PER_TOKEN);
    else total += MEDIA_BLOCK_TOKENS;
  }
  return total;
}

/**
 * Keep the newest contiguous items that fit the budget. The newest item is
 * always kept, even alone over budget, so a turn never loses its latest row.
 *
 * @template T
 * @param {T[]} items - chronological, oldest first
 * @param {number} budgetTokens
 * @param {(item: T) => number} [measure] - token cost of one item
 * @returns {{kept: T[], dropped: T[]}} both chronological
 */
export function keepNewestWithinBudget(items, budgetTokens, measure = (item) => estimateTokens(item?.content ?? item)) {
  const list = Array.isArray(items) ? items : [];
  let used = 0;
  let start = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const cost = measure(list[i]);
    if (start < list.length && used + cost > budgetTokens) break;
    used += cost;
    start = i;
  }
  return { kept: list.slice(start), dropped: list.slice(0, start) };
}

/**
 * Trim prompt lines (oldest first) to the newest that fit a token budget.
 * A budget of 0 or less returns the lines unchanged.
 * @param {string[]} lines
 * @param {number} budgetTokens
 * @returns {string[]}
 */
export function fitNewestLines(lines, budgetTokens) {
  if (!(budgetTokens > 0)) return lines;
  return keepNewestWithinBudget(lines, budgetTokens, (line) => estimateTokens(String(line)) + 1).kept;
}

/**
 * Split loaded history rows (with meta) into the model-ready kept rows and
 * the dropped rows that are candidates for folding.
 * @param {Array<{id: number, role: string, content: string}>} rows - chronological
 * @param {number} budgetTokens
 * @returns {{history: Array<{role: string, content: string}>, dropped: Array<object>}}
 */
export function applyHistoryBudget(rows, budgetTokens) {
  const { kept, dropped } = keepNewestWithinBudget(rows, budgetTokens);
  return { history: kept.map(({ role, content }) => ({ role, content })), dropped };
}
