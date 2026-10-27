// =============================================================================
// lib/actionTrace.js - Action memory for Nexus chat bots.
//
// The chat pipeline historically persisted only two things per turn: the
// user's message and the bot's final TEXT reply. Everything the bot actually
// DID in between, reading an email, drafting a reply, staging a HITL card,
// creating a reminder, lived inside the tool loop and was discarded the
// instant the turn ended. One turn later the bot had no record of its own
// actions, so it would draw a blank on "the email I cc'd you on" or claim it
// had done something it never did.
//
// These helpers turn the tool-call trace of a turn into a compact breadcrumb
// that gets persisted into chat_history alongside the reply (memory only --
// never posted to Nexus). They also detect the inverse failure: a reply that
// claims success while no write tool actually ran.
//
// Pure functions, no I/O. Exported for unit testing.
//
// Hard rules:
//   - No em dashes or en dashes.
//   - ES modules only.
// =============================================================================

// Identifier-ish input keys that are safe and useful to record in a
// breadcrumb. We deliberately do NOT record body/content/text/html fields:
// the breadcrumb is a memory aid (who/what/which), not a transcript, and
// dumping full email bodies into history would bloat it and leak content
// into every future prompt. Mirrors the "log subject+sender, not body" rule.
const SAFE_INPUT_KEYS = [
  "to", "from", "cc", "recipient", "recipients", "sender",
  "subject", "title", "name", "label",
  "query", "q", "search",
  "company", "email", "domain", "phone",
  "id", "message_id", "event_id", "prospect_id", "entity_id", "attachment_id",
  "when", "due", "due_at", "dueat", "date", "time", "start",
  "channel", "channel_slug", "slug",
  "status", "category", "kind", "type",
  "amount", "count", "limit",
];

// Tool-name patterns that are read-only (do not mutate state or send anything).
// Used so a reply that only READ something is not credited as having taken a
// write action when checking for unbacked success claims.
const READONLY_EXACT = new Set([
  "read_channel_history",
  "nexus_load_attachment",
  "nexus_view_gif",
]);
const READONLY_PREFIXES = [
  "get_", "list_", "read_", "search_", "find_", "lookup_",
  "check_", "fetch_", "view_", "show_", "query_",
];

const MAX_TOOLS_IN_BREADCRUMB = 10;
const MAX_VALUE_LEN = 80;
const MAX_TOOL_SUMMARY_LEN = 220;

// Identifier-ish keys worth retaining from a tool RESULT (what came back), so a
// later turn can reference it ("authorise it", "void that one"). Same spirit as
// SAFE_INPUT_KEYS: ids/numbers/totals/status only, never body/content text.
// Covers both our snake_case shapes and Xero/Ninja PascalCase fields.
const RESULT_ID_KEYS = [
  "id", "ID", "uuid",
  "invoiceId", "invoice_id", "InvoiceID", "InvoiceNumber", "invoiceNumber",
  "contactId", "contact_id", "ContactID",
  "ticketId", "ticket_id", "ticketNumber",
  "eventId", "event_id", "messageId", "message_id",
  "orderId", "order_id", "number", "reference", "Reference",
  "total", "Total", "amount", "AmountDue", "subtotal",
  "status", "Status", "state", "count",
  "name", "Name", "email", "url",
];

// Common envelope keys a handler wraps its real payload in. We look one level
// into the first of these we find so {success:true, invoice:{...}} still yields
// the invoice's id. Kept shallow on purpose (no deep walk, no bloat).
const RESULT_WRAPPER_KEYS = [
  "data", "result", "record", "invoice", "contact", "item",
  "ticket", "event", "order", "message", "payment",
];

const MAX_RESULT_SUMMARY_LEN = 160;

// Verbs that assert an action was completed. Used to detect a reply that
// claims success. Past-tense / done-state phrasing only, "I'll add" or
// "want me to send" are intentions, not claims, and must not match.
const SUCCESS_CLAIM_RE =
  /\b(?:done|added|created|scheduled|saved|set(?: up| a)?|staged|sent|emailed|drafted|updated|deleted|removed|booked|posted|reminded|enrolled|cancelled|canceled|completed|marked|filed|logged|assigned)\b/i;

/**
 * Decide whether a tool name represents a read-only operation.
 *
 * @param {string} name - tool name
 * @returns {boolean} true if the tool only reads (does not mutate/send)
 */
export function isReadonlyToolName(name) {
  if (!name || typeof name !== "string") return false;
  if (READONLY_EXACT.has(name)) return true;
  const lower = name.toLowerCase();
  return READONLY_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Produce a compact, privacy-conscious one-line summary of a single tool call.
 * Records only whitelisted identifier-ish keys, never body/content text.
 *
 * @param {string} name - tool name
 * @param {object} input - the tool_use .input object
 * @param {boolean} [isError=false] - whether the tool call errored
 * @returns {string} e.g. "draft_email(to: ilya@x.com, subject: Re: Chicago)"
 */
export function summarizeToolCall(name, input, isError = false) {
  const safeName = typeof name === "string" && name ? name : "unknown_tool";
  const parts = [];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of SAFE_INPUT_KEYS) {
      if (parts.length >= 4) break;
      if (input[key] === undefined || input[key] === null) continue;
      let val = input[key];
      if (typeof val === "object") {
        try { val = JSON.stringify(val); } catch { val = "[obj]"; }
      }
      val = String(val).replace(/\s+/g, " ").trim();
      if (!val) continue;
      if (val.length > MAX_VALUE_LEN) val = `${val.slice(0, MAX_VALUE_LEN)}...`;
      parts.push(`${key}: ${val}`);
    }
  }
  let summary = parts.length ? `${safeName}(${parts.join(", ")})` : `${safeName}()`;
  if (summary.length > MAX_TOOL_SUMMARY_LEN) {
    summary = `${summary.slice(0, MAX_TOOL_SUMMARY_LEN)}...)`;
  }
  if (isError) summary += " [FAILED]";
  return summary;
}

