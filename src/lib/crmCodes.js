// =============================================================================
// lib/crmCodes.js, Shared READ-ONLY CRM client-code tools for the fleet.
//
// Every bot needs to resolve the short, all-caps client codes Brian and staff
// use as everyday shorthand ("pull SEP's tickets", "draft a note to RHC"). The
// code is the client's `nexus_channel_slug` in the CRM (e.g. slug "sep" ->
// "Southeastern Pneumatic"). See persona-blocks/FLEET_CLIENT_CODES.md for the
// convention the persona is told to follow; this module is the tool that backs
// it so a bot can actually answer instead of guessing.
//
// READ-ONLY by design: no create / update / convert / send. Bots that own
// write paths (Jacob, Maxwell) keep their own richer CRM tools; this module is
// the universal read surface for everyone else.
//
// Auth: X-API-Key header (SALES_API_KEY). Base URL via SALES_API_URL env var
// or the default https://sales.blackravenit.com. Handler signature is
// (input, env, ctx) per SPEC.md. Unconfigured env returns an opaque refusal.
// =============================================================================

const DEFAULT_BASE = "https://sales.blackravenit.com";

/**
 * True when the CRM API key is present in env.
 * @param {object} env
 * @returns {boolean}
 */
function isConfigured(env) {
  return Boolean(env && env.SALES_API_KEY);
}

/**
 * Opaque refusal for an unconfigured CRM env. Per the fleet's opaque-refusal
 * rule we do not name which env var is missing.
 * @returns {{error: string}}
 */
function notConfigured() {
  return { error: "CRM lookup is unavailable in this environment." };
}

/**
 * GET a CRM API path. Read-only helper: never sends a body.
 * @param {object} env
 * @param {string} path - path starting with /api/...
 * @returns {Promise<any>}
 */
