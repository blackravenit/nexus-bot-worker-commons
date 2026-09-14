// =============================================================================
// lib/nexus.js - Nexus comms-app integration for bot workers
//
// Provides:
//   postToNexus(env, slug, content, [options])      - POST markdown to a channel
//                                                     (auto-switches to channel-gated
//                                                     Bearer route when attachment_ids
//                                                     supplied so images render inline)
//   uploadBotAttachment(env, bytes, filename, mime, [options]) - upload file, get id
//   attachButtons(env, messageId, buttons, [options]) - attach interactive buttons
//   sendNexusHeartbeat(env, [meta], [options])       - heartbeat ping
//   sendTyping(env, slug, action, [options])        - "<bot> is typing..." indicator
//
// options:
//   nexusKeyEnvVar     {string} - env var name for the API key (default: inferred below)
//   callbackSecretEnvVar {string} - env var name for button callback_secret
//
// Auth: X-API-Key: <env[nexusKeyEnvVar]> on every request (or Bearer
// where the Nexus route requires it; sendTyping uses Bearer).
// Errors are swallowed with console.warn so a Nexus outage never crashes a
// cron job or chat handler. Callers receive null on failure.
//
// Because this library is shared across bots, the nexusKeyEnvVar option
// must be supplied via the options object. postToNexus and attachButtons
// look up the key as env[options.nexusKeyEnvVar]. When options is omitted
// the caller should ensure env.NEXUS_KEY or env[botName + "_NEXUS_KEY"]
// is reachable -- but the canonical path is via options.nexusKeyEnvVar.
//
// NOTE: handleChatMessage passes options automatically from config.
// Direct callers (cron jobs) should pass { nexusKeyEnvVar: "BOT_NEXUS_KEY" }.
//
// Fleet error surfacing: attachButtons and editNexusMessage call
// reportFleetError on failure. postToNexus, sendTyping, sendNexusHeartbeat,
// and pingBotPresence do NOT -- postToNexus would recurse, the typing/
// heartbeat/presence ops are high-frequency ambient calls whose failures
// are expected noise during brief outages and must stay silent.
// =============================================================================

import { getProvenanceContext } from "./provenanceContext.js";
import { scrubFleetDashes } from "./sanitize.js";
import { buildReport } from "./embedCard.js";

// Lazy import to avoid circular dependency: fleetError imports postToNexus,
// so we must not import at module load time (CF Workers module-scope I/O ban
// and circular dep risk). We inline a dynamic import wrapper instead.
// Because CF Workers are module workers, top-level dynamic import is fine
// as long as it happens inside a function body (per-request), not at parse time.
let _reportFleetError = null;
async function _getReportFleetError() {
  if (!_reportFleetError) {
    const mod = await import("./fleetError.js");
    _reportFleetError = mod.reportFleetError;
  }
  return _reportFleetError;
}

const TIMEOUT_MS = 8000;

/**
 * Resolve the Nexus API key from env using the provided env var name or
 * common fallback names.
 *
 * @param {object} env
 * @param {object} [options]
 * @returns {string|undefined}
 */
function resolveNexusKey(env, options = {}) {
  if (options.nexusKeyEnvVar) return env[options.nexusKeyEnvVar];
  // Fallback: try common names so direct callers without options still work
  return env.NEXUS_KEY || env.BOT_NEXUS_KEY;
}

/**
 * Derive a human-readable bot display name from the nexusKeyEnvVar option or
 * the BOT_DISPLAY_NAME env binding. Used when calling reportFleetError so
 * errors in #fleet-errors are attributed to the right bot rather than
 * falling back to "unknown-bot".
 *
 * Resolution order:
 *   1. options.nexusKeyEnvVar stripped of "_NEXUS_KEY" suffix (e.g.
 *      "COURTNEY_NEXUS_KEY" -> "Courtney", "BOT_NEXUS_KEY" -> "Bot")
 *   2. env.BOT_DISPLAY_NAME (wrangler [vars] entry, set per-worker)
 *   3. undefined (reportFleetError uses its own fallback "unknown-bot")
 *
 * @param {object} env
 * @param {object} [options]
 * @returns {string|undefined}
 */
