// =============================================================================
// lib/channelRouter.js, single source of truth for HITL approval channels.
//
// Bots historically hardcoded their approval channel slug in each job file
// ("maxwell-finance", "jacob-hitl", "soc-notifications"). When a routing
// decision needs to change (e.g. CRITICAL incidents go to a louder channel)
// every job file has to be patched. This registry centralizes the lookup.
//
// Resolution order, first match wins:
//   1. Severity override (route key + ":" + uppercase severity)
//   2. Direct route key (bot:kind)
//   3. Default template ({bot}-hitl)
//
// Client-specific routing (per-client Nexus channels) intentionally NOT
// here, that belongs in the CRM (clients.nexus_channel_slug, per the
// dexter-worker pattern). channelRouter is HITL approval channels only.
// =============================================================================

import registry from "../config/approval-channels.json" with { type: "json" };

/**
 * Resolve the Nexus channel slug for a HITL approval card.
 *
 * @param {object} env - unused today; reserved for env-overridable routing
 * @param {object} params
 * @param {string} params.bot                  - lowercase bot name
 * @param {string} params.kind                 - lowercase-kebab kind
 * @param {string} [params.severity]           - optional severity (CRITICAL, HIGH...)
 * @returns {string}
 */
export function routeApprovalChannel(env, { bot, kind, severity } = {}) {
  const b = String(bot || "").toLowerCase().trim();
  const k = String(kind || "").toLowerCase().trim();
  if (!b) throw new Error("routeApprovalChannel: bot is required");
  if (!k) throw new Error("routeApprovalChannel: kind is required");

  // 1. Severity override
  if (severity) {
    const sev = String(severity).toUpperCase();
    const sevKey = `${b}:${k}:${sev}`;
    const sevHit = registry.severity_overrides && registry.severity_overrides[sevKey];
    if (sevHit) return sevHit;
  }

  // 2. Direct route
  const routeKey = `${b}:${k}`;
  const direct = registry.routes && registry.routes[routeKey];
  if (direct) return direct;

  // 3. Default template
  const tmpl = registry.default || "{bot}-hitl";
  return tmpl.replace("{bot}", b);
}

/**
 * Returns the full registry (for debugging / admin routes).
 * @returns {object}
 */
export function getApprovalChannelRegistry() {
  return registry;
}