async function crmGet(env, path) {
  const baseUrl = (env.SALES_API_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { "X-API-Key": env.SALES_API_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const t = await res.text();
      if (t) detail = " " + t.slice(0, 300);
    } catch { /* body read is best-effort; the status error is thrown regardless */ }
    const err = new Error(`CRM GET ${path} ${res.status} ${res.statusText}${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * The leading token of a slug ("sep-construction" -> "sep"), so a code query
 * still resolves when a channel slug embeds the code with a suffix.
 * @param {string} slug
 * @returns {string}
 */
function slugHead(slug) {
  return String(slug || "").toLowerCase().trim().split(/[-_]/)[0];
}

/**
 * Shape a CRM client row down to the fields a bot needs to scope a reply:
 * the company name, the client code, the record id, and any Ninja org hint.
 * @param {object} c
 * @returns {object}
 */
function shapeClient(c) {
  return {
    id: c.id,
    company: c.company,
    code: c.nexus_channel_slug || null,
    ninja_organization_id: c.ninja_organization_id ?? c.ninjaOrganizationId ?? null,
    mrr: c.mrr ?? null,
  };
}

// ---- Tool definitions -------------------------------------------------------

export const crmReadTools = [
  {
    name: "crm_resolve_client_code",
    description:
      "Resolve a short client code (the 3-4 letter all-caps shorthand like SEP, RHC, ITS, FAI) to the actual client. These codes are the CRM client's nexus_channel_slug. Call this FIRST whenever someone uses such a code so you name the real client back ('SEP is Southeastern Pneumatic') instead of guessing at a product acronym or asking what it means. Returns the matched client (company, code, record id, Ninja org id when present) plus near-miss candidates if there is no exact code.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The client code or shorthand, case-insensitive (e.g. 'SEP')." },
      },
      required: ["code"],
    },
  },
  {
    name: "crm_list_clients",
    description:
      "List all active CRM clients with their client code (nexus_channel_slug), company name, and record id. Use this to browse who the codes map to, or when crm_resolve_client_code returns no exact match and you want to scan the full roster. READ-ONLY.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "crm_search",
    description:
      "Search the CRM (READ-ONLY) by company name, contact name, contact email, or client code. Returns matching clients, prospects, opportunities, and partners. When the query exactly matches a client code the result includes a `code_match` naming that client. Use crm_resolve_client_code instead when you only need to turn a code into a client name.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Company name, contact name, partial email, or client code (case-insensitive)." },
      },
      required: ["query"],
    },
  },
];

// ---- Handlers ---------------------------------------------------------------

/**
 * Load the client roster, tolerating either {clients:[...]} or a bare array.
 * @param {object} env
 * @returns {Promise<object[]>}
 */
async function loadClients(env) {
  const data = await crmGet(env, "/api/clients?limit=200");
  return data.clients || (Array.isArray(data) ? data : []);
}

/**
 * crm_resolve_client_code: exact slug match first, then leading-token match
 * (covers embedded codes like "sep-construction"), then near-miss candidates.
 * @param {object} input
 * @param {object} env
 * @returns {Promise<any>}
 */
async function handleResolveClientCode(input, env) {
  if (!isConfigured(env)) return notConfigured();
  const code = String(input?.code || "").toLowerCase().trim();
  if (!code) return { error: "code is required" };
  try {
    const clients = await loadClients(env);
    const exact = clients.find((c) => String(c.nexus_channel_slug || "").toLowerCase().trim() === code);
    if (exact) return { resolved: true, match: shapeClient(exact) };

    const headMatch = clients.find((c) => slugHead(c.nexus_channel_slug) === code);
    if (headMatch) return { resolved: true, match: shapeClient(headMatch) };

    // No code hit: offer companies whose name or slug contains the token so the
    // bot can confirm rather than dead-end.
    const candidates = clients
      .filter((c) => {
        const blob = `${c.company || ""} ${c.nexus_channel_slug || ""}`.toLowerCase();
        return blob.includes(code);
      })
      .slice(0, 8)
      .map(shapeClient);
    return { resolved: false, code: input.code, candidates };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * crm_list_clients: full client roster (read-only), shaped to code + company.
 * @param {object} _input
 * @param {object} env
 * @returns {Promise<any>}
 */
async function handleListClients(_input, env) {
  if (!isConfigured(env)) return notConfigured();
  try {
    const clients = await loadClients(env);
    return clients.map(shapeClient);
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * crm_search: token-OR match across company / contact / email / slug for
 * clients, prospects, opportunities, partners. Surfaces an exact code_match.
 * @param {object} input
 * @param {object} env
 * @returns {Promise<any>}
 */
async function handleCrmSearch(input, env) {
  if (!isConfigured(env)) return notConfigured();
  const raw = String(input?.query || "").toLowerCase().trim();
  if (!raw) return { error: "query is required" };
  const tokens = raw.split(/\s+/).filter((t) => t.length >= 2);

  const hit = (r) => {
    const blob = [r.company, r.contact_name, r.contact_email, r.nexus_channel_slug]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .join(" | ");
    if (!blob) return false;
    if (tokens.length === 0) return blob.includes(raw);
    return tokens.some((t) => blob.includes(t));
  };

  try {
    const [clientsData, prospectsData, oppsData, partnersData] = await Promise.all([
      crmGet(env, "/api/clients?limit=200").catch(() => ({ clients: [] })),
      crmGet(env, "/api/prospects?limit=200").catch(() => ({ prospects: [] })),
      crmGet(env, "/api/opportunities?limit=200").catch(() => ({ opportunities: [] })),
      crmGet(env, "/api/partners?limit=200").catch(() => ({ partners: [] })),
    ]);
    const clientRows = clientsData.clients || [];
    const codeHit = !raw.includes(" ")
      ? clientRows.find((c) => String(c.nexus_channel_slug || "").toLowerCase().trim() === raw)
      : null;
    const result = {
      query: input.query,
      clients: clientRows.filter(hit),
      prospects: (prospectsData.prospects || []).filter(hit),
      opportunities: (oppsData.opportunities || []).filter(hit),
      partners: (partnersData.partners || []).filter(hit),
    };
    if (codeHit) {
      result.code_match = { id: codeHit.id, company: codeHit.company, code: codeHit.nexus_channel_slug };
    }
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

// ---- Handler map ------------------------------------------------------------

export const crmReadHandlers = {
  crm_resolve_client_code: (input, env, ctx) => handleResolveClientCode(input, env, ctx),
  crm_list_clients: (input, env, ctx) => handleListClients(input, env, ctx),
  crm_search: (input, env, ctx) => handleCrmSearch(input, env, ctx),
};
