// =============================================================================
// lib/hitl.js - Human-in-the-loop approval card helper for bot workers
//
// Two exported functions:
//
// postApprovalCard(env, params, [options])
//   Posts an approval card to the approvals channel, attaches Approve/Deny
//   buttons, persists a pending record in D1.
//   Accepts two call shapes:
//     Chat HITL:   { action, channelSlug, requesterUserId, summary }
//     Legacy cron: { incidentId, operation, description, risk, actionParams, reversible }
//
// processButtonClick(env, payload, [options])
//   Resolves a pending HITL action when a user clicks a button.
//   Returns { handled: false } for non-hitl button IDs so per-bot button
//   code can fall through to its own logic.
//
// options:
//   approvalSlug     {string} - channel slug for approval cards (required)
//   nexusKeyEnvVar   {string} - env var name for Nexus API key
//   workerBaseUrlEnvVar {string} - env var name for worker base URL
//   dbBinding        {string} - D1 binding name (default: "DB")
//
// Button ID formats:
//   Legacy cron path:  "approve:<incidentId>" | "deny:<incidentId>"
//   Chat HITL path:    "hitl-approve:<messageId>" | "hitl-deny:<messageId>"
//
// D1 table: hitl_pending (migration 003_hitl_pending.sql)
// =============================================================================

import { postToNexus, attachButtons, settleMessageComponents } from "./nexus.js";

const DEFAULT_DB_BINDING = "DB";

/**
 * Resolve the worker base URL for constructing button callback URLs.
 *
 * @param {object} env
 * @param {object} options
 * @returns {string}
 */
