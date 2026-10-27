// =============================================================================
// lib/kbClientProfiles.js, Shared Client Profiles tools (KB app) for the fleet.
//
// The KB's Client Profiles module (kb.blackravenit.com, Clients tab) is the
// structured per-client reference store: sites, WAN/LAN networks, key
// infrastructure, portal references, and vendor contacts, plus the IP lookup
// that answers "whose IP is this" during alert triage. Origin: Desk 6644, an
// impossible-travel false positive that burned an evening because nobody could
// answer that question.
//
// INTERNAL ONLY. Everything this module returns is staff-facing operational
// data: it is shared in Nexus and nowhere else. It must never appear in any
// email, SMS, phone call, or other client-facing output.
//
// Split surfaces:
//   kbProfileReadTools/Handlers, Robert, Dexter, Courtney (lookup + read)
//   kbProfileWriteTools/Handlers, Courtney ONLY (she maintains the data)
// Write tools are exported separately and imported only by Courtney's
// registry; read-only bots never even see them.
//
// Auth: X-API-Key (KB_API_KEY, each worker holds its own key with the right
// role server-side). Base via KB_API_URL or https://kb.blackravenit.com.
// Handler signature (input, env, ctx) per SPEC.md. Opaque refusal when
// unconfigured. Secrets NEVER live in this store: credential fields are
// keeper:// pointers and the API rejects anything else.
// =============================================================================

const DEFAULT_BASE = "https://kb.blackravenit.com";

/**
 * True when the KB API key is present in env.
 * @param {object} env
 * @returns {boolean}
 */
function isConfigured(env) {
  return Boolean(env && env.KB_API_KEY);
}

/**
 * Opaque refusal for an unconfigured KB env.
 * @returns {{error: string}}
 */
function notConfigured() {
  return { error: "Client profile lookup is unavailable in this environment." };
}

/**
 * JSON request against the KB API. Returns parsed body; throws on non-2xx.
 * @param {object} env
 * @param {string} method
 * @param {string} path - path starting with /api/...
 * @param {object} [body]
 * @returns {Promise<any>}
 */
