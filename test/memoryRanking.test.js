import { test } from "node:test";
import assert from "node:assert/strict";

import {
  toEpochMs, collectRecallCandidates, rankRecallCandidates, selectRankedRecall,
  importanceOf, recencyOf, minMaxNormalize, viaSuffix, latestSummaryLine,
} from "../src/lib/memoryRanking.js";
import { buildMemoryRecallBlock } from "../src/lib/memoryRecallBlock.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 16);

test("toEpochMs accepts ms, seconds, and ISO strings", () => {
  assert.equal(toEpochMs(NOW), NOW);
  assert.equal(toEpochMs(NOW / 1000), NOW);
  assert.equal(toEpochMs(new Date(NOW).toISOString()), NOW);
  assert.equal(toEpochMs(null), null);
});

test("recency halves every 14 days and importance follows the rules", () => {
  assert.equal(recencyOf(NOW, NOW), 1);
  assert.ok(Math.abs(recencyOf(NOW - 14 * DAY, NOW) - 0.5) < 1e-9);
  assert.equal(importanceOf({ kind: "fact", predicate: "decision_maker", confidence: 0.2 }), 1);
  assert.equal(importanceOf({ kind: "fact", predicate: "note", confidence: 0.95 }), 1);
  assert.equal(importanceOf({ kind: "fact", predicate: "note", confidence: 0.4 }), 0.4);
  assert.equal(importanceOf({ kind: "turn" }), 0.3);
});

test("minMaxNormalize maps to 0..1 and a flat series to 0", () => {
  assert.deepEqual(minMaxNormalize([2, 4, 6]), [0, 0.5, 1]);
  assert.deepEqual(minMaxNormalize([3, 3]), [0, 0]);
});

test("semantic matches enrich existing rows and dedupe by normalized text", () => {
  const ctx = {
    facts: [{ id: "f1", predicate: "note", object: "Likes red.", confidence: 1, created_at: NOW }],
    recent_turns: [
      { id: "t1", role: "user", content: "hello there", created_at: NOW, session_id: "s-other" },
      { id: "t2", role: "user", content: "Hello, there!", created_at: NOW - DAY, session_id: "s-other" },
      { id: "t3", role: "user", content: "live session turn", created_at: NOW, session_id: "live" },
    ],
    semantic_matches: [{ type: "fact", id: "f1", score: 0.9, text: "Likes red.", predicate: "note" }],
  };
  const cands = collectRecallCandidates(ctx, { currentSessionId: "live" });
  assert.equal(cands.filter((c) => c.kind === "fact").length, 1);
  assert.equal(cands.find((c) => c.id === "f1").semanticScore, 0.9);
  assert.equal(cands.filter((c) => c.kind === "turn").length, 1, "text dupes collapse, live session excluded");
});

test("an old relevant critical fact outranks a fresh trivial turn", () => {
  const ctx = {
    facts: [{ id: "f1", predicate: "incumbent_msp", object: "Acme IT", confidence: 1, created_at: NOW - 60 * DAY }],
    recent_turns: [{ id: "t1", role: "user", content: "ok thanks", created_at: NOW }],
    semantic_matches: [{ type: "fact", id: "f1", score: 0.8, text: "Acme IT", predicate: "incumbent_msp" }],
  };
  const ranked = rankRecallCandidates(collectRecallCandidates(ctx), { now: NOW, query: "who is their msp" });
  assert.equal(ranked[0].id, "f1");
});

test("weights are configurable: recency-only restores newest first", () => {
  const ctx = {
    facts: [
      { id: "old", predicate: "decision_maker", object: "Pat", confidence: 1, created_at: NOW - 30 * DAY },
      { id: "new", predicate: "note", object: "minor", confidence: 0.1, created_at: NOW },
    ],
  };
  const ranked = rankRecallCandidates(collectRecallCandidates(ctx), { now: NOW, weights: { importance: 0, relevance: 0 } });
  assert.equal(ranked[0].id, "new");
});

test("keyword overlap breaks a tie in relevance", () => {
  const ctx = {
    facts: [
      { id: "a", predicate: "note", object: "printer on floor two jams", confidence: 1, created_at: NOW },
      { id: "b", predicate: "note", object: "prefers morning calls", confidence: 1, created_at: NOW },
    ],
  };
  const ranked = rankRecallCandidates(collectRecallCandidates(ctx), { now: NOW, query: "the printer jams again" });
  assert.equal(ranked[0].id, "a");
});

test("selectRankedRecall honors caps and char budget, turns come back oldest first", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, role: "user", content: `turn number ${i}`, created_at: NOW - i * DAY }));
  const { turns: picked } = selectRankedRecall({ recent_turns: turns }, { now: NOW, maxTurns: 5 });
  assert.equal(picked.length, 5);
  assert.ok(picked[0].createdAt < picked[4].createdAt);
  const budgeted = selectRankedRecall({ recent_turns: turns }, { now: NOW, maxChars: 30, renderLine: (c) => c.text });
  assert.ok(budgeted.turns.length <= 2);
});

test("viaSuffix and latestSummaryLine are defensive about absent fields", () => {
  assert.equal(viaSuffix({ botId: "wren" }, "jacob"), " (via wren)");
  assert.equal(viaSuffix({ botId: "Jacob" }, "jacob"), "");
  assert.equal(viaSuffix({}, "jacob"), "");
  assert.equal(latestSummaryLine({}), "");
  assert.equal(latestSummaryLine({ latest_summary: { summary: "Talked renewals." } }), "Last conversation summary: Talked renewals.");
});

test("buildMemoryRecallBlock keeps the format, adds via and summary lines", () => {
  const ctx = {
    facts: [{ id: "f1", predicate: "favorite_color", object: "red", confidence: 1, created_at: Date.now() - 3 * DAY, bot_id: "wren" }],
    recent_turns: [{ id: "t1", role: "assistant", content: "Sent the quote", channel: "email", created_at: Date.now() - DAY, session_id: "x", bot_id: "jacob" }],
    recent_sessions: [{ id: "s1", summary: "Quote talk", channel: "voice", last_active: Date.now() - DAY }],
    latest_summary: { session_id: "s1", summary: "Quote talk" },
  };
  const block = buildMemoryRecallBlock(ctx, "live", { botId: "jacob", query: "quote" });
  assert.match(block, /WHAT YOU REMEMBER ABOUT THIS PERSON/);
  assert.match(block, /Last conversation summary: Quote talk/);
  assert.match(block, /- favorite color: red \[3d ago\] \(via wren\)/);
  assert.match(block, /- you \(email\) \[1d ago\]: Sent the quote/);
  assert.doesNotMatch(block, /Recent conversation summaries/, "latest summary is not repeated");
  assert.equal(buildMemoryRecallBlock({}, "live"), "");
});
