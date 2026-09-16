import { test } from "node:test";
import assert from "node:assert/strict";

import { migrateLegacyFacts, formatFactsReply } from "../src/lib/memoryNotes.js";
import { buildMemoryCommandHandlers } from "../src/handlers/memoryCommands.js";
import { persistEmailExchange } from "../src/lib/memoryService.js";
import { buildContactRecall } from "../src/lib/memoryRecall.js";
import { stripQuotedReply } from "../src/lib/emailQuote.js";

/** Fake memory-worker: entities keyed by external id, facts deduped server side. */
function fakeMemory() {
  const state = { calls: [], facts: [], turns: [] };
  const fetch = async (req) => {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json() : null;
    state.calls.push({ path: url.pathname, body, headers: Object.fromEntries(req.headers) });
    if (url.pathname === "/entities") {
      const key = body.external_ids.nexus_user_id || body.external_ids.email;
      return Response.json({ id: `ent:${key}` });
    }
    if (url.pathname === "/facts") {
      const dup = state.facts.find((f) => f.subject_id === body.subject_id && f.object === body.object);
      if (dup) return Response.json({ id: dup.id, deduplicated: true });
      const id = `f${state.facts.length + 1}`;
      state.facts.push({ id, ...body });
      return Response.json({ id, deduplicated: false });
    }
    if (url.pathname.endsWith("/facts")) return Response.json({ facts: state.facts });
    if (url.pathname === "/turns") { state.turns.push(body); return Response.json({ id: "t" }); }
    if (url.pathname === "/context") return Response.json(state.context || {});
    return new Response("nope", { status: 404 });
  };
  return { fetch, state };
}

function legacyDb(rows) {
  return {
    prepare: (sql) => {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        all: async () => {
          if (sql.startsWith("SELECT id, user_id, text FROM facts")) {
            return { results: rows.filter((r) => r.id > args[0]).slice(0, args[1]) };
          }
          return { results: rows.filter((r) => r.user_id === args[0]) };
        },
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    },
  };
}

test("migrateLegacyFacts copies rows as critical notes and is idempotent", async () => {
  const memory = fakeMemory();
  const rows = [
    { id: 1, user_id: "u1", text: "likes tea" },
    { id: 2, user_id: "u1", text: "on call Fridays" },
    { id: 3, user_id: "u2", text: "  " },
  ];
  const env = { MEMORY: memory, DB: legacyDb(rows) };
  const first = await migrateLegacyFacts(env, "jacob");
  assert.deepEqual(first, { scanned: 3, migrated: 2, deduplicated: 0, failed: 1, nextAfterId: null });
  assert.equal(memory.state.facts[0].predicate, "note");
  assert.equal(memory.state.facts[0].critical, true);
  const staffWrite = memory.state.calls.find((c) => c.path === "/facts");
  assert.equal(staffWrite.headers["x-memory-audience"], "internal");
  const second = await migrateLegacyFacts(env, "jacob");
  assert.equal(second.deduplicated, 2);
  assert.equal(second.migrated, 0);
  const paged = await migrateLegacyFacts(env, "jacob", { limit: 2 });
  assert.equal(paged.nextAfterId, 2);
});

test("migrateLegacyFacts refuses to run without bindings", async () => {
  await assert.rejects(() => migrateLegacyFacts({}, "jacob"), /needs DB and MEMORY/);
});

