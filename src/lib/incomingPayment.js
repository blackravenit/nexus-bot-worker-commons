// =============================================================================
// lib/incomingPayment.js - Shared "is this money IN, not a vendor bill?" guard.
//
// Biller Genie is Black Raven's AR / customer-invoicing system. Anything from it
// is a CUSTOMER paying US (money in) and must NEVER become an ACCPAY vendor bill
// or be forwarded to Maxwell's AP inbox. This guard is the single source of
// truth shared by Wren's vendor-bill forwarder AND Maxwell's ap-inbox monitor
// (previously two drifting per-bot copies, the drift is exactly why a client's
// Biller Genie receipt slipped through twice: 2026-06-03 and 2026-06-04).
//
// Discriminator priority:
//   1. Sender / body mentions our own white-label billing address
//      (hello@blackravenit.com). Biller Genie sends customer payment receipts AS
//      "Black Raven" from hello@; a copy lands in owner@, and Wren's native Graph
//      forward keeps "Original From: hello@blackravenit.com" in the body. A real
//      vendor bill is ALWAYS from an external vendor domain, never from us.
//   2. Any literal "Biller Genie" mention.
//   3. Unambiguous money-IN language (payout / deposited to your / you have
//      received a payment / customer payment received / has paid your invoice).
//
// NOTE: we deliberately do NOT match generic "payment received / thank you for
// your payment / your card was charged" phrasing, a VENDOR's paid-receipt says
// the same thing and we DO want those booked (the auto-pay receipt flow). The
// sender is the safe discriminator; phrasing is not.
// =============================================================================

const OWN_BILLING_SENDER_RE = /hello@blackravenit\.com/;
const BILLER_GENIE_RE = /biller\s*genie|billergenie/;
const MONEY_IN_RE =
  /\b(payout|deposit(ed)?\s+to\s+your|funds?\s+(have|has)\s+been\s+(deposited|sent)|you('|\s+ha)ve\s+received\s+a\s+payment|customer\s+payment\s+received|has\s+paid\s+(you|your\s+invoice))\b/;

/**
 * True when an email is an INCOMING / customer payment notification (money in)
 * rather than a vendor bill (money out).
 *
 * Accepts the union of the shapes the two callers use: Wren passes
 * `{ from, subject, body, preview }`; Maxwell passes `{ from, subject, text }`.
 *
 * @param {object} email
 * @param {string} [email.from]
 * @param {string} [email.subject]
 * @param {string} [email.body]
 * @param {string} [email.preview]
 * @param {string} [email.text]
 * @returns {boolean}
 */
export function looksLikeIncomingPayment({ from = "", subject = "", body = "", preview = "", text = "" } = {}) {
  const haystack = `${from} ${subject} ${body || text || preview}`.toLowerCase();
  if (OWN_BILLING_SENDER_RE.test(haystack)) return true;
  if (BILLER_GENIE_RE.test(haystack)) return true;
  if (MONEY_IN_RE.test(haystack)) return true;
  return false;
}
