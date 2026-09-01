// =============================================================================
// lib/appLinks.js -- deep-link builders + url-button helpers for bot posts.
//
// Why this exists (2026-06-04): Maxwell posted the daily reconciliation alert
// and, when asked for a link to the unreconciled transactions, replied that it
// had no tool to deep-link into Xero. Brian's directive: every bot post that
// references a specific external record should carry an "Open in <app>"
// url-button to that record in its source app.
//
// Nexus supports url-buttons natively (migration 103_button_url): a button
// descriptor with a `url` field (instead of `callback_url`) opens that URL in a
// new tab and fires no callback. attachButtons() forwards the field untouched.
//
// The builders below take whatever identifier is available at the post site and
// return a ready-to-open URL, or null when the identifier / config var needed to
// build it is missing. linkButton()/linkButtons() turn those into button
// descriptors and drop the nulls, so a missing config var degrades to "no
// button" rather than a broken link. attachLinkButtons() is the one-liner for
// the cron-alert path (post body, then attach links to the returned message id).
// =============================================================================

import { attachButtons } from "./nexus.js";

// Nexus constraints (nexus-app bot-components validateButton):
//   button_id <= 64 chars, label <= 80 chars, url http/https <= 2048 chars.
const MAX_BUTTON_ID = 64;
const MAX_LABEL = 80;
const MAX_URL = 2048;

// ─── Generic url-button helpers ──────────────────────────────────────────────

/**
 * Build a stable, length-safe button_id for a link button from its label.
 * url-buttons never dispatch, so the id only needs to be unique-per-message and
 * within the 64-char cap. Distinct labels on one card yield distinct ids.
 *
 * @param {string} label
 * @returns {string} e.g. "link:open-in-xero"
 */
export function linkButtonId(label) {
  const slug = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BUTTON_ID - "link:".length) || "open";
  return `link:${slug}`;
}

/**
 * Turn a (label, url) pair into a Nexus url-button descriptor.
 *
 * @param {string} label - button text (truncated to 80 chars)
 * @param {string|null|undefined} url - destination; null/empty => no button
 * @param {object} [opts]
 * @param {string} [opts.style="secondary"] - Nexus button style
 * @param {string} [opts.buttonId] - override the derived button_id
 * @returns {{button_id:string,label:string,style:string,url:string}|null}
 */
export function linkButton(label, url, opts = {}) {
  if (!url || typeof url !== "string") return null;
  if (url.length > MAX_URL) return null;
  try {
    const proto = new URL(url).protocol;
    if (proto !== "https:" && proto !== "http:") return null;
  } catch {
    return null;
  }
  const text = String(label || "Open").slice(0, MAX_LABEL);
  return {
    button_id: (opts.buttonId || linkButtonId(text)).slice(0, MAX_BUTTON_ID),
    label: text,
    style: opts.style || "secondary",
    url,
  };
}

/**
 * Map an array of {label, url, style?} specs into url-button descriptors,
 * dropping any whose url could not be built. Safe to pass straight to
 * attachButtons or to concat onto a card's existing buttons.
 *
 * @param {Array<{label:string,url:string|null,style?:string,buttonId?:string}>} specs
 * @returns {Array<object>}
 */
export function linkButtons(specs) {
  if (!Array.isArray(specs)) return [];
  return specs
    .map((s) => (s ? linkButton(s.label, s.url, s) : null))
    .filter(Boolean);
}

/**
 * Cron/alert convenience: attach url-buttons to a message after it's posted.
 * Build the body, postToNexus, then call this with the returned message id.
 * No-ops cleanly when no spec resolves to a usable link.
 *
 * @param {object} env
 * @param {string} messageId - id returned by postToNexus
 * @param {Array<{label:string,url:string|null,style?:string}>} specs
 * @param {object} [options] - forwarded to attachButtons (nexusKeyEnvVar, ...)
 * @returns {Promise<Array|null>}
 */
export async function attachLinkButtons(env, messageId, specs, options = {}) {
  const buttons = linkButtons(specs);
  if (!messageId || buttons.length === 0) return null;
  return attachButtons(env, messageId, buttons, options);
}

// ─── Per-app URL builders (return string | null) ─────────────────────────────

