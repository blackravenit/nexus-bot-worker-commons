// =============================================================================
// lib/intel/rdap.js: registration data via RDAP (rdap.org bootstrap).
//
// rdap.org redirects to the authoritative registry RDAP server per TLD, so
// one keyless endpoint covers every TLD the Mask sweep generates. A 404 is a
// definitive "not registered"; every other failure is reported as unknown
// (ok: false) so the caller never mistakes an outage for an answer.
//
// Lives in nexus-bot-worker-commons so robert-worker (Mask sweep) and
// scanner-worker (Hawkeye Mask scan) share one engine. Pure: no bindings.
// =============================================================================

const RDAP_BASE = "https://rdap.org/domain/";
const DEFAULT_USER_AGENT = "robert-worker/mask-sweep";

/**
 * Pulls the vCard fn or org value from an RDAP entity.
 * @param {object} entity - RDAP entity object
 * @returns {string|null} Display name, or null when absent
 */
function vcardName(entity) {
  const fields = entity?.vcardArray?.[1];
  if (!Array.isArray(fields)) return null;
  const org = fields.find((f) => f[0] === "org");
  const fn = fields.find((f) => f[0] === "fn");
  return (org?.[3] || fn?.[3] || null) ?? null;
}

/**
 * Finds the first RDAP entity carrying the given role.
 * @param {object} body - RDAP response body
 * @param {string} role - Role to search for (registrar, registrant)
 * @returns {object|null} Matching entity, or null
 */
function entityByRole(body, role) {
  return (body?.entities || []).find((e) => (e.roles || []).includes(role)) || null;
}

/**
 * Look up a domain's registration data.
 * @param {string} domain - Bare domain, punycode form for IDNs
 * @param {{userAgent?: string}} [options] - Caller identity; defaults to the Robert sweep UA
 * @returns {Promise<{ok: boolean, registered: boolean|null, registrar?: string|null, registrantOrg?: string|null, createdAt?: string|null, error?: string}>}
 */
export async function rdapDomain(domain, { userAgent = DEFAULT_USER_AGENT } = {}) {
  try {
    const res = await fetch(RDAP_BASE + encodeURIComponent(domain), {
      headers: { Accept: "application/rdap+json", "User-Agent": userAgent },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return { ok: true, registered: false };
    if (!res.ok) return { ok: false, registered: null, error: `http ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, registered: null, error: "unparseable rdap body" };
    const createdAt = (body.events || []).find((e) => e.eventAction === "registration")?.eventDate || null;
    return {
      ok: true,
      registered: true,
      registrar: vcardName(entityByRole(body, "registrar")),
      registrantOrg: vcardName(entityByRole(body, "registrant")),
      createdAt,
    };
  } catch (err) {
    return { ok: false, registered: null, error: err?.message || String(err) };
  }
}
