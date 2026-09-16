// =============================================================================
// lib/externalReplyGate.js -- Shared "external mail gets a HITL draft" gate.
//
// Brian 2026-06-05: every email to every bot should surface a HITL draft so no
// inbox needs manual checking. Bots whose mail pollers auto-reply to internal
// staff but SILENTLY DROP external mail (Dexter, Robert, Maxwell) use this to
// turn each external message into a reviewable card in the bot's HITL channel
// instead. Internal auto-replies are unchanged.
//
// Storage is KV (every bot has a CACHE binding) keyed by the Nexus card id, so
// there is no per-bot D1 migration.
//
// GRAMMAR (Brian 2026-08-06, aligned to Courtney's emailGate): there is no
// blind Approve & Send. A card carries Reject plus an "Edit reply and send"
// modal, and the modal is the ONLY send path, so a human reads the reply before
// it leaves. The modal offers the full Courtney field set, To, CC, Subject and
// body, all editable. Cards staged before that date still carry the old Approve
// button; the legacy branch below keeps them working until their KV rows expire.
//
// Two failure-mode rules this file exists to enforce, both learned the hard way:
//
//   1. A failed send must NEVER destroy the card. editNexusMessage replaces the
//      WHOLE body, so the old failure path turned a full draft card into the
//      bare string "Send failed: ..." with a live send button still attached.
//      The rendered card body is now persisted in KV and every failure re-renders
//      it with a banner appended.
//   2. A send that reports failure may still have been DELIVERED. Graph answers
//      a send with 202 and an empty body; parsing that as JSON throws after the
//      mail is gone (the 2026-08-06 Maxwell incident). Before any send we write
//      an attempt marker, and a second attempt refuses and tells the reviewer to
//      check Sent Items instead of quietly sending a duplicate.
// =============================================================================

import { postToNexus, attachButtons, attachModals, editNexusMessage, settleHitlCard } from "./nexus.js";
import { buildReport } from "./embedCard.js";
import { routeApprovalChannel } from "./channelRouter.js";
import { flattenEmailHtml } from "./emailQuote.js";
import { persistEmailExchange } from "./memoryService.js";

const TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_KIND = "external-reply";

