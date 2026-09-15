// =============================================================================
// lib/fleetAdmins.js - Fleet admin identity, resolved from env, never hardcoded.
//
// Seven workers (courtney, dexter, jacob, maxwell, moxie, robert, wren) each
// gated admin-only commands on a single `env.BRIAN_NEXUS_USER_ID`, several with
// a literal uid baked in as a fallback. That shape cannot express a SECOND
// admin, so adding coverage meant editing and redeploying every worker.
//
// The list lives in `env.ADMIN_NEXUS_USER_IDS` (comma separated Nexus user ids)
// and falls back to the legacy single `env.BRIAN_NEXUS_USER_ID` so existing
// wrangler.toml [vars] keep working untouched. Commons deliberately carries NO
// uid literal: an unconfigured worker resolves to an empty admin list and its
// admin actions stay closed, which is the safe direction to fail.
// =============================================================================

/**
 * Resolve the ordered list of Nexus user ids allowed to run admin actions.
 *
 * Reads `env.ADMIN_NEXUS_USER_IDS` (comma separated), trimming each entry and
 * dropping empties. When that var is unset or contains no usable id, falls back
 * to the legacy single `env.BRIAN_NEXUS_USER_ID`. Returns an empty array when
 * neither is configured, so callers fail closed rather than onto a literal.
 *
 * @param {object} env - Worker env bindings
 * @returns {string[]} Trimmed, non empty, de duplicated admin Nexus user ids
 */
export function getAdminNexusUserIds(env) {
  const raw = typeof env?.ADMIN_NEXUS_USER_IDS === "string" ? env.ADMIN_NEXUS_USER_IDS : "";
  const listed = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (listed.length > 0) return [...new Set(listed)];

  const legacy = typeof env?.BRIAN_NEXUS_USER_ID === "string" ? env.BRIAN_NEXUS_USER_ID.trim() : "";
  return legacy ? [legacy] : [];
}

/**
 * Membership check for admin gated commands and tools.
 *
 * @param {object} env - Worker env bindings
 * @param {string} userId - Nexus user id of the caller
 * @returns {boolean} True when userId is a configured fleet admin
 */
export function isFleetAdmin(env, userId) {
  const candidate = typeof userId === "string" ? userId.trim() : "";
  if (!candidate) return false;
  return getAdminNexusUserIds(env).includes(candidate);
}

/**
 * First configured admin id, for code paths that must DM exactly one person
 * (pager escalations, single recipient approval cards).
 *
 * @param {object} env - Worker env bindings
 * @returns {string|null} The primary admin Nexus user id, or null when unset
 */
export function getPrimaryAdminNexusUserId(env) {
  const [first] = getAdminNexusUserIds(env);
  return first || null;
}