async function kbFetch(env, method, path, body) {
  const baseUrl = (env.KB_API_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "X-API-Key": env.KB_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `KB ${method} ${path} ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Wraps a handler body with the configured-check and error shaping every
 * tool here shares.
 * @param {Function} fn - async (input, env, ctx) => result
 * @returns {Function}
 */
function guarded(fn) {
  return async (input, env, ctx) => {
    if (!isConfigured(env)) return notConfigured();
    try {
      return await fn(input, env, ctx);
    } catch (err) {
      return { error: err.message };
    }
  };
}

// ---- Read tools (Robert, Dexter, Courtney) ----------------------------------

export const kbProfileReadTools = [
  {
    name: "kb_lookup_client_by_ip",
    description:
      "INTERNAL ONLY: resolve an IP address to the client, site, and network record it belongs to. Call this BEFORE classifying any geo-anomaly or impossible-travel alert: most 'impossible travel' on staff accounts is a tech egressing from a client office or their own home. Returns ALL matches (IPs get reassigned) with confidence (confirmed = human-verified, observed = telemetry hypothesis, stale = old), is_egress, reverse DNS, and last_seen, plus unclaimed-queue hits including 'BRIT staff egress' designations. Always state the confidence level when citing a match, and never assert a client for an unattributed IP. Share results in Nexus only, never in any client-facing output.",
    input_schema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "IPv4 address to resolve, e.g. '184.180.185.195'." },
      },
      required: ["ip"],
    },
  },
  {
    name: "kb_get_client_profile",
    description:
      "INTERNAL ONLY: fetch a client's full profile from the KB Client Profiles store: summary, alert banner, sites with their networks (WAN IPs, subnets, ISP, circuit refs, reverse DNS), key infrastructure (firewall, NAS, servers; Keeper credential pointers only, never secrets), portal references, and vendor/ISP contacts. Accepts the client code (kim, acc) or client UUID. This is the fastest orientation on a client before touching their environment. Nexus only, never client-facing.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client code (e.g. 'kim') or client UUID." },
      },
      required: ["client"],
    },
  },
  {
    name: "kb_list_client_profiles",
    description:
      "INTERNAL ONLY: list all client profiles in the KB store with client code, company, site/network counts, and alert level. Use to browse coverage or find which clients have documented networks.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "kb_list_client_networks",
    description:
      "INTERNAL ONLY: list every network record for one client (flat, including soft-deleted history rows flagged by deleted_at). Answers 'give me every known egress IP for client X' including 'was this IP theirs three weeks ago'. Accepts client code or UUID.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client code or client UUID." },
      },
      required: ["client"],
    },
  },
  {
    name: "kb_list_unclaimed_ips",
    description:
      "INTERNAL ONLY: list the observed-but-unattributed egress IP queue (from Entra sign-in telemetry). Each row has sighting count, which staff users were seen, first/last seen, ISP/ASN/reverse DNS enrichment, and status (open, staff_egress, dismissed, assigned). Never guess an attribution from this list; a human assigns in the KB UI.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: open (default), staff_egress, dismissed, assigned, or all." },
      },
      required: [],
    },
  },
];

/**
 * Resolves a client code/UUID to its profile id, throwing on a miss.
 * @param {object} env
 * @param {string} client
 * @returns {Promise<object>} Full profile payload
 */
async function getProfileOrThrow(env, client) {
  const key = String(client || "").trim();
  if (!key) throw new Error("client is required");
  const data = await kbFetch(env, "GET", `/api/client-profiles/${encodeURIComponent(key)}`);
  return data.profile;
}

export const kbProfileReadHandlers = {
  kb_lookup_client_by_ip: guarded(async (input, env) => {
    const ip = String(input?.ip || "").trim();
    if (!ip) return { error: "ip is required" };
    return kbFetch(env, "GET", `/api/lookup/ip/${encodeURIComponent(ip)}`);
  }),
  kb_get_client_profile: guarded(async (input, env) => {
    return { profile: await getProfileOrThrow(env, input?.client) };
  }),
  kb_list_client_profiles: guarded(async (_input, env) => {
    return kbFetch(env, "GET", "/api/client-profiles");
  }),
  kb_list_client_networks: guarded(async (input, env) => {
    const profile = await getProfileOrThrow(env, input?.client);
    return kbFetch(env, "GET", `/api/client-profiles/${profile.id}/networks`);
  }),
  kb_list_unclaimed_ips: guarded(async (input, env) => {
    const status = String(input?.status || "open");
    return kbFetch(env, "GET", `/api/unclaimed-ips?status=${encodeURIComponent(status)}`);
  }),
};

// ---- Write tools (Courtney ONLY) --------------------------------------------

const KEEPER_HINT =
  "Credential fields accept keeper://<record_uid> pointers ONLY; the API rejects anything else. Never place a password or secret in any field.";

export const kbProfileWriteTools = [
  {
    name: "kb_upsert_client_profile",
    description:
      `INTERNAL ONLY: create or update a client profile (idempotent on client_id; requires the FULL client UUID, never truncated). Also updates summary, alert banner (the read-me-first strip techs see), and primary site label. ${KEEPER_HINT}`,
    input_schema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "Full CRM client UUID." },
        client_code: { type: "string", description: "Short client code (kim, acc)." },
        company: { type: "string", description: "Exact Desk company name." },
        summary: { type: "string", description: "2-3 sentence orientation for techs." },
        alert_banner: { type: "string", description: "Read-me-first strip, 1-3 lines." },
        alert_level: { type: "string", description: "info, warning, or critical." },
        primary_site_label: { type: "string" },
      },
      required: ["client_id", "company"],
    },
  },
  {
    name: "kb_add_client_site",
    description:
      "INTERNAL ONLY: add a physical site to a client profile. Networks and infrastructure hang off sites. Pass the client code or UUID plus a label.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client code or UUID." },
        label: { type: "string", description: "e.g. 'Phoenix HQ'." },
        address: { type: "string" },
        timezone: { type: "string", description: "IANA tz, e.g. America/Phoenix." },
        notes: { type: "string" },
      },
      required: ["client", "label"],
    },
  },
  {
    name: "kb_add_client_network",
    description:
      "INTERNAL ONLY: add a network record (WAN IP, LAN subnet, VPN endpoint) to a client site. kind: wan_static, wan_dynamic_observed, lan_subnet, vpn_endpoint, guest. confidence: confirmed (human verified), observed, stale. Set is_egress true when staff/client traffic leaves from this IP (alert triage matches on it). rDNS/ASN/ISP auto-enrich on write.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client code or UUID." },
        site_label: { type: "string", description: "Which site (exact label, e.g. 'Phoenix HQ')." },
        kind: { type: "string" },
        value: { type: "string", description: "IP, CIDR, or hostname." },
        isp: { type: "string" },
        circuit_ref: { type: "string", description: "Account/circuit number for calling the ISP." },
        confidence: { type: "string" },
        is_egress: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["client", "site_label", "kind", "value"],
    },
  },
  {
    name: "kb_update_client_network",
    description:
      "INTERNAL ONLY: update a network record by id (confidence, last_seen, notes, kind, value...). To retire a network use soft delete semantics: set confidence 'stale' or ask a human to retire it in the UI; records are never hard-deleted because history answers 'was this IP theirs three weeks ago'.",
    input_schema: {
      type: "object",
      properties: {
        network_id: { type: "string" },
        kind: { type: "string" },
        value: { type: "string" },
        isp: { type: "string" },
        circuit_ref: { type: "string" },
        confidence: { type: "string" },
        is_egress: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["network_id"],
    },
  },
  {
    name: "kb_add_client_infrastructure",
    description:
      `INTERNAL ONLY: add a named device (firewall, switch, ap, server, nas, hypervisor, ups, printer, other) to a client site. Not an inventory; Ninja is the endpoint source of truth, link via ninja_device_id. ${KEEPER_HINT}`,
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client code or UUID." },
        site_label: { type: "string", description: "Which site (exact label)." },
        kind: { type: "string" },
        name: { type: "string", description: "Hostname or label." },
        make_model: { type: "string" },
        mgmt_url: { type: "string" },
        credential_ref: { type: "string", description: "keeper://<record_uid>#label pointer only." },
        ninja_device_id: { type: "string" },
        notes: { type: "string" },
      },
      required: ["client", "site_label", "kind", "name"],
    },
  },
  {
    name: "kb_add_client_reference",
    description:
      `INTERNAL ONLY: add a reference row to a client profile: portal URL, M365 tenant ID, account number, anything a tech looks up. ${KEEPER_HINT}`,
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client code or UUID." },
        label: { type: "string", description: "e.g. 'M365 tenant ID'." },
        value: { type: "string", description: "The identifier or URL." },
        credential_ref: { type: "string", description: "keeper://<record_uid>#label pointer only." },
        notes: { type: "string" },
      },
      required: ["client", "label"],
    },
  },
  {
    name: "kb_add_client_contact",
    description:
      "INTERNAL ONLY: add a vendor/ISP contact to a client profile (role: isp, landlord, phone_vendor, app_vendor, other). Client staff contacts live in the Desk; do not duplicate them here.",
    input_schema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client code or UUID." },
        role: { type: "string" },
        org: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        account_ref: { type: "string" },
        notes: { type: "string" },
      },
      required: ["client", "role"],
    },
  },
  {
    name: "kb_assign_unclaimed_ip",
    description:
      "INTERNAL ONLY: attribute an unclaimed IP from the queue to a client site, flipping it to a confirmed network record. Only do this when the attribution is explicitly confirmed by Brian or a tech; NEVER assign from inference. Pass the unclaimed row id (from kb_list_unclaimed_ips) plus client and site label.",
    input_schema: {
      type: "object",
      properties: {
        unclaimed_id: { type: "string" },
        client: { type: "string", description: "Client code or UUID." },
        site_label: { type: "string", description: "Which site (exact label)." },
        kind: { type: "string", description: "Defaults to wan_dynamic_observed." },
        is_egress: { type: "boolean", description: "Defaults true." },
      },
      required: ["unclaimed_id", "client", "site_label"],
    },
  },
  {
    name: "kb_mark_staff_ip",
    description:
      "INTERNAL ONLY: designate an unclaimed IP as a BRIT tech's own egress (home broadband etc). The IP then resolves in lookups as 'BRIT staff egress: <user>' which is exactly what impossible-travel triage needs. Only mark when the tech association is confirmed.",
    input_schema: {
      type: "object",
      properties: {
        unclaimed_id: { type: "string" },
        staff_user: { type: "string", description: "Tech username, e.g. ryan.sarkar." },
      },
      required: ["unclaimed_id", "staff_user"],
    },
  },
];

/**
 * Finds a site by exact label on a client profile, throwing with the
 * available labels on a miss so the bot can self-correct.
 * @param {object} profile - Full nested profile
 * @param {string} label
 * @returns {object}
 */
function siteByLabel(profile, label) {
  const want = String(label || "").trim();
  const site = (profile.sites || []).find((s) => s.label === want);
  if (!site) {
    const labels = (profile.sites || []).map((s) => s.label).join(", ") || "none";
    throw new Error(`Site '${want}' not found for ${profile.company}. Existing sites: ${labels}`);
  }
  return site;
}

export const kbProfileWriteHandlers = {
  kb_upsert_client_profile: guarded(async (input, env) => {
    return kbFetch(env, "POST", "/api/client-profiles", input);
  }),
  kb_add_client_site: guarded(async (input, env) => {
    const profile = await getProfileOrThrow(env, input?.client);
    return kbFetch(env, "POST", `/api/client-profiles/${profile.id}/sites`, {
      label: input.label, address: input.address, timezone: input.timezone, notes: input.notes,
    });
  }),
  kb_add_client_network: guarded(async (input, env) => {
    const profile = await getProfileOrThrow(env, input?.client);
    const site = siteByLabel(profile, input?.site_label);
    return kbFetch(env, "POST", `/api/client-profiles/${profile.id}/networks`, {
      site_id: site.id, kind: input.kind, value: input.value, isp: input.isp,
      circuit_ref: input.circuit_ref, confidence: input.confidence,
      is_egress: input.is_egress, notes: input.notes,
    });
  }),
  kb_update_client_network: guarded(async (input, env) => {
    const { network_id: networkId, ...fields } = input || {};
    if (!networkId) return { error: "network_id is required" };
    return kbFetch(env, "PUT", `/api/networks/${encodeURIComponent(networkId)}`, fields);
  }),
  kb_add_client_infrastructure: guarded(async (input, env) => {
    const profile = await getProfileOrThrow(env, input?.client);
    const site = siteByLabel(profile, input?.site_label);
    return kbFetch(env, "POST", `/api/sites/${site.id}/infrastructure`, {
      kind: input.kind, name: input.name, make_model: input.make_model, mgmt_url: input.mgmt_url,
      credential_ref: input.credential_ref, ninja_device_id: input.ninja_device_id, notes: input.notes,
    });
  }),
  kb_add_client_reference: guarded(async (input, env) => {
    const profile = await getProfileOrThrow(env, input?.client);
    return kbFetch(env, "POST", `/api/client-profiles/${profile.id}/references`, {
      label: input.label, value: input.value, credential_ref: input.credential_ref, notes: input.notes,
    });
  }),
  kb_add_client_contact: guarded(async (input, env) => {
    const profile = await getProfileOrThrow(env, input?.client);
    return kbFetch(env, "POST", `/api/client-profiles/${profile.id}/contacts`, {
      role: input.role, org: input.org, name: input.name, email: input.email,
      phone: input.phone, account_ref: input.account_ref, notes: input.notes,
    });
  }),
  kb_assign_unclaimed_ip: guarded(async (input, env) => {
    const profile = await getProfileOrThrow(env, input?.client);
    const site = siteByLabel(profile, input?.site_label);
    if (!input?.unclaimed_id) return { error: "unclaimed_id is required" };
    return kbFetch(env, "POST", `/api/unclaimed-ips/${encodeURIComponent(input.unclaimed_id)}/assign`, {
      site_id: site.id, kind: input.kind, is_egress: input.is_egress,
    });
  }),
  kb_mark_staff_ip: guarded(async (input, env) => {
    if (!input?.unclaimed_id) return { error: "unclaimed_id is required" };
    return kbFetch(env, "POST", `/api/unclaimed-ips/${encodeURIComponent(input.unclaimed_id)}/mark-staff`, {
      staff_user: input.staff_user,
    });
  }),
};
