// test/deskFinding.test.js: the guard rails on the fleet's finding reporter.
//
// The helper itself is a thin POST. What is worth pinning is the two ways it
// could make things worse than the chat posts it replaces: a key that names an
// occurrence instead of a condition (one ticket per run), and a failure that
// reports success (a detector that thinks it filed and did not).

import { test } from "node:test";
import assert from "node:assert/strict";

import { reportFinding } from "../src/lib/deskFinding.js";

const ENV = { DESK_API_KEY: "k", DESK_API_URL: "https://desk.test" };

const FINDING = {
  key: "robert:nexus-self-probe:csp-missing",
  title: "Nexus SPA is serving no CSP header",
  detector: "robert:nexus-self-probe",
};

/** Swap global fetch for the duration of one call, capturing what was sent. */
async function withFetch(impl, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return impl(url, init);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    global.fetch = original;
  }
}

const ok = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("posts the finding with the key as external_id", async () => {
  const { result, calls } = await withFetch(ok({ ok: true, created: true, ticket: { number: 42 } }), () =>
    reportFinding(ENV, { ...FINDING, note: "probe run" }));
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.number, 42);
  assert.equal(calls[0].url, "https://desk.test/api/internal/finding");
  assert.equal(calls[0].body.external_id, FINDING.key);
  assert.equal(calls[0].body.queue, "bugs");
  assert.equal(calls[0].init.headers["X-API-Key"], "k");
});

// The mistake that would turn this into 80 tickets on a Monday morning.
test("refuses a key that names the occurrence instead of the condition", async () => {
  for (const key of [
    "robert:nexus-self-probe:2026-09-26",
    "maxwell:cron-watchdog:run-at-timestamp",
    "jacob:qa:epoch-1759000000",
  ]) {
    const { result, calls } = await withFetch(ok({ ok: true }), () => reportFinding(ENV, { ...FINDING, key }));
    assert.equal(result.ok, false, `key ${key} must be refused`);
    assert.equal(calls.length, 0, "nothing may be posted for a dated key");
  }
});

test("refuses a finding with no key at all", async () => {
  const { result, calls } = await withFetch(ok({ ok: true }), () => reportFinding(ENV, { ...FINDING, key: "" }));
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("a missing Desk key fails loudly instead of pretending to file", async () => {
  const { result, calls } = await withFetch(ok({ ok: true }), () => reportFinding({}, FINDING));
  assert.equal(result.ok, false);
  assert.equal(result.error, "no desk api key");
  assert.equal(calls.length, 0);
});

test("an HTTP error is not reported as filed", async () => {
  const impl = async () => new Response("boom", { status: 500 });
  const { result } = await withFetch(impl, () => reportFinding(ENV, FINDING));
  assert.equal(result.ok, false);
  assert.equal(result.error, "http_500");
});

// CF Access answers 200 with an HTML interstitial. Treating that as success is
// how a write silently no-ops while the caller logs a win.
test("a 200 carrying HTML is treated as a failure", async () => {
  const impl = async () => new Response("<html>Access</html>", { status: 200, headers: { "content-type": "text/html" } });
  const { result } = await withFetch(impl, () => reportFinding(ENV, FINDING));
  assert.equal(result.ok, false);
  assert.equal(result.error, "non_json_response");
});

test("a thrown fetch never escapes into the detector's own run", async () => {
  const impl = async () => { throw new Error("network down"); };
  const { result } = await withFetch(impl, () => reportFinding(ENV, FINDING));
  assert.equal(result.ok, false);
  assert.equal(result.error, "network down");
});

test("cleared sends resolved so the ticket closes itself", async () => {
  const { calls } = await withFetch(ok({ ok: true, resolved: true }), () =>
    reportFinding(ENV, { ...FINDING, cleared: true }));
  assert.equal(calls[0].body.resolved, true);
});

test("an unknown queue falls back to bugs rather than failing the write", async () => {
  const { calls } = await withFetch(ok({ ok: true }), () =>
    reportFinding(ENV, { ...FINDING, queue: "client" }));
  assert.equal(calls[0].body.queue, "bugs");
});

test("dashes are scrubbed out of the title before it reaches the board", async () => {
  const { calls } = await withFetch(ok({ ok: true }), () =>
    reportFinding(ENV, { ...FINDING, title: "CSP missing — the SPA serves no header" }));
  assert.ok(!calls[0].body.title.includes("—"), "an em dash must never reach a ticket title");
});
