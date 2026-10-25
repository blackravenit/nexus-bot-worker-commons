// =============================================================================
// lib/emailBackup.js - Fleetwide "email is down" backup notifier.
//
// When a bot's outbound email send fails, post an @channel card to the bot's
// home Nexus channel so a human picks up the dropped action. This is an
// out-of-band path: it does NOT depend on the mail system, so it still reaches
// a human when Graph/email is fully down (the failure mode that started this --
// a voice caller asked Jacob to email collateral, the send 403'd, and nobody
// was ever notified).
//
// @channel resolves on the bot post route (resolveAndInsertMentions) to a
// mention + push fan-out to every active human member of the channel, so a real
// person gets pinged -- not just a line of text in a feed.
//
// Best-effort + deduped: a mass outage that fails many sends in one cron
// invocation collapses to a single ping per (bot, reason) per window, so we
// don't fire 40 pings when a cadence loop hits a dead mailbox.
// =============================================================================

import { postToNexus } from "./nexus.js";

/**
 * bot id -> { slug, keyEnvVar }. Single source of truth for each bot's home
 * channel (where the @channel email-down ping lands) and the env var holding
 * its Nexus API key (passed to postToNexus). Keep this in lockstep with the
 * per-worker NEXUS keys and the voice-bridge persona routing.
 *
 * Deliberate exception to the "everything actionable lands in <bot>-hitl" rule:
 * these are outage alarms, not approval cards. Nobody clicks anything and the
 * point is that the noisy channel people already watch lights up. Do not route
 * them through routeApprovalChannel.
 */
export const BOT_HOME_CHANNELS = {
  jacob:    { slug: "jacob-sales",     keyEnvVar: "JACOB_NEXUS_KEY" },
  courtney: { slug: "courtney-it",     keyEnvVar: "COURTNEY_NEXUS_KEY" },
  dexter:   { slug: "dexter-devops",   keyEnvVar: "DEXTER_NEXUS_KEY" },
  robert:   { slug: "robert-soc",      keyEnvVar: "ROBERT_NEXUS_KEY" },
  maxwell:  { slug: "maxwell-finance", keyEnvVar: "MAXWELL_NEXUS_KEY" },
  moxie:    { slug: "moxie-marketing", keyEnvVar: "MOXIE_NEXUS_KEY" },
  wren:     { slug: "wren-assistant",  keyEnvVar: "WREN_NEXUS_KEY" },
  kate:     { slug: "kate-cs",         keyEnvVar: "KATE_NEXUS_KEY" },
};

// Isolate-local dedup window. Survives only for the isolate's lifetime, which
// is enough to absorb a single cron invocation that fails many sends in a row.
const PING_DEDUP_MS = 10 * 60 * 1000;
const _recentPings = new Map(); // dedupKey -> expiresAtMs

/**
 * Returns true if this dedupKey was pinged within the window (so the caller
 * should skip). Records the key as pinged otherwise.
 * @param {string} key
 * @returns {boolean}
 */
function _isDuplicate(key) {
  const now = Date.now();
  const exp = _recentPings.get(key);
  if (exp && exp > now) return true;
  _recentPings.set(key, now + PING_DEDUP_MS);
  if (_recentPings.size > 200) {
    for (const [k, v] of _recentPings) {
      if (v <= now) _recentPings.delete(k);
    }
  }
  return false;
}

// A send can fail two ways, and they need different humans doing different
// things. Transport is an OUTAGE: the message was good, the mail system is
// down or refusing, and a person can send it by hand. Configuration is a
// PERMISSION or identity problem: that mailbox was never going to send,
// re-sending by hand fails the same way, and only a config change fixes it.
// Paging a channel for the second kind trains everyone to ignore the first.
//
// CLASSIFY ON STRUCTURED FACTS, NEVER BY SEARCHING THE ERROR TEXT. That text
// carries remote content: a Graph failure quotes our own subject and recipient
// list back at us, so anyone who gets "403" or "AccessPolicy" into a subject
// or an address could downgrade a REAL outage to a quiet line and nobody would
// be paged. Status and error code are tagged onto the thrown error by
// mimeEmail.js. Anything ambiguous PAGES: a false siren costs attention, a
// missed one costs the message.
const CONFIG_ERROR_CODES = new Set([
  "erroraccessdenied",
  "accessdenied",
  "invalidauthenticationtoken",
  "mailboxnotenabledforrestapi",
  "authorization_requestdenied",
  "invalid_client",
  "unauthorized_client",
  "invalid_grant",
  "forbidden",
]);

