// =============================================================================
// lib/mimeEmail.js -- MIME email builder + Graph MIME upload sender.
//
// Builds proper multipart/alternative messages with text/plain + text/html
// parts and explicit charset declarations. Sends via Graph's MIME upload
// path (POST /messages with base64 body, then POST /messages/{id}/send)
// instead of the JSON /sendMail endpoint.
//
// M365 EOP scores multipart/alternative with both parts significantly
// higher than HTML-only messages from the JSON sendMail path.
// =============================================================================

import { scrubFleetDashes } from "./sanitize.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Generate a random hex string for MIME boundaries and Message-ID.
 * @param {number} bytes
 * @returns {string}
 */
function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Base64-encode a UTF-8 string for the Graph MIME upload body.
 * @param {string} s
 * @returns {string}
 */
function utf8Base64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Strip HTML tags and decode common entities to produce a plain-text fallback.
 * @param {string} html
 * @returns {string}
 */
function htmlToPlainText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<\/?(p|div|h[1-6]|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * RFC 2047 Q-encode a header value if it contains non-ASCII characters.
 * @param {string} s
 * @returns {string}
 */
function qEncode(s) {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const bytes = new TextEncoder().encode(s);
  let encoded = "";
  for (const b of bytes) {
    if (
      (b >= 0x30 && b <= 0x39) ||
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a)
    ) {
      encoded += String.fromCharCode(b);
    } else {
      encoded += "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return `=?UTF-8?Q?${encoded}?=`;
}

/**
 * Build a multipart/alternative MIME message with both text/plain and
 * text/html parts, explicit charset declarations, and proper headers.
 *
 * @param {object} opts
 * @param {string} opts.from - sender email address
 * @param {string} [opts.fromName] - sender display name
 * @param {string|string[]} opts.to - recipient(s)
 * @param {string|string[]} [opts.cc] - CC recipient(s)
 * @param {string|string[]} [opts.bcc] - BCC recipient(s)
 * @param {string} opts.subject
 * @param {string} opts.htmlBody - HTML content
 * @param {string} [opts.textBody] - plain text (auto-derived from HTML if omitted)
 * @param {Array<{name: string, contentType?: string, contentBytes: Uint8Array}>} [opts.attachments]
 * @param {string} [opts.listUnsubscribe] - RFC 8058 List-Unsubscribe header value
 *   (e.g. "<https://.../u/token>, <mailto:unsub@x?subject=...>"). When set, a
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click header is added too so
 *   bulk sends qualify for Gmail/Yahoo one-click unsubscribe.
 * @returns {{mime: string, messageId: string}}
 */
export function buildMimeMessage(opts) {
  const {
    from,
    fromName,
    to,
    cc,
    bcc,
    subject: rawSubject,
    htmlBody: rawHtml,
    textBody: rawText,
    attachments,
    listUnsubscribe,
  } = opts;

  // Strip em/en dashes from human-facing fields before MIME assembly. Fleet
  // rule: dashes are a bot tell in email prose. Applied here so every caller
  // gets it for free instead of relying on each per-bot send wrapper.
  const subject = scrubFleetDashes(rawSubject);
  const htmlBody = scrubFleetDashes(rawHtml);
  const textBody = rawText != null ? scrubFleetDashes(rawText) : rawText;

  const toList = Array.isArray(to) ? to : [to];
  const ccList = Array.isArray(cc) ? cc : (cc ? [cc] : []);
  const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);
  const finalText = textBody || htmlToPlainText(htmlBody);
  const messageId = `<${randomHex(16)}@blackravenit.com>`;
  const altBoundary = `====alt_${randomHex(10)}====`;
  const hasAttachments = attachments && attachments.length > 0;
  const mixedBoundary = hasAttachments ? `====mix_${randomHex(10)}====` : null;

  const fromHeader = fromName
    ? `"${qEncode(fromName)}" <${from}>`
    : from;

  const headerLines = [
    `From: ${fromHeader}`,
    `To: ${toList.join(", ")}`,
  ];
  if (ccList.length) headerLines.push(`Cc: ${ccList.join(", ")}`);
  if (bccList.length) headerLines.push(`Bcc: ${bccList.join(", ")}`);
  headerLines.push(
    `Subject: ${qEncode(subject)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
  );

  // RFC 8058 one-click unsubscribe. Both headers are required for Gmail/Yahoo
  // to render the one-click control; the Post header signals the recipient's
  // mail client may POST the List-Unsubscribe URL without a confirmation step.
  if (listUnsubscribe) {
    headerLines.push(`List-Unsubscribe: ${listUnsubscribe}`);
    headerLines.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }

  if (hasAttachments) {
    headerLines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  } else {
    headerLines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  }

  const altParts = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintableEncode(finalText),
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintableEncode(htmlBody),
    `--${altBoundary}--`,
  ].join("\r\n");

  let body;
  if (hasAttachments) {
    const attParts = attachments.map((att) => {
      const bytes = att.contentBytes instanceof Uint8Array
        ? att.contentBytes
        : new Uint8Array(att.contentBytes);
      let binary = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const b64 = btoa(binary);
      const wrapped = b64.replace(/(.{76})/g, "$1\r\n");
      const ct = att.contentType || "application/octet-stream";
      return [
        `--${mixedBoundary}`,
        `Content-Type: ${ct}; name="${att.name}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${att.name}"`,
        "",
        wrapped,
      ].join("\r\n");
    });

    body = [
      "",
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      altParts,
      ...attParts,
      `--${mixedBoundary}--`,
      "",
    ].join("\r\n");
  } else {
    body = [
      "",
      altParts,
      "",
    ].join("\r\n");
  }

  return { mime: `${headerLines.join("\r\n")}\r\n${body}`, messageId };
}

/**
 * Encode a string as quoted-printable (RFC 2045).
 * @param {string} s
 * @returns {string}
 */
function quotedPrintableEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let line = "";
  const lines = [];

  for (const b of bytes) {
    let ch;
    if (b === 0x0d) continue;
    if (b === 0x0a) {
      lines.push(line);
      line = "";
      continue;
    }
    if (
      (b >= 0x20 && b <= 0x7e && b !== 0x3d) ||
      b === 0x09
    ) {
      ch = String.fromCharCode(b);
    } else {
      ch = "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
    if (line.length + ch.length > 75) {
      lines.push(line + "=");
      line = ch;
    } else {
      line += ch;
    }
  }
  lines.push(line);
  return lines.join("\r\n");
}

/**
 * Tag a Graph failure with the facts a caller needs to classify it, so nobody
 * has to pattern-match the message text (which carries remote content and can
 * be steered by whatever is in the subject or the recipient list).
 *
 * @param {string} message - human-readable error line
 * @param {number} status - HTTP status from Graph
 * @param {string} bodyText - raw response body, parsed best-effort for error.code
 * @returns {Error}
 */
function graphError(message, status, bodyText) {
  const err = new Error(message);
  err.status = status;
  try {
    const parsed = JSON.parse(bodyText);
    const code = parsed?.error?.code;
    if (typeof code === "string") err.graphCode = code;
  } catch {
    // Non-JSON body: status alone carries the classification.
  }
  return err;
}

/**
 * Send a MIME message via Graph's MIME upload path.
 *
 * Two-step process:
 *   1. POST /users/{mailbox}/messages with Content-Type: text/plain,
 *      body = base64-encoded MIME string. Creates a draft.
 *   2. POST /users/{mailbox}/messages/{draftId}/send to dispatch it.
 *
 * @param {string} token - Graph Bearer token
 * @param {string} mailbox - UPN of the sending mailbox
 * @param {string} mimeString - complete RFC 5322 MIME message
 * @param {object} [opts]
 * @param {boolean} [opts.saveToSentItems=true]
 * @returns {Promise<{messageId: string}>}
 */
export async function sendMimeEmail(token, mailbox, mimeString, opts = {}) {
  const mb = encodeURIComponent(mailbox);
  const mimeB64 = utf8Base64(mimeString);

  const draftRes = await fetch(
    `${GRAPH_BASE}/users/${mb}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: mimeB64,
    },
  );

  if (!draftRes.ok) {
    const text = await draftRes.text();
    throw graphError(`Graph MIME draft POST ${draftRes.status}: ${text.slice(0, 500)}`, draftRes.status, text);
  }

  const draft = await draftRes.json();
  const draftId = draft.id;
  if (!draftId) throw new Error("Graph MIME draft returned no id");

  const sendRes = await fetch(
    `${GRAPH_BASE}/users/${mb}/messages/${draftId}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!sendRes.ok && sendRes.status !== 202) {
    const text = await sendRes.text();
    throw graphError(`Graph MIME send POST ${sendRes.status}: ${text.slice(0, 500)}`, sendRes.status, text);
  }

  return { messageId: draftId };
}
