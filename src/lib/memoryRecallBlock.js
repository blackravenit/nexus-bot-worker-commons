// =============================================================================
// lib/memoryRecallBlock.js - The "WHAT YOU REMEMBER ABOUT THIS PERSON" block
// for the Nexus chat pipeline, built from a ranked memory-worker /context.
//
// Moved out of handlers/handleChatMessage.js so the ranking can be tested
// without the whole pipeline. Output format and age tags are unchanged; only
// WHICH facts and turns make the cut changed (score, not pure recency).
// =============================================================================

import { selectRankedRecall, viaSuffix, latestSummaryLine } from "./memoryRanking.js";

const MAX_FACT_LINES = 15;
const MAX_TURN_LINES = 12;
const MAX_SUMMARY_LINES = 3;
const TURN_SNIPPET_CHARS = 200;
const SUMMARY_SNIPPET_CHARS = 300;
const CHARS_PER_TOKEN = 4;

/**
 * Human age tag like "3d ago" for an epoch ms timestamp.
 * @param {number} createdAt - epoch ms
 * @param {number} now - epoch ms
 * @returns {string}
 */
export function formatRecallAge(createdAt, now) {
  if (typeof createdAt !== "number" || !createdAt) return "";
  const ms = now - createdAt;
  if (ms < 60 * 1000) return "just now";
  const mins = Math.floor(ms / (60 * 1000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function factLine(cand, now, botId) {
  const age = formatRecallAge(cand.createdAt, now);
  return `- ${String(cand.predicate).replace(/_/g, " ")}: ${cand.text}${age ? ` [${age}]` : ""}${viaSuffix(cand, botId)}`;
}

function turnLine(cand, now, botId) {
  const who = cand.role === "assistant" ? "you" : "them";
  const where = cand.channel ? ` (${cand.channel})` : "";
  const age = formatRecallAge(cand.createdAt, now);
  const body = String(cand.text).replace(/\s+/g, " ").slice(0, TURN_SNIPPET_CHARS);
  return `- ${who}${where}${age ? ` [${age}]` : ""}${viaSuffix(cand, botId)}: ${body}`;
}

function summaryLines(ctx, now) {
  const latestId = ctx.latest_summary?.session_id;
  const summaries = (Array.isArray(ctx.recent_sessions) ? ctx.recent_sessions : [])
    .filter((s) => s && s.summary && (!latestId || s.id !== latestId));
  if (!summaries.length) return [];
  const lines = ["Recent conversation summaries:"];
  for (const s of summaries.slice(0, MAX_SUMMARY_LINES)) {
    const where = s.channel ? `${s.channel}: ` : "";
    const age = formatRecallAge(s.last_active, now);
    lines.push(`-${age ? ` [${age}]` : ""} ${where}${String(s.summary).replace(/\s+/g, " ").slice(0, SUMMARY_SNIPPET_CHARS)}`);
  }
  return lines;
}

/**
 * Build a compact recall block from a memory-worker /context payload: a
 * latest-summary line, top ranked facts, top ranked cross-surface turns
 * (EXCLUDING the live chat session, which chat_history already carries), and
 * recent session summaries. Returns "" when there is nothing worth injecting.
 *
 * @param {object|null} ctx - memory-worker /context response
 * @param {string} currentSessionId - historyKey of the live chat session
 * @param {object} [opts]
 * @param {string} [opts.query] - current user message, for keyword relevance
 * @param {string} [opts.botId] - caller bot id, for "(via <bot>)" suffixes
 * @param {object} [opts.weights] - recency/importance/relevance weights
 * @param {number} [opts.maxTokens=0] - token budget for ranked items (0 = caps only)
 * @returns {string}
 */
export function buildMemoryRecallBlock(ctx, currentSessionId, opts = {}) {
  if (!ctx) return "";
  const now = Date.now();
  const lines = [];
  const summary = latestSummaryLine(ctx);
  if (summary) lines.push(summary);

  const renderLine = (c) => (c.kind === "fact" ? factLine(c, now, opts.botId) : turnLine(c, now, opts.botId));
  const { facts, turns } = selectRankedRecall(ctx, {
    query: opts.query, currentSessionId, weights: opts.weights, now,
    maxFacts: MAX_FACT_LINES, maxTurns: MAX_TURN_LINES,
    maxChars: opts.maxTokens > 0 ? opts.maxTokens * CHARS_PER_TOKEN : 0, renderLine,
  });
  if (facts.length) {
    if (lines.length) lines.push("");
    lines.push("Known facts:", ...facts.map(renderLine));
  }
  if (turns.length) {
    if (lines.length) lines.push("");
    lines.push("Earlier across chat/voice/phone (oldest to newest):", ...turns.map(renderLine));
  }
  const sessions = summaryLines(ctx, now);
  if (sessions.length) {
    if (lines.length) lines.push("");
    lines.push(...sessions);
  }
  if (!lines.length) return "";
  return (
    "\n\nWHAT YOU REMEMBER ABOUT THIS PERSON (your shared memory across chat, voice calls, and phone calls -- " +
    "use it naturally for continuity; do NOT recite it verbatim or say you looked it up). " +
    "Bracketed ages like [3d ago] mark how OLD each item is -- this is PAST context, not current events. " +
    "Do NOT raise an old fact or past conversation as if it is happening now or announce it as news; " +
    "only bring it up if the person references it first or it directly answers what they just asked:\n" +
    lines.join("\n")
  );
}
