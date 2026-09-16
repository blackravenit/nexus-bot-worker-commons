// =============================================================================
// lib/memoryRanking.js - Ranked recall over a memory-worker /context payload.
//
// Recall used to show the newest N facts and turns. Newest is not the same as
// useful: a durable account detail from last month outranks "ok thanks" from
// an hour ago, and a semantic hit on what the person just asked outranks both.
// Every candidate (fact, recent turn, semantic match) is scored as
//
//   score = w.recency * recency + w.importance * importance + w.relevance * relevance
//
// with each dimension min-max normalized to 0..1 across the candidate set.
//
// Pure functions only; no I/O. Callers format the selection.
// =============================================================================

export const DEFAULT_RECALL_WEIGHTS = Object.freeze({ recency: 1, importance: 1, relevance: 1 });
export const RECENCY_HALF_LIFE_DAYS = 14;
export const TURN_IMPORTANCE = 0.3;
const HIGH_CONFIDENCE = 0.9;
const DEFAULT_FACT_CONFIDENCE = 1;
const KEYWORD_BONUS_MAX = 0.2;
const MIN_KEYWORD_LENGTH = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
// Epoch values below this are seconds, not milliseconds (legacy D1 rows).
const EPOCH_MS_FLOOR = 1e12;

// Mirrors memory-worker src/lib/facts.js CRITICAL_PREDICATES (kept forever there).
export const CRITICAL_PREDICATES = new Set([
  "current_stack", "incumbent_msp", "environment_detail", "company_size",
  "industry", "location", "decision_maker", "recurring_issue",
  "escalation_history", "contact_detail", "relationship", "commitment",
  "account_number", "account_detail", "client_detail", "next_step",
]);

/**
 * Coerce a created_at value (epoch ms, epoch seconds, or ISO string) to epoch ms.
 * @param {unknown} value
 * @returns {number|null}
 */
export function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < EPOCH_MS_FLOOR ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Lowercase, collapse whitespace, drop punctuation. Used for text dedupe.
 * @param {string} text
 * @returns {string}
 */
