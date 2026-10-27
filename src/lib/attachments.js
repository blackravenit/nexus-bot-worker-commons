// =============================================================================
// lib/attachments.js, Multimodal attachment loader for Nexus bot callbacks.
//
// Nexus's dispatchBotCallback (worker/src/lib/message-insert.js) hydrates the
// payload it sends to each bot with an `attachments` array of the form:
//
//   [{
//     id:         <attachment uuid>,
//     filename:   <display name>,
//     mime_type:  <e.g. application/pdf, image/png>,
//     size_bytes: <integer>,
//     url:        "/api/internal/attachments/<id>"   // server-relative
//   }, ...]
//
// This module turns that list into Anthropic Messages API content blocks:
//
//   PDFs            -> { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
//   Native images   -> { type: "image",    source: { type: "base64", media_type: <mime>, data } }
//     (png, jpeg, gif, webp, the only formats Anthropic vision accepts)
//   Exotic images   -> transcoded to JPEG via env.IMAGES, then an image block
//     (heic, heif, tiff, bmp, avif, e.g. iPhone photos)
//   Word / Excel    -> { type: "text", text: <extracted document text> }
//     (.docx/.xlsx have no native reader; we crack the OOXML zip ourselves)
//   SVG + text/*    -> { type: "text", text: <source / file text> }
//
// Fetch auth: GET <NEXUS_BASE_URL><url> with X-Internal-Token = INTERNAL_ADMIN_TOKEN.
// The Nexus worker exposes /api/internal/attachments/:id behind that same token
// (see nexus-app/worker/src/routes/attachments.js handleInternalDownloadAttachment).
//
// Hard caps:
//   - Per-file:  10 MB (skip oversized; the caller can surface the warning)
//   - Aggregate: 32 MB (Anthropic absolute) AND a soft 3 MB working budget;
//                we honor whichever limit hits first, dropping later files
//                once the budget is spent.
//
// Per-file failures (404, 502, decode errors) are skipped with a console.warn
// and a warning text returned to the caller; they never abort the LLM call.
// =============================================================================

import { extractOfficeText, isOfficeMime } from "./officeText.js";
import { isExoticImageMime, transcodeToJpeg } from "./imageTranscode.js";
import { buildInlineImageBlock, isInlineAttachment } from "./inlineAttachments.js";

const PER_FILE_MAX_BYTES = 10 * 1024 * 1024;
const TOTAL_SOFT_BYTES = 3 * 1024 * 1024;
const TOTAL_HARD_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

// Formats Anthropic vision accepts as-is.
const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

const PDF_MIME = "application/pdf";
const SVG_MIME = "image/svg+xml";

// Text-ish mimes we can decode straight to a text block. Anything matching
// text/* is also treated as text (covers text/markdown, text/csv, etc.).
const TEXT_MIME = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);

/**
 * Base64-encode an ArrayBuffer using btoa via Latin1 chunked conversion.
 * Workers expose btoa but not Buffer; chunking avoids "too many arguments"
 * on apply() for multi-MB buffers.
 *
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return btoa(binary);
}

/**
 * Whether this module knows how to turn the given mime into a content block.
 * Mirrors the routing in fetchOne so callers can pre-flight without fetching.
 * @param {string} mime
 * @returns {boolean}
 */
export function isSupportedAttachmentMime(mime) {
  const m = String(mime || "").toLowerCase();
  return (
    m === PDF_MIME ||
    m === SVG_MIME ||
    IMAGE_MIME.has(m) ||
    isExoticImageMime(m) ||
    isOfficeMime(m) ||
    TEXT_MIME.has(m) ||
    m.startsWith("text/")
  );
}

/**
 * Fetch one attachment from Nexus and convert to an Anthropic content block.
 * Returns null if the file is over the per-file cap, the mime is unsupported,
 * or the fetch/conversion fails.
 *
 * @param {object} env
 * @param {string} baseUrl
 * @param {string} token
 * @param {object} att
 * @returns {Promise<{ block: object, bytes: number } | null>}
 */
