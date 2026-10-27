// =============================================================================
// emailHeader.js, render a Graph message's envelope (From / To / Cc) into the
// text a bot actually reads.
//
// Every mail surface in the fleet used to hand the model a subject line and a
// body and nothing else, so bots could not answer "who else got this?" and said
// they had no visibility into recipients. They did have it: Graph returns
// toRecipients/ccRecipients whenever they are in $select, the formatters were
// simply dropping them on the floor (2026-08-17, maxwell owner-email-handler).
//
// Two things callers must know:
//  - Graph omits any field absent from $select. Including this block in a prompt
//    is only half the fix; the fetch has to ask for the recipient fields too.
//  - Bcc is invisible on a RECEIVED message by design. Absent Bcc means "cannot
//    know", never "nobody". renderEmailHeader says so explicitly rather than
//    letting the model infer a complete distribution list from an incomplete one.
// =============================================================================

// Recipient lists are long on distribution mail and the envelope should never
// crowd out the body it describes. Overflow is counted, not silently dropped.
const MAX_RECIPIENTS_SHOWN = 15;

/**
 * Format one Graph recipient into "Display Name <address>", or just the address
 * when the two are identical or the name is missing.
 * @param {{emailAddress?: {name?: string, address?: string}}} recipient
 * @returns {string|null} formatted recipient, or null when there is no address
 */
function formatRecipient(recipient) {
  const addr = recipient?.emailAddress?.address?.trim();
  if (!addr) return null;
  const name = recipient?.emailAddress?.name?.trim();
  if (!name || name.toLowerCase() === addr.toLowerCase()) return addr;
  return `${name} <${addr}>`;
}

/**
 * Format a Graph recipient array into a single comma-separated line.
 * @param {Array<object>} recipients
 * @returns {string|null} the line, or null when the list is empty
 */
function formatRecipientList(recipients) {
  const formatted = (Array.isArray(recipients) ? recipients : [])
    .map(formatRecipient)
    .filter(Boolean);
  if (formatted.length === 0) return null;
  if (formatted.length <= MAX_RECIPIENTS_SHOWN) return formatted.join(", ");
  const shown = formatted.slice(0, MAX_RECIPIENTS_SHOWN).join(", ");
  return `${shown}, and ${formatted.length - MAX_RECIPIENTS_SHOWN} more`;
}

/**
 * Render the envelope of a Graph message as plain header lines for a prompt.
 *
 * Returns "" when the message carries no usable envelope at all, so callers can
 * concatenate unconditionally without producing a stray blank header.
 *
 * @param {object} msg - a Graph message (needs from/toRecipients/ccRecipients in $select)
 * @param {object} [options]
 * @param {boolean} [options.includeSubject=true] - emit the Subject line
 * @param {boolean} [options.includeDate=true] - emit the Date line
 * @returns {string} header lines, no trailing newline
 */
export function renderEmailHeader(msg, options = {}) {
  if (!msg || typeof msg !== "object") return "";
  const { includeSubject = true, includeDate = true } = options;

  const lines = [];
  const from = formatRecipient(msg.from) || formatRecipient(msg.sender);
  if (from) lines.push(`From: ${from}`);

  const to = formatRecipientList(msg.toRecipients);
  if (to) lines.push(`To: ${to}`);

  const cc = formatRecipientList(msg.ccRecipients);
  if (cc) lines.push(`Cc: ${cc}`);

  const replyTo = formatRecipientList(msg.replyTo);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);

  if (includeDate && msg.receivedDateTime) lines.push(`Date: ${msg.receivedDateTime}`);
  if (includeSubject && msg.subject) lines.push(`Subject: ${msg.subject}`);

  if (lines.length === 0) return "";

  // Only worth saying once there is a recipient list to qualify. Without this a
  // model reads the To/Cc lines as the complete distribution and will state that
  // someone was not copied when they may simply have been bcc'd.
  if (to || cc) {
    lines.push("(Bcc recipients are not visible on received mail. Do not treat the list above as exhaustive.)");
  }

  return lines.join("\n");
}

/**
 * Convenience wrapper: the rendered envelope followed by the body, ready to drop
 * into a prompt as one text block. Returns the body alone when the message has
 * no usable envelope.
 *
 * @param {object} msg - a Graph message
 * @param {string} body - body text, already flattened and truncated by the caller
 * @param {object} [options] - forwarded to renderEmailHeader
 * @returns {string}
 */
export function renderEmailForPrompt(msg, body, options = {}) {
  const header = renderEmailHeader(msg, options);
  const text = typeof body === "string" ? body : "";
  return header ? `${header}\n\n${text}` : text;
}
