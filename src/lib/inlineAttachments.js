// =============================================================================
// lib/inlineAttachments.js : Attachments that carry their own bytes.
//
// FleetView's chat panel has no Nexus upload to point at, so it sends images
// inline: { name, content_type, data_base64 }. This module validates one and
// turns it into the same base64 image content block the URL path builds.
// Images only: png, jpeg, webp, gif. Cap 6 MB decoded.
// =============================================================================

export const INLINE_MAX_BYTES = 6 * 1024 * 1024;

const INLINE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * True when the attachment is the inline form (bytes in the payload, no url).
 * @param {object} att
 * @returns {boolean}
 */
export function isInlineAttachment(att) {
  return Boolean(att) && typeof att.data_base64 === "string" && !att.url;
}

/**
 * Decoded size of a base64 string without decoding it.
 * @param {string} b64
 * @returns {number}
 */
function decodedLength(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Build an image content block from one inline attachment.
 * Returns null (after a console.warn) for a wrong type, oversize or bad data.
 *
 * @param {{ name?: string, content_type?: string, data_base64: string }} att
 * @returns {{ block: object, bytes: number } | null}
 */
export function buildInlineImageBlock(att) {
  const mime = String(att?.content_type || "").toLowerCase();
  const label = att?.name || "inline image";
  if (!INLINE_IMAGE_MIME.has(mime)) {
    console.warn(`[inlineAttachments] skipping ${label}: unsupported type ${mime || "?"}`);
    return null;
  }
  const data = att.data_base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length === 0) {
    console.warn(`[inlineAttachments] skipping ${label}: not valid base64`);
    return null;
  }
  const bytes = decodedLength(data);
  if (bytes > INLINE_MAX_BYTES) {
    console.warn(`[inlineAttachments] skipping ${label}: ${bytes} bytes exceeds cap ${INLINE_MAX_BYTES}`);
    return null;
  }
  return { block: { type: "image", source: { type: "base64", media_type: mime, data } }, bytes };
}
