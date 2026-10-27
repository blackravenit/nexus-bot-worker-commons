// =============================================================================
// lib/emailAttachments.js, Turn a Microsoft Graph message's attachments into
// Anthropic content blocks so every fleet bot can actually READ what was sent,
// not just the email body.
//
// Why this exists: bots polled / read mailboxes but only ever saw body text.
// When Brian forwarded a DMARC aggregate report to Dexter and Robert, neither
// could open it, a DMARC report is an XML file, almost always shipped GZIP'd
// (`...xml.gz`) or ZIP'd, which nothing in the fleet decompressed.
//
// This module is mailbox-client-agnostic. Each bot's mail lib (mailbox.js /
// outlook.js / graph.js) wraps its own token + Graph GET into a single
// `graphJson(path)` closure and hands it here; we do the rest:
//
//   1. GET /messages/{id}/attachments
//   2. For each fileAttachment: base64-decode contentBytes, then
//        - GZIP  (`.xml.gz`, magic 1F 8B)        -> gunzip, re-route the inner file
//        - ZIP   (`.zip`, magic 50 4B)           -> expand entries, re-route each
//        - else  (pdf/png/xml/csv/txt/docx/...)  -> buildBlock() (shared router)
//   3. For an itemAttachment (a message forwarded "as attachment"): expand it,
//      hand over the forwarded body as text plus any nested file attachments.
//
// buildBlock() (lib/attachments.js) already maps PDF -> document block, images
// -> image block (with HEIC/TIFF transcode), Office -> extracted text, and
// any text/xml/csv/json/svg -> a text block. So once a DMARC XML is gunzipped,
// the model reads it for free. This module only adds the decompression + the
// Graph fetch plumbing on top of that existing router.
//
// Best-effort throughout: a single unreadable attachment is skipped with a
// warning string, never an exception that kills the email read.
// =============================================================================

import { buildBlock } from "./attachments.js";
import { readZipEntries, inflateRaw } from "./officeText.js";

const DEFAULT_MAX_FILES = 6;
const PER_FILE_MAX_BYTES = 10 * 1024 * 1024;
const TOTAL_HARD_BYTES = 25 * 1024 * 1024;

// Inline attachments are usually signature logos, social icons, and tracking
// pixels, which we skip. But a screenshot pasted into the email body is ALSO an
// inline image (cid-referenced), and that is real content we must read. Size is
// the cheap discriminator: logos/icons/pixels are small, a screenshot is not.
// An inline image at or above this many bytes is treated as readable content.
const INLINE_IMAGE_MIN_BYTES = 10 * 1024;

/**
 * Decide whether an inline attachment is real content (a pasted screenshot) vs
 * decorative chrome (signature logo, social icon, tracking pixel). Keep inline
 * images at or above the size floor; skip everything else inline.
 * @param {object} a - Graph attachment summary (has contentType, name, size)
 * @returns {boolean}
 */
function inlineWorthReading(a) {
  const mime = cleanMime(a.contentType) || mimeFromName(a.name);
  if (!mime.startsWith("image/")) return false;
  return (a.size || 0) >= INLINE_IMAGE_MIN_BYTES;
}

// Filename-extension -> mime, used when Graph reports application/octet-stream
// (DMARC reports and many gzip/zip parts arrive that way) or no contentType.
const EXT_MIME = {
  xml: "text/xml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  log: "text/plain",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Decode a base64 string (Graph `contentBytes`) to a Uint8Array. Workers expose
 * atob but not Buffer.
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Return a standalone ArrayBuffer for a (possibly sub-viewed) Uint8Array.
 * buildBlock / readZipEntries read the whole backing buffer, so a subarray view
 * would otherwise leak neighboring bytes.
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

/**
 * Best-effort mime from a filename extension.
 * @param {string} name
 * @returns {string}
 */
function mimeFromName(name) {
  const ext = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && EXT_MIME[ext]) || "";
}

/**
 * Normalize a Graph contentType to a bare mime, treating the generic
 * octet-stream / zip aliases as "unknown" so we fall back to name inference.
 * @param {string} ct
 * @returns {string}
 */
