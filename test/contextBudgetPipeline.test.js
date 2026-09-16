import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { runLlmPipeline } from "../src/handlers/handleChatMessage.js";

// Smoke test of the opt-in token budget inside the real pipeline: Nexus is
// unconfigured (posts no-op), Anthropic is a fetch mock, D1 is a small fake.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function chatDb(historyRows, foldRows = []) {
  const queries = [];
  return {
    queries,
    prepare: (sql) => {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        all: async () => {
          queries.push({ sql, args });
          if (sql.includes("FROM chat_history")) return { results: historyRows.slice().reverse().slice(0, args[1]) };
          return { results: [] };
        },
        first: async () => (sql.includes("history_summaries") ? foldRows[0] || null : null),
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    },
  };
}

function mockModel() {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("anthropic")) {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  return bodies;
}

const rows = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1, role: i % 2 ? "assistant" : "user", content: `message ${i + 1} ${"x".repeat(400)}`, created_at: i,
}));

function baseArgs(db, contextBudget) {
  return {
    env: { DB: db, ANTHROPIC_API_KEY: "k" },
    user_id: "u1", display_name: "Pat", channel_slug: "testbot-assistant",
    userText: "hello", labeledUserText: "Pat (uid:u1): hello", historyKey: "nexus:u1",
    config: {
      botName: "testbot", persona: { systemPrompt: "You are a test bot." },
      tools: { definitions: [], handlers: {} },
      channelContext: { enabled: false }, hitlContext: { enabled: false },
      contextBudget,
    },
  };
}

test("budget off: the fixed 30 row window is loaded, no fold block", async () => {
  const bodies = mockModel();
  const db = chatDb(rows);
  await runLlmPipeline(baseArgs(db, undefined));
  const historyQuery = db.queries.find((q) => q.sql.includes("FROM chat_history"));
  assert.equal(historyQuery.args[1], 30);
  assert.ok(bodies.length >= 1);
  assert.doesNotMatch(JSON.stringify(bodies[0].messages), /Earlier in this conversation/);
});

test("budget on: newest rows within budget are sent and the cached fold is injected", async () => {
  const bodies = mockModel();
  const db = chatDb(rows, [{ upto_id: 5, summary: "They picked Tuesday." }]);
  await runLlmPipeline(baseArgs(db, { enabled: true, history: 600, foldMinRows: 1000 }));
  const historyQuery = db.queries.find((q) => q.sql.includes("FROM chat_history"));
  assert.equal(historyQuery.args[1], 80);
  const sent = JSON.stringify(bodies[0].messages);
  assert.match(sent, /message 40 /);
  assert.doesNotMatch(sent, /message 30 /, "old rows were dropped for budget");
  assert.match(sent, /Earlier in this conversation \(summary\): They picked Tuesday\./);
  assert.ok(!/"id":/.test(sent), "row meta never reaches the model");
});
