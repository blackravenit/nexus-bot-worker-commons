// Tests for the fleet usage reporter's binding-first / URL-fallback routing.
//
// Cron (scheduled) invocations cannot fetch a same-account *.workers.dev
// worker by public hostname (CF error 1042); the old bare `fetch(...).catch(
// () => {})` swallowed that failure silently, so every cron's spend vanished.
// These tests pin: binding preferred when present, URL fallback when absent,
// and a failure is logged (never thrown) either way.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reportUsage } from "../src/lib/usageReport.js";

const USAGE = { input_tokens: 100, output_tokens: 50 };

function mockFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl ? impl(url, init) : new Response(null, { status: 202 });
  };
  return { fn, calls };
}

test("reportUsage calls the MAXWELL_USAGE service binding when present, never the public URL", async () => {
  const binding = mockFetch();
  const publicFetch = mockFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = publicFetch.fn;
  try {
    const env = {
      MAXWELL_USAGE: { fetch: binding.fn },
      USAGE_REPORT_URL: "https://maxwell-worker.blackravenit.workers.dev/api/internal/usage-report",
      NEXUS_INTERNAL_TOKEN: "tok",
      AI_GATEWAY_BOT: "robert",
    };
    await reportUsage(env, { usage: USAGE, model: "claude-sonnet-5", surface: "cron" });

    assert.equal(binding.calls.length, 1);
    assert.equal(publicFetch.calls.length, 0);
    assert.equal(binding.calls[0].url, "https://maxwell.internal/api/internal/usage-report");
    assert.equal(binding.calls[0].init.headers["x-internal-token"], "tok");
    const body = JSON.parse(binding.calls[0].init.body);
    assert.equal(body.bot, "robert");
    assert.equal(body.input_tokens, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reportUsage falls back to the existing MAXWELL binding when MAXWELL_USAGE is absent", async () => {
  const binding = mockFetch();
  const env = {
    MAXWELL: { fetch: binding.fn },
    USAGE_REPORT_URL: "https://maxwell-worker.blackravenit.workers.dev/api/internal/usage-report",
    NEXUS_INTERNAL_TOKEN: "tok",
    AI_GATEWAY_BOT: "jacob",
  };
  await reportUsage(env, { usage: USAGE, model: "claude-sonnet-5", surface: "cron" });

  assert.equal(binding.calls.length, 1);
  assert.equal(binding.calls[0].url, "https://maxwell.internal/api/internal/usage-report");
});

test("reportUsage falls back to the public URL when no service binding is configured", async () => {
  const publicFetch = mockFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = publicFetch.fn;
  try {
    const env = {
      USAGE_REPORT_URL: "https://maxwell-worker.blackravenit.workers.dev/api/internal/usage-report",
      NEXUS_INTERNAL_TOKEN: "tok",
      AI_GATEWAY_BOT: "courtney",
    };
    await reportUsage(env, { usage: USAGE, model: "claude-sonnet-5", surface: "chat" });

    assert.equal(publicFetch.calls.length, 1);
    assert.equal(
      publicFetch.calls[0].url,
      "https://maxwell-worker.blackravenit.workers.dev/api/internal/usage-report",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reportUsage no-ops when neither a binding nor USAGE_REPORT_URL is configured", async () => {
  const publicFetch = mockFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = publicFetch.fn;
  try {
    const out = reportUsage({ NEXUS_INTERNAL_TOKEN: "tok" }, { usage: USAGE, model: "claude-sonnet-5" });
    assert.equal(out, undefined);
    assert.equal(publicFetch.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reportUsage no-ops when usage or model is missing", async () => {
  const binding = mockFetch();
  const env = { MAXWELL_USAGE: { fetch: binding.fn }, NEXUS_INTERNAL_TOKEN: "tok" };
  reportUsage(env, { usage: null, model: "claude-sonnet-5" });
  reportUsage(env, { usage: USAGE, model: null });
  assert.equal(binding.calls.length, 0);
});

test("reportUsage on binding failure logs a tagged warning and never throws", async () => {
  const binding = mockFetch(async () => {
    throw new Error("network boom");
  });
  const env = { MAXWELL_USAGE: { fetch: binding.fn }, NEXUS_INTERNAL_TOKEN: "tok" };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await assert.doesNotReject(
      reportUsage(env, { usage: USAGE, model: "claude-sonnet-5", surface: "cron" }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[usageReport\]/);
    assert.match(warnings[0], /network boom/);
  } finally {
    console.warn = originalWarn;
  }
});

test("reportUsage on a non-2xx response logs a tagged warning and never throws", async () => {
  const binding = mockFetch(async () => new Response("nope", { status: 500 }));
  const env = { MAXWELL_USAGE: { fetch: binding.fn }, NEXUS_INTERNAL_TOKEN: "tok" };

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await reportUsage(env, { usage: USAGE, model: "claude-sonnet-5", surface: "cron" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[usageReport\]/);
    assert.match(warnings[0], /500/);
  } finally {
    console.warn = originalWarn;
  }
});
