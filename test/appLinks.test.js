// Unit tests for src/lib/appLinks.js -- deep-link builders + url-button helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  linkButton,
  linkButtons,
  linkButtonId,
  xeroBankAccountUrl,
  xeroBillUrl,
  xeroInvoiceUrl,
  s1ThreatUrl,
  scCaseUrl,
  ninjaDeviceUrl,
  ninjaTicketUrl,
  crmRecordUrl,
  dattoDeviceUrl,
  boxFileUrl,
  cdwProductUrl,
} from "../src/lib/appLinks.js";

// ── linkButtonId ─────────────────────────────────────────────────────────────

test("linkButtonId slugifies and stays <= 64 chars", () => {
  assert.equal(linkButtonId("Open in Xero"), "link:open-in-xero");
  const longId = linkButtonId("x".repeat(200));
  assert.ok(longId.length <= 64, `id length ${longId.length}`);
  assert.ok(longId.startsWith("link:"));
});

test("linkButtonId falls back for empty/symbol-only labels", () => {
  assert.equal(linkButtonId(""), "link:open");
  assert.equal(linkButtonId("!!!"), "link:open");
});

// ── linkButton ───────────────────────────────────────────────────────────────

test("linkButton builds a url-button descriptor", () => {
  const b = linkButton("Open in Xero", "https://go.xero.com/x");
  assert.deepEqual(b, {
    button_id: "link:open-in-xero",
    label: "Open in Xero",
    style: "secondary",
    url: "https://go.xero.com/x",
  });
});

test("linkButton returns null for missing/invalid url", () => {
  assert.equal(linkButton("x", null), null);
  assert.equal(linkButton("x", ""), null);
  assert.equal(linkButton("x", "ftp://nope"), null);
  assert.equal(linkButton("x", "not a url"), null);
  assert.equal(linkButton("x", "https://" + "a".repeat(2050)), null);
});

test("linkButton truncates label to 80 chars and honors style override", () => {
  const b = linkButton("L".repeat(120), "https://x.test", { style: "primary" });
  assert.equal(b.label.length, 80);
  assert.equal(b.style, "primary");
});

// ── linkButtons ──────────────────────────────────────────────────────────────

test("linkButtons drops specs whose url is unbuildable", () => {
  const out = linkButtons([
    { label: "Good", url: "https://a.test" },
    { label: "Bad", url: null },
    null,
    { label: "AlsoGood", url: "https://b.test" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((b) => b.label), ["Good", "AlsoGood"]);
});

test("linkButtons returns [] for non-array", () => {
  assert.deepEqual(linkButtons(undefined), []);
  assert.deepEqual(linkButtons(null), []);
});

// ── Xero builders ────────────────────────────────────────────────────────────

test("xero builders produce expected urls and null on missing id", () => {
  assert.equal(
    xeroBankAccountUrl("abc-123"),
    "https://go.xero.com/Bank/BankTransactions.aspx?accountId=abc-123",
  );
  assert.equal(
    xeroBillUrl("INV-9"),
    "https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=INV-9",
  );
  assert.equal(
    xeroInvoiceUrl("INV-9"),
    "https://go.xero.com/app/invoicing/view/INV-9",
  );
  assert.equal(xeroBankAccountUrl(null), null);
  assert.equal(xeroBillUrl(""), null);
});

// ── Template-driven builders (robert) ────────────────────────────────────────

test("s1/sc builders interpolate {id} templates and null when tmpl absent", () => {
  const env = {
    S1_THREAT_URL_TMPL: "https://s1.test/incidents/threats/{id}/overview",
    SC_CASE_URL_TMPL: "https://sc.test/cases/{id}",
  };
  assert.equal(s1ThreatUrl(env, "t9"), "https://s1.test/incidents/threats/t9/overview");
  assert.equal(scCaseUrl(env, "c9"), "https://sc.test/cases/c9");
  assert.equal(s1ThreatUrl({}, "t9"), null);
  assert.equal(scCaseUrl(env, ""), null);
});

test("template builder appends id when {id} placeholder missing", () => {
  const env = { SC_CASE_URL_TMPL: "https://sc.test/cases" };
  assert.equal(scCaseUrl(env, "c9"), "https://sc.test/cases/c9");
});

// ── Ninja builders ───────────────────────────────────────────────────────────

test("ninja builders require NINJA_BASE_URL", () => {
  const env = { NINJA_BASE_URL: "https://us2.ninjarmm.com/" };
  assert.equal(ninjaDeviceUrl(env, 42), "https://us2.ninjarmm.com/#/deviceDashboard/42/overview");
  assert.equal(ninjaTicketUrl(env, 7), "https://us2.ninjarmm.com/#/ticketing/ticket/7");
  assert.equal(ninjaDeviceUrl({}, 42), null);
  assert.equal(ninjaDeviceUrl(env, ""), null);
});

// ── CRM builder ──────────────────────────────────────────────────────────────

test("crmRecordUrl builds hash deep-links (kind -> CRM page) and null otherwise", () => {
  const env = { CRM_APP_BASE: "https://sales.blackravenit.com" };
  // The SPA routes by hash, and a prospect lives on the "leads" page.
  assert.equal(crmRecordUrl(env, "opportunities", "op_1"), "https://sales.blackravenit.com/#opportunities/op_1");
  assert.equal(crmRecordUrl(env, "clients", "c_1"), "https://sales.blackravenit.com/#clients/c_1");
  assert.equal(crmRecordUrl(env, "prospects", "p_1"), "https://sales.blackravenit.com/#leads/p_1");
  assert.equal(crmRecordUrl(env, "partners", "pa_1"), "https://sales.blackravenit.com/#partners/pa_1");
  assert.equal(crmRecordUrl(env, "widgets", "w_1"), null);
  assert.equal(crmRecordUrl({}, "clients", "c_1"), null);
});

// ── Datto / Box / CDW ─────────────────────────────────────────────────────────

test("dattoDeviceUrl null without portal base", () => {
  assert.equal(dattoDeviceUrl({}, "SER123"), null);
  assert.equal(
    dattoDeviceUrl({ DATTO_PORTAL_BASE_URL: "https://portal.datto.test" }, "SER123"),
    "https://portal.datto.test/device/SER123",
  );
});

test("boxFileUrl accepts (fileId) or (env, fileId)", () => {
  assert.equal(boxFileUrl("f1"), "https://app.box.com/file/f1");
  assert.equal(boxFileUrl({ BOX_FILE_BASE: "https://app.box.com/file" }, "f2"), "https://app.box.com/file/f2");
  assert.equal(boxFileUrl(null), null);
});

test("cdwProductUrl passes through http(s) urls only", () => {
  assert.equal(cdwProductUrl("https://www.cdw.com/product/x/123"), "https://www.cdw.com/product/x/123");
  assert.equal(cdwProductUrl("/relative"), null);
  assert.equal(cdwProductUrl(null), null);
});