async function fetchOne(env, baseUrl, token, att) {
  if (!att || !att.url || !att.mime_type) return null;

  const mime = String(att.mime_type).toLowerCase();
  if (!isSupportedAttachmentMime(mime)) {
    console.log(`[attachments] skipping unsupported mime ${mime} (${att.filename})`);
    return null;
  }

  if (typeof att.size_bytes === "number" && att.size_bytes > PER_FILE_MAX_BYTES) {
    console.warn(
      `[attachments] skipping ${att.filename}, ${att.size_bytes} bytes exceeds per-file cap ${PER_FILE_MAX_BYTES}`
    );
    return null;
  }

  const fetchUrl = `${baseUrl.replace(/\/$/, "")}${att.url}`;
  let resp;
  try {
    resp = await fetch(fetchUrl, {
      method: "GET",
      headers: { "X-Internal-Token": token },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[attachments] fetch failed for ${att.id}:`, err?.message);
    return null;
  }
  if (!resp.ok) {
    console.warn(`[attachments] non-2xx for ${att.id}: ${resp.status}`);
    return null;
  }

  let buf;
  try {
    buf = await resp.arrayBuffer();
  } catch (err) {
    console.warn(`[attachments] body read failed for ${att.id}:`, err?.message);
    return null;
  }

  if (buf.byteLength > PER_FILE_MAX_BYTES) {
    console.warn(
      `[attachments] ${att.filename} exceeded per-file cap after fetch (${buf.byteLength} bytes)`
    );
    return null;
  }

  return buildBlock(env, mime, buf, att.filename);
}

/**
 * Route a fetched buffer to the right Anthropic content block based on mime.
 * Shared by the inline-attachment path and the nexus_load_attachment tool.
 *
 * @param {object} env - worker env (reads IMAGES binding for exotic transcode)
 * @param {string} mime - lower-cased mime type
 * @param {ArrayBuffer} buf - the raw file bytes
 * @param {string} [filename]
 * @returns {Promise<{ block: object, bytes: number } | null>}
 */
export async function buildBlock(env, mime, buf, filename) {
  // --- PDF: native document block ---
  if (mime === PDF_MIME) {
    return {
      block: { type: "document", source: { type: "base64", media_type: PDF_MIME, data: bufferToBase64(buf) } },
      bytes: buf.byteLength,
    };
  }

  // --- Native images: straight through ---
  if (IMAGE_MIME.has(mime)) {
    return {
      block: { type: "image", source: { type: "base64", media_type: mime, data: bufferToBase64(buf) } },
      bytes: buf.byteLength,
    };
  }

  // --- Exotic raster (HEIC/TIFF/BMP/AVIF): transcode to JPEG via Images ---
  if (isExoticImageMime(mime)) {
    const jpeg = await transcodeToJpeg(env.IMAGES, buf);
    if (!jpeg) {
      console.warn(`[attachments] could not transcode ${mime} (${filename}); IMAGES binding missing or failed`);
      return null;
    }
    return {
      block: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: bufferToBase64(jpeg) } },
      bytes: jpeg.byteLength,
    };
  }

  // --- Word / Excel: extract text, hand over as a text block ---
  if (isOfficeMime(mime)) {
    let text;
    try {
      text = await extractOfficeText(buf, mime);
    } catch (err) {
      console.warn(`[attachments] office extract failed for ${filename}:`, err?.message || String(err));
      return null;
    }
    if (!text) return null;
    const label = filename ? `Contents of ${filename}` : "Attached document contents";
    return {
      block: { type: "text", text: `${label}:\n\n${text}` },
      bytes: text.length,
    };
  }

  // --- SVG + any text/* (markdown, csv, json, xml, yaml, plain): decode text ---
  if (mime === SVG_MIME || TEXT_MIME.has(mime) || mime.startsWith("text/")) {
    let text;
    try {
      text = new TextDecoder("utf-8").decode(buf);
    } catch (err) {
      console.warn(`[attachments] text decode failed for ${filename}:`, err?.message || String(err));
      return null;
    }
    const label = filename ? `Contents of ${filename} (${mime})` : `Attached ${mime} contents`;
    return {
      block: { type: "text", text: `${label}:\n\n${text}` },
      bytes: text.length,
    };
  }

  return null;
}

/**
 * Convert the inbound `attachments` array (from the Nexus callback payload)
 * into Anthropic Messages API content blocks. Returns the blocks ready to
 * prepend in front of the user's text turn, plus a human-readable warning
 * for any files that were skipped.
 *
 * Bot workers should pass these blocks into the user-turn content array
 * BEFORE the text body. They will be the first thing Claude sees, which
 * matters for documents (the OUTPUT CONTRACT pattern relies on text last).
 *
 * @param {object} env, worker env (reads INTERNAL_ADMIN_TOKEN, NEXUS_BASE_URL, IMAGES)
 * @param {Array<object>} attachments, payload.attachments from Nexus
 * @param {object} [options]
 * @param {string} [options.tokenEnvVar=NEXUS_INTERNAL_TOKEN]
 *   Override the env var name carrying the X-Internal-Token. Falls back to
 *   INTERNAL_ADMIN_TOKEN for parity with Nexus's own internal-route gates.
 * @param {string} [options.baseUrlEnvVar=NEXUS_BASE_URL]
 *   Override the env var name carrying the Nexus base URL.
 * @returns {Promise<{ blocks: Array<object>, warnings: string[] }>}
 */
async function buildUrlAttachmentBlocks(env, attachments, options = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { blocks: [], warnings: [] };
  }

  const tokenEnvVar = options.tokenEnvVar || "NEXUS_INTERNAL_TOKEN";
  const baseUrlEnvVar = options.baseUrlEnvVar || "NEXUS_BASE_URL";
  const token = env[tokenEnvVar] || env.INTERNAL_ADMIN_TOKEN;
  const baseUrl = env[baseUrlEnvVar];

  if (!token || !baseUrl) {
    console.warn(
      `[attachments] missing ${tokenEnvVar}/INTERNAL_ADMIN_TOKEN or ${baseUrlEnvVar}, skipping ${attachments.length} attachment(s)`
    );
    return {
      blocks: [],
      warnings: [
        `Could not load ${attachments.length} attachment(s): bot worker is missing Nexus internal access credentials. Ask Brian to set ${tokenEnvVar} and ${baseUrlEnvVar}.`,
      ],
    };
  }

  const blocks = [];
  const warnings = [];
  let totalBytes = 0;

  for (const att of attachments) {
    if (totalBytes >= TOTAL_SOFT_BYTES) {
      warnings.push(
        `Skipped ${att.filename || att.id}, attachment budget (${TOTAL_SOFT_BYTES} bytes) already spent.`
      );
      continue;
    }
    const result = await fetchOne(env, baseUrl, token, att);
    if (!result) {
      warnings.push(`Could not read ${att.filename || att.id} (mime ${att.mime_type || "?"}).`);
      continue;
    }
    if (totalBytes + result.bytes > TOTAL_HARD_BYTES) {
      warnings.push(
        `Skipped ${att.filename || att.id}, would exceed Anthropic 32 MB cap.`
      );
      continue;
    }
    blocks.push(result.block);
    totalBytes += result.bytes;
  }

  return { blocks, warnings };
}

/**
 * Public entry. Inline attachments ({ name, content_type, data_base64 }, sent
 * by FleetView) are decoded in place and need no Nexus credentials; every
 * other attachment goes through the URL fetch path unchanged.
 *
 * @param {object} env
 * @param {Array<object>} attachments
 * @param {object} [options] - same as the URL path (tokenEnvVar, baseUrlEnvVar)
 * @returns {Promise<{ blocks: Array<object>, warnings: string[] }>}
 */
export async function buildAttachmentContentBlocks(env, attachments, options = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { blocks: [], warnings: [] };
  }
  const blocks = [];
  const warnings = [];
  for (const att of attachments.filter(isInlineAttachment)) {
    const built = buildInlineImageBlock(att);
    if (built) blocks.push(built.block);
    else warnings.push(`Could not read ${att.name || "an inline image"} (type ${att.content_type || "?"}).`);
  }
  const remote = attachments.filter((att) => !isInlineAttachment(att));
  const fromUrls = await buildUrlAttachmentBlocks(env, remote, options);
  return { blocks: [...blocks, ...fromUrls.blocks], warnings: [...warnings, ...fromUrls.warnings] };
}