function deriveBotName(env, options = {}) {
  if (options.nexusKeyEnvVar) {
    // Strip the "_NEXUS_KEY" or "_NEXUS_KEY_TEST" suffix and title-case the remainder.
    const raw = options.nexusKeyEnvVar.replace(/_NEXUS_KEY(?:_TEST)?$/, "");
    if (raw && raw !== options.nexusKeyEnvVar) {
      // Convert SCREAMING_SNAKE to Title Case: "COURTNEY" -> "Courtney"
      return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    }
  }
  if (env && env.BOT_DISPLAY_NAME) return String(env.BOT_DISPLAY_NAME);
  return undefined;
}

/**
 * Resolve the callback secret from env.
 *
 * @param {object} env
 * @param {object} [options]
 * @returns {string|undefined}
 */
function resolveCallbackSecret(env, options = {}) {
  if (options.callbackSecretEnvVar) return env[options.callbackSecretEnvVar];
  if (options.callbackSecret) return options.callbackSecret;
  return env.CALLBACK_SECRET || env.BOT_CALLBACK_SECRET;
}

/**
 * POST JSON to a Nexus endpoint using X-API-Key auth and return parsed JSON on success.
 * Throws on non-2xx so callers can catch and log.
 *
 * @param {string} url
 * @param {object} body
 * @param {string} apiKey
 * @returns {Promise<object>}
 */
async function _post(url, body, apiKey, extraHeaders = null) {
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nexus POST ${url} -> ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * POST JSON to a Nexus endpoint using Authorization: Bearer auth and return parsed JSON on success.
 * Used for bot-side component routes (e.g. /api/bot/messages/:id/buttons) which require
 * Bearer token auth rather than X-API-Key.
 * Throws on non-2xx so callers can catch and log.
 *
 * @param {string} url
 * @param {object} body
 * @param {string} apiKey
 * @returns {Promise<object>}
 */
async function _bearerPost(url, body, apiKey, extraHeaders = null) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nexus POST ${url} -> ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Classify whether a thrown Nexus POST error is worth retrying. Network/timeout
 * faults and 5xx/429 responses are transient; other 4xx are caller errors that
 * will fail identically on retry.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function _isRetryableNexusError(err) {
  const msg = err?.message || "";
  const statusMatch = msg.match(/->\s(\d{3}):/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 429 || status >= 500;
  }
  // No HTTP status in the message => network error, timeout, or abort: retry.
  return true;
}

/**
 * POST JSON via Bearer auth with bounded retry on transient failures.
 * Component-attach routes (buttons/modals) use this: a swallowed attach failure
 * strands a button-less HITL card that an analyst cannot action, so a transient
 * blip must not be the difference between a live card and a dead one. Permanent
 * 4xx errors short-circuit immediately.
 *
 * @param {string} url
 * @param {object} body
 * @param {string} apiKey
 * @param {number} [attempts=3] - total tries (1 initial + up to 2 retries)
 * @returns {Promise<object>}
 */
async function _bearerPostWithRetry(url, body, apiKey, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await _bearerPost(url, body, apiKey);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !_isRetryableNexusError(err)) break;
      // Exponential backoff: 300ms then 900ms (~1.2s worst-case added latency).
      await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(3, i)));
    }
  }
  throw lastErr;
}

/**
 * Post a markdown message to a Nexus channel by slug.
 *
 * Default path: POST /api/bot/messages (the X-API-Key bot endpoint).
 * When options.attachment_ids is supplied, switches to the channel-gated
 * Bearer route POST /api/bot/channels/:slug/messages so the file(s) render
 * inline in the channel. The attachment_ids must come from a prior
 * uploadBotAttachment() call by the same bot.
 *
 * Content is truncated to 8000 chars defensively.
 *
 * @param {object} env
 * @param {string} slug - Nexus channel slug (e.g. "robert-soc", "soc-approvals")
 * @param {string} content - markdown body
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string[]} [options.attachment_ids] - attachment ids from uploadBotAttachment
 * @returns {Promise<object|null>} Nexus message object with .id, or null on error
 */
