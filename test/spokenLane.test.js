// Tests for the spoken fast lane (lib/spokenLane.js) and its wiring in the
// real turn pipeline: lane detection, model pick, token cap, addendum, recall
// time budget, timings, and that normal turns are unchanged.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isSpokenRequest, pickTurnModel, pickMaxTokens, raceRecallBudget, laneTimings,
  SPOKEN_ADDENDUM, SPOKEN_DEFAULT_MODEL, SPOKEN_MAX_TOKENS,
} from "../src/lib/spokenLane.js";
import { runLlmPipeline } from "../src/handlers/handleChatMessage.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("lane detection: voice true or reply_style spoken", () => {
  assert.equal(isSpokenRequest({ voice: true }), true);
  assert.equal(isSpokenRequest({ reply_style: "spoken" }), true);
  assert.equal(isSpokenRequest({ voice: "true" }), false);
  assert.equal(isSpokenRequest({ reply_style: "long" }), false);
  assert.equal(isSpokenRequest({}), false);
  assert.equal(isSpokenRequest(null), false);
});

test("pickTurnModel: spoken uses VOICE_MODEL, then the default constant", () => {
  assert.equal(pickTurnModel({ VOICE_MODEL: "v-model" }, { spoken: true, defaultModel: "big" }), "v-model");
  assert.equal(pickTurnModel({}, { spoken: true, defaultModel: "big" }), SPOKEN_DEFAULT_MODEL);
  assert.equal(SPOKEN_DEFAULT_MODEL, "claude-sonnet-5-5");
  assert.equal(pickTurnModel({ VOICE_MODEL: "v-model" }, { spoken: false, defaultModel: "big" }), "big");
});

test("pickMaxTokens: caps at 400, never raises a lower cap, leaves normal alone", () => {
  assert.equal(pickMaxTokens(true), SPOKEN_MAX_TOKENS);
  assert.equal(pickMaxTokens(true, 4096), SPOKEN_MAX_TOKENS);
  assert.equal(pickMaxTokens(true, 200), 200);
  assert.equal(pickMaxTokens(false), undefined);
  assert.equal(pickMaxTokens(false, 4096), 4096);
});

test("recall race: slow recall is skipped after 400ms with one log line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warns = [];
  t.mock.method(console, "warn", (m) => warns.push(String(m)));
  const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 5000));
  const raced = raceRecallBudget(slow, 400);
  t.mock.timers.tick(400);
  assert.equal(await raced, "");
  assert.deepEqual(warns, ["[turn] spoken lane: recall skipped after 400ms"]);
});

test("recall race: fast recall wins and logs nothing", async (t) => {
  const warns = [];
  t.mock.method(console, "warn", (m) => warns.push(String(m)));
  assert.equal(await raceRecallBudget(Promise.resolve("facts"), 400), "facts");
  assert.equal(warns.length, 0);
});

test("laneTimings labels the lane and model", () => {
  assert.deepEqual(laneTimings(true, "m"), { lane: "spoken", model_id: "m" });
  assert.deepEqual(laneTimings(false, "m"), { lane: "normal", model_id: "m" });
});

/**
 * Run the real pipeline against a fetch mock and return the model request body
 * and the timings FleetView would receive.
 */
async function runTurn(extra) {
  const state = { model: null, delivered: null };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("anthropic")) {
      state.model = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }), { status: 200 });
    }
    if (String(url).includes("fleetview.test")) {
      state.delivered = JSON.parse(init.body);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  };
  const db = { prepare: () => { const s = { bind: () => s, all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0 } }) }; return s; } };
  await runLlmPipeline({
    env: { DB: db, ANTHROPIC_API_KEY: "k", CLAUDE_MODEL: "claude-opus-4-7", FLEETVIEW_DELIVERY_SECRET: "s" },
    user_id: "u1", display_name: "Brian", channel_slug: "testbot-assistant",
    userText: "hello", labeledUserText: "Brian (uid:u1): hello", historyKey: "nexus:u1",
    source: "fleetview", reply_webhook: "https://fleetview.test/cb", thread_id: "t1",
    dispatched_at: Date.now() - 5,
    config: {
      botName: "testbot", persona: { systemPrompt: "You are a test bot." },
      tools: { definitions: [], handlers: {} },
      channelContext: { enabled: false }, hitlContext: { enabled: false },
    },
    ...extra,
  });
  return state;
}

const bodyText = (req) => JSON.stringify(req);

test("pipeline: spoken turn uses voice model, 400 tokens, addendum, lane timings", async () => {
  const { model, delivered } = await runTurn({ spoken: true });
  assert.equal(model.model, SPOKEN_DEFAULT_MODEL);
  assert.equal(model.max_tokens, 400);
  assert.ok(bodyText(model).includes("This reply will be spoken aloud."));
  assert.equal(delivered.timings.lane, "spoken");
  assert.equal(delivered.timings.model_id, SPOKEN_DEFAULT_MODEL);
  for (const k of ["queue_wait", "history", "recall_and_facts", "prompt_built", "model", "total"]) {
    assert.equal(typeof delivered.timings[k], "number", k);
  }
});

test("pipeline: normal FleetView turn is unchanged apart from lane labels", async () => {
  const { model, delivered } = await runTurn({});
  assert.equal(model.model, "claude-opus-4-7");
  assert.equal(model.max_tokens, 4096);
  assert.ok(!bodyText(model).includes("This reply will be spoken aloud."));
  assert.equal(delivered.timings.lane, "normal");
  assert.equal(delivered.timings.model_id, "claude-opus-4-7");
});

test("addendum text is the agreed wording", () => {
  assert.ok(SPOKEN_ADDENDUM.includes("two to four sentences"));
  assert.ok(SPOKEN_ADDENDUM.includes("on it"));
});