/** Clamp a string for card display. */
function clamp(str, max) {
  const s = String(str ?? "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Flatten HTML to readable text for a markdown card or a modal textarea.
 * @param {string} html - Source HTML.
 * @param {number} [limit=4000] - Maximum characters to keep.
 * @returns {string} Plain text.
 */
export function htmlToText(html, limit = 4000) {
  return flattenEmailHtml(html, limit);
}

/**
 * Wrap reviewer-typed plain text back into the HTML a Graph send expects.
 * Mirrors the per-bot modal handlers so an edited reply renders like a drafted
 * one instead of arriving as a single run-on paragraph.
 *
 * @param {string} text - Plain text from the modal textarea.
 * @returns {string} HTML body.
 */
export function textToHtml(text) {
  const escaped = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map(para => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Split a reviewer-typed address list on commas, semicolons or whitespace. */
function parseAddresses(value) {
  return String(value || "").split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
}

/**
 * The subject Graph's createReply will generate for this thread. Used as the
 * modal prefill so the reviewer sees what will actually go out, and as the
 * baseline for deciding whether they changed it.
 *
 * @param {string} subject - Inbound subject line.
 * @returns {string} Reply subject.
 */
export function replySubject(subject) {
  const s = String(subject || "").trim();
  if (!s) return "RE:";
  return /^re:/i.test(s) ? s : `RE: ${s}`;
}

/**
 * Render the reviewable card body. Persisted verbatim in KV so a later failure
 * can rebuild the card instead of overwriting it.
 *
 * @param {object} params
 * @param {string} params.botName - Bot display name.
 * @param {object} params.inbound - Inbound message summary.
 * @param {string[]} params.cc - CC list on the draft.
 * @param {string} params.draftText - Plain-text draft preview.
 * @returns {string} Markdown card body.
 */
function renderCard({ botName, inbound, cc, draftText }) {
  return buildReport({
    botName,
    emoji: "📨",
    title: "External Email -- Reply Draft",
    subtitle: "Awaiting review. Nothing sends until you open Edit reply and send.",
    sections: [
      {
        emoji: "📧",
        title: "Inbound",
        lines: [
          `- **From:** ${clamp(`${inbound.fromName ? `${inbound.fromName} ` : ""}<${inbound.from || "unknown"}>`, 200)}`,
          `- **Subject:** ${clamp(inbound.subject || "(no subject)", 200)}`,
          `- **Received:** ${clamp(inbound.received || "(unknown)", 60)}`,
          inbound.preview ? `- **Preview:** ${clamp(inbound.preview, 600)}` : null,
        ].filter(Boolean).join("\n"),
      },
      {
        emoji: "↩️",
        title: "Draft reply",
        lines: [
          `- **To:** ${clamp(inbound.from || "(unknown)", 200)}`,
          `- **CC:** ${clamp(cc.length ? cc.join(", ") : "(none)", 300)}`,
          "",
          clamp(draftText || "(empty)", 1500),
        ].join("\n"),
      },
    ],
  });
}

/**
 * Fallback card body for a legacy KV row staged before cardBody was persisted.
 * @param {object} pending - Stored payload.
 * @returns {string} Markdown card body.
 */
function legacyCardBody(pending) {
  const cc = Array.isArray(pending?.cc) ? pending.cc : [];
  return buildReport({
    botName: pending?.botName || "",
    emoji: "📨",
    title: "External Email -- Reply Draft",
    subtitle: "Rebuilt from storage. This card was staged before card bodies were persisted.",
    sections: [{
      emoji: "↩️",
      title: "Draft reply",
      lines: [
        `- **To:** ${pending?.to || pending?.from || "(unknown)"}`,
        `- **CC:** ${cc.length ? cc.join(", ") : "(none)"}`,
        `- **Subject:** ${pending?.subject || "(no subject)"}`,
        "",
        clamp(htmlToText(pending?.draftHtml, 1500), 1500) || "(draft body empty)",
      ].join("\n"),
    }],
  });
}

/**
 * Stage an inbound external email as a reviewable HITL card.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.bot                        lowercase bot name, routes the channel
 * @param {string} [opts.kind="external-reply"]    routing kind for routeApprovalChannel
 * @param {string} [opts.hitlChannel]              DEPRECATED explicit slug override
 * @param {string} opts.botName                    display name on the card
 * @param {object} opts.inbound                    { emailId, from, fromName, cc, subject, received, preview }
 * @param {string} opts.draftHtml                  HTML body that will actually be sent
 * @param {string} opts.draftText                  plain-text preview for the card
 * @param {string} opts.workerBaseUrl              absolute base URL for callbacks
 * @param {string} [opts.buttonPrefix="extmail"]   button/modal id namespace
 * @param {string} [opts.kvPrefix="extreply:"]     KV key prefix for pending payloads
 * @param {string} [opts.nexusKeyEnvVar]
 * @param {string} [opts.callbackSecretEnvVar]
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function stageExternalReply(env, opts) {
  if (!env.CACHE) return { success: false, error: "CACHE (KV) binding missing" };
  const buttonPrefix = opts.buttonPrefix || "extmail";
  const kvPrefix = opts.kvPrefix || "extreply:";
  const inbound = opts.inbound || {};
  const cc = Array.isArray(inbound.cc) ? inbound.cc : (inbound.cc ? [inbound.cc] : []);

  // The modal IS the send path, so a card posted without a resolvable callback
  // base URL would be unactionable. Refuse to post one rather than leave a
  // reviewer clicking a trigger that submits into a relative URL.
  const workerBaseUrl = opts.workerBaseUrl || "";
  if (!workerBaseUrl) {
    console.error(`[externalReplyGate] no workerBaseUrl for ${opts.bot || opts.botName}, refusing to stage an unactionable card`);
    return { success: false, error: "workerBaseUrl required" };
  }

  let channelSlug;
  if (opts.hitlChannel) {
    console.warn(`[externalReplyGate] hitlChannel is deprecated, pass bot + kind instead (got "${opts.hitlChannel}")`);
    channelSlug = opts.hitlChannel;
  } else {
    channelSlug = routeApprovalChannel(env, { bot: opts.bot, kind: opts.kind || DEFAULT_KIND });
  }

  const cardBody = renderCard({ botName: opts.botName, inbound, cc, draftText: opts.draftText });
  const nexusOpts = { nexusKeyEnvVar: opts.nexusKeyEnvVar, callbackSecretEnvVar: opts.callbackSecretEnvVar };

  let msg;
  try {
    msg = await postToNexus(env, channelSlug, cardBody, { nexusKeyEnvVar: opts.nexusKeyEnvVar });
  } catch (err) {
    return { success: false, error: `postToNexus failed: ${err.message}` };
  }
  // postToNexus returns null on an intermittent Nexus 5xx rather than throwing.
  const messageId = msg?.id;
  if (!messageId) return { success: false, error: "no message id from Nexus" };

  const payload = {
    emailId: inbound.emailId,
    from: inbound.from,
    to: inbound.from,
    cc,
    subject: inbound.subject,
    draftHtml: opts.draftHtml || "",
    cardBody,
    channelSlug,
    botName: opts.botName || "",
    attempts: 0,
    staged_at: new Date().toISOString(),
  };
  try {
    await env.CACHE.put(`${kvPrefix}${messageId}`, JSON.stringify(payload), { expirationTtl: TTL_SECONDS });
  } catch (err) {
    return { success: false, error: `KV put failed: ${err.message}`, messageId };
  }

  await attachButtons(env, messageId, [
    { button_id: `${buttonPrefix}_reject:${messageId}`, label: "Reject", style: "danger", callback_url: `${workerBaseUrl}/api/internal/button-click` },
  ], nexusOpts).catch(err => console.warn(`[externalReplyGate] attachButtons failed: ${err.message}`));

  // All four Courtney fields (Brian 2026-08-06). An earlier cut of this gate
  // offered only CC and body, reasoning that a Graph createReply thread fixes
  // the recipient and subject. It does not: createReply returns a DRAFT, and
  // the draft is already PATCHed here to insert the body, so toRecipients and
  // subject ride along in the same PATCH. The consumer's sendReply applies an
  // override only when the reviewer actually changed the field, so an untouched
  // reply still threads exactly as before.
  await attachModals(env, messageId, [{
    modal_id: `${buttonPrefix}-edit:${messageId}`,
    title: "Edit reply and send",
    fields: [
      { name: "to", label: "To", type: "text", value: inbound.from || "", required: true, max_length: 200 },
      // cc MUST be textarea. Nexus silently rejects a text field with a large
      // max_length and drops the WHOLE modal, so the card renders with no Edit
      // trigger at all. Courtney already paid for this one; do not "simplify".
      { name: "cc", label: "CC (comma-separated)", type: "textarea", value: cc.join(", "), required: false, max_length: 1000 },
      { name: "subject", label: "Subject", type: "text", value: replySubject(inbound.subject), required: true, max_length: 200 },
      { name: "body", label: "Reply body", type: "textarea", value: htmlToText(opts.draftHtml || opts.draftText, 4000), required: true, max_length: 4000 },
    ],
    callback_url: `${workerBaseUrl}/api/internal/modal-submit`,
  }], nexusOpts).catch(err => console.warn(`[externalReplyGate] attachModals failed: ${err.message}`));

  return { success: true, messageId, channelSlug };
}

/**
 * Re-render a card after a failed send WITHOUT destroying it, and re-stage the
 * KV row so the reviewer can retry. Components are deliberately left live.
 *
 * @param {object} env
 * @param {string} messageId
 * @param {object} pending - Stored payload (mutated with the new attempt count).
 * @param {Error} err - The send failure.
 * @param {string} key - KV key holding the payload.
 * @param {object} editOpts - Nexus options.
 * @returns {Promise<void>}
 */
async function renderFailure(env, messageId, pending, err, key, editOpts) {
  const attempt = (pending.attempts || 0) + 1;
  pending.attempts = attempt;
  await env.CACHE.put(key, JSON.stringify(pending), { expirationTtl: TTL_SECONDS }).catch(() => {});
  const banner = [
    "",
    `> **Send failed (attempt ${attempt}).** ${clamp(err?.message || "unknown error", 200)}`,
    "> The draft above is unchanged and the card is still actionable.",
    "> If this is a repeat failure, check the mailbox Sent Items before retrying: a send can report failure after it has already been delivered.",
  ].join("\n");
  await editNexusMessage(env, messageId, `${pending.cardBody || legacyCardBody(pending)}\n${banner}`, editOpts)
    .catch(e => console.warn(`[externalReplyGate] failure re-render failed: ${e.message}`));
}

/**
 * Record that a send is about to be attempted for this email, and report
 * whether one already was. Guards the "reported failure but actually delivered"
 * case, which no amount of response parsing can fully rule out.
 *
 * @param {object} env
 * @param {string} guardKey - KV key for the attempt marker.
 * @param {string} actor - Who is attempting the send.
 * @returns {Promise<object|null>} The prior attempt marker, or null if this is the first.
 */
async function claimSendAttempt(env, guardKey, actor) {
  const prior = await env.CACHE.get(guardKey, "json").catch(() => null);
  if (prior) return prior;
  await env.CACHE
    .put(guardKey, JSON.stringify({ at: new Date().toISOString(), actor }), { expirationTtl: TTL_SECONDS })
    .catch(() => {});
  return null;
}

/**
 * Render the "a send was already attempted" stop card, with a single override
 * button for the case where the reviewer has checked Sent Items and knows the
 * mail never left.
 *
 * @param {object} env
 * @param {string} messageId
 * @param {object} pending - Stored payload.
 * @param {object} prior - The earlier attempt marker.
 * @param {string} buttonPrefix
 * @param {string} workerBaseUrl
 * @param {object} nexusOpts
 * @returns {Promise<void>}
 */
async function renderAlreadyAttempted(env, messageId, pending, prior, buttonPrefix, workerBaseUrl, nexusOpts) {
  const banner = [
    "",
    `> **A send was already attempted at ${prior.at} by ${prior.actor}.** Nothing was sent just now.`,
    "> Check the mailbox Sent Items. A send can report failure after Graph has already delivered it, so retrying blind risks a duplicate.",
    "> Use Send anyway only once you have confirmed the reply is NOT in Sent Items.",
  ].join("\n");
  await editNexusMessage(env, messageId, `${pending.cardBody || legacyCardBody(pending)}\n${banner}`, nexusOpts)
    .catch(e => console.warn(`[externalReplyGate] attempt-guard re-render failed: ${e.message}`));
  if (!workerBaseUrl) return;
  await attachButtons(env, messageId, [
    { button_id: `${buttonPrefix}_force:${messageId}`, label: "Send anyway", style: "danger", callback_url: `${workerBaseUrl}/api/internal/button-click` },
  ], nexusOpts).catch(err => console.warn(`[externalReplyGate] force button attach failed: ${err.message}`));
}

/**
 * Perform the send for a claimed card and settle or re-render the card.
 * Shared by the modal path, the legacy approve path and the force override.
 *
 * @param {object} env
 * @param {object} params - { messageId, key, pending, actor, opts, force }
 * @returns {Promise<{handled: boolean, action: string}>}
 */
async function sendAndSettle(env, { messageId, key, pending, actor, opts, force = false }) {
  const buttonPrefix = opts.buttonPrefix || "extmail";
  const kvPrefix = opts.kvPrefix || "extreply:";
  const nexusOpts = { nexusKeyEnvVar: opts.nexusKeyEnvVar, callbackSecretEnvVar: opts.callbackSecretEnvVar };
  const guardKey = `${kvPrefix}attempt:${pending.emailId}`;

  if (!force) {
    const prior = await claimSendAttempt(env, guardKey, actor);
    if (prior) {
      // Put the card back so the override button has something to act on.
      await env.CACHE.put(key, JSON.stringify(pending), { expirationTtl: TTL_SECONDS }).catch(() => {});
      await renderAlreadyAttempted(env, messageId, pending, prior, buttonPrefix, opts.workerBaseUrl || "", nexusOpts);
      return { handled: true, action: "already_attempted" };
    }
  }

  try {
    await opts.sendReply(env, pending);
  } catch (err) {
    await renderFailure(env, messageId, pending, err, key, nexusOpts);
    return { handled: true, action: "failed" };
  }

  // Opt-in episodic memory of what was ACTUALLY sent (after any reviewer edit).
  // The inbound side is written by the consumer's poller at stage time.
  if (opts.memoryBotId && pending.from) {
    await persistEmailExchange(env, opts.memoryBotId, {
      fromEmail: pending.from, subject: pending.subject, replyText: pending.draftHtml, audience: "external",
    });
  }

  const ccLine = Array.isArray(pending.cc) && pending.cc.length ? ` CC: ${pending.cc.join(", ")}` : "";
  await settleHitlCard(env, messageId, {
    botName: pending.botName || "",
    title: "External Reply",
    status: `Sent to ${pending.to || pending.from || "recipient"}${ccLine}`,
    actor,
  }, nexusOpts).catch(e => console.warn(`[externalReplyGate] settle failed: ${e.message}`));
  return { handled: true, action: "sent" };
}

/**
 * Handle a Reject / legacy Approve & Send / Send anyway click on an
 * external-reply card.
 *
 * @param {object} env
 * @param {object} payload   normalized button-click payload (button_id, message_id, display_name)
 * @param {object} opts
 * @param {function} opts.sendReply    (env, pending) => Promise, performs the Graph reply
 * @param {string} [opts.memoryBotId]  when set, the sent reply is written to shared memory (channel email)
 * @param {string} [opts.buttonPrefix="extmail"]
 * @param {string} [opts.kvPrefix="extreply:"]
 * @param {string} [opts.workerBaseUrl]
 * @param {string} [opts.nexusKeyEnvVar]
 * @param {string} [opts.callbackSecretEnvVar]
 * @returns {Promise<{handled: boolean, action?: string}>}
 */
export async function handleExternalReplyGate(env, payload, opts) {
  const buttonId = String(payload?.button_id || "");
  const messageId = String(payload?.message_id || "");
  const actor = (typeof payload?.display_name === "string" && payload.display_name.trim()) ? payload.display_name.trim() : "someone";
  const buttonPrefix = opts.buttonPrefix || "extmail";
  const kvPrefix = opts.kvPrefix || "extreply:";
  const nexusOpts = { nexusKeyEnvVar: opts.nexusKeyEnvVar, callbackSecretEnvVar: opts.callbackSecretEnvVar };

  if (!buttonId.startsWith(`${buttonPrefix}_`)) return { handled: false };
  if (!env.CACHE || !messageId) return { handled: false };

  const key = `${kvPrefix}${messageId}`;
  const raw = await env.CACHE.get(key);
  if (!raw) {
    await settleHitlCard(env, messageId, { title: "External Reply", status: "Already actioned" }, nexusOpts).catch(() => {});
    return { handled: true, action: "already" };
  }
  // Claim: delete first so a concurrent click loses the race.
  await env.CACHE.delete(key).catch(() => {});
  let pending;
  try { pending = JSON.parse(raw); } catch { pending = null; }

  if (buttonId.startsWith(`${buttonPrefix}_reject:`)) {
    await settleHitlCard(env, messageId, {
      botName: pending?.botName || "", title: "External Reply", status: "Rejected, nothing sent", actor, rejected: true,
    }, nexusOpts).catch(() => {});
    return { handled: true, action: "rejected" };
  }

  const isLegacyApprove = buttonId.startsWith(`${buttonPrefix}_approve:`);
  const isForce = buttonId.startsWith(`${buttonPrefix}_force:`);
  if (!isLegacyApprove && !isForce) return { handled: false };

  if (!pending) {
    await settleHitlCard(env, messageId, { title: "External Reply", status: "Draft payload unreadable, nothing sent", actor, rejected: true }, nexusOpts).catch(() => {});
    return { handled: true, action: "error" };
  }
  if (isLegacyApprove) {
    // Cards staged before the 2026-08-06 grammar change. Countable so the tail
    // can be confirmed empty before this branch is deleted.
    console.log(`[externalReplyGate] legacy_approve_grammar messageId=${messageId} actor=${actor}`);
  }

  return sendAndSettle(env, { messageId, key, pending, actor, opts, force: isForce });
}

/**
 * Handle the "Edit reply and send" modal submission. This is the sole send path
 * for cards staged from 2026-08-06 onward.
 *
 * @param {object} env
 * @param {object} payload   normalized modal payload (modal_id, message_id, display_name, values)
 * @param {object} opts      same shape as handleExternalReplyGate
 * @returns {Promise<{handled: boolean, action?: string}>}
 */
export async function handleExternalReplyModal(env, payload, opts) {
  const modalId = String(payload?.modal_id || payload?.modalId || "");
  const messageId = String(payload?.message_id || payload?.messageId || "");
  const actor = (typeof payload?.display_name === "string" && payload.display_name.trim()) ? payload.display_name.trim() : "someone";
  const values = payload?.values || {};
  const buttonPrefix = opts.buttonPrefix || "extmail";
  const kvPrefix = opts.kvPrefix || "extreply:";
  const nexusOpts = { nexusKeyEnvVar: opts.nexusKeyEnvVar, callbackSecretEnvVar: opts.callbackSecretEnvVar };

  if (!modalId.startsWith(`${buttonPrefix}-edit:`)) return { handled: false };
  if (!env.CACHE || !messageId) return { handled: false };

  const bodyText = typeof values.body === "string" ? values.body.trim() : "";
  if (!bodyText) return { handled: true, action: "empty_body" };

  const key = `${kvPrefix}${messageId}`;
  const raw = await env.CACHE.get(key);
  if (!raw) {
    await settleHitlCard(env, messageId, { title: "External Reply", status: "Already actioned" }, nexusOpts).catch(() => {});
    return { handled: true, action: "already" };
  }
  await env.CACHE.delete(key).catch(() => {});
  let pending;
  try { pending = JSON.parse(raw); } catch { pending = null; }
  if (!pending) {
    await settleHitlCard(env, messageId, { title: "External Reply", status: "Draft payload unreadable, nothing sent", actor, rejected: true }, nexusOpts).catch(() => {});
    return { handled: true, action: "error" };
  }

  const ccVal = typeof values.cc === "string" ? values.cc.trim() : "";
  const toVal = typeof values.to === "string" ? values.to.trim() : "";
  const subjectVal = typeof values.subject === "string" ? values.subject.trim() : "";

  // Overrides are set ONLY when the reviewer actually changed the field. An
  // untouched reply must PATCH neither toRecipients nor subject, so it keeps
  // whatever createReply built for the thread. Comparing against the same
  // values the modal was prefilled with is what makes that safe.
  const toList = toVal ? parseAddresses(toVal) : [];
  const toChanged = toList.length > 0 && toList.join(",").toLowerCase() !== String(pending.from || "").toLowerCase();
  const subjectChanged = Boolean(subjectVal) && subjectVal !== replySubject(pending.subject);

  const edited = {
    ...pending,
    cc: ccVal ? parseAddresses(ccVal) : [],
    to: toList.length ? toList.join(", ") : pending.to,
    toOverride: toChanged ? toList : undefined,
    subjectOverride: subjectChanged ? subjectVal : undefined,
    draftHtml: textToHtml(bodyText),
    edited_by: actor,
  };
  return sendAndSettle(env, { messageId, key, pending: edited, actor, opts });
}