export async function postToNexus(env, slug, content, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) {
    console.warn("[nexus] missing API key or NEXUS_BASE_URL, skipping post");
    return null;
  }
  const raw = typeof content === "string" ? content : String(content);
  const body = scrubFleetDashes(raw).slice(0, 8000);
  const attachmentIds = Array.isArray(options.attachment_ids) && options.attachment_ids.length > 0
    ? options.attachment_ids
    : null;

  // postedVia identifies the helper that built the post (postHitlCard,
  // buildReport, bangAlert, bangReport, fleetError). Hand-rolled posts
  // default to "raw".
  const postedVia = options.postedVia || "raw";
  const extraHeaders = { "X-Bot-Posted-Via": postedVia };

  try {
    const provenance = options.provenance ?? getProvenanceContext() ?? null;

    // Nexus rejects a provenance-less post with a 400, and the resulting
    // silence is indistinguishable from the bot simply not answering: the
    // reply never appears and the typing indicator never clears. The old
    // failure log named only the channel, so tracking down WHICH call site
    // escaped its withProvenance wrapper meant reading the whole handler.
    // Name the caller at the point the context is found missing.
    if (!provenance) {
      const site = (new Error().stack || "").split("\n").slice(2, 5).join(" | ");
      console.warn(`[nexus] postToNexus(${slug}) has NO provenance (postedVia=${postedVia}); this post will 400. Caller: ${site}`);
    }

    if (attachmentIds) {
      // Channel-gated Bearer route. Required for attachments; provenance mandatory.
      const payload = { body, attachment_ids: attachmentIds };
      if (options.reply_to) payload.reply_to = options.reply_to;
      payload.provenance = provenance || "scheduled-cron";
      const result = await _bearerPost(
        `${env.NEXUS_BASE_URL}/api/bot/channels/${encodeURIComponent(slug)}/messages`,
        payload,
        apiKey,
        extraHeaders,
      );
      pingBotPresence(env, options).catch(() => {});
      return result?.data || null;
    }

    const payload = { channel_slug: slug, body };
    if (options.reply_to) payload.reply_to = options.reply_to;
    if (provenance) payload.provenance = provenance;
    const result = await _post(
      `${env.NEXUS_BASE_URL}/api/bot/messages`,
      payload,
      apiKey,
      extraHeaders,
    );
    // Stamp presence fire-and-forget so the dot turns green. Do not await.
    pingBotPresence(env, options).catch(() => {});
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] postToNexus(${slug}) failed:`, err.message);
    return null;
  }
}

/**
 * Upload bytes as an attachment owned by this bot, return the attachment id.
 *
 * Hits POST /api/bot/attachments (Bearer auth, multipart/form-data). Returns
 * the new attachment id, which can be passed to postToNexus(..., { attachment_ids })
 * so the message renders the image/file inline.
 *
 * Max size: 25 MiB (server-enforced). Caller should chunk or downscale before
 * calling for large media. PNG/JPEG/GIF/WEBP/PDF render inline in the Nexus UI;
 * other mimes display as a download link.
 *
 * @param {object} env
 * @param {Uint8Array | ArrayBuffer | Blob} bytes - file contents
 * @param {string} filename - display filename (e.g. "morphora-quote-card.png")
 * @param {string} mime - mime type (e.g. "image/png")
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<string|null>} attachment id, or null on error
 */
export async function uploadBotAttachment(env, bytes, filename, mime, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) {
    console.warn("[nexus] uploadBotAttachment: missing API key or NEXUS_BASE_URL");
    return null;
  }
  if (!bytes || !filename) {
    console.warn("[nexus] uploadBotAttachment: bytes + filename required");
    return null;
  }

  const blob = bytes instanceof Blob
    ? bytes
    : new Blob([bytes], { type: mime || "application/octet-stream" });

  const form = new FormData();
  form.append("file", blob, filename);

  try {
    const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/attachments`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] uploadBotAttachment(${filename}) -> ${res.status}: ${text}`);
      _getReportFleetError().then(fn => fn(env, {
        bot: deriveBotName(env, options),
        op: "uploadBotAttachment",
        msg: `HTTP ${res.status}: ${text.slice(0, 120)}`,
        ctx: { filename, mime, size: blob.size },
      }, options)).catch(() => {});
      return null;
    }
    const j = await res.json().catch(() => ({}));
    return j?.data?.id || null;
  } catch (err) {
    console.warn(`[nexus] uploadBotAttachment(${filename}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "uploadBotAttachment",
      msg: err.message,
      ctx: { filename, mime },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Detect an image mime type from the first bytes (magic numbers), since some
 * hosts (e.g. Azure Blob) serve images as application/octet-stream. Returns
 * null for non-image bytes so callers can skip them.
 * @param {Uint8Array} buf
 * @returns {{mime: string, ext: string}|null}
 */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: "image/gif", ext: "gif" };
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/**
 * Fetch images by URL and upload them as bot attachments, returning the
 * attachment ids ready for postToNexus(..., { attachment_ids }). Best-effort:
 * any image that fails to fetch, is not actually an image, or exceeds the size
 * cap is skipped, never thrown. Handy for vendor product photos and other
 * remote media that should render inline in a post.
 *
 * @param {object} env
 * @param {Array<string | {url: string, filename?: string}>} images - URLs or
 *   {url, filename} entries. Spaces in URLs are encoded automatically.
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var holding the bot API key
 * @param {number} [options.max=4] - cap on how many images to upload
 * @returns {Promise<string[]>} uploaded attachment ids (order preserved)
 */