test("!remember / !facts use shared memory when MEMORY is bound", async () => {
  const memory = fakeMemory();
  const env = { MEMORY: memory, DB: legacyDb([{ id: 9, user_id: "u1", text: "old legacy" }]) };
  const replies = [];
  const cmd = (args) => ({ args, reply: async (t) => { replies.push(t); } });
  const handlers = buildMemoryCommandHandlers(env, "u1", { botName: "Jacob" });
  await handlers.remember(cmd("gate code is 1234"));
  await handlers.remember(cmd("gate code is 1234"));
  assert.deepEqual(replies.slice(0, 2), ["Remembered: gate code is 1234", "Already remembered: gate code is 1234"]);
  await handlers.facts(cmd(""));
  assert.match(replies[2], /1\. gate code is 1234\n2\. old legacy \(legacy, not yet migrated\)/);

  const migrated = buildMemoryCommandHandlers(env, "u1", { botName: "jacob", legacyFactsMigrated: true });
  await migrated.facts(cmd(""));
  assert.doesNotMatch(replies[3], /legacy/);
  await migrated.forget(cmd("gate code"));
  assert.match(replies[4], /1 shared memory note\(s\) also match but cannot be deleted/);
});

test("formatFactsReply handles empty and non-note predicates", () => {
  assert.equal(formatFactsReply([], []), "No facts remembered yet.");
  assert.match(formatFactsReply([{ predicate: "decision_maker", object: "Pat" }], []), /decision maker: Pat/);
});

test("persistEmailExchange strips quotes and HTML, caps bodies, tags channel email", async () => {
  const memory = fakeMemory();
  const env = { MEMORY: memory };
  const inbound = "Can we move to Thursday?\n\nOn Mon, Sep 14, 2026 Bob wrote:\n> earlier stuff";
  const reply = `<p>${"Thursday works. ".repeat(400)}</p><div>From: Wren</div>`;
  const entityId = await persistEmailExchange(env, "wren", {
    fromEmail: "Pat@Example.com", fromName: "Pat", subject: "Meeting", inboundText: inbound, replyText: reply, audience: "external",
  });
  assert.equal(entityId, "ent:pat@example.com");
  assert.equal(memory.state.turns.length, 2);
  const [userTurn, botTurn] = memory.state.turns;
  assert.equal(userTurn.content, "Subject: Meeting\n\nCan we move to Thursday?");
  assert.equal(userTurn.channel, "email");
  assert.equal(userTurn.session_id, "email:pat@example.com");
  assert.ok(botTurn.content.length <= 4000);
  assert.doesNotMatch(botTurn.content, /<p>|From: Wren/);
  assert.equal(memory.state.calls[0].headers["x-memory-audience"], "external");
});

test("persistEmailExchange writes only the inbound turn when there is no reply", async () => {
  const memory = fakeMemory();
  await persistEmailExchange({ MEMORY: memory }, "robert", { fromEmail: "a@b.com", inboundText: "hi" });
  assert.equal(memory.state.turns.length, 1);
  assert.equal(await persistEmailExchange({}, "robert", { fromEmail: "a@b.com", inboundText: "hi" }), null);
});

test("buildContactRecall ranks, suffixes via, and prepends the latest summary", async () => {
  const memory = fakeMemory();
  const now = Date.now();
  memory.state.context = {
    facts: [{ id: "f1", predicate: "favorite_color", object: "red", confidence: 1, created_at: now, bot_id: "courtney" }],
    recent_turns: [{ id: "t1", role: "user", content: "call me later", created_at: now }],
    latest_summary: { summary: "Discussed renewal." },
  };
  const { block } = await buildContactRecall({ MEMORY: memory }, "wren", { email: "x@y.com" }, "renewal");
  assert.match(block, /Last conversation summary: Discussed renewal\.\n\nKnown facts:\n- favorite color: red \(via courtney\)/);
  assert.match(block, /Recent across chat\/voice\/phone\/email \(oldest to newest\):\n- them: call me later/);
  const ctxCall = memory.state.calls.find((c) => c.path === "/context");
  assert.equal(ctxCall.body.max_facts, 40);
});

test("stripQuotedReply keeps a forward whose body starts with the marker", () => {
  assert.equal(stripQuotedReply("Sounds good\n-----Original Message-----\nold"), "Sounds good");
  assert.equal(stripQuotedReply("From: someone\nforwarded text"), "From: someone\nforwarded text");
});