function resolveWorkerBase(env, options) {
  const raw = (options.workerBaseUrlEnvVar ? env[options.workerBaseUrlEnvVar] : env.WORKER_BASE_URL) || "";
  if (!raw) return "";
  // Normalise to the bare origin. Some bots set this var to the FULL
  // button-click URL (e.g. ".../api/internal/button-click"), and callers append
  // their own path, without this, the path doubles and the callback 404s.
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/**
 * Post a HITL approval card to the approvals channel.
 *
 * Chat HITL call shape:
 *   params = { action, channelSlug, requesterUserId, summary }
 *   where action is the parsed action object from Claude's response.
 *
 * Legacy cron call shape:
 *   params = { incidentId, operation, description, risk, actionParams, reversible }
 *
 * @param {object} env - CF env bindings
 * @param {object} params
 * @param {object} options
 * @param {string} options.approvalSlug - channel slug for the approval card
 * @param {string} [options.nexusKeyEnvVar] - env var name for Nexus key
 * @param {string} [options.workerBaseUrlEnvVar] - env var for worker base URL
 * @param {string} [options.dbBinding="DB"] - D1 binding name
 * @returns {Promise<string>} Acknowledgment message
 */
export async function postApprovalCard(env, params, options = {}) {
  if (!options.approvalSlug) {
    throw new Error("[hitl] postApprovalCard: options.approvalSlug is required");
  }

  const approvalSlug = options.approvalSlug;
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const callbackUrl = `${resolveWorkerBase(env, options)}/api/internal/button-click`;
  // callbackSecretEnvVar must be forwarded into nexusOptions so attachButtons
  // stamps each button with callback_secret. Without it, Nexus persists
  // callback_secret=NULL; the dispatcher's signCallback("") then throws in
  // crypto.subtle.importKey and the click silently 500s with no audit row.
  // (Burned 2026-05-28 on dexter-worker HITL approvals.)
  const nexusOptions = {
    nexusKeyEnvVar: options.nexusKeyEnvVar,
    callbackSecretEnvVar: options.callbackSecretEnvVar,
    callbackSecret: options.callbackSecret,
    provenance: "hitl-approval",
  };

  // ---- Chat HITL path (action block from Claude) ----------------------------
  if (params.action) {
    const { action, channelSlug, requesterUserId, summary } = params;
    const riskLabel = (action.risk || "unknown").toUpperCase();
    const opLabel = action.operation || action.service || "unknown";
    const descText = summary || action.description || "No description provided.";

    const cardLines = [
      `## SOC Response Action, Pending Approval \`${riskLabel}\``,
      `*Operation: \`${opLabel}\`*`,
      ``,
      `- **Requested by:** ${requesterUserId || "unknown"}`,
      `- **Description:** ${descText}`,
    ];
    if (action.params) {
      cardLines.push(`Parameters:\n\`\`\`json\n${JSON.stringify(action.params, null, 2).slice(0, 400)}\n\`\`\``);
    }
    cardLines.push(`\nClick Approve to execute or Deny to reject.`);

    const msg = await postToNexus(env, approvalSlug, cardLines.join("\n"), nexusOptions);
    if (!msg || !msg.id) {
      console.warn("[hitl] chat: postToNexus returned no message id");
      return "Approval card could not be posted (Nexus unavailable). Contact ops to resolve manually.";
    }

    const messageId = msg.id;

    await attachButtons(env, messageId, [
      {
        button_id: `hitl-approve:${messageId}`,
        label: "Approve",
        style: "success",
        callback_url: callbackUrl,
      },
      {
        button_id: `hitl-deny:${messageId}`,
        label: "Deny",
        style: "danger",
        callback_url: callbackUrl,
      },
    ], nexusOptions);

    const db = env[dbKey];
    if (db) {
      const now = Math.floor(Date.now() / 1000);
      try {
        await db
          .prepare(
            `INSERT OR REPLACE INTO hitl_pending
             (message_id, channel_slug, action_payload, requester_user_id, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(messageId, channelSlug || approvalSlug, JSON.stringify(action), requesterUserId || "", now)
          .run();
      } catch (err) {
        console.error("[hitl] chat D1 persist failed:", err.message);
      }
    }

    return `Pending approval posted to ${approvalSlug} (message \`${messageId}\`). Waiting for human authorization.`;
  }

  // ---- Legacy cron path (incidentId-based) ----------------------------------
  const {
    incidentId,
    operation,
    description,
    risk,
    actionParams,
    reversible = false,
  } = params;

  const riskLabel = (risk || "high").toUpperCase();
  const reversibleLabel = reversible ? "Yes" : "No";
  const paramsSnippet = JSON.stringify(actionParams, null, 2).slice(0, 600);

  const cardBody = [
    `## SOC Action Pending Approval \`${riskLabel}\``,
    ``,
    `- **Operation:** \`${operation}\``,
    `- **Description:** ${description}`,
    `- **Reversible:** ${reversibleLabel}`,
    `- **Incident ID:** \`${incidentId}\``,
    `Parameters:\n\`\`\`json\n${paramsSnippet}\n\`\`\``,
    ``,
    `Click Approve or Deny below.`,
  ].join("\n");

  const msg = await postToNexus(env, approvalSlug, cardBody, nexusOptions);
  if (!msg || !msg.id) {
    console.warn("[hitl] legacy: postToNexus returned no message id, cannot attach buttons");
    return `Approval card queued (Nexus unavailable). Incident ID: \`${incidentId}\`. Contact ops to resolve manually.`;
  }

  await attachButtons(env, msg.id, [
    {
      button_id: `approve:${incidentId}`,
      label: "Approve & Execute",
      style: "success",
      callback_url: callbackUrl,
    },
    {
      button_id: `deny:${incidentId}`,
      label: "Deny",
      style: "danger",
      callback_url: callbackUrl,
    },
  ], nexusOptions);

  return `Pending approval, Incident ID \`${incidentId}\` posted to ${approvalSlug}. Waiting for human authorization.`;
}

/**
 * Resolve a HITL action when a user clicks an Approve or Deny button.
 * Only handles button IDs with the "hitl-approve:" or "hitl-deny:" prefix.
 * Returns { handled: false } for any other button_id so per-bot button
 * logic can fall through.
 *
 * @param {object} env - CF env bindings
 * @param {object} payload - Button click payload from Nexus
 * @param {string} payload.message_id - Nexus message id
 * @param {string} payload.button_id - "hitl-approve:<msgId>" | "hitl-deny:<msgId>"
 * @param {string} payload.user_id - Who clicked
 * @param {string} payload.display_name - Display name of who clicked
 * @param {object} options
 * @param {string} options.approvalSlug - channel slug for resolution acknowledgment
 * @param {string} [options.nexusKeyEnvVar] - env var name for Nexus key
 * @param {string} [options.dbBinding="DB"] - D1 binding name
 * @returns {Promise<{handled: boolean, action: string|null, pending: object|null}>}
 */
export async function processButtonClick(env, payload, options = {}) {
  if (!options.approvalSlug) {
    throw new Error("[hitl] processButtonClick: options.approvalSlug is required");
  }

  const approvalSlug = options.approvalSlug;
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const nexusOptions = {
    nexusKeyEnvVar: options.nexusKeyEnvVar,
    provenance: "hitl-approval",
  };

  const { message_id, button_id, user_id, display_name } = payload || {};

  if (!button_id || typeof button_id !== "string") {
    return { handled: false, action: null, pending: null };
  }

  const isApprove = button_id.startsWith("hitl-approve:");
  const isDeny = button_id.startsWith("hitl-deny:");

  if (!isApprove && !isDeny) {
    return { handled: false, action: null, pending: null };
  }

  const resolution = isApprove ? "approved" : "denied";
  const cardMessageId = message_id || button_id.replace(/^hitl-(?:approve|deny):/, "");

  let pending = null;
  const db = env[dbKey];

  if (db) {
    try {
      const row = await db
        .prepare("SELECT * FROM hitl_pending WHERE message_id = ?")
        .bind(cardMessageId)
        .first();

      if (row) {
        pending = {
          ...row,
          action_payload: JSON.parse(row.action_payload || "{}"),
        };
        const resolvedAt = Math.floor(Date.now() / 1000);
        await db
          .prepare("UPDATE hitl_pending SET resolved_at = ?, resolution = ? WHERE message_id = ?")
          .bind(resolvedAt, resolution, cardMessageId)
          .run();
      }
    } catch (err) {
      console.error("[hitl] processButtonClick D1 error:", err.message);
    }
  }

  // Strip the original card's Approve/Deny controls now that it is resolved, so
  // a settled SOC card cannot be re-clicked. The decision detail is carried by
  // the resolution post below; we only retire the stale buttons here.
  await settleMessageComponents(env, cardMessageId, nexusOptions).catch(() => {});

  const decidedBy = display_name || user_id || "unknown";
  const opLabel = pending?.action_payload?.operation || pending?.action_payload?.service || "unknown";

  const resultLines = [
    `**Action ${resolution.toUpperCase()}**`,
    `Operation: \`${opLabel}\``,
    `Decision by: **${decidedBy}**`,
    `At: ${new Date().toISOString()}`,
    resolution === "approved"
      ? "Mitigation workflow acknowledged. Check SentinelOne for remediation status."
      : "No automated mitigation fired. Human follow-up required.",
  ];

  await postToNexus(env, approvalSlug, resultLines.join("\n"), nexusOptions).catch(err => {
    console.warn("[hitl] resolution post failed:", err.message);
  });

  return { handled: true, action: resolution, pending };
}
