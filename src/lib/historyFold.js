// =============================================================================
// lib/historyFold.js - Rolling summary of chat history rows that fell out of
// the token budget (see lib/contextBudget.js).
//
// Rows dropped for budget are folded into a short summary with a cheap model.
// The summary is cached in the bot's state D1 (table history_summaries) keyed
// by history_key plus the id of the newest row it covers, so it is recomputed
// only when at least foldMinRows NEW rows have fallen out since the last fold.
// Each refold summarizes (previous summary + newly dropped rows), which keeps
// content older than the load window alive.
//
// Known gap: up to foldMinRows - 1 rows between the cached fold and the kept
// window are neither summarized nor sent. They join the next fold.
// =============================================================================

import { callAnthropic } from "./anthropic.js";
import { startMemorySession, endMemorySession } from "./memoryService.js";

export const DEFAULT_SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const SUMMARY_MAX_TOKENS = 400;
const ROW_SNIPPET_CHARS = 1200;
const SUMMARY_KEEP_PER_KEY = 3;
const DEFAULT_DB_BINDING = "DB";

const SUMMARY_SYSTEM =
  "You compress an earlier part of a workplace chat between a person and an assistant bot. " +
  "Write a factual summary in at most 150 words: decisions made, requests and their status, names, " +
  "numbers, ids, dates, and anything promised. No preamble, no opinions, no invented detail. " +
  "Plain sentences, no dashes as punctuation.";

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS history_summaries (history_key TEXT NOT NULL, upto_id INTEGER NOT NULL, " +
  "summary TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (history_key, upto_id))";

/**
 * Newest cached fold for a key, or null. Creates the table on first use when
 * the bot has not applied migration 014 yet.
 * @param {object} db - D1 binding
 * @param {string} historyKey
 * @returns {Promise<{upto_id: number, summary: string}|null>}
 */
export async function loadLatestFold(db, historyKey) {
  const sql = "SELECT upto_id, summary FROM history_summaries WHERE history_key = ? ORDER BY upto_id DESC LIMIT 1";
  try {
    return (await db.prepare(sql).bind(historyKey).first()) || null;
  } catch (err) {
    if (!/no such table/i.test(String(err?.message))) throw err;
    console.warn("[historyFold] history_summaries missing, creating it (apply commons migration 014)");
    await db.prepare(CREATE_TABLE_SQL).run();
    return null;
  }
}

/**
 * Store a fold and prune older folds for the key.
 * @param {object} db
 * @param {string} historyKey
 * @param {number} uptoId
 * @param {string} summary
 * @returns {Promise<void>}
 */
export async function saveFold(db, historyKey, uptoId, summary) {
  await db.prepare(
    "INSERT OR REPLACE INTO history_summaries (history_key, upto_id, summary, created_at) VALUES (?, ?, ?, ?)",
  ).bind(historyKey, uptoId, summary, Math.floor(Date.now() / 1000)).run();
  await db.prepare(
    "DELETE FROM history_summaries WHERE history_key = ? AND upto_id NOT IN " +
    "(SELECT upto_id FROM history_summaries WHERE history_key = ? ORDER BY upto_id DESC LIMIT ?)",
  ).bind(historyKey, historyKey, SUMMARY_KEEP_PER_KEY).run();
}

/**
 * Delete every cached fold for a key (used by !clear). Missing table is fine.
 * @param {object} db
 * @param {string} historyKey
 * @returns {Promise<void>}
 */
export async function clearFolds(db, historyKey) {
  try {
    await db.prepare("DELETE FROM history_summaries WHERE history_key = ?").bind(historyKey).run();
  } catch (err) {
    if (!/no such table/i.test(String(err?.message))) throw err;
  }
}

/**
 * Render rows as a plain transcript for the summarizer.
 * @param {Array<{role: string, content: unknown}>} rows
 * @returns {string}
 */
export function renderFoldTranscript(rows) {
  return rows.map((r) => {
    const who = r.role === "assistant" ? "Assistant" : "Person";
    const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    return `${who}: ${text.replace(/\s+/g, " ").slice(0, ROW_SNIPPET_CHARS)}`;
  }).join("\n");
}

/**
 * Summarize (previous summary + newly dropped rows) with the cheap model.
 * @param {object} env
 * @param {string|null} previousSummary
 * @param {Array<object>} rows
 * @returns {Promise<string>}
 */
export async function summarizeRows(env, previousSummary, rows) {
  const prior = previousSummary ? `Summary so far:\n${previousSummary}\n\nNewer messages:\n` : "Messages:\n";
  // One-shot call: a cache write would never be read back, so skip the surcharge.
  const oneShotEnv = { ...env, ANTHROPIC_CACHE_TTL: "off" };
  const text = await callAnthropic(oneShotEnv, SUMMARY_SYSTEM, [
    { role: "user", content: prior + renderFoldTranscript(rows) },
  ], { model: env.SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL, maxTokens: SUMMARY_MAX_TOKENS, surface: "history-fold" });
  return String(text || "").trim();
}

/**
 * Best-effort copy of a fresh fold into memory-worker as a session summary.
 * Chat turns use historyKey as a session id with no sessions row behind it,
 * so a real session is started and immediately ended carrying the summary.
 * @returns {Promise<void>}
 */
async function mirrorFoldToMemory(env, { botId, entityId, channel, summary }) {
  if (!env.MEMORY || !botId) return;
  try {
    const sessionId = await startMemorySession(env, botId, { entityId, channel });
    if (sessionId) await endMemorySession(env, botId, sessionId, summary);
  } catch (err) {
    console.error(`[historyFold] memory mirror failed bot=${botId}: ${err?.message}`);
  }
}

/**
 * Return the rolling summary block for dropped history rows, refolding when
 * enough new rows fell out. Never throws; "" on any failure or nothing to say.
 *
 * @param {object} env
 * @param {object} params
 * @param {string} params.historyKey
 * @param {Array<{id: number, role: string, content: string}>} params.dropped - chronological
 * @param {number} [params.foldMinRows=10]
 * @param {string} [params.dbBinding="DB"]
 * @param {boolean} [params.allowRefold=true] - false on latency-bound turns (cache only)
 * @param {string} [params.botId] - memory-worker bot id for the mirror
 * @param {string|null} [params.entityId]
 * @param {string} [params.channel]
 * @returns {Promise<string>} "\n\nEarlier in this conversation (summary): ..." or ""
 */
export async function buildHistoryFoldBlock(env, params) {
  const { historyKey, dropped, foldMinRows = 10, dbBinding, allowRefold = true } = params;
  const db = env?.[dbBinding || DEFAULT_DB_BINDING];
  if (!db || !Array.isArray(dropped) || dropped.length === 0) return "";
  try {
    const cached = await loadLatestFold(db, historyKey);
    const pending = dropped.filter((r) => typeof r.id === "number" && r.id > (cached?.upto_id ?? -1));
    let summary = cached?.summary || "";
    if (allowRefold && pending.length >= foldMinRows) {
      summary = await summarizeRows(env, cached?.summary || null, pending);
      if (summary) {
        await saveFold(db, historyKey, pending[pending.length - 1].id, summary);
        await mirrorFoldToMemory(env, { ...params, summary });
      }
    }
    return summary ? `\n\nEarlier in this conversation (summary): ${summary}` : "";
  } catch (err) {
    console.error(`[historyFold] fold failed key=${historyKey}: ${err?.message}`);
    return "";
  }
}
