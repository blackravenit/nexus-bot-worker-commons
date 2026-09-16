import { test } from "node:test";
import assert from "node:assert/strict";

import { recordLesson, searchLessons, renderLessonsBlock } from "../src/lib/memoryLessons.js";

/** Fake memory-worker recording every call; `status` forces a failure code. */
function fakeMemory({ status = 200, lessons = [], throws = false } = {}) {
  const calls = [];
  const fetch = async (req) => {
    if (throws) throw new Error("binding down");
    const body = await req.json();
    calls.push({ path: new URL(req.url).pathname, body, headers: Object.fromEntries(req.headers) });
    if (status !== 200) return new Response("boom", { status });
    if (new URL(req.url).pathname === "/lessons") {
      return Response.json({ id: "l1", created_at: 1, embedded: true, audience: "internal" }, { status: 201 });
    }
    return Response.json({ lessons, fallback: false });
  };
  return { env: { MEMORY: { fetch } }, calls };
}

/** Silence tagged console.error during an expected-failure test. */
async function quietly(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    return { value: await fn(), logged };
  } finally {
    console.error = original;
  }
}

test("recordLesson posts staff scope and truncates fields to 2000", async () => {
  const { env, calls } = fakeMemory();
  const out = await recordLesson(env, "jacob", {
    surface: "jacob.cold_draft", situation: "s", good: "g".repeat(3000), bad: "b", source: "hitl_edit:1",
  });
  assert.equal(out.id, "l1");
  assert.equal(calls[0].path, "/lessons");
  assert.equal(calls[0].headers["x-memory-scope"], "all");
  assert.equal(calls[0].headers["x-memory-bot"], "jacob");
  assert.equal(calls[0].body.good.length, 2000);
  assert.equal(calls[0].body.reason, undefined);
});

test("recordLesson no-ops without binding and rejects a bad surface", async () => {
  assert.equal(await recordLesson({}, "jacob", { surface: "x", situation: "s", good: "g" }), null);
  const { env, calls } = fakeMemory();
  const { value, logged } = await quietly(() => recordLesson(env, "jacob", { surface: "Bad Surface", situation: "s" }));
  assert.equal(value, null);
  assert.equal(calls.length, 0);
  assert.match(logged[0], /\[memoryLessons\]/);
});

test("recordLesson never throws on worker errors", async () => {
  const failing = fakeMemory({ status: 500 });
  const a = await quietly(() => recordLesson(failing.env, "jacob", { surface: "jacob.x", situation: "s", good: "g" }));
  assert.equal(a.value, null);
  assert.equal(a.logged.length, 1);
  const down = fakeMemory({ throws: true });
  const b = await quietly(() => recordLesson(down.env, "jacob", { surface: "jacob.x", situation: "s", good: "g" }));
  assert.equal(b.value, null);
});

test("searchLessons clamps k and returns lessons", async () => {
  const { env, calls } = fakeMemory({ lessons: [{ id: "l1", situation: "s", good: "g" }] });
  const out = await searchLessons(env, "jacob", { surface: "jacob.cold_draft", query: "cfo saas", k: 9 });
  assert.equal(out.length, 1);
  assert.equal(calls[0].path, "/lessons/search");
  assert.equal(calls[0].body.k, 5);
  assert.equal(calls[0].headers["x-memory-scope"], "all");
  assert.deepEqual(await searchLessons({}, "jacob", { surface: "jacob.cold_draft" }), []);
  const failing = fakeMemory({ status: 403 });
  const r = await quietly(() => searchLessons(failing.env, "jacob", { surface: "jacob.cold_draft" }));
  assert.deepEqual(r.value, []);
});

test("renderLessonsBlock renders edits, rejections, reasons, and excerpts", () => {
  assert.equal(renderLessonsBlock([]), "");
  assert.equal(renderLessonsBlock(null), "");
  const block = renderLessonsBlock([
    { situation: "step 1 cfo", bad: "x".repeat(900), good: "short", reason: "too long" },
    { situation: "step 2", bad: "pushy close", good: "" },
  ]);
  assert.match(block, /^LESSONS FROM PAST HUMAN EDITS \(apply these, do not mention them\):/);
  assert.match(block, /Reason: too long/);
  assert.match(block, /Rejected: "pushy close"/);
  assert.ok(!block.includes("x".repeat(401)));
});
