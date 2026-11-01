import { test } from "node:test";
import assert from "node:assert/strict";
import { createBotsPageReadHandler, injectBotsPageRead, BOTS_PAGE_READ_TOOL_NAME } from "../src/lib/botsPageRead.js";
import { verifyNexusSignature } from "../src/lib/callbackSign.js";

const SECRET = "kate-inbound";

function stubFetch(reply, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status });
  };
  return calls;
}

test("signs a read with the bot's own inbound secret and posts to the bots page", async () => {
  const calls = stubFetch({ ok: true, report: { id: "r1", markdown: "# hi" } });
  const handler = createBotsPageReadHandler("kate", "KATE_CALLBACK_SECRET");
  const out = await handler({ view: "report", id: "r1" }, { KATE_CALLBACK_SECRET: SECRET });
  assert.equal(out.report.markdown, "# hi");
  assert.equal(calls[0].url, "https://bots.blackravenit.com/api/bot-reply/data");
  assert.deepEqual(JSON.parse(calls[0].init.body), { bot: "kate", view: "report", params: { id: "r1" } });
  assert.equal(await verifyNexusSignature(SECRET, calls[0].init.body, new Headers(calls[0].init.headers)), true);
});

test("refuses a bad view or a report with no id without calling out", async () => {
  const calls = stubFetch({ ok: true });
  const handler = createBotsPageReadHandler("kate", "KATE_CALLBACK_SECRET");
  assert.equal((await handler({ view: "everything" }, { KATE_CALLBACK_SECRET: SECRET })).ok, false);
  assert.match((await handler({ view: "report" }, { KATE_CALLBACK_SECRET: SECRET })).error, /id is required/);
  assert.equal(calls.length, 0);
});

test("returns the page's error instead of throwing", async () => {
  stubFetch({ error: "Unauthorized" }, 401);
  const out = await createBotsPageReadHandler("kate", "KATE_CALLBACK_SECRET")({ view: "cards" }, { KATE_CALLBACK_SECRET: SECRET });
  assert.deepEqual(out, { ok: false, error: "Unauthorized" });
});

test("is injected only when the bot is wired to the page and holds its secret", () => {
  const who = { botName: "kate", secretEnvVar: "KATE_CALLBACK_SECRET" };
  const wired = { FLEETVIEW_DELIVERY_SECRET: "d", KATE_CALLBACK_SECRET: SECRET };
  assert.deepEqual(injectBotsPageRead([], {}, wired, who).tools.map((t) => t.name), [BOTS_PAGE_READ_TOOL_NAME]);
  assert.equal(injectBotsPageRead([], {}, { KATE_CALLBACK_SECRET: SECRET }, who).injected, false);
  assert.equal(injectBotsPageRead([], {}, { FLEETVIEW_DELIVERY_SECRET: "d" }, who).injected, false);
  assert.equal(injectBotsPageRead([{ name: BOTS_PAGE_READ_TOOL_NAME }], {}, wired, who).injected, false);
});
