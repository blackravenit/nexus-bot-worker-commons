// =============================================================================
// lib/hitlCard.js, canonical HITL approval card builder.
//
// Single fleet entry point for the "human, decide this" surface. Renders the
// FLEET_OUTPUT_STYLE.md template (## title with optional severity pill,
// italic subtitle, ### sections with bullets or blockquotes, footer), wires
// up canonical buttons via BUTTON_LABELS, optionally attaches a modal,
// persists the pending row in hitl_pending so processButtonClick still works.
//
// Why this exists: before this helper each bot hand-rolled its approval card
// (Maxwell vendor-reply, Jacob newsletter, Courtney external-reply, ...).
// Titles, ID callouts, severity badges, button labels all drifted. The
// healer scorecard flags hand-rolled approvals (posted_via != postHitlCard)
// so they get migrated.
//
// Compatibility: the approve/deny pair is emitted with the LEGACY button_id
// grammar (hitl-approve:<messageId>, hitl-deny:<messageId>) so the existing
// commons processButtonClick handler routes them. Any other buttons (edit,
// skip, send, etc.) use the new <verb>:<kind>:<id> grammar from buttonId.js
// and must be handled per-bot.
// =============================================================================

import { postToNexus, attachButtons, attachModals } from "./nexus.js";
import { BUTTON_LABELS, buttonId } from "./buttonId.js";
import { linkButtons } from "./appLinks.js";
import { routeApprovalChannel } from "./channelRouter.js";
import { nexusTimestamp, PALETTE } from "./format.js";

const MAX_CARD_CHARS = 6000;
const DEFAULT_DB_BINDING = "DB";

/**
 * Post a canonical HITL approval card.
 *
 * @param {object} env
 * @param {object} params
 * @param {string} params.bot          - lowercase bot name ("maxwell", "jacob")
 * @param {string} params.kind         - lowercase-kebab (e.g. "vendor-reply")
 * @param {string} params.approvalId   - opaque per-row identifier (no colons)
 * @param {string} params.title        - sentence-case title text
 * @param {string} [params.titleEmoji] - palette glyph prepended to title
 * @param {string} [params.subtitle]   - one-line italic summary under the title
 * @param {string} [params.severity]   - "CRITICAL" | "HIGH" | "DEGRADED" | "STABLE" etc.
 *                                       Rendered as inline-code pill at end of title.
 * @param {Array<HitlSection>} [params.sections]
 * @param {string[]|string} [params.buttons]
 *   Either a list of verb keys ["approve","deny","edit"] (rendered with
 *   defaults) or richer overrides: [{verb, label?, style?}]. Default:
 *   ["approve","deny"]. The approve/deny pair gets legacy button_id format
 *   for processButtonClick compatibility.
 * @param {Array<{label:string,url:string|null,style?:string}>} [params.links]
 *   Optional deep-link url-buttons (e.g. {label:"View in Xero", url}). Each is
 *   rendered as a Nexus url-button that opens in a new tab; specs whose url is
 *   null/unbuildable are silently dropped. Appended after the action buttons.
 * @param {object} [params.modal]      - optional { trigger, title, fields, modalId? }
 *                                       trigger ∈ BUTTON_LABELS keys (e.g. "edit").
 * @param {string} [params.channelSlug]   - override resolved channel
 * @param {string} [params.severityChannel] - if supplied, ignored (use channelRouter)
 * @param {string} params.requesterUserId - persisted into hitl_pending
 * @param {object} [params.actionPayload] - optional opaque object stored in
 *                                          hitl_pending.action_payload
 * @param {string} [params.callbackUrl] - full button click callback URL.
 *                                        Auto-derived from env.WORKER_BASE_URL
 *                                        when omitted.
 * @param {string} [params.nexusKeyEnvVar]
 * @param {string} [params.dbBinding]
 * @returns {Promise<{messageId:string, approvalId:string, channelSlug:string} | null>}
 */
