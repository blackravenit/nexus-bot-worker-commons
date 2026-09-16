import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildHistoryFoldBlock, clearFolds, renderFoldTranscript } from "../src/lib/historyFold.js";

/** Minimal D1 fake for the history_summaries statements historyFold issues. */
function fakeDb({ tableExists = true } = {}) {
  const state = { exists: tableExists, rows: [], statements: [] };
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind: (...a) => { args = a; return stmt; },
      first: async () => {
        if (!state.exists) throw new Error("D1_ERROR: no such table: history_summaries");
        const mine = state.rows.filter((r) => r.history_key === args[0]).sort((a, b) => b.upto_id - a.upto_id);
        return mine[0] ? { upto_id: mine[0].upto_id, summary: mine[0].summary } : null;
      },
      run: async () => {
        state.statements.push(sql);
        if (sql.startsWith("CREATE TABLE")) { state.exists = true; return {}; }
        if (!state.exists) throw new Error("no such table: history_summaries");
        if (sql.startsWith("INSERT")) state.rows.push({ history_key: args[0], upto_id: args[1], summary: args[2] });
        if (sql.startsWith("DELETE FROM history_summaries WHERE history_key = ?") && args.length === 1) {
          state.rows = state.rows.filter((r) => r.history_key !== args[0]);
        }
        return {};
      },
    };
    return stmt;
  };
  return { prepare, state };
}

const realFetch = globalThis.fetch;
let anthropicCalls = [];
function mockAnthropic(text = "They agreed on Tuesday.") {
  anthropicCalls = [];
  globalThis.fetch = async (url, init) => {
    anthropicCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: null }), { status: 200 });
  };
}
afterEach(() => { globalThis.fetch = realFetch; });

const rows = (from, count) => Array.from({ length: count }, (_, i) => ({ id: from + i, role: i % 2 ? "assistant" : "user", content: `row ${from + i}` }));

test("fewer than foldMinRows dropped rows and no cache: no summary, no model call", async () => {
  mockAnthropic();
  const db = fakeDb();
  const block = await buildHistoryFoldBlock({ DB: db, ANTHROPIC_API_KEY: "k" }, { historyKey: "nexus:u", dropped: rows(1, 9) });
  assert.equal(block, "");
  assert.equal(anthropicCalls.length, 0);
});

test("folds once, then serves the cache until the window moves by 10 more rows", async () => {
  mockAnthropic();
  const db = fakeDb({ tableExists: false });
  const env = { DB: db, ANTHROPIC_API_KEY: "k" };
  const first = await buildHistoryFoldBlock(env, { historyKey: "nexus:u", dropped: rows(1, 12) });
  assert.equal(first, "\n\nEarlier in this conversation (summary): They agreed on Tuesday.");
  assert.equal(anthropicCalls.length, 1);
  assert.equal(anthropicCalls[0].body.model, "claude-haiku-4-5-20251001");
  assert.equal(anthropicCalls[0].body.max_tokens, 400);
  assert.ok(db.state.statements.some((s) => s.startsWith("CREATE TABLE")), "table created lazily");

  const cached = await buildHistoryFoldBlock(env, { historyKey: "nexus:u", dropped: rows(1, 20) });
  assert.match(cached, /They agreed on Tuesday/);
  assert.equal(anthropicCalls.length, 1, "8 new rows is below the refold threshold");

  mockAnthropic("Rolled forward.");
  env.SUMMARY_MODEL = "claude-test-model";
  const refold = await buildHistoryFoldBlock(env, { historyKey: "nexus:u", dropped: rows(1, 22) });
  assert.match(refold, /Rolled forward/);
  assert.equal(anthropicCalls[0].body.model, "claude-test-model");
  assert.equal(typeof anthropicCalls[0].body.messages[0].content, "string", "no cache_control on a one-shot call");
  assert.match(anthropicCalls[0].body.messages[0].content, /Summary so far:\nThey agreed on Tuesday/);
});

test("allowRefold false serves cache only; model failure returns empty, never throws", async () => {
  const db = fakeDb();
  db.state.rows.push({ history_key: "k", upto_id: 5, summary: "cached" });
  globalThis.fetch = async () => { throw new Error("should not be called"); };
  const block = await buildHistoryFoldBlock({ DB: db, ANTHROPIC_API_KEY: "k" }, { historyKey: "k", dropped: rows(1, 30), allowRefold: false });
  assert.match(block, /cached/);

  globalThis.fetch = async () => new Response("bad", { status: 400 });
  const failed = await buildHistoryFoldBlock({ DB: fakeDb(), ANTHROPIC_API_KEY: "k" }, { historyKey: "k2", dropped: rows(1, 30) });
  assert.equal(failed, "");
});

test("a fresh fold is mirrored to memory-worker as a started and ended session", async () => {
  mockAnthropic();
  const memCalls = [];
  const env = {
    DB: fakeDb(), ANTHROPIC_API_KEY: "k",
    MEMORY: { fetch: async (req) => { memCalls.push({ path: new URL(req.url).pathname, body: await req.json() }); return Response.json({ id: "sess1" }); } },
  };
  await buildHistoryFoldBlock(env, { historyKey: "k", dropped: rows(1, 10), botId: "jacob", entityId: "e1", channel: "jacob-assistant" });
  assert.deepEqual(memCalls.map((c) => c.path), ["/sessions/start", "/sessions/end"]);
  assert.equal(memCalls[1].body.session_id, "sess1");
  assert.equal(memCalls[1].body.summary, "They agreed on Tuesday.");
});

test("clearFolds deletes a key and tolerates a missing table", async () => {
  const db = fakeDb();
  db.state.rows.push({ history_key: "k", upto_id: 1, summary: "s" });
  await clearFolds(db, "k");
  assert.equal(db.state.rows.length, 0);
  await clearFolds(fakeDb({ tableExists: false }), "k");
  assert.match(renderFoldTranscript([{ role: "assistant", content: "a\n b" }]), /^Assistant: a b$/);
});
