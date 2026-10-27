// =============================================================================
// lib/callbackSign.js - HMAC-SHA256 signature verification for Nexus callbacks
//
// Nexus signs every callback with HMAC-SHA256 using the per-bot callback
// secret. The signed string is:
//   "<unix-seconds>.<raw-body-string>"
//
// Headers set by Nexus:
//   X-Nexus-Timestamp: <unix-seconds>
//   X-Nexus-Signature: sha256=<hex>
//
// Exported functions:
//   verifyNexusSignature(secret, rawBody, headers, [options]) -> Promise<boolean>
//   timingSafeEqual(a, b) -> boolean
//
// Hard rules:
//   - No module-level I/O (no fetch, no Response, no crypto at top level).
//   - Constant-time comparison via XOR accumulator.
//   - Default replay window: 300 seconds.
// =============================================================================

/**
 * Constant-time byte-array comparison using XOR accumulator.
 * Returns false immediately if lengths differ (length difference is not secret,
 * but we prevent short-circuit on content).
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify the X-Nexus-Timestamp and X-Nexus-Signature headers on an inbound
 * Nexus callback. Rejects if the secret is missing, the timestamp is outside
 * the replay window, or the computed HMAC does not match the provided signature.
 *
 * @param {string} secret - The per-bot HMAC signing secret (from env)
 * @param {string} rawBody - The raw request body string (already read)
 * @param {Headers} headers - The inbound request headers
 * @param {object} [options]
 * @param {number} [options.replayWindowSec=300] - Max age before rejection
 * @returns {Promise<boolean>}
 */
export async function verifyNexusSignature(secret, rawBody, headers, options = {}) {
  const replayWindowSec = options.replayWindowSec ?? 300;

  if (!secret) {
    console.warn("[callbackSign] secret not provided, rejecting");
    return false;
  }

  const ts = headers.get("X-Nexus-Timestamp") || headers.get("x-nexus-timestamp") || "";
  const sig = headers.get("X-Nexus-Signature") || headers.get("x-nexus-signature") || "";

  if (!ts || !sig) return false;

  const tsNum = Number(ts);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > replayWindowSec) {
    console.warn("[callbackSign] timestamp out of window:", ts);
    return false;
  }

  const enc = new TextEncoder();
  const signingInput = `${ts}.${rawBody}`;

  let keyMaterial;
  try {
    keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    console.error("[callbackSign] importKey failed:", err.message);
    return false;
  }

  const sigBuf = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(signingInput));
  const expectedHex = "sha256=" + Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(enc.encode(sig), enc.encode(expectedHex));
}

/**
 * Sign a callback body exactly the way Nexus signs outbound bot callbacks --
 * HMAC-SHA256 over "<unix-seconds>.<rawBody>", header value "sha256=<hex>".
 * The inverse of {@link verifyNexusSignature}; used by the contract test
 * harness to replay signed fixtures against a bot's real routes, and available
 * to any commons-side sender. Wire-identical to nexus-app's signCallback.
 *
 * @param {string} secret - The per-bot HMAC signing secret
 * @param {string} rawBody - The exact body string that will be POSTed
 * @param {object} [options]
 * @param {number} [options.timestamp] - Unix seconds override (default: now).
 *   Pass a stale value to exercise replay-window rejection in tests.
 * @returns {Promise<{ timestamp: string, signature: string }>}
 */
export async function signCallback(secret, rawBody, options = {}) {
  const ts = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${rawBody}`));
  const signature = "sha256=" + Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { timestamp: ts, signature };
}
