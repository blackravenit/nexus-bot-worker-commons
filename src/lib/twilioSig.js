// =============================================================================
// lib/twilioSig.js -- Twilio webhook signature validation.
//
// Every inbound Twilio webhook (voice or SMS) is signed by Twilio. We
// validate the X-Twilio-Signature header against the canonical string
// Twilio produces from the full URL plus alphabetically-sorted form params.
//
// Twilio docs:
//   https://www.twilio.com/docs/usage/security#validating-requests
//
// Algorithm:
//   1. Take the FULL URL (including query string) the request hit.
//   2. Append each form param key+value (no separator) sorted by key.
//   3. HMAC-SHA1 with the Twilio auth token as the key, base64-encode.
//   4. Compare to X-Twilio-Signature header.
//
// Constant-time compare -- even though the header is base64 (so timing
// leaks via length are fixed), still don't short-circuit on byte mismatch.
//
// Shared across every bot worker with an inbound Twilio route (voice or
// SMS): originally lived only in voice-agent-bridge; promoted here so
// robert-worker's inbound SMS webhook (and any future bot) can reuse the
// exact same algorithm instead of a second hand-rolled copy.
// =============================================================================

/**
 * @param {object} env - CF Worker env bindings (needs TWILIO_AUTH_TOKEN)
 * @param {Request} request
 * @param {URLSearchParams|FormData} formParams - the parsed body
 * @returns {Promise<boolean>}
 */
export async function verifyTwilioSignature(env, request, formParams) {
  const expectedSig = request.headers.get("X-Twilio-Signature");
  if (!expectedSig) return false;

  const token = env.TWILIO_AUTH_TOKEN;
  if (!token) {
    console.warn("[twilioSig] TWILIO_AUTH_TOKEN unset -- refusing to validate");
    return false;
  }

  // Twilio expects the URL Twilio CALLED, not what the worker sees
  // post-routing. Workers expose request.url verbatim -- that's the URL
  // Twilio hit. No reconstruction needed.
  const url = request.url;

  // Form params sorted alphabetically by key, concatenated as
  // key+value+key+value (no separator).
  const entries = [];
  if (formParams) {
    if (typeof formParams.entries === "function") {
      for (const [k, v] of formParams.entries()) entries.push([k, v]);
    } else if (typeof formParams.forEach === "function") {
      formParams.forEach((v, k) => entries.push([k, v]));
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const paramStr = entries.map(([k, v]) => `${k}${v}`).join("");

  const data = url + paramStr;

  // HMAC-SHA1 via Web Crypto (Workers built-in)
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  // Base64-encode the raw HMAC bytes
  const sigB64 = bytesToBase64(new Uint8Array(sigBytes));

  return constantTimeEquals(sigB64, expectedSig);
}

/**
 * Constant-time string compare. Both args are plain JS strings; we
 * compare byte-by-byte without short-circuiting.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
