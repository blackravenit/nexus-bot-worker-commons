// =============================================================================
// lib/voiceJoin.js - Bot-side helpers for the !join / !leave Nexus voice flow.
//
// Used by jacob-worker, courtney-worker, moxie-worker, wren-worker (and any
// future bot that wants to participate in Nexus voice channels). All four
// bots share this code path; the only per-bot variability is the env var
// name holding the HMAC signing key.
//
// Flow on !join:
//   1. POST /voice/bot/join with HMAC-signed body including requester_user_id.
//      The nexus-app worker resolves which voice channel the user is in
//      server-side (via VoiceRoom DO roster fan-out) so the bot worker never
//      needs to call the cookie-gated GET /api/voice/rosters endpoint.
//   2. The server echoes back the resolved channel_slug in its success payload.
//
// Signature convention is identical to the inbound Nexus callback shape
// (see commons/callbackSign.js): timestamp + body + sha256= prefix.
//
// Hard rules:
//   - No module-level I/O.
//   - All errors are caught and surfaced to the caller as a human-readable
//     string. The command handler converts to a reply().
// =============================================================================

/**
 * Sign + POST a JSON body to Nexus with the X-Nexus-Timestamp + X-Nexus-
 * Signature header pair. Mirrors callbackSign.verifyNexusSignature on the
 * receiving side: signing input is `${ts}.${rawBody}`, signature header is
 * `sha256=<hex>`.
 *
 * @param {object} env
 * @param {string} path  - path relative to NEXUS_BASE_URL (e.g. "/voice/bot/join")
 * @param {object} body
 * @param {object} [options]
 * @param {string} [options.nexusKeyEnvVar='JACOB_NEXUS_KEY']
 * @returns {Promise<{ status: number, body: object | string }>}
 */
export async function postHmacSigned(env, path, body, options = {}) {
  const keyVar = options.nexusKeyEnvVar || "JACOB_NEXUS_KEY";
  const secret = env[keyVar];
  const baseUrl = env.NEXUS_BASE_URL;
  if (!secret || !baseUrl) {
    throw new Error("voiceJoin: NEXUS_BASE_URL or bot key missing");
  }
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${raw}`));
  const hex = "sha256=" + Array.from(new Uint8Array(macBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Nexus-Timestamp": ts,
      "X-Nexus-Signature": hex,
    },
    body: raw,
    signal: AbortSignal.timeout(15000),
  });
  let parsed;
  try { parsed = await res.json(); } catch { parsed = await res.text().catch(() => ""); }
  return { status: res.status, body: parsed };
}

/**
 * !join command handler factory. Returns an async handler that conforms to
 * the commons cmdCtx shape `(cmdCtx) => Promise<void>`. Looks up the caller's
 * voice channel, POSTs /voice/bot/join, replies in the text channel.
 *
 * @param {string} botName  - canonical bot identifier (e.g. "jacob")
 * @param {string} nexusKeyEnvVar
 * @returns {(cmdCtx: object) => Promise<void>}
 */
export function makeJoinCommand(botName, nexusKeyEnvVar) {
  return async function handleJoin(ctx) {
    const { user_id, env, reply } = ctx;
    // Pass requester_user_id and omit channel_slug. The nexus-app worker
    // resolves the channel server-side via VoiceRoom DO roster fan-out,
    // which avoids the 401 that resulted from calling the cookie-gated
    // GET /api/voice/rosters from a bot worker.
    let res;
    try {
      res = await postHmacSigned(
        env,
        "/voice/bot/join",
        { bot: botName, requester_user_id: user_id, invoked_by: user_id },
        { nexusKeyEnvVar },
      );
    } catch (err) {
      await reply(`Join failed: ${err.message}`);
      return;
    }
    if (res.status === 200 && res.body?.success) {
      const slug = res.body?.data?.channel_slug || "voice";
      const idempotent = res.body?.data?.idempotent ? " (already in)" : "";
      await reply(`Joining #${slug}${idempotent}.`);
      return;
    }
    if (res.status === 404 && res.body?.error === "invoker_not_in_voice") {
      await reply("You're not in a voice channel right now. Join one first, then run !join.");
      return;
    }
    const errCode = res.body?.error || `http_${res.status}`;
    const friendly = friendlyErrorFor(errCode, res.body);
    await reply(`Could not join: ${friendly}`);
  };
}

/**
 * !leave command handler factory. Calls POST /voice/bot/leave.
 *
 * @param {string} botName
 * @param {string} nexusKeyEnvVar
 * @returns {(cmdCtx: object) => Promise<void>}
 */
export function makeLeaveCommand(botName, nexusKeyEnvVar) {
  return async function handleLeave(ctx) {
    const { user_id, env, reply } = ctx;
    // Pass requester_user_id without channel_slug so the nexus-app worker
    // resolves the invoker's current channel server-side. Same pattern as
    // makeJoinCommand: avoids the 401 from the cookie-gated rosters endpoint.
    let res;
    try {
      res = await postHmacSigned(
        env,
        "/voice/bot/leave",
        { bot: botName, requester_user_id: user_id },
        { nexusKeyEnvVar },
      );
    } catch (err) {
      await reply(`Leave failed: ${err.message}`);
      return;
    }
    if (res.status === 200 && res.body?.success) {
      const slug = res.body?.data?.channel_slug || "voice";
      const idempotent = res.body?.data?.idempotent;
      await reply(idempotent ? "Not currently in a voice channel." : `Left #${slug}.`);
      return;
    }
    if (res.status === 404 && res.body?.error === "invoker_not_in_voice") {
      await reply("Join the voice channel you want me to leave, then run !leave.");
      return;
    }
    const errCode = res.body?.error || `http_${res.status}`;
    await reply(`Could not leave: ${friendlyErrorFor(errCode, res.body)}`);
  };
}

function friendlyErrorFor(code, body) {
  switch (code) {
    case "voice_bot_disabled":      return "voice bots are currently disabled (feature flag off).";
    case "unknown_bot":              return "this bot isn't configured for Nexus voice.";
    case "bot_misconfigured":        return `missing ${body?.missing || "config"} on the Nexus side.`;
    case "channel_not_found":        return "channel not found.";
    case "channel_not_voice":        return "that's not a voice channel.";
    case "invoker_no_access":        return "you don't have access to that channel.";
    case "invoker_not_in_voice":     return "you're not in a voice channel right now.";
    case "another_bot_in_channel":   return `another bot (${body?.current || "?"}) is already there.`;
    case "fleet_cap":                return `fleet cap reached (${body?.active}/${body?.cap}).`;
    case "do_init_failed":           return `voice setup failed (status ${body?.status}). Try again in a moment.`;
    default:                         return code;
  }
}
