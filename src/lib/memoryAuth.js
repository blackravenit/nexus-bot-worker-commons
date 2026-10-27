// =============================================================================
// lib/memoryAuth.js - Per-caller request signing for the memory-worker.
//
// memory-worker is reachable only via Cloudflare service binding (same-account,
// no public route), so there is no EXTERNAL attack surface. This signing exists
// to contain INTERNAL blast radius: without it, any fleet worker could set
// `X-Memory-Bot: <sibling>` and read/write another bot's memory. Each caller
// signs with a per-caller key derived from a master secret that only the
// memory-worker holds, so a compromised worker can only act as itself.
//
// Key derivation (done at provisioning time, mirrored in memory-worker):
//   MEMORY_SIGNING_KEY = hex(HMAC-SHA256(MEMORY_MASTER_SECRET, callerId))
// Request signature:
//   sig = hex(HMAC-SHA256(MEMORY_SIGNING_KEY, `${callerId}\n${botId}\n${ts}`))
//
// callerId is the signing identity (usually == botId; voice-bridge signs as
// "voice-bridge" because it writes under every persona's bot_id). botId stays
// the data-scope (X-Memory-Bot) the memory-worker already keys storage on.
// =============================================================================

/**
 * HMAC-SHA256(keyStr, msg) as lowercase hex. The key is used as raw UTF-8
 * bytes of the (hex) key string, both sides treat it identically, so no
 * hex-decoding mismatch can occur.
 * @param {string} keyStr
 * @param {string} msg
 * @returns {Promise<string>}
 */
export async function memoryHmacHex(keyStr, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the auth headers for a memory-worker request. Returns an empty object
 * when MEMORY_SIGNING_KEY is unset (pre-provisioning / unsigned mode), so the
 * client stays backward compatible until keys are rolled out.
 *
 * @param {object} env - worker env (reads MEMORY_SIGNING_KEY, MEMORY_CALLER_ID)
 * @param {string} botId - data scope (X-Memory-Bot)
 * @returns {Promise<Record<string,string>>}
 */
export async function buildMemoryAuthHeaders(env, botId) {
  const signingKey = env?.MEMORY_SIGNING_KEY;
  if (!signingKey) return {};
  const caller = env.MEMORY_CALLER_ID || botId;
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await memoryHmacHex(signingKey, `${caller}\n${botId}\n${ts}`);
  return {
    "X-Memory-Caller": caller,
    "X-Memory-Timestamp": ts,
    "X-Memory-Sig": sig,
  };
}
