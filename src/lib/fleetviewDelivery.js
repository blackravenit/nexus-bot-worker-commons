// =============================================================================
// lib/fleetviewDelivery.js: reply delivery for the FleetView surface.
//
// FleetView (fleet.blackravenit.com) is Brian's always-open bot launcher. It
// dispatches to the same POST /api/internal/chat-message route Nexus uses,
// signed with the same per-bot HMAC secret, so a FleetView turn runs the
// bot's real persona, tools, memory, and HITL path with no special casing.
//
// The one thing that differs is where the answer goes. Nexus dispatch expects
// the reply to land in the channel the message came from. FleetView has no
// channel: the browser is holding a WebSocket open and wants the text back.
// Since chat-message returns 202 and the tool loop finishes minutes later in
// the LlmRoom DO, the answer cannot ride the response body. It is POSTed back
// to a FleetView callback URL instead, signed with FLEETVIEW_DELIVERY_SECRET
// so FleetView can verify it with the same verifyNexusSignature the bots use.
//
// Substantive answers ALSO go to the bot's Nexus home channel, so asking a bot
// something from the laptop still leaves the same record in Nexus that asking
// it in-channel would. Short conversational replies do not, or every "you up?"
// would spam #courtney-it.
//
// Hard rules:
//   - No module-level I/O.
//   - No em dashes or en dashes.
//   - ES modules only.
// =============================================================================

import { signCallback } from "./callbackSign.js";
import { postToNexus } from "./nexus.js";
import { chunkBangReport } from "./embedCard.js";

/** Payload `source` value that selects this delivery path. */
export const FLEETVIEW_SOURCE = "fleetview";

// An answer longer than this is a report, not a chat reply, and gets mirrored
// to the bot's home channel. Tuned to sit above a normal multi-sentence answer
// and below anything with a table or a list of findings in it.
const HOME_CHANNEL_ESCALATION_CHARS = 1200;

// Webhook delivery attempts before giving up and falling back to Nexus.
const WEBHOOK_ATTEMPTS = 3;
const WEBHOOK_TIMEOUT_MS = 10000;

/**
 * True when this turn was dispatched by FleetView rather than Nexus.
 *
 * @param {string|undefined} source - the payload `source` field
 * @returns {boolean}
 */
export function isFleetViewSource(source) {
  return source === FLEETVIEW_SOURCE;
}

/**
 * Decide whether a FleetView answer is substantive enough to also belong in
 * the bot's Nexus home channel.
 *
 * Two qualifiers, deliberately narrow. A staged HITL card means the turn has a
 * real-world side effect the channel record must show. Length is the proxy for
 * "this is a report, not a chat reply". Tool use on its own is NOT a qualifier:
 * nearly every real question runs a tool, and mirroring all of those would turn
 * every home channel into a transcript of Brian's laptop.
 *
 * @param {string} answer - the visible reply text
 * @param {object} [signals]
 * @param {object|null} [signals.stagedAction] - HITL card staged this turn
 * @returns {boolean}
 */
export function shouldMirrorToHomeChannel(answer, signals = {}) {
  if (signals.stagedAction) return true;
  return String(answer || "").length > HOME_CHANNEL_ESCALATION_CHARS;
}

/**
 * Cloudflare Access service-token headers for the FleetView callback, when the
 * worker has them bound. Returns an empty object if either half is missing, so
 * a bot that has not been given the token yet still delivers while the Access
 * policy is permissive, and fails loudly at the edge once it is not.
 *
 * @param {object} env - worker bindings
 * @returns {Record<string, string>}
 */
export function accessServiceTokenHeaders(env) {
  const clientId = env.FLEETVIEW_ACCESS_CLIENT_ID;
  const clientSecret = env.FLEETVIEW_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn("[fleetview] no Access service token bound; the callback will be rejected at the edge");
    return {};
  }
  return { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret };
}

/**
 * POST the finished answer back to FleetView, HMAC-signed the same way Nexus
 * signs bot callbacks so the receiver can reuse verifyNexusSignature.
 *
 * @param {object} env - worker bindings (needs FLEETVIEW_DELIVERY_SECRET)
 * @param {string} replyWebhook - absolute FleetView callback URL
 * @param {object} payload - reply body (serialized once, then signed)
 * @returns {Promise<boolean>} true when FleetView accepted the delivery
 */
