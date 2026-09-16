// =============================================================================
// lib/emailQuote.js - Strip the quoted reply chain from a flattened email body.
//
// Ported from wren-worker src/jobs/meeting-approval-poller.js stripQuotedReply
// so every surface that stores or reasons over a sender's words uses one rule.
// A reply carries every earlier message inline; storing that chain in memory
// would re-store the bot's own earlier replies as the sender's words.
// =============================================================================

const QUOTE_MARKERS = [
  /-{2,}\s*Original Message\s*-{2,}/i,
  /\bFrom:\s*\S/,
  /\bOn\b[^]{0,120}?\bwrote:/i,
  /_{10,}/,
];

/**
 * Flatten HTML to readable text. Shared by externalReplyGate.htmlToText and
 * the memory email writer; lives here because this module has no imports, so
 * neither consumer creates an import cycle.
 * @param {string} html - Source HTML.
 * @param {number} [limit=4000] - Maximum characters to keep ("..." appended when cut).
 * @returns {string} Plain text.
 */
export function flattenEmailHtml(html, limit = 4000) {
  const text = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/**
 * Return only the sender's own words, dropping the quoted chain beneath them.
 * Falls back to the full text when the cut would leave nothing.
 *
 * @param {string} body - message body with HTML already flattened
 * @returns {string}
 */
export function stripQuotedReply(body) {
  const text = String(body || "");
  let cut = text.length;
  for (const marker of QUOTE_MARKERS) {
    const found = text.match(marker);
    if (found && found.index < cut) cut = found.index;
  }
  const own = text.slice(0, cut).trim();
  return own || text.trim();
}
