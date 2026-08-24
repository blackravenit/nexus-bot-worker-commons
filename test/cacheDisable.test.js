// ANTHROPIC_CACHE_TTL="off" is the opt-out for a worker whose calls are
// one-shot (a cron stage, a nightly summary, a single FleetView question).
// Those read the cache back zero times, so every write is a 1.25x surcharge on
// tokens nothing reuses. Measured 2026-08-24: dexter-worker wrote 31.9k cache
// tokens across a week and read 0.
//
// The failure mode these guard against is a HALF-disabled cache: dropping the
// anchor while the tail breakpoint still writes leaves the surcharge fully in
// place on a worker that believes it opted out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMessageCache, buildSystemBlocks } from "../src/lib/anthropic.js";

const OFF = { ANTHROPIC_CACHE_TTL: "off" };

const CONVO = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

/** Every cache_control found anywhere in a message array. */
function controlsIn(messages) {
  return messages.flatMap((m) =>
    (Array.isArray(m.content) ? m.content : []).map((b) => b.cache_control).filter(Boolean)
  );
}

test("off leaves no cache breakpoint on the messages, tail included", () => {
  assert.deepEqual(controlsIn(applyMessageCache(CONVO, OFF)), []);
});

test("off leaves no cache_control on a string system prompt", () => {
  const blocks = buildSystemBlocks("you are a bot", OFF);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].cache_control, undefined);
  assert.equal(blocks[0].text, "you are a bot");
});

test("off leaves no cache_control on a segmented system prompt, text unchanged", () => {
  const blocks = buildSystemBlocks(
    [{ text: "stable persona", cache: true }, { text: "volatile bit" }],
    OFF,
  );
  assert.deepEqual(blocks.map((b) => b.text), ["stable persona", "volatile bit"]);
  assert.ok(blocks.every((b) => b.cache_control === undefined));
});

test("the spelling variants all disable, and an unrelated value does not", () => {
  for (const value of ["off", "none", "no", "false", "0", "disabled", "OFF", "Off"]) {
    assert.deepEqual(
      controlsIn(applyMessageCache(CONVO, { ANTHROPIC_CACHE_TTL: value })),
      [],
      `expected ${value} to disable caching`,
    );
  }
  assert.equal(controlsIn(applyMessageCache(CONVO, { ANTHROPIC_CACHE_TTL: "1h" })).length > 0, true);
});

test("no env at all still caches, so the fleet default is untouched", () => {
  assert.ok(controlsIn(applyMessageCache(CONVO)).length > 0);
  assert.ok(buildSystemBlocks("you are a bot")[0].cache_control);
});