async function postSignedReply(env, replyWebhook, payload) {
  const secret = env.FLEETVIEW_DELIVERY_SECRET;
  if (!secret) {
    console.error("[fleetview] FLEETVIEW_DELIVERY_SECRET not bound; cannot deliver reply");
    return false;
  }

  // Serialize ONCE. The signature covers these exact bytes, so re-stringifying
  // for the fetch body would risk signing something other than what is sent.
  const rawBody = JSON.stringify(payload);

  // Cloudflare Access sits in front of the callback path with a service-token
  // policy, so junk traffic is rejected at the edge before it costs a worker
  // invocation. The HMAC below is still the real authentication: these headers
  // only get the request through the front door.
  const accessHeaders = accessServiceTokenHeaders(env);

  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
    try {
      const { timestamp, signature } = await signCallback(secret, rawBody);
      const res = await fetch(replyWebhook, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Nexus-Timestamp": timestamp,
          "X-Nexus-Signature": signature,
          ...accessHeaders,
        },
        body: rawBody,
        // Never follow a redirect. An identity proxy in front of FleetView
        // answers an unauthenticated POST with a 302 to its login page, and
        // following it yields a cheerful 200 of HTML: the delivery reports
        // success and the answer is silently lost. A 3xx here means the
        // callback path is not actually reaching the worker.
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      if (res.status >= 300 && res.status < 400) {
        console.error(
          `[fleetview] reply webhook redirected (${res.status} to ${res.headers.get("location") || "?"}); ` +
          "the callback path is being intercepted before it reaches FleetView",
        );
        return false;
      }

      // A success status carrying HTML is the same interception wearing a
      // different hat. FleetView always answers JSON.
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
          console.error(`[fleetview] reply webhook returned ${res.status} with content-type "${contentType}", not JSON`);
          return false;
        }
        return true;
      }
      const txt = await res.text().catch(() => "");
      console.warn(`[fleetview] reply webhook ${res.status} (attempt ${attempt}): ${txt.slice(0, 200)}`);
      // A 403 here is Cloudflare Access, not the worker: the service token is
      // missing, wrong, or expired. Retrying with the same credentials cannot
      // help, and the fix is a token rotation, not a redelivery.
      if (res.status === 403) {
        console.error("[fleetview] Access rejected the service token; check FLEETVIEW_ACCESS_CLIENT_ID/SECRET");
        return false;
      }
      // A rejected signature or a bad thread id will not fix itself on retry.
      if (res.status === 401 || res.status === 404) return false;
    } catch (err) {
      console.warn(`[fleetview] reply webhook error (attempt ${attempt}): ${err?.message}`);
    }
    if (attempt < WEBHOOK_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  console.error(`[fleetview] reply webhook failed after ${WEBHOOK_ATTEMPTS} attempts: ${replyWebhook}`);
  return false;
}

/**
 * Post a FleetView answer to the bot's Nexus home channel, chunked so nothing
 * is lost to the 8000-char body cap.
 *
 * @param {object} env
 * @param {string} homeChannelSlug
 * @param {string} answer
 * @param {object} nexusOptions - { nexusKeyEnvVar } and friends
 * @param {string} [askedBy] - display name to attribute the question to
 * @param {string} [question] - the original question, for channel context
 * @returns {Promise<boolean>}
 */
async function mirrorToHomeChannel(env, homeChannelSlug, answer, nexusOptions, askedBy, question) {
  if (!homeChannelSlug) return false;
  const header = question
    ? `${askedBy || "Brian"} asked from FleetView: ${String(question).slice(0, 300)}\n\n`
    : `Asked by ${askedBy || "Brian"} from FleetView.\n\n`;
  try {
    const parts = chunkBangReport(header + answer);
    for (const part of parts) {
      await postToNexus(env, homeChannelSlug, part, { ...nexusOptions, postedVia: "fleetview" });
    }
    return true;
  } catch (err) {
    console.error(`[fleetview] home channel mirror failed (${homeChannelSlug}): ${err?.message}`);
    return false;
  }
}

/**
 * Deliver a completed FleetView turn: mirror to the home channel when the
 * answer is substantive, then push it to the browser via the reply webhook.
 *
 * When the webhook cannot be reached the answer is posted to the home channel
 * regardless, so a finished turn is never silently discarded.
 *
 * @param {object} env - worker bindings
 * @param {object} args
 * @param {string} args.replyWebhook - FleetView callback URL
 * @param {string} args.threadId - FleetView thread/turn correlation id
 * @param {string} args.botName - e.g. "kate"
 * @param {string} args.homeChannelSlug - e.g. "kate-cs"
 * @param {string} args.answer - visible reply text
 * @param {string} [args.question] - the user text that triggered the turn
 * @param {string} [args.askedBy] - display name of the asker
 * @param {Array<object>} [args.toolTrace] - tool calls run this turn
 * @param {object|null} [args.stagedAction] - HITL card staged this turn
 * @param {string|null} [args.error] - error text when the turn failed
 * @param {object} [args.nexusOptions] - passed through to postToNexus
 * @returns {Promise<{delivered: boolean, postedToHomeChannel: boolean}>}
 */
export async function deliverFleetViewReply(env, args) {
  const {
    replyWebhook,
    threadId,
    botName,
    homeChannelSlug,
    answer,
    question,
    askedBy,
    toolTrace = [],
    stagedAction = null,
    error = null,
    nexusOptions = {},
    timings = null,
  } = args || {};

  const text = String(answer || "");
  let postedToHomeChannel = false;

  if (!error && text && shouldMirrorToHomeChannel(text, { stagedAction })) {
    postedToHomeChannel = await mirrorToHomeChannel(
      env, homeChannelSlug, text, nexusOptions, askedBy, question,
    );
  }

  const payload = {
    thread_id: threadId || null,
    bot: botName || null,
    answer: text,
    error: error || null,
    tool_calls: toolTrace.map((t) => ({ name: t?.name || "?", error: Boolean(t?.error) })),
    staged_action: stagedAction ? { description: stagedAction.description, channel: stagedAction.channel } : null,
    posted_to_home_channel: postedToHomeChannel,
    timings,
    home_channel_slug: homeChannelSlug || null,
    finished_at: new Date().toISOString(),
  };

  let delivered = false;
  if (replyWebhook) {
    delivered = await postSignedReply(env, replyWebhook, payload);
  } else {
    console.warn(`[fleetview] no reply_webhook on a fleetview turn for ${botName}`);
  }

  // Last resort: the answer exists but FleetView never got it. Put it in the
  // home channel so the work is recoverable instead of lost to a dead socket.
  if (!delivered && !postedToHomeChannel && text) {
    postedToHomeChannel = await mirrorToHomeChannel(
      env, homeChannelSlug, text, nexusOptions, askedBy, question,
    );
    if (postedToHomeChannel) {
      console.warn(`[fleetview] webhook undeliverable; answer posted to ${homeChannelSlug} instead`);
    }
  }

  return { delivered, postedToHomeChannel };
}
