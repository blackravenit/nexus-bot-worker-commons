// Tests for lib/fleetviewReport.js: signed POST, validation, injection rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fleetviewReportTool,
  createFleetviewReportHandler,
  injectFleetviewReport,
  normalizeReportInput,
  REPORT_TITLE_MAX,
  REPORT_MARKDOWN_MAX,
} from "../src/lib/fleetviewReport.js";
import { verifyNexusSignature } from "../src/lib/callbackSign.js";

const SECRET = "report-secret";

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return calls;
}

test("handler posts a signed body naming the bot", async () => {
  const calls = stubFetch(new Response(JSON.stringify({ ok: true, id: "abc" }), { status: 200 }));
  const handler = createFleetviewReportHandler("kate");
  const out = await handler({ title: "AR", request: "show ar", markdown: "# hi" }, { FLEETVIEW_DELIVERY_SECRET: SECRET });
  assert.deepEqual(out, { ok: true, id: "abc", title: "AR", where: "FleetView Custom Reports" });
  assert.equal(calls[0].url, "https://fleet.blackravenit.com/api/bot-reply/report");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.bot, "kate");
  assert.equal(body.markdown, "# hi");
  assert.equal(typeof body.created_at, "number");
  assert.equal(await verifyNexusSignature(SECRET, calls[0].init.body, new Headers(calls[0].init.headers)), true);
});

test("FLEETVIEW_BASE_URL overrides the default", async () => {
  const calls = stubFetch(new Response(JSON.stringify({ ok: true, id: "x" }), { status: 200 }));
  await createFleetviewReportHandler("kate")(
    { title: "t", request: "r", markdown: "m" },
    { FLEETVIEW_DELIVERY_SECRET: SECRET, FLEETVIEW_BASE_URL: "https://fv.example.com/" },
  );
  assert.equal(calls[0].url, "https://fv.example.com/api/bot-reply/report");
});

test("title and markdown are clamped, empty ones rejected", async () => {
  const n = normalizeReportInput({ title: "t".repeat(500), request: "r", markdown: "m".repeat(70000) });
  assert.equal(n.title.length, REPORT_TITLE_MAX);
  assert.equal(n.markdown.length, REPORT_MARKDOWN_MAX);
  assert.equal(normalizeReportInput({ title: "", markdown: "x" }).ok, false);
  const out = await createFleetviewReportHandler("kate")({ title: "t", markdown: "" }, { FLEETVIEW_DELIVERY_SECRET: SECRET });
  assert.equal(out.ok, false);
});

test("a failed post returns ok:false instead of throwing", async () => {
  stubFetch(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
  const out = await createFleetviewReportHandler("kate")({ title: "t", request: "r", markdown: "m" }, { FLEETVIEW_DELIVERY_SECRET: SECRET });
  assert.equal(out.ok, false);
  assert.equal(out.error, "Unauthorized");
});

test("injected only when the secret is bound", () => {
  const off = injectFleetviewReport([], {}, {}, "kate");
  assert.equal(off.injected, false);
  assert.equal(off.tools.length, 0);
  const on = injectFleetviewReport([{ name: "a" }], { a: () => 1 }, { FLEETVIEW_DELIVERY_SECRET: SECRET }, "kate");
  assert.equal(on.injected, true);
  assert.equal(on.tools.at(-1).name, fleetviewReportTool.name);
  assert.equal(typeof on.handlers.fleetview_report, "function");
});

test("a bot's own fleetview_report wins, no duplicate", () => {
  const own = () => "own";
  const out = injectFleetviewReport([{ name: "fleetview_report" }], { fleetview_report: own }, { FLEETVIEW_DELIVERY_SECRET: SECRET }, "maxwell");
  assert.equal(out.injected, false);
  assert.equal(out.tools.length, 1);
  assert.equal(out.handlers.fleetview_report, own);
});
