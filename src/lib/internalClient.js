// =============================================================================
// lib/internalClient.js - Shared "this client is us, never sell to it" gate.
//
// Black Raven IT is itself a row in the CRM clients table, carrying
// is_internal = 1, so that internal staff equipment purchases get a signed
// opportunity as their approval record. That is deliberate: the opportunity is
// the expense approval, not a sale.
//
// The consequence is that an internal client sits in the SAME queues every
// client-facing automation reads. Spend on it must never become a sale: no
// contract, invoice, agreement, onboarding, welcome email, thank-you email,
// newsletter, review request, commission, Desk client record or MRR.
//
// Before this module the rule lived in prose in the client's own notes field
// ("Internal purchases only. Never sold to: no contract, invoice, onboarding,
// commission or MRR") and was enforced only inside crm-app. The bots never
// looked. On 2026-10-11 two internal ThinkPad purchases closed won, and
// jacob-worker's signed-contract-thanks job tried to email a customer
// thank-you to owner@blackravenit.com every ten minutes. sendEmail refused
// (our own domain), the job only stamps an opportunity on its success path, so
// nothing recorded the failure and the next tick started over: two paid model
// calls and one red error card per opportunity per tick, permanently.
//
// So this is ONE source of truth, imported by crm-app and by every bot, rather
// than a rule each caller re-derives. A caller that screens on its own copy of
// a rule drifts from the code it is screening for, which is how that loop
// happened in the first place.
//
// Note on what this is NOT: it is not an email-domain test. Checking whether
// the contact address is one of ours catches this one client by luck. A real
// client could list a contact at our domain (an alias we host), and an internal
// record could carry a personal address. The flag is the fact; the address is a
// coincidence. Use isInternalAddress for "may I send mail here" and this for
// "is this a customer at all".
// =============================================================================

/** GL expense account for internal staff equipment (Xero 6080). */
export const INTERNAL_COGS_ACCOUNT = "6080";

// The exact vocabulary crm-app's truthyFlag() accepts when WRITING the column
// (routes/_crud.js). A reader that accepts less than its writer is a gate that
// disagrees with the record it is gating on: a row written from "true" would
// store 1, yet an in-flight row still carrying the string "true" would read as
// not-internal. Same list on both sides, so there is no differential.
const TRUTHY = new Set([true, 1, "1", "true"]);

/**
 * True when a row describes our own internal client.
 *
 * Accepts either shape the CRM serves, because callers hold different rows:
 *   - a client row, which carries `is_internal`
 *   - an opportunity or contract row, which carries the joined
 *     `client_is_internal` (see crm-app OPP_SELECT_COLS)
 * Both the list and single-record opportunity endpoints already return the
 * joined flag, so a job holding an opportunity needs no extra client fetch.
 *
 * Either field saying internal is enough. It is deliberately OR, not a
 * precedence chain: a caller that merges an opportunity over its client, or
 * fetches one of the two partially, would otherwise let an absent or zero
 * field overrule a present 1 and leak a client-facing action onto our own
 * books. No real client ever carries a 1 in either field, so OR cannot
 * suppress a paying customer's paperwork.
 *
 * KNOWN LIMIT, and the thing to re-check if this ever misfires: absence reads
 * as NOT internal. That direction is chosen (see below), but it means the gate
 * depends on the CRM continuing to serve the field. If a future change drops
 * `client_is_internal` from an opportunity payload, every caller silently
 * fails open. The jobs where that would cost real money keep a second,
 * independent reason to stop.
 *
 * Why absence is not treated as internal: this gate suppresses contracts,
 * invoices, onboarding and outbound mail. Defaulting an unknown row to
 * internal would stop a paying client's paperwork with no error raised
 * anywhere, which is both more likely and harder to notice than the converse.
 *
 * @param {object|null|undefined} row Client, opportunity or contract row.
 * @returns {boolean} True only for a confirmed internal row; false when absent.
 */
export function isInternalRow(row) {
  if (!row) return false;
  return TRUTHY.has(row.is_internal) || TRUTHY.has(row.client_is_internal);
}

/**
 * The reason line to stamp on an activity or log when a job skips an internal
 * client, so the timeline says why rather than going silent.
 *
 * @param {string} what What was skipped, e.g. "Thank-you email".
 * @returns {string}
 */
export function internalSkipReason(what) {
  return `${what} skipped: this client is Black Raven IT itself (is_internal = 1), recorded as an internal purchase approval, not a sale.`;
}