export async function postHitlCard(env, params = {}) {
  const {
    bot,
    kind,
    approvalId,
    title,
    titleEmoji,
    subtitle,
    severity,
    sections = [],
    buttons = ["approve", "deny"],
    links,
    modal,
    requesterUserId,
    actionPayload,
    nexusKeyEnvVar,
    callbackSecretEnvVar,
    callbackSecret,
    dbBinding = DEFAULT_DB_BINDING,
  } = params;

  if (!bot || !kind || !approvalId) {
    throw new Error("postHitlCard: bot, kind, approvalId are required");
  }
  if (!title) {
    throw new Error("postHitlCard: title is required");
  }

  const channelSlug = params.channelSlug
    || routeApprovalChannel(env, { bot, kind, severity });
  const callbackUrl = params.callbackUrl
    || _resolveCallbackUrl(env);

  // ---- Render markdown ------------------------------------------------------
  const body = renderHitlCard({
    bot, kind, title, titleEmoji, subtitle, severity, sections,
  });

  // ---- Post -----------------------------------------------------------------
  const nexusOptions = {
    nexusKeyEnvVar,
    callbackSecretEnvVar,
    callbackSecret,
    provenance: "hitl-approval",
    postedVia: "postHitlCard",
  };
  const msg = await postToNexus(env, channelSlug, body, nexusOptions);
  if (!msg || !msg.id) {
    console.warn(`[postHitlCard] postToNexus(${channelSlug}) returned no message id`);
    return null;
  }
  const messageId = msg.id;

  // ---- Buttons --------------------------------------------------------------
  const buttonDescriptors = _resolveButtons(buttons, {
    messageId, kind, approvalId, callbackUrl,
  });
  // Optional deep-link url-buttons ("Open in Xero", etc.) ride alongside the
  // approve/deny callback buttons in the same attach call. linkButtons drops
  // any spec whose url couldn't be built, so a missing config var = no button.
  if (Array.isArray(links) && links.length > 0) {
    buttonDescriptors.push(...linkButtons(links));
  }
  if (buttonDescriptors.length > 0) {
    try {
      await attachButtons(env, messageId, buttonDescriptors, nexusOptions);
    } catch (err) {
      console.warn(`[postHitlCard] attachButtons failed: ${err.message}`);
    }
  }

  // ---- Modal ----------------------------------------------------------------
  if (modal && Array.isArray(modal.fields)) {
    const modalDescriptor = {
      modal_id: modal.modalId || buttonId(modal.trigger || "edit", kind, approvalId),
      title: modal.title || "Edit",
      fields: modal.fields,
      // Trigger button label inherits from BUTTON_LABELS unless overridden.
      trigger_label: modal.triggerLabel
        || (BUTTON_LABELS[modal.trigger || "edit"]?.label)
        || "Edit",
      trigger_style: modal.triggerStyle
        || (BUTTON_LABELS[modal.trigger || "edit"]?.style)
        || "secondary",
      callback_url: callbackUrl,
    };
    try {
      await attachModals(env, messageId, [modalDescriptor], nexusOptions);
    } catch (err) {
      console.warn(`[postHitlCard] attachModals failed: ${err.message}`);
    }
  }

  // ---- Persist pending row --------------------------------------------------
  const db = env[dbBinding];
  if (db) {
    try {
      const now = Math.floor(Date.now() / 1000);
      await db
        .prepare(
          `INSERT OR REPLACE INTO hitl_pending
             (message_id, channel_slug, action_payload, requester_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          messageId,
          channelSlug,
          JSON.stringify({
            bot, kind, approvalId, severity: severity || null,
            payload: actionPayload || null,
          }),
          requesterUserId || "",
          now,
        )
        .run();
    } catch (err) {
      console.error(`[postHitlCard] hitl_pending persist failed: ${err.message}`);
    }
  }

  return { messageId, approvalId, channelSlug };
}

/**
 * Pure markdown renderer for the canonical HITL card. Exported so tests +
 * the healer can compare expected output to a captured post.
 *
 * @param {object} opts, same shape as postHitlCard params (visual subset)
 * @returns {string}
 */
export function renderHitlCard({
  bot, kind, title, titleEmoji, subtitle, severity, sections = [], numbered = false,
}) {
  const titlePrefix = titleEmoji ? `${titleEmoji} ` : "";
  const severityPill = severity ? ` \`${String(severity).toUpperCase()}\`` : "";
  const out = [`## ${titlePrefix}${title}${severityPill}`];
  if (subtitle) {
    out.push(`*${subtitle}*`);
  }

  const renderedSections = sections
    .map((sec, i) => renderSection(sec, i, numbered))
    .filter(Boolean);
  if (renderedSections.length > 0) {
    out.push("");
    out.push(renderedSections.join("\n\n---\n\n"));
  }

  const stamp = nexusTimestamp(Date.now(), "f");
  const botPretty = _titleCase(bot || "bot");
  const footer = `${botPretty} · ${kind || "approval"} · pending decision`;
  out.push("");
  out.push("---");
  out.push(`*${footer} · ${stamp}*`);

  let body = out.join("\n");
  const TRUNC_SUFFIX = "\n\n_... (truncated)_";
  if (body.length > MAX_CARD_CHARS) {
    body = body.slice(0, MAX_CARD_CHARS - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
  }
  return body;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Render a single section header (house style: emoji+bold, no markdown `###`).
 * Numbering is off by default for HITL cards; pass `numbered=true` (or set it
 * card-wide on renderHitlCard) to get "1. / 2. / ..." prefixes, and
 * `sec.number === false` to opt an individual section out.
 *
 * Accepts mutually-exclusive body shapes:
 *   - lines:  raw multi-line content
 *   - items:  bullet list
 *   - kv:     {key: value} key/value pairs
 *   - quote:  {from, subject, body, truncatedAt?} → blockquote
 *
 * @param {object} sec
 * @param {number} [index=0]
 * @param {boolean} [numbered=false]
 * @returns {string|null}
 */
function renderSection(sec, index = 0, numbered = false) {
  if (!sec || typeof sec !== "object") return null;
  const emoji = sec.emoji ? `${sec.emoji} ` : "";
  const count = typeof sec.count === "number" ? ` *(${sec.count})*` : "";
  const numPrefix = numbered && sec.number !== false ? `${index + 1}. ` : "";
  const header = `${emoji}**${numPrefix}${sec.title || ""}**${count}`;

  if (sec.quote && typeof sec.quote === "object") {
    return `${header}\n${_renderQuote(sec.quote)}`;
  }
  if (sec.kv && typeof sec.kv === "object") {
    const rows = Object.entries(sec.kv)
      .map(([k, v]) => `- **${k}:** ${v}`)
      .join("\n");
    return `${header}\n${rows || "None"}`;
  }
  if (Array.isArray(sec.items)) {
    if (sec.items.length === 0) return `${header}\n${sec.empty || "None"}`;
    const max = typeof sec.max === "number" ? sec.max : 8;
    const visible = sec.items.slice(0, max);
    const overflow = sec.items.length - visible.length;
    const lines = visible.map((it) => `- ${it}`);
    if (overflow > 0) lines.push(`_+${overflow} more_`);
    return `${header}\n${lines.join("\n")}`;
  }
  if (typeof sec.lines === "string") {
    return `${header}\n${sec.lines}`;
  }
  return header;
}

/**
 * Render an email/message quote as a blockquote. Short content (≤ 400 chars)
 * inline; longer content gets a `_... (truncated)_` tail. Reserves the
 * triple-backtick fence for raw output that must survive as plain text.
 *
 * @param {{from?:string, subject?:string, body:string, max?:number}} q
 * @returns {string}
 */
function _renderQuote({ from, subject, body, max = 400 }) {
  const lines = [];
  if (from)    lines.push(`> **From:** ${from}`);
  if (subject) lines.push(`> **Subject:** ${subject}`);
  if (from || subject) lines.push(`>`);
  const safeBody = String(body || "").trim();
  const truncated = safeBody.length > max;
  const shown = truncated ? safeBody.slice(0, max).trimEnd() : safeBody;
  const wrapped = shown
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  lines.push(wrapped || "> (empty)");
  if (truncated) {
    lines.push(`> _... (truncated, ${safeBody.length - max} chars omitted)_`);
  }
  return lines.join("\n");
}

/**
 * Translate the buttons param into concrete attachButtons descriptors.
 * approve / deny use legacy button_id format so processButtonClick handles
 * them. Other verbs use the canonical <verb>:<kind>:<id> grammar.
 *
 * @param {string[]|Array<{verb:string,label?:string,style?:string}>} btnsRaw
 * @param {{messageId:string, kind:string, approvalId:string, callbackUrl:string}} ctx
 * @returns {object[]}
 */
function _resolveButtons(btnsRaw, ctx) {
  const arr = Array.isArray(btnsRaw) ? btnsRaw : [];
  return arr.map((b) => {
    const verb = (typeof b === "string" ? b : b?.verb || "").toLowerCase();
    const spec = BUTTON_LABELS[verb];
    if (!spec) {
      console.warn(`[postHitlCard] unknown button verb "${verb}", skipping`);
      return null;
    }
    const label = (typeof b === "object" && b.label) || spec.label;
    const style = (typeof b === "object" && b.style) || spec.style;
    let id;
    if (verb === "approve") {
      id = `hitl-approve:${ctx.messageId}`;
    } else if (verb === "deny") {
      id = `hitl-deny:${ctx.messageId}`;
    } else {
      id = buttonId(verb, ctx.kind, ctx.approvalId);
    }
    return {
      button_id: id,
      label,
      style,
      callback_url: ctx.callbackUrl,
    };
  }).filter(Boolean);
}

function _resolveCallbackUrl(env) {
  const raw = env?.WORKER_BASE_URL || env?.SELF_URL || "";
  if (!raw) {
    console.warn("[postHitlCard] no WORKER_BASE_URL; buttons will fail to call back");
    return "";
  }
  try {
    return `${new URL(raw).origin}/api/internal/button-click`;
  } catch {
    return `${raw.replace(/\/+$/, "")}/api/internal/button-click`;
  }
}

function _titleCase(s) {
  return String(s || "")
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Re-export PALETTE for callers that want the canonical emoji set.
export { PALETTE };