function cleanMime(ct) {
  const m = String(ct || "").toLowerCase().split(";")[0].trim();
  if (!m || m === "application/octet-stream" || m === "binary/octet-stream") return "";
  return m;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {string} ct
 * @returns {boolean}
 */
function looksGzip(bytes, name, ct) {
  return (
    (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    /\.gz$/i.test(name || "") ||
    /gzip/i.test(ct || "")
  );
}

/**
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {string} ct
 * @returns {boolean}
 */
function looksZip(bytes, name, ct) {
  // ZIP local-file / empty-archive / spanned signatures all start "PK".
  const magic = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  return magic || /\.zip$/i.test(name || "") || /zip/i.test(ct || "");
}

/**
 * Gunzip via the runtime's DecompressionStream (no zlib in Workers).
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Turn one decoded file (name + bytes) into content block(s), recursing through
 * GZIP and ZIP containers. Mutates the accumulator in place.
 *
 * @param {object} env
 * @param {string} name
 * @param {string} ct - reported contentType (may be empty / octet-stream)
 * @param {Uint8Array} bytes
 * @param {{blocks: object[], warnings: string[], names: string[], totalBytes: number, maxFiles: number}} acc
 * @returns {Promise<void>}
 */
async function pushFileBlocks(env, name, ct, bytes, acc) {
  if (acc.blocks.length >= acc.maxFiles || acc.totalBytes >= TOTAL_HARD_BYTES) return;
  if (bytes.byteLength > PER_FILE_MAX_BYTES) {
    acc.warnings.push(`Skipped ${name} (${bytes.byteLength} bytes, over per-file cap).`);
    return;
  }

  // GZIP container (DMARC `...xml.gz`): gunzip, then route the inner file.
  if (looksGzip(bytes, name, ct)) {
    let inner;
    try {
      inner = await gunzip(bytes);
    } catch (err) {
      acc.warnings.push(`Could not gunzip ${name}: ${err.message}`);
      return;
    }
    const innerName = String(name || "file").replace(/\.gz$/i, "") || "decompressed.xml";
    await pushFileBlocks(env, innerName, mimeFromName(innerName), inner, acc);
    return;
  }

  // ZIP container (DMARC `.zip`, or a bundle): expand and route each entry.
  if (looksZip(bytes, name, ct)) {
    let entries;
    try {
      entries = readZipEntries(toArrayBuffer(bytes));
    } catch (err) {
      acc.warnings.push(`Could not read zip ${name}: ${err.message}`);
      return;
    }
    for (const [entryName, entry] of entries) {
      if (acc.blocks.length >= acc.maxFiles) break;
      if (entryName.endsWith("/") || entryName.startsWith("__MACOSX/")) continue;
      let raw;
      try {
        raw = entry.method === 0 ? entry.raw : await inflateRaw(entry.raw);
      } catch (err) {
        acc.warnings.push(`Could not inflate ${entryName} in ${name}: ${err.message}`);
        continue;
      }
      await pushFileBlocks(env, entryName, mimeFromName(entryName), raw, acc);
    }
    return;
  }

  // Plain file: hand to the shared router (pdf/image/office/text/xml/svg).
  const mime = cleanMime(ct) || mimeFromName(name);
  if (!mime) {
    acc.warnings.push(`Skipped ${name} (could not determine type).`);
    return;
  }
  let built;
  try {
    built = await buildBlock(env, mime, toArrayBuffer(bytes), name);
  } catch (err) {
    acc.warnings.push(`Could not read ${name}: ${err.message}`);
    return;
  }
  if (!built) {
    acc.warnings.push(`Unsupported attachment ${name} (${mime}).`);
    return;
  }
  if (acc.totalBytes + built.bytes > TOTAL_HARD_BYTES) {
    acc.warnings.push(`Skipped ${name} (would exceed ${TOTAL_HARD_BYTES} byte budget).`);
    return;
  }
  acc.blocks.push(built.block);
  acc.totalBytes += built.bytes;
  acc.names.push(name);
}

/**
 * Expand a message forwarded "as attachment" (itemAttachment): the forwarded
 * body becomes a text block and any nested file attachments are routed too.
 * Graph does not always surface deeply nested attachments, but the body text
 * alone keeps the model from claiming it saw nothing.
 *
 * @param {object} env
 * @param {(path: string) => Promise<any>} graphJson
 * @param {string} messageId
 * @param {object} att - the itemAttachment summary
 * @param {object} acc
 * @returns {Promise<void>}
 */
async function expandItemAttachment(env, graphJson, messageId, att, acc) {
  let data;
  try {
    data = await graphJson(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.id)}` +
        `?$expand=microsoft.graph.itemAttachment/item`,
    );
  } catch (err) {
    acc.warnings.push(`Could not open forwarded message ${att.name || att.id}: ${err.message}`);
    return;
  }
  const item = data?.item;
  if (!item) return;

  if (acc.blocks.length < acc.maxFiles) {
    const text = String(item.body?.content || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
    if (text) {
      acc.blocks.push({ type: "text", text: `[Forwarded message: ${item.subject || "(no subject)"}]\n${text}` });
      acc.names.push(item.subject || "forwarded message");
    }
  }

  for (const na of item.attachments || []) {
    if (acc.blocks.length >= acc.maxFiles) break;
    if (na["@odata.type"] !== "#microsoft.graph.fileAttachment" || !na.contentBytes) continue;
    if (na.isInline && !inlineWorthReading(na)) continue; // keep pasted screenshots, drop logos
    await pushFileBlocks(env, na.name || "attachment", na.contentType, base64ToBytes(na.contentBytes), acc);
  }
}

/**
 * Build Anthropic content blocks for the readable attachments on a Graph
 * message. The blocks are meant to be returned from a chat tool handler as
 * `{ toolResultContent: [...] }`, or prepended to a poller's user turn.
 *
 * @param {object} env - worker env (passed through to buildBlock for IMAGES transcode)
 * @param {(path: string) => Promise<any>} graphJson
 *   Authenticated Graph GET returning parsed JSON for a path RELATIVE to the
 *   target mailbox, e.g. `/messages/{id}/attachments`. The bot supplies this
 *   bound to its own mailbox + app credentials.
 * @param {string} messageId
 * @param {{maxFiles?: number}} [opts]
 * @returns {Promise<{blocks: object[], warnings: string[], names: string[]}>}
 */
export async function buildEmailAttachmentBlocks(env, graphJson, messageId, opts = {}) {
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
  const acc = { blocks: [], warnings: [], names: [], totalBytes: 0, maxFiles };

  let data;
  try {
    data = await graphJson(`/messages/${encodeURIComponent(messageId)}/attachments`);
  } catch (err) {
    return { blocks: [], warnings: [`Could not list attachments: ${err.message}`], names: [] };
  }

  const atts = Array.isArray(data?.value) ? data.value : [];
  for (const a of atts) {
    if (acc.blocks.length >= maxFiles) break;
    const odataType = a["@odata.type"];

    if (odataType === "#microsoft.graph.itemAttachment") {
      await expandItemAttachment(env, graphJson, messageId, a, acc);
      continue;
    }
    if (odataType !== "#microsoft.graph.fileAttachment") continue;
    // Inline: keep a pasted screenshot, skip signature logos / icons / pixels.
    if (a.isInline && !inlineWorthReading(a)) continue;

    // Graph omits contentBytes from the list response for larger attachments;
    // fetch the single attachment to get the bytes.
    if (!a.contentBytes) {
      try {
        const full = await graphJson(
          `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.id)}`,
        );
        if (full?.contentBytes) a.contentBytes = full.contentBytes;
      } catch {
        /* fall through to the skip below */
      }
    }
    if (!a.contentBytes) {
      acc.warnings.push(`Skipped ${a.name || a.id} (no content returned by Graph).`);
      continue;
    }
    await pushFileBlocks(env, a.name || "attachment", a.contentType, base64ToBytes(a.contentBytes), acc);
  }

  return { blocks: acc.blocks, warnings: acc.warnings, names: acc.names };
}

/**
 * Convenience wrapper for email pollers that already hold a Graph app token and
 * the target mailbox address: builds the `/users/{mailbox}` GET closure for you
 * and returns the attachment content blocks. Lets a cron poller decode a
 * forwarded report (DMARC/PDF/etc.) in one call instead of re-deriving the Graph
 * plumbing in every job.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.token - Graph access token (app-only)
 * @param {string} opts.mailbox - mailbox address the message lives in
 * @param {string} opts.messageId
 * @param {string} [opts.graphBase="https://graph.microsoft.com/v1.0"]
 * @param {number} [opts.maxFiles]
 * @returns {Promise<{blocks: object[], warnings: string[], names: string[]}>}
 */
export async function emailAttachmentBlocksByToken(env, { token, mailbox, messageId, graphBase = "https://graph.microsoft.com/v1.0", maxFiles } = {}) {
  if (!token || !mailbox || !messageId) {
    return { blocks: [], warnings: ["emailAttachmentBlocksByToken: token, mailbox, and messageId are required"], names: [] };
  }
  const mb = encodeURIComponent(mailbox);
  const graphJson = async (path) => {
    const res = await fetch(`${graphBase}/users/${mb}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`graph ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };
  return buildEmailAttachmentBlocks(env, graphJson, messageId, maxFiles ? { maxFiles } : {});
}
