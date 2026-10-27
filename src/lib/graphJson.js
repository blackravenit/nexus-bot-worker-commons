// =============================================================================
// lib/graphJson.js, lenient parser for Microsoft Graph success responses.
//
// Why this exists (the 2026-08-06 Maxwell incident, and Robert's 2026-07-23
// one before it): Graph write endpoints do NOT all return JSON on success.
// `POST /messages/{id}/send` and `POST /users/{mbx}/sendMail` return 202 with
// an EMPTY body. A bare `res.json()` on that throws "Unexpected end of JSON
// input" AFTER the mail has already left the tenant. Callers that treat the
// throw as a send failure then re-stage the HITL card, and the next Approve
// click sends a DUPLICATE to the client.
//
// So: success bodies are parsed leniently and this never throws. Non-2xx is
// still the caller's job to detect and throw on, BEFORE calling this.
// =============================================================================

/**
 * Parse a Microsoft Graph success response body without ever throwing.
 *
 * Callers must check `res.ok` and throw themselves first. This only handles
 * the success case, where the body may legitimately be absent or non-JSON.
 *
 * @param {Response} res - A Graph response already known to be successful.
 * @param {object} [ctx] - Optional context for the warn log, e.g. { method, path }.
 * @returns {Promise<object|null>} Parsed JSON, `{ _raw }` for a non-JSON body,
 *   or `null` when the body is empty (202/204 and friends).
 */
export async function parseGraphResponse(res, ctx = {}) {
  // 202 Accepted (send, sendMail, move) and 204 No Content are bodyless by
  // contract. Short-circuit before touching the stream.
  if (res.status === 202 || res.status === 204) return null;

  const text = await res.text().catch(() => "");
  if (!text.trim()) return null;

  try {
    return JSON.parse(text);
  } catch {
    // An edge, proxy, or auth interstitial returned HTML on a 2xx. Do not
    // throw: the write may well have landed. Hand back the raw text so a
    // caller that needs a field (e.g. `draft?.id`) still fails naturally with
    // a message that points at the real problem.
    const where = ctx.method || ctx.path ? ` (${ctx.method || ""} ${ctx.path || ""})`.trimEnd() : "";
    console.warn(`[graphJson] non-JSON ${res.status} body${where}: ${text.slice(0, 200)}`);
    return { _raw: text.slice(0, 500) };
  }
}