/**
 * Pull a compact set of identifier-ish values from a tool RESULT so a later
 * turn can reference what the tool returned. Records only whitelisted id/number/
 * total/status keys (top level plus one level into a common envelope), never
 * body/content text. Returns "" when nothing useful is present.
 *
 * @param {string|object|Array} result - the tool_result content (string JSON,
 *   parsed object, or multimodal array). Arrays/non-objects yield "".
 * @returns {string} e.g. "InvoiceID: abc-123, Total: 4200, Status: DRAFT"
 */
export function summarizeToolResult(result) {
  let obj = result;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (!s || (s[0] !== "{" && s[0] !== "[")) return "";
    try { obj = JSON.parse(s); } catch { return ""; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";

  const collect = (src, parts) => {
    if (!src || typeof src !== "object" || Array.isArray(src)) return;
    for (const key of RESULT_ID_KEYS) {
      if (parts.length >= 4) break;
      if (src[key] === undefined || src[key] === null) continue;
      if (typeof src[key] === "object") continue; // ids are scalars
      let val = String(src[key]).replace(/\s+/g, " ").trim();
      if (!val) continue;
      if (val.length > MAX_VALUE_LEN) val = `${val.slice(0, MAX_VALUE_LEN)}...`;
      if (parts.some((p) => p.startsWith(`${key}:`))) continue;
      parts.push(`${key}: ${val}`);
    }
  };

  const parts = [];
  collect(obj, parts);
  if (parts.length < 4) {
    for (const wk of RESULT_WRAPPER_KEYS) {
      if (parts.length >= 4) break;
      const nested = obj[wk];
      if (Array.isArray(nested)) collect(nested[0], parts);
      else collect(nested, parts);
    }
  }
  if (parts.length === 0) return "";
  let summary = parts.join(", ");
  if (summary.length > MAX_RESULT_SUMMARY_LEN) {
    summary = `${summary.slice(0, MAX_RESULT_SUMMARY_LEN)}...`;
  }
  return summary;
}

/**
 * Build the action breadcrumb line for a turn, from the collected tool trace
 * plus any HITL action staged after the LLM returned.
 *
 * The returned string is meant to be appended to the ASSISTANT history content
 * (memory only), NOT posted to Nexus. Returns "" when nothing actionable
 * happened, so callers can skip appending an empty marker.
 *
 * @param {Array<{name: string, input: object, isError?: boolean}>} toolTrace
 * @param {object} [staged] - optional staged-HITL descriptor
 * @param {string} [staged.description] - human description of the staged action
 * @param {string} [staged.channel] - approval channel slug the card landed in
 * @returns {string}
 */
export function buildActionBreadcrumb(toolTrace, staged = null) {
  const entries = [];
  const trace = Array.isArray(toolTrace) ? toolTrace : [];
  for (const t of trace.slice(0, MAX_TOOLS_IN_BREADCRUMB)) {
    if (!t || !t.name) continue;
    let entry = summarizeToolCall(t.name, t.input, !!t.isError);
    // Append identifiers the tool RETURNED (e.g. the invoice id from a list/
    // create) so a follow-up turn can act on "it" without re-querying. Only on
    // success, a failed call returned no usable referent.
    if (!t.isError && t.result !== undefined) {
      const resultIds = summarizeToolResult(t.result);
      if (resultIds) entry += ` -> ${resultIds}`;
    }
    entries.push(entry);
  }
  if (trace.length > MAX_TOOLS_IN_BREADCRUMB) {
    entries.push(`(+${trace.length - MAX_TOOLS_IN_BREADCRUMB} more)`);
  }
  if (staged && (staged.description || staged.channel)) {
    const where = staged.channel ? ` in #${staged.channel}` : "";
    const what = staged.description
      ? `: "${String(staged.description).replace(/\s+/g, " ").trim().slice(0, 120)}"`
      : "";
    entries.push(`staged HITL approval card${where}${what}`);
  }
  if (entries.length === 0) return "";
  return (
    "[actions you actually performed on this turn (private memory note, the user did NOT see this line): " +
    entries.join("; ") +
    "]"
  );
}

/**
 * Detect a reply that claims an action was completed while no write tool
 * actually ran this turn. Read-only tool calls do not count as a write.
 *
 * This is an observability signal (fed to QA capture), not a hard block --
 * heuristic phrasing detection should never suppress a user-facing reply.
 *
 * @param {string} replyText - the visible reply text
 * @param {Array<{name: string, isError?: boolean}>} toolTrace
 * @returns {boolean} true when the reply claims success but no write tool fired
 */
export function looksLikeUnbackedClaim(replyText, toolTrace) {
  if (!replyText || typeof replyText !== "string") return false;
  if (!SUCCESS_CLAIM_RE.test(replyText)) return false;
  const trace = Array.isArray(toolTrace) ? toolTrace : [];
  const ranWriteTool = trace.some(
    (t) => t && t.name && !t.isError && !isReadonlyToolName(t.name),
  );
  return !ranWriteTool;
}