export async function attachImagesFromUrls(env, images, options = {}) {
  const MAX_BYTES = 24 * 1024 * 1024; // under the 25 MiB server cap
  const list = (images || [])
    .map((i) => (typeof i === "string" ? { url: i } : i))
    .filter((i) => i && typeof i.url === "string" && i.url.trim());
  const max = Number.isFinite(options.max) ? options.max : 4;

  const ids = [];
  for (const img of list.slice(0, max)) {
    try {
      const fetchUrl = img.url.trim().replace(/ /g, "%20");
      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) continue;
      const kind = sniffImageMime(buf);
      if (!kind) continue; // not a renderable image
      const filename = sanitizeAttachmentName(img.filename) || `image.${kind.ext}`;
      const id = await uploadBotAttachment(env, buf, filename, kind.mime, options);
      if (id) ids.push(id);
    } catch (err) {
      console.warn(`[nexus] attachImagesFromUrls failed for ${img.url}:`, err.message);
    }
  }
  return ids;
}

/**
 * Normalize a remote filename to a safe attachment name with an image
 * extension, collapsing odd characters.
 * @param {string} [name]
 * @returns {string|null}
 */
function sanitizeAttachmentName(name) {
  if (!name || typeof name !== "string") return null;
  const cleaned = name.trim().replace(/[^\w.\-() ]+/g, "_").replace(/\s+/g, " ").slice(0, 120);
  return cleaned || null;
}

/**
 * Attach interactive buttons to a Nexus message.
 * Uses POST /api/bot/messages/:id/buttons (Bearer auth, bot-side route added 2026-05-10).
 *
 * This route requires:
 *   - Authorization: Bearer <BOT_NEXUS_KEY> (not X-API-Key)
 *   - The bot must have a bot_channel_permissions row for the message's channel
 *   - The message must have been authored by the same bot
 *
 * Stamps each button with callback_secret so Nexus can HMAC-sign the dispatch.
 * The receiving handler (buttonClick.js) verifies the resulting X-Nexus-Signature.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id returned by postToNexus
 * @param {Array<{button_id: string, label: string, style?: string, callback_url: string}>} buttons
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string} [options.callbackSecretEnvVar] - env var name for callback_secret
 * @param {string} [options.callbackSecret] - callback_secret value directly
 * @returns {Promise<Array|null>} inserted button rows or null on error
 */
