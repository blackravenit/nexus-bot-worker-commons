import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveContextBudget, estimateTokens, keepNewestWithinBudget, fitNewestLines, applyHistoryBudget,
} from "../src/lib/contextBudget.js";

test("resolveContextBudget is opt-in and ignores bad numbers", () => {
  const off = resolveContextBudget({});
  assert.equal(off.enabled, false);
  assert.deepEqual([off.history, off.channel, off.hitl, off.recall], [6000, 2500, 1200, 2000]);
  const on = resolveContextBudget({ contextBudget: { enabled: true, history: 100, channel: -5, recall: "x" } });
  assert.equal(on.enabled, true);
  assert.equal(on.history, 100);
  assert.equal(on.channel, 2500);
  assert.equal(on.recall, 2000);
  assert.equal(resolveContextBudget({ contextBudget: { enabled: "true" } }).enabled, false);
});

test("estimateTokens is chars/4 with a flat charge per media block", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens([{ type: "text", text: "abcd" }, { type: "image" }]), 1 + 1500);
});

test("keepNewestWithinBudget keeps the newest contiguous rows", () => {
  const rows = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].map((content, id) => ({ id, content }));
  const { kept, dropped } = keepNewestWithinBudget(rows, 20);
  assert.deepEqual(kept.map((r) => r.id), [1, 2]);
  assert.deepEqual(dropped.map((r) => r.id), [0]);
});

test("the newest row survives even when it alone busts the budget", () => {
  const { kept, dropped } = keepNewestWithinBudget([{ content: "x".repeat(10) }, { content: "y".repeat(400) }], 5);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
});

test("fitNewestLines trims from the oldest end; budget 0 is a no-op", () => {
  const lines = ["old".repeat(20), "mid".repeat(20), "new".repeat(20)];
  assert.deepEqual(fitNewestLines(lines, 20), [lines[2]]);
  assert.equal(fitNewestLines(lines, 0), lines);
});

test("applyHistoryBudget strips meta from model rows", () => {
  const rows = [{ id: 1, role: "user", content: "hi", created_at: 1 }, { id: 2, role: "assistant", content: "yo", created_at: 2 }];
  const { history, dropped } = applyHistoryBudget(rows, 100);
  assert.deepEqual(history, [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]);
  assert.equal(dropped.length, 0);
});