// Reads ONE field out of a provider body, the error code. Nothing else in the
// string is ever examined.
const ERROR_CODE_RE = new RegExp("\"code\"[ ]*:[ ]*\"([A-Za-z_]{1,60})\"");

/**
 * Whether this failure is a configuration or permission problem rather than an
 * outage. A configuration failure is reported without paging the channel.
 *
 * @param {string} reason - error text; only its error-code field is read
 * @param {object} [facts]
 * @param {number} [facts.status] - HTTP status from the failed call
 * @param {string} [facts.errorCode] - provider error code, compared exactly
 * @returns {boolean} true only when something authoritative says permission
 */
export function isConfigFailure(reason, { status, errorCode } = {}) {
  if (typeof errorCode === "string" && CONFIG_ERROR_CODES.has(errorCode.trim().toLowerCase())) return true;
  if (Number.isFinite(status)) return status === 401 || status === 403;
  const match = ERROR_CODE_RE.exec(String(reason || ""));
  return match ? CONFIG_ERROR_CODES.has(match[1].toLowerCase()) : false;
}
/**
 * Notify a bot's home channel that an outbound email failed to send. Use this
 * in the catch path of a worker's email-send wrapper, right before rethrowing
 * (so existing behavior -- pausing a cadence, logging fleet-errors -- is
 * preserved AND a human gets an @channel ping). Never throws.
 *
 * @param {object} env
 * @param {object} args
 * @param {string} args.bot - bot id key in BOT_HOME_CHANNELS (e.g. "jacob")
 * @param {string} [args.channelSlug] - post here instead of the bot home channel
 * @param {string} [args.to] - intended recipient address, for the card
 * @param {string} [args.subject] - intended subject, for the card
 * @param {string} [args.reason] - error message / why the send failed
 * @param {number} [args.status] - HTTP status of the failed call, when known
 * @param {string} [args.errorCode] - provider error code, when known
 * @param {string} [args.context] - optional extra context (job name, prospect)
 * @returns {Promise<boolean>} true if a ping was posted, false if skipped
 */
export async function notifyEmailDown(env, { bot, to, subject, reason, context, channelSlug, status, errorCode } = {}) {
  try {
    const entry = BOT_HOME_CHANNELS[String(bot || "").toLowerCase()];
    if (!entry) {
      console.warn(`[emailBackup] no home channel registered for bot "${bot}"`);
      return false;
    }

    // Dedup on bot + a coarse slice of the error so an outage collapses to one
    // ping, but a genuinely different failure still gets through.
    // A bot may route its outage pings somewhere other than its home channel.
    // Courtney does: her home channel is for conversation, notices live in
    // courtney-cases. The home entry still supplies the posting key.
    const slug = channelSlug || entry.slug;

    const dedupKey = `${slug}:${String(reason || "").slice(0, 80)}`;
    if (_isDuplicate(dedupKey)) return false;

    // A config failure gets no @channel: nobody can hand-send their way out of
    // a permission error, and the siren belongs to real outages.
    const config = isConfigFailure(reason, { status, errorCode });
    const headline = config
      ? "EMAIL SEND BLOCKED -- that mailbox is not permitted to send, so this is a configuration fix, not a dropped message. Sending it by hand will fail the same way."
      : `@channel EMAIL SEND FAILED -- the mail system rejected an outbound message, so I'm flagging it here so someone can follow up manually.`;
    const body = [
      headline,
      ``,
      to ? `Intended recipient: ${to}` : null,
      subject ? `Subject: ${subject}` : null,
      reason ? `Error: ${String(reason).slice(0, 300)}` : null,
      context ? `Context: ${context}` : null,
    ].filter((l) => l !== null).join("\n");

    const res = await postToNexus(env, slug, body, {
      nexusKeyEnvVar: entry.keyEnvVar,
      provenance: "system-alert",
      postedVia: "emailDownBackup",
    });
    return !!res;
  } catch (err) {
    console.warn(`[emailBackup] notifyEmailDown failed: ${err?.message || err}`);
    return false;
  }
}