export function normalizeRecallText(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Build the unified candidate list from a /context payload.
 * Semantic matches that point at an already-listed row enrich it instead of
 * duplicating it. Turns from the live session are excluded (history has them).
 *
 * @param {object} ctx - memory-worker /context response
 * @param {object} [opts]
 * @param {string} [opts.currentSessionId]
 * @returns {Array<object>} candidates {kind, id, text, createdAt, predicate, confidence, role, channel, botId, semanticScore}
 */
export function collectRecallCandidates(ctx, opts = {}) {
  if (!ctx) return [];
  const byKey = new Map();
  const add = (cand) => {
    const key = cand.id ? `${cand.kind}:${cand.id}` : null;
    const existing = key ? byKey.get(key) : null;
    if (existing) {
      if (cand.semanticScore != null) existing.semanticScore = Math.max(existing.semanticScore ?? 0, cand.semanticScore);
      existing.botId = existing.botId || cand.botId;
      return;
    }
    byKey.set(key || `anon:${byKey.size}`, cand);
  };
  for (const f of Array.isArray(ctx.facts) ? ctx.facts : []) {
    if (f?.predicate && f?.object) add(factCandidate(f, f.object));
  }
  for (const t of Array.isArray(ctx.recent_turns) ? ctx.recent_turns : []) {
    if (!t?.content) continue;
    if (opts.currentSessionId && t.session_id === opts.currentSessionId) continue;
    add(turnCandidate(t, t.content));
  }
  for (const m of Array.isArray(ctx.semantic_matches) ? ctx.semantic_matches : []) {
    if (!m?.text) continue;
    if (opts.currentSessionId && m.session_id && m.session_id === opts.currentSessionId) continue;
    const score = Number(m.score);
    const withScore = (c) => ({ ...c, semanticScore: Number.isFinite(score) ? score : 0 });
    if (m.type === "fact" && m.predicate) add(withScore(factCandidate(m, m.text)));
    else if (m.type === "turn") add(withScore(turnCandidate(m, m.text)));
  }
  return dedupeByText([...byKey.values()]);
}

function factCandidate(row, text) {
  return {
    kind: "fact", id: row.id ?? null, text: String(text), createdAt: toEpochMs(row.created_at),
    predicate: row.predicate, confidence: row.confidence, botId: row.bot_id || null, semanticScore: null,
  };
}

function turnCandidate(row, text) {
  return {
    kind: "turn", id: row.id ?? null, text: String(text), createdAt: toEpochMs(row.created_at),
    role: row.role, channel: row.channel || null, botId: row.bot_id || null, semanticScore: null,
  };
}

/**
 * Drop candidates whose normalized text repeats an earlier one, keeping the
 * copy with the higher semantic score.
 * @param {Array<object>} candidates
 * @returns {Array<object>}
 */
function dedupeByText(candidates) {
  const kept = new Map();
  for (const cand of candidates) {
    const key = `${cand.kind}:${cand.predicate || ""}:${normalizeRecallText(cand.text)}`;
    const prior = kept.get(key);
    if (!prior || (cand.semanticScore ?? -1) > (prior.semanticScore ?? -1)) kept.set(key, cand);
  }
  return [...kept.values()];
}

/**
 * Importance: critical or high-confidence facts 1, other facts their
 * confidence, turns a flat TURN_IMPORTANCE.
 * @param {object} cand
 * @returns {number}
 */
export function importanceOf(cand) {
  if (cand.kind !== "fact") return TURN_IMPORTANCE;
  const conf = Number(cand.confidence);
  const confidence = Number.isFinite(conf) ? conf : DEFAULT_FACT_CONFIDENCE;
  if (CRITICAL_PREDICATES.has(cand.predicate) || confidence >= HIGH_CONFIDENCE) return 1;
  return Math.max(0, confidence);
}

/**
 * Exponential decay on age with a 14 day half-life. Undated items score 0.
 * @param {number|null} createdAtMs
 * @param {number} nowMs
 * @returns {number}
 */
export function recencyOf(createdAtMs, nowMs) {
  if (!createdAtMs) return 0;
  const ageDays = Math.max(0, nowMs - createdAtMs) / DAY_MS;
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Semantic score plus a small bonus for query keywords present in the text.
 * @param {object} cand
 * @param {Set<string>} queryWords
 * @returns {number}
 */
export function relevanceOf(cand, queryWords) {
  const base = cand.semanticScore != null && Number.isFinite(cand.semanticScore) ? cand.semanticScore : 0;
  if (!queryWords || queryWords.size === 0) return base;
  const words = new Set(keywordsOf(cand.text));
  let hits = 0;
  for (const w of queryWords) if (words.has(w)) hits += 1;
  return base + KEYWORD_BONUS_MAX * (hits / queryWords.size);
}

/**
 * Significant words of a text (length >= 4), normalized.
 * @param {string} text
 * @returns {string[]}
 */
export function keywordsOf(text) {
  return normalizeRecallText(text).split(" ").filter((w) => w.length >= MIN_KEYWORD_LENGTH);
}

/**
 * Min-max normalize an array of numbers to 0..1. A flat series maps to 0,
 * so a dimension with no spread contributes nothing to the ordering.
 * @param {number[]} values
 * @returns {number[]}
 */
export function minMaxNormalize(values) {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  return values.map((v) => (range > 0 ? (v - min) / range : 0));
}

/**
 * Score and sort candidates, highest first. Ties break newest first.
 * @param {Array<object>} candidates
 * @param {object} [opts]
 * @param {string} [opts.query] - current user message
 * @param {{recency?: number, importance?: number, relevance?: number}} [opts.weights]
 * @param {number} [opts.now]
 * @returns {Array<object>} candidates with .score
 */
export function rankRecallCandidates(candidates, opts = {}) {
  const weights = { ...DEFAULT_RECALL_WEIGHTS, ...(opts.weights || {}) };
  const now = opts.now ?? Date.now();
  const queryWords = new Set(keywordsOf(opts.query || ""));
  const recency = minMaxNormalize(candidates.map((c) => recencyOf(c.createdAt, now)));
  const importance = minMaxNormalize(candidates.map(importanceOf));
  const relevance = minMaxNormalize(candidates.map((c) => relevanceOf(c, queryWords)));
  return candidates
    .map((c, i) => ({
      ...c,
      score: weights.recency * recency[i] + weights.importance * importance[i] + weights.relevance * relevance[i],
    }))
    .sort((a, b) => b.score - a.score || (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Pick the top facts and turns by score within per-kind caps and an optional
 * character budget (lowest scored items are the first to go).
 *
 * @param {object} ctx - /context payload
 * @param {object} [opts]
 * @param {string} [opts.query]
 * @param {string} [opts.currentSessionId]
 * @param {number} [opts.maxFacts=15]
 * @param {number} [opts.maxTurns=12]
 * @param {number} [opts.maxChars=0] - 0 means no budget
 * @param {(cand: object) => string} [opts.renderLine] - line used for budget math
 * @param {object} [opts.weights]
 * @returns {{facts: Array<object>, turns: Array<object>}} facts by score, turns oldest first
 */
export function selectRankedRecall(ctx, opts = {}) {
  const maxFacts = opts.maxFacts ?? 15;
  const maxTurns = opts.maxTurns ?? 12;
  const ranked = rankRecallCandidates(collectRecallCandidates(ctx, opts), opts);
  const facts = [];
  const turns = [];
  let chars = 0;
  for (const cand of ranked) {
    const bucket = cand.kind === "fact" ? facts : turns;
    if (bucket.length >= (cand.kind === "fact" ? maxFacts : maxTurns)) continue;
    const lineChars = opts.renderLine ? opts.renderLine(cand).length + 1 : 0;
    if (opts.maxChars > 0 && chars + lineChars > opts.maxChars) continue;
    chars += lineChars;
    bucket.push(cand);
  }
  turns.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { facts, turns };
}

/**
 * " (via <bot>)" when the item was written by a different bot than the caller.
 * @param {object} cand
 * @param {string} [callerBotId]
 * @returns {string}
 */
export function viaSuffix(cand, callerBotId) {
  if (!cand?.botId || !callerBotId) return "";
  return String(cand.botId).toLowerCase() === String(callerBotId).toLowerCase() ? "" : ` (via ${cand.botId})`;
}

/**
 * One-line "Last conversation summary:" from ctx.latest_summary, or "".
 * @param {object} ctx
 * @param {number} [maxChars=300]
 * @returns {string}
 */
export function latestSummaryLine(ctx, maxChars = 300) {
  const latest = ctx?.latest_summary;
  const text = typeof latest === "string" ? latest : latest?.summary;
  if (!text || !String(text).trim()) return "";
  return `Last conversation summary: ${String(text).replace(/\s+/g, " ").trim().slice(0, maxChars)}`;
}