function interpolateTmpl(tmpl, id) {
  if (!tmpl || !id) return null;
  return tmpl.includes("{id}")
    ? tmpl.replace(/\{id\}/g, encodeURIComponent(id))
    : `${tmpl.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
}

function joinBase(base, path) {
  if (!base) return null;
  return `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

// ── Xero ──────────────────────────────────────────────────────────────────

/**
 * Xero bank account transactions page (the reconcile/transactions list for that
 * account). BankAccount.aspx?accountID=... 404s; the working deep link is
 * BankTransactions.aspx?accountId=... (Brian, 2026-06-04).
 * @param {string} accountId - Xero AccountID GUID (present on bank transactions)
 * @returns {string|null}
 */
export function xeroBankAccountUrl(accountId) {
  if (!accountId) return null;
  return `https://go.xero.com/Bank/BankTransactions.aspx?accountId=${encodeURIComponent(accountId)}`;
}

/**
 * Xero accounts-payable bill editor. Mirrors maxwell ap-format.js xeroBillUrl.
 * @param {string} invoiceId - Xero InvoiceID GUID for an ACCPAY bill
 * @returns {string|null}
 */
export function xeroBillUrl(invoiceId) {
  if (!invoiceId) return null;
  return `https://go.xero.com/AccountsPayable/Edit.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`;
}

/**
 * Xero accounts-receivable invoice deep link (new invoicing).
 * The legacy /AccountsReceivable/Edit.aspx?InvoiceID= path is classic-invoicing
 * only; for invoices created in new invoicing it lands on the create-new screen,
 * so we use the /app/invoicing/view/{guid} route which resolves drafts too.
 * @param {string} invoiceId - Xero InvoiceID GUID for an ACCREC invoice
 * @returns {string|null}
 */
export function xeroInvoiceUrl(invoiceId) {
  if (!invoiceId) return null;
  return `https://go.xero.com/app/invoicing/view/${encodeURIComponent(invoiceId)}`;
}

// ── SentinelOne / Stellar Cyber (templates live in robert wrangler.toml) ────

/**
 * SentinelOne threat overview, from env.S1_THREAT_URL_TMPL ("...{id}...").
 * @param {object} env
 * @param {string} id - S1 threat id
 * @returns {string|null}
 */
export function s1ThreatUrl(env, id) {
  return interpolateTmpl(env?.S1_THREAT_URL_TMPL, id);
}

/**
 * Stellar Cyber case page, from env.SC_CASE_URL_TMPL ("...{id}").
 * @param {object} env
 * @param {string} id - Stellar Cyber case _id
 * @returns {string|null}
 */
export function scCaseUrl(env, id) {
  return interpolateTmpl(env?.SC_CASE_URL_TMPL, id);
}

// ── NinjaOne (env.NINJA_BASE_URL) ───────────────────────────────────────────

/**
 * NinjaOne device dashboard.
 * @param {object} env
 * @param {string|number} deviceId
 * @returns {string|null}
 */
export function ninjaDeviceUrl(env, deviceId) {
  if (!env?.NINJA_BASE_URL || deviceId == null || deviceId === "") return null;
  return `${String(env.NINJA_BASE_URL).replace(/\/+$/, "")}/#/deviceDashboard/${encodeURIComponent(deviceId)}/overview`;
}

/**
 * NinjaOne ticket detail.
 * @param {object} env
 * @param {string|number} ticketId
 * @returns {string|null}
 */
export function ninjaTicketUrl(env, ticketId) {
  if (!env?.NINJA_BASE_URL || ticketId == null || ticketId === "") return null;
  return `${String(env.NINJA_BASE_URL).replace(/\/+$/, "")}/#/ticketing/ticket/${encodeURIComponent(ticketId)}`;
}

// ── CRM (env.CRM_APP_BASE = https://sales.blackravenit.com) ──────────────────

// The CRM SPA routes by URL HASH ("#<page>/<id>"), not path, and its page names
// differ from the bot-facing record "kind" (a prospect lives on the "leads"
// page). A path-style link (/prospects/<id>) loads the SPA with an empty hash
// and falls straight through to the dashboard -- which is exactly the "Open in
// CRM goes to the dashboard" bug Brian hit. Map kind -> page and emit a hash
// deep-link that the SPA opens directly on the record.
const CRM_PAGE_BY_KIND = {
  prospects: "leads",
  leads: "leads",
  clients: "clients",
  opportunities: "opportunities",
  partners: "partners",
};

/**
 * Black Raven CRM record deep-link (hash route the SPA opens directly).
 * @param {object} env
 * @param {string} kind - "prospects" | "clients" | "opportunities" | "partners"
 * @param {string|number} id
 * @returns {string|null} e.g. https://sales.blackravenit.com/#leads/<id>
 */
export function crmRecordUrl(env, kind, id) {
  if (!env?.CRM_APP_BASE || !kind || id == null || id === "") return null;
  const page = CRM_PAGE_BY_KIND[kind];
  if (!page) return null;
  const base = String(env.CRM_APP_BASE).replace(/\/+$/, "");
  return `${base}/#${page}/${encodeURIComponent(id)}`;
}

// ── Datto (env.DATTO_PORTAL_BASE_URL) ────────────────────────────────────────

/**
 * Datto BCDR portal device search by serial. Best-effort: requires the portal
 * base var to be set, otherwise returns null (no button).
 * @param {object} env
 * @param {string} serial
 * @returns {string|null}
 */
export function dattoDeviceUrl(env, serial) {
  if (!env?.DATTO_PORTAL_BASE_URL || !serial) return null;
  return `${String(env.DATTO_PORTAL_BASE_URL).replace(/\/+$/, "")}/device/${encodeURIComponent(serial)}`;
}

// ── Box (env.BOX_FILE_BASE, default app.box.com/file) ────────────────────────

/**
 * Box file viewer.
 * @param {object} env_or_fileId - env (with BOX_FILE_BASE) or, for callers
 *   without env, pass the fileId directly as the first arg.
 * @param {string} [fileId]
 * @returns {string|null}
 */
export function boxFileUrl(env_or_fileId, fileId) {
  // Allow boxFileUrl(fileId) or boxFileUrl(env, fileId).
  let base = "https://app.box.com/file";
  let id = fileId;
  if (typeof env_or_fileId === "object" && env_or_fileId) {
    if (env_or_fileId.BOX_FILE_BASE) base = env_or_fileId.BOX_FILE_BASE;
  } else {
    id = env_or_fileId;
  }
  if (!id) return null;
  return joinBase(base, encodeURIComponent(id));
}

// ── CDW (product url already scraped at the call site) ───────────────────────

/**
 * Pass-through for a CDW product URL captured during procurement scraping.
 * @param {string} url
 * @returns {string|null}
 */
export function cdwProductUrl(url) {
  if (!url || typeof url !== "string") return null;
  return url.startsWith("http") ? url : null;
}
