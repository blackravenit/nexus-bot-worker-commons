// =============================================================================
// lib/recordingPlayback.js - sign and verify Twilio recording playback links
//
// Twilio recording media is auth-protected: the stored URL 401s for anyone who is
// not holding the owning account's credentials, so an <audio src> pointing
// straight at it plays nothing. Those credentials cannot go to a browser, so the
// bridge, which already holds them, proxies the bytes behind a signed, expiring
// link.
//
// The signature is the access control. A recording sid is guessable enough that
// an unsigned endpoint would hand call audio to anyone who asked, and these are
// recordings of real prospects and real support calls.
//
// Only the SID travels, never a URL. Taking a URL would make this a proxy for any
// host the caller names, so the Twilio URL is rebuilt here from a strictly
// validated sid instead.
//
// Lives in commons because TWO workers need it and they must agree exactly: the
// bridge verifies what the CRM signed. Two copies of an HMAC scheme is two
// implementations that agree until one is edited.
//
// Hard rules: no em dashes, ES modules, no global-scope I/O.
// =============================================================================

/**
 * HMAC-SHA256 as lowercase hex. Inlined rather than imported so this module is
 * self contained: it is shared across workers and must not drag a dependency
 * chain into whichever one imports it.
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Twilio recording sids: RE + 32 hex. Anything else is not a sid. */
const RECORDING_SID_RE = /^RE[0-9a-f]{32}$/i;

/** How long a minted playback link stays valid. */
export const PLAYBACK_TTL_SEC = 60 * 60 * 6;

/**
 * The key playback links are signed with. Falls back to the dial HMAC secret so
 * an operator does not have to provision a second secret before this works.
 * @param {object} env
 * @returns {string}
 */
export function playbackSigningKey(env) {
  return env?.RECORDING_PLAYBACK_KEY || env?.DIAL_HMAC_SECRET || '';
}

/**
 * @param {string} sid
 * @returns {boolean}
 */
export function isRecordingSid(sid) {
  return RECORDING_SID_RE.test(String(sid || ''));
}

/**
 * Pull the recording sid out of a stored Twilio media URL.
 *
 * recording_url is stored as the Twilio resource URL plus .mp3, so the sid is
 * already on disk and no column had to be added to carry it.
 * @param {string} url
 * @returns {string} the sid, or '' when the URL is not a Twilio recording
 */
export function recordingSidFromUrl(url) {
  const m = String(url || '').match(/\/Recordings\/(RE[0-9a-f]{32})(?:\.\w+)?(?:\?|$)/i);
  return m ? m[1] : '';
}

/**
 * Mint a signed, expiring playback URL.
 * @param {object} env
 * @param {string} sid
 * @param {object} [opts]
 * @param {string} [opts.host] - the bridge host to point at
 * @param {number} [opts.ttlSec]
 * @param {number} [opts.now] - ms, for tests
 * @returns {Promise<string>} the URL, or '' when it cannot be signed
 */
export async function signPlaybackUrl(env, sid, opts = {}) {
  const key = playbackSigningKey(env);
  if (!key || !isRecordingSid(sid)) return '';
  const host = opts.host
    || String(env.BRIDGE_PUBLIC_URL || 'https://voice-agent-bridge.blackravenit.workers.dev')
      .replace(/^https?:\/\//, '').replace(/\/$/, '');
  const nowMs = opts.now ?? Date.now();
  const exp = Math.floor(nowMs / 1000) + (opts.ttlSec ?? PLAYBACK_TTL_SEC);
  const sig = await hmacHex(key, `${sid}.${exp}`);
  return `https://${host}/audio/recording?sid=${encodeURIComponent(sid)}&exp=${exp}&sig=${sig}`;
}

/**
 * Constant-time string compare, so a wrong signature cannot be narrowed by
 * timing one character at a time.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualHex(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a playback request's signature and expiry.
 * @param {object} env
 * @param {URL} url
 * @param {number} [nowMs]
 * @returns {Promise<{ok: boolean, sid?: string, reason?: string}>}
 */
export async function verifyPlaybackRequest(env, url, nowMs = Date.now()) {
  const key = playbackSigningKey(env);
  if (!key) return { ok: false, reason: 'no signing key configured' };
  const sid = url.searchParams.get('sid') || '';
  const exp = parseInt(url.searchParams.get('exp') || '0', 10);
  const sig = url.searchParams.get('sig') || '';
  if (!isRecordingSid(sid)) return { ok: false, reason: 'bad sid' };
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'bad exp' };
  if (Math.floor(nowMs / 1000) > exp) return { ok: false, reason: 'link expired' };
  const expected = await hmacHex(key, `${sid}.${exp}`);
  if (!timingSafeEqualHex(sig, expected)) return { ok: false, reason: 'bad signature' };
  return { ok: true, sid };
}
