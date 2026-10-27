// =============================================================================
// lib/imageTranscode.js, Transcode exotic image formats into JPEG.
//
// Anthropic vision accepts only image/png, image/jpeg, image/gif, image/webp.
// iPhone photos (HEIC) and other raster formats (TIFF, BMP, AVIF) are common on
// Nexus but unreadable by the model, so we run them through the Cloudflare
// Images binding (env.IMAGES) to produce a JPEG the model CAN read.
//
// The binding must be declared in each bot's wrangler.toml:
//   [images]
//   binding = "IMAGES"
//
// Callers should treat a null return as "couldn't transcode" and surface a
// warning rather than failing the turn.
// =============================================================================

const EXOTIC_IMAGE_MIME = new Set([
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
  "image/x-ms-bmp",
  "image/avif",
]);

/**
 * True if the mime is a raster image Claude can't read natively but the Images
 * binding can transcode.
 * @param {string} mime
 * @returns {boolean}
 */
export function isExoticImageMime(mime) {
  return EXOTIC_IMAGE_MIME.has(String(mime || "").toLowerCase());
}

/**
 * Transcode an arbitrary supported image buffer to JPEG using the Cloudflare
 * Images binding. Returns the JPEG bytes, or null if the binding is missing or
 * the transform fails (caller decides how to warn).
 *
 * @param {object} imagesBinding - env.IMAGES (ImagesBinding) or undefined
 * @param {ArrayBuffer} buf - the source image bytes
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function transcodeToJpeg(imagesBinding, buf) {
  if (!imagesBinding || typeof imagesBinding.input !== "function") return null;
  try {
    const result = await imagesBinding
      .input(new Blob([buf]).stream())
      .output({ format: "image/jpeg" });
    return await new Response(result.image()).arrayBuffer();
  } catch (err) {
    console.warn("[imageTranscode] transcode failed:", err?.message || String(err));
    return null;
  }
}