export async function attachButtons(env, messageId, buttons, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;

  const callbackSecret = resolveCallbackSecret(env, options);

  const withSecret = (Array.isArray(buttons) ? buttons : []).map(b => ({
    ...b,
    ...(callbackSecret ? { callback_secret: callbackSecret } : {}),
  }));

  try {
    const result = await _bearerPostWithRetry(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/buttons`,
      { buttons: withSecret },
      apiKey,
    );
    // Stamp presence fire-and-forget. Do not await.
    pingBotPresence(env, options).catch(() => {});
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] attachButtons(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "attachButtons",
      msg: err.message,
      ctx: { messageId, buttonCount: Array.isArray(buttons) ? buttons.length : null },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Attach select menus (dropdown, or checkbox-style rows when max_values > 1)
 * to a Nexus message the bot authored.
 * Uses POST /api/bot/messages/:id/select-menus (Bearer auth).
 *
 * Menu shape: { custom_id: '<bot>:<id>', placeholder?, min_values?,
 *   max_values?, options: [{value, label, description?, default?}] }.
 * Options with default: true start selected in the UI.
 *
 * When a callback secret resolves, each menu is stamped with a callback_url
 * marker + callback_secret so submissions reach the bot over the signed HTTP
 * path at POST /api/internal/select-submit (fleet workers hold no BotRouter
 * WS). Nexus ignores the marker's path and canonicalizes the URL from the
 * bot's registered origin, same as buttons. Without a secret the menu stays
 * on the WS dispatch path.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id returned by postToNexus
 * @param {Array<object>} menus
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string} [options.callbackSecretEnvVar] - env var name for callback_secret
 * @param {string} [options.callbackSecret] - callback_secret value directly
 * @returns {Promise<Array|null>} inserted menu rows or null on error
 */
export async function attachSelectMenus(env, messageId, menus, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;

  const callbackSecret = resolveCallbackSecret(env, options);

  const withSecret = (Array.isArray(menus) ? menus : []).map((m) => ({
    ...m,
    ...(callbackSecret
      ? { callback_url: "https://canonicalized-at-attach.invalid", callback_secret: callbackSecret }
      : {}),
  }));

  try {
    const result = await _bearerPostWithRetry(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/select-menus`,
      { select_menus: withSecret },
      apiKey,
    );
    pingBotPresence(env, options).catch(() => {});
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] attachSelectMenus(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "attachSelectMenus",
      msg: err.message,
      ctx: { messageId, menuCount: Array.isArray(menus) ? menus.length : null },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Disable action buttons on a Nexus message the bot authored. Disabled buttons
 * render greyed + non-clickable and the click route rejects stale clicks. Link
 * buttons (url set) are never disabled server-side, so an "Open in CRM" deep
 * link stays usable after the card is settled.
 *
 * Use this to lock a HITL card's stale buttons once its outcome is decided,
 * e.g. disabling "Decline" after a cadence step was approved and sent.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id returned by postToNexus
 * @param {object} target - one of: { all: true } or { buttonIds: string[] }
 * @param {boolean} [target.all] - disable every non-link action button
 * @param {string[]} [target.buttonIds] - disable only these button_id strings
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<Array|null>} refreshed button rows or null on error
 */
export async function disableMessageButtons(env, messageId, target = {}, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;

  const payload = target.all
    ? { all: true }
    : { button_ids: Array.isArray(target.buttonIds) ? target.buttonIds : [] };
  if (!payload.all && payload.button_ids.length === 0) return null;

  try {
    const result = await _bearerPostWithRetry(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/buttons/disable`,
      payload,
      apiKey,
    );
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] disableMessageButtons(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "disableMessageButtons",
      msg: err.message,
      ctx: { messageId, target: payload.all ? "all" : payload.button_ids },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Mark one of a card's action buttons as clicked on behalf of a human who did
 * the equivalent thing OUTSIDE Nexus, so the card renders the same check glyph
 * and "-- <name>" attribution a native click would. Example: a tech claims a
 * ticket on the Desk board, so the mirror card's "Take" button lights up with
 * their name instead of staying live.
 *
 * Nexus resolves the person by upn first, then display_name (case-insensitive,
 * active humans only). When nobody matches it disables the button instead, so
 * the stale action still goes away; the result's mode says which happened.
 * Idempotent per user.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id returned by postToNexus
 * @param {object} who
 * @param {string} who.buttonId - the button_id string attached via attachButtons
 * @param {string} [who.upn] - the person's UPN / email
 * @param {string} [who.displayName] - fallback display name
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<{mode: string, rows: Array}|null>} outcome or null on error
 */
export async function markButtonClicked(env, messageId, who = {}, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL || !messageId) return null;
  const buttonId = String(who.buttonId || "").trim();
  const upn = String(who.upn || "").trim();
  const displayName = String(who.displayName || "").trim();
  if (!buttonId || (!upn && !displayName)) return null;

  try {
    const result = await _bearerPostWithRetry(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/buttons/mark-clicked`,
      { button_id: buttonId, ...(upn ? { upn } : {}), ...(displayName ? { display_name: displayName } : {}) },
      apiKey,
    );
    return { mode: result?.mode || "clicked", rows: result?.data || [] };
  } catch (err) {
    console.warn(`[nexus] markButtonClicked(${messageId}, ${buttonId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "markButtonClicked",
      msg: err.message,
      ctx: { messageId, buttonId },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Settle a HITL card's interactive components once its outcome is final.
 * Strips the action buttons + modal triggers + select menus the bot attached
 * (link buttons are preserved server-side) so a sent/rejected card no longer
 * shows a live Reject button or Edit modal trigger.
 *
 * Use this instead of disableMessageButtons when a card carries a modal trigger
 * (e.g. an "Edit reply" Edit modal): disableMessageButtons only greys buttons
 * and cannot retire a modal trigger.
 *
 * Best-effort: returns null and reports a fleet error on failure so a settle
 * miss never blocks the caller.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id whose card is now settled
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<object|null>} settle result or null on error
 */
export async function settleMessageComponents(env, messageId, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;

  try {
    const result = await _bearerPostWithRetry(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/components/settle`,
      {},
      apiKey,
    );
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] settleMessageComponents(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "settleMessageComponents",
      msg: err.message,
      ctx: { messageId },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Settle a resolved HITL card to a terse status line and strip its controls.
 *
 * The pending HITL card already showed the reviewer the full message, so the
 * settled card must NOT re-print it ("don't read it twice"). This collapses the
 * card to a single status line (title + "<status> by <actor>" + auto footer
 * timestamp) and then removes the action buttons + modal triggers via
 * settleMessageComponents. One call replaces the old "edit a verbose outcome
 * card, then disable buttons" pattern.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id of the card being settled
 * @param {object} params
 * @param {string} [params.botName]  - bot display name for the footer ("Courtney")
 * @param {string} [params.title]    - card title ("External Reply")
 * @param {string} [params.status="Actioned"] - outcome verb ("Sent", "Rejected", "Canceled")
 * @param {string} [params.actor]    - who actioned it (display name)
 * @param {boolean} [params.rejected=false] - render the 🛑 glyph instead of ✅
 * @param {string} [params.footer]   - optional footer override
 * @param {object} [options] - nexus options (nexusKeyEnvVar, etc.)
 * @returns {Promise<object|null>} settle result or null
 */
export async function settleHitlCard(env, messageId, params = {}, options = {}) {
  if (!messageId) return null;
  const { botName = "", title = "Request", status = "Actioned", actor, rejected = false, footer } = params;
  const subtitleParts = [status];
  if (actor) subtitleParts.push(`by ${actor}`);
  const body = buildReport({
    botName,
    emoji: rejected ? "🛑" : "✅",
    title,
    subtitle: subtitleParts.join(" "),
    sections: [],
    ...(footer ? { footer } : {}),
  });
  // Atomic edit + component clear in a SINGLE PATCH (clear_components:true).
  // Server-side this rewrites the body, deletes the buttons + modal triggers,
  // then broadcasts broadcast_update followed in-order by a settled:true frame
  // so the client cannot re-seed a stale Edit modal. The old pattern -- edit,
  // then a separate settleMessageComponents -- fired two independent requests
  // whose broadcasts could arrive out of order: the body-edit broadcast still
  // carried the old modal rows and re-seeded a live "Edit reply" trigger on a
  // resolved card if it landed after the settle. Do NOT split these back apart.
  return editNexusMessage(env, messageId, body, { ...options, clearComponents: true });
}

/**
 * Attach message-modal triggers to a Nexus message.
 * Uses POST /api/bot/messages/:id/modals (Bearer auth, same as attachButtons).
 *
 * Each entry in the modals array is stored in Nexus D1. The UI renders a
 * trigger button per modal; clicking it opens an inline form overlay. On
 * submission the server HMAC-signs the payload and POSTs to callback_url.
 *
 * @param {object} env
 * @param {string} messageId - Nexus message id returned by postToNexus
 * @param {Array<{modal_id: string, title: string, fields: Array<object>, callback_url: string}>} modals
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string} [options.callbackSecretEnvVar] - env var name for callback_secret
 * @param {string} [options.callbackSecret] - callback_secret value directly
 * @returns {Promise<Array|null>} inserted modal rows or null on error
 */
export async function attachModals(env, messageId, modals, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;

  const callbackSecret = resolveCallbackSecret(env, options);

  const withSecret = (Array.isArray(modals) ? modals : []).map((m) => ({
    ...m,
    ...(callbackSecret ? { callback_secret: callbackSecret } : {}),
  }));

  try {
    const result = await _bearerPostWithRetry(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${messageId}/modals`,
      { modals: withSecret },
      apiKey,
    );
    pingBotPresence(env, options).catch(() => {});
    return result?.data || null;
  } catch (err) {
    console.warn(`[nexus] attachModals(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "attachModals",
      msg: err.message,
      ctx: { messageId, modalCount: Array.isArray(modals) ? modals.length : null },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Edit a Nexus message previously posted by this bot.
 * Uses PATCH /api/bot/messages/:id (Bearer auth, authorship enforced
 * server-side -- bot can only edit its own messages).
 *
 * Best-effort: returns null on failure so callers in click-handlers do
 * not crash an HTTP response chain when Nexus is briefly unreachable.
 *
 * @param {object} env
 * @param {string} messageId
 * @param {string} body - new markdown body
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar]
 * @returns {Promise<object|null>}
 */
export async function editNexusMessage(env, messageId, body, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;
  if (!messageId || typeof body !== "string" || !body.trim()) return null;
  const scrubbedBody = scrubFleetDashes(body);
  try {
    const res = await fetch(
      `${env.NEXUS_BASE_URL}/api/bot/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          body: scrubbedBody,
          body_format: "markdown",
          ...(options.clearComponents ? { clear_components: true } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] editNexusMessage(${messageId}) -> ${res.status}: ${text}`);
      _getReportFleetError().then(fn => fn(env, {
        bot: deriveBotName(env, options),
        op: "editNexusMessage",
        msg: `HTTP ${res.status}: ${text.slice(0, 120)}`,
        ctx: { messageId },
      }, options)).catch(() => {});
      return null;
    }
    // Stamp presence fire-and-forget. Do not await.
    pingBotPresence(env, options).catch(() => {});
    const j = await res.json().catch(() => ({}));
    return j?.data || null;
  } catch (err) {
    console.warn(`[nexus] editNexusMessage(${messageId}) failed:`, err.message);
    _getReportFleetError().then(fn => fn(env, {
      bot: deriveBotName(env, options),
      op: "editNexusMessage",
      msg: err.message,
      ctx: { messageId },
    }, options)).catch(() => {});
    return null;
  }
}

/**
 * Send a "<bot> is typing..." indicator to a Nexus channel.
 *
 * Hits POST /api/bot/typing (X-API-Key auth, same identity model as
 * postToNexus) which fans the frame out through the channel's ChatRoom
 * DO. The DO sets a 90s TTL on each start; callers in long-running tool
 * loops should re-send "start" periodically (every ~60s) to keep the
 * indicator alive. "stop" clears it immediately (the auto-clear on bot
 * message arrival also handles this, so an explicit stop is mostly
 * insurance for error paths).
 *
 * When options.thread_id is provided, the indicator is scoped to that
 * thread's open panel only -- the main channel's typing row stays empty
 * so the bot doesn't appear to be typing in the channel when it's
 * actually replying inside a thread.
 *
 * Why this uses the X-API-Key route, not the channel-gated Bearer route:
 * the typing entry's user_id needs to match the eventual message's
 * user_id so the DO's auto-clear-on-arrival logic lines up. The legacy
 * X-API-Key path resolves keys to bot_<name> (underscore) while the
 * channel-gated Bearer path uses bot-<name> (hyphen); we want the same
 * id chain the post will use.
 *
 * Best-effort: never throws. A Nexus outage or auth misconfig must not
 * crash a chat handler or take down a tool loop.
 *
 * @param {object} env
 * @param {string} slug - Nexus channel slug
 * @param {"start"|"stop"} action
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @param {string} [options.thread_id] - parent message id when scoping typing to a thread panel
 * @returns {Promise<void>}
 */
export async function sendTyping(env, slug, action, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return;
  if (action !== "start" && action !== "stop") return;
  if (!slug || typeof slug !== "string") return;
  try {
    const payload = { channel_slug: slug, action };
    if (options.thread_id) payload.thread_id = options.thread_id;
    const res = await fetch(
      `${env.NEXUS_BASE_URL}/api/bot/typing`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] sendTyping(${slug}, ${action}) -> ${res.status}: ${text}`);
    }
  } catch (err) {
    console.warn(`[nexus] sendTyping(${slug}, ${action}) failed:`, err.message);
  }
}

/**
 * Stamp this bot's last_seen_at so the presence dot turns green.
 *
 * Fire-and-forget: called internally after every postToNexus /
 * attachButtons / editNexusMessage success. Callers never need to call
 * this directly, though they may if they have bot activity that doesn't
 * go through those helpers (e.g. a cron that only reads data).
 *
 * Uses the same Bearer auth as attachButtons / editNexusMessage.
 * Swallows all errors so a Nexus outage never crashes a cron job.
 *
 * @param {object} env
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<void>}
 */
export async function pingBotPresence(env, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return;
  try {
    const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/me/last-seen`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[nexus] pingBotPresence -> ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error("[nexus] pingBotPresence failed:", err.message);
  }
}

/**
 * Read recent messages from a Nexus channel.
 * Uses GET /api/bot/channels/:slug/messages (Bearer auth, channel-perm gated).
 *
 * @param {object} env
 * @param {string} slug - channel slug
 * @param {object} [options]
 * @param {number} [options.limit] - max messages to return (1-50, default 10)
 * @param {string} [options.nexusKeyEnvVar]
 * @returns {Promise<Array|null>} array of { id, user_id, display_name, body, created_at } or null
 */
export async function fetchChannelMessages(env, slug, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return null;
  const limit = options.limit || 10;
  try {
    const url = `${env.NEXUS_BASE_URL}/api/bot/channels/${encodeURIComponent(slug)}/messages?limit=${limit}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] fetchChannelMessages(${slug}) -> ${res.status}: ${text}`);
      return null;
    }
    const j = await res.json().catch(() => ({}));
    return j?.data || null;
  } catch (err) {
    console.warn(`[nexus] fetchChannelMessages(${slug}) failed:`, err.message);
    return null;
  }
}

/**
 * Read a full thread (parent + replies) by parent message id.
 * Uses GET /api/messages/:id/thread (session auth path; bots access via
 * the internal-token route below when called from a worker).
 *
 * @param {object} env
 * @param {string} parentId - the thread root message id
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar]
 * @returns {Promise<{ parent: object, replies: object[] }|null>}
 */
export async function fetchThreadMessages(env, parentId, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL || !parentId) return null;
  try {
    const url = `${env.NEXUS_BASE_URL}/api/bot/threads/${encodeURIComponent(parentId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[nexus] fetchThreadMessages(${parentId}) -> ${res.status}: ${text}`);
      return null;
    }
    const j = await res.json().catch(() => ({}));
    return j?.data || null;
  } catch (err) {
    console.warn(`[nexus] fetchThreadMessages(${parentId}) failed:`, err.message);
    return null;
  }
}

/**
 * Send a heartbeat ping to Nexus.
 *
 * @param {object} env
 * @param {object} [meta] - optional metadata to include
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar] - env var name holding the API key
 * @returns {Promise<void>}
 */
export async function sendNexusHeartbeat(env, meta = {}, options = {}) {
  const apiKey = resolveNexusKey(env, options);
  if (!apiKey || !env.NEXUS_BASE_URL) return;
  try {
    const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ status: "ok", meta }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[nexus] heartbeat failed:", res.status, text);
    }
  } catch (err) {
    console.warn("[nexus] heartbeat error:", err.message);
  }
}
