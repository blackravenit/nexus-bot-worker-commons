// Tests for the AI egress pin. These exist for the ROLLOUT, not the happy
// path: the pin is being adopted one repo at a time across 27 of them, so the
// two properties that matter are "does nothing without a binding" and "never
// fails a call it could have made". A regression in either turns a latency fix
// into a fleet outage.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AiEgressBase, egressFetch } from "../src/lib/aiEgress.js";

// Swap global fetch for the duration of one call and record what it saw.
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

// A namespace stub that records the names and options it is asked for.
function fakeNamespace(stubFetch, { getThrows = false } = {}) {
  const seen = { names: [], options: [], stubUrls: [] };
  return {
    seen,
    ns: {
      idFromName(name) {
        seen.names.push(name);
        return `id:${name}`;
      },
      get(_id, options) {
        seen.options.push(options);
        if (getThrows) throw new Error("namespace unavailable");
        return {
          fetch: async (url, init) => {
            seen.stubUrls.push(url);
            return stubFetch(url, init);
          },
        };
      },
    },
  };
}

test("egressFetch is a plain fetch when no AI_EGRESS binding is present", async () => {
  const { calls } = await withFetch(
    async () => new Response("ok"),
    () => egressFetch({}, "https://api.anthropic.com/v1/messages", { method: "POST" }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.anthropic.com/v1/messages");
  assert.deepEqual(calls[0][1], { method: "POST" });
});

test("egressFetch treats a missing env the same way rather than throwing", async () => {
  const { result } = await withFetch(
    async () => new Response("ok"),
    () => egressFetch(null, "https://api.anthropic.com/v1/messages"),
  );
  assert.equal(result.status, 200);
});

test("egressFetch routes through the object with an enam location hint", async () => {
  const { seen, ns } = fakeNamespace(async () => new Response("via object"));
  const env = { AI_GATEWAY_BOT: "robert", AI_EGRESS: ns };

  const { result, calls } = await withFetch(
    async () => new Response("direct"),
    () => egressFetch(env, "https://api.anthropic.com/v1/messages", { method: "POST" }),
  );

  assert.equal(await result.text(), "via object");
  assert.equal(calls.length, 0, "must not touch global fetch when the object answers");
  assert.deepEqual(seen.options[0], { locationHint: "enam" });
  // The stub is addressed with the REAL target URL, which is what lets the
  // object forward using request.url with no out-of-band addressing.
  assert.equal(seen.stubUrls[0], "https://api.anthropic.com/v1/messages");
});

test("egressFetch keeps each bot on its own object", async () => {
  const names = [];
  const mk = (bot) => {
    const { seen, ns } = fakeNamespace(async () => new Response("ok"));
    return { env: { AI_GATEWAY_BOT: bot, AI_EGRESS: ns }, seen };
  };
  for (const bot of ["robert", "moxie"]) {
    const { env, seen } = mk(bot);
    await egressFetch(env, "https://x.test/");
    names.push(...seen.names);
  }
  assert.ok(names.every((n) => n.includes("-enam-")), `got ${names.join(",")}`);
  assert.ok(names.some((n) => n.startsWith("robert-")));
  assert.ok(names.some((n) => n.startsWith("moxie-")));
});

test("egressFetch honours AI_EGRESS_SHARDS and stays inside the range", async () => {
  const seenAll = new Set();
  for (let i = 0; i < 80; i++) {
    const { seen, ns } = fakeNamespace(async () => new Response("ok"));
    await egressFetch({ AI_GATEWAY_BOT: "robert", AI_EGRESS_SHARDS: "2", AI_EGRESS: ns }, "https://x.test/");
    for (const n of seen.names) seenAll.add(n);
  }
  assert.deepEqual([...seenAll].sort(), ["robert-enam-0", "robert-enam-1"]);
});

test("egressFetch falls back to a direct fetch when the namespace throws", async () => {
  const { ns } = fakeNamespace(async () => new Response("via object"), { getThrows: true });

  const { result, calls } = await withFetch(
    async () => new Response("direct"),
    () => egressFetch({ AI_EGRESS: ns }, "https://api.anthropic.com/v1/messages"),
  );

  // Never worse than not having the pin: a direct fetch may land in HKG and
  // 403, which is precisely today's behaviour.
  assert.equal(await result.text(), "direct");
  assert.equal(calls.length, 1);
});

test("egressFetch falls back when the stub itself rejects", async () => {
  const { ns } = fakeNamespace(async () => {
    throw new Error("object boot failed");
  });

  const { result } = await withFetch(
    async () => new Response("direct"),
    () => egressFetch({ AI_EGRESS: ns }, "https://api.anthropic.com/v1/messages"),
  );

  assert.equal(await result.text(), "direct");
});

test("AiEgressBase forwards method, headers and body to the request's own URL", async () => {
  const obj = new AiEgressBase({}, {});
  const req = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "k", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5" }),
  });

  const { result, calls } = await withFetch(
    async () => new Response("upstream", { status: 200 }),
    () => obj.fetch(req),
  );

  assert.equal(result.status, 200);
  const [url, init] = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.get("x-api-key"), "k");
  assert.match(new TextDecoder().decode(init.body), /claude-sonnet-5/);
});

test("AiEgressBase sends no body on a GET", async () => {
  const obj = new AiEgressBase({}, {});
  const { calls } = await withFetch(
    async () => new Response("ok"),
    () => obj.fetch(new Request("https://api.anthropic.com/v1/models", { method: "GET" })),
  );
  assert.equal(calls[0][1].body, null);
});

test("AiEgressBase returns 502 instead of throwing across the stub boundary", async () => {
  const obj = new AiEgressBase({}, {});
  const { result } = await withFetch(
    async () => {
      throw new Error("connection reset");
    },
    () => obj.fetch(new Request("https://api.anthropic.com/v1/messages", { method: "POST" })),
  );

  // An error thrown inside an object reaches the caller flattened to "internal
  // error", which would hide the cause from the retry classifier.
  assert.equal(result.status, 502);
  assert.equal((await result.json()).error.type, "egress_failed");
});
