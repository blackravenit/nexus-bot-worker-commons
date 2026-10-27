// =============================================================================
// handlers/handleHitlSettled.js, read-only GET /api/internal/hitl-settled.
//
// Exposes a bot's OWN resolved HITL rows (hitl_pending.resolved_at IS NOT NULL)
// so the fleet self-healer (nexus-app) can cross-check them against Nexus D1 and
// re-settle any card whose interactive controls re-grew off a read-replica lag
// (the HITL straggler-reseed bug). Read-only, zero mutation.
//
// Auth: Bearer <BOT_NEXUS_KEY> or x-nexus-key header (constant-time compare).
// The bot wires this route with its own key env var, e.g.:
//   if (method === "GET" && path === "/api/internal/hitl-settled")
//     return handleHitlSettled(request, env, { keyEnvVar: "ROBERT_NEXUS_KEY" });
// =============================================================================

import { timingSafeEqual } from "../lib/callbackSign.js";

const DEFAULT_WINDOW_SEC = 24 * 60 * 60; // 24h
const MAX_ROWS = 200;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.keyEnvVar - env var holding the bot's NEXUS_KEY
 * @param {string} [opts.dbBinding="DB"] - env var name of the D1 binding
 * @returns {Promise<Response>}
 */
export async function handleHitlSettled(request, env, { keyEnvVar, dbBinding = "DB" } = {}) {
  const expected = env[keyEnvVar];
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const provided = bearer || request.headers.get("x-nexus-key") || "";
  // timingSafeEqual compares Uint8Arrays; raw strings XOR their chars to NaN
  // (which |= to 0), so unencoded input would accept wrong same-length keys.
  const enc = new TextEncoder();
  if (!expected || !provided || !timingSafeEqual(enc.encode(provided), enc.encode(expected))) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const db = env[dbBinding];
  if (!db) return jsonResponse({ success: true, settled: [] });

  const url = new URL(request.url);
  // resolved_at is stored in UNIX SECONDS (see commons hitl.js), so `since` is
  // seconds too. Default: the last 24h.
  const sinceSec = Number(url.searchParams.get("since")) || Math.floor(Date.now() / 1000) - DEFAULT_WINDOW_SEC;

  let rows = [];
  try {
    const res = await db
      .prepare(
        "SELECT message_id, channel_slug, resolved_at, resolution FROM hitl_pending WHERE resolved_at IS NOT NULL AND resolved_at > ? ORDER BY resolved_at DESC LIMIT ?"
      )
      .bind(sinceSec, MAX_ROWS)
      .all();
    rows = res?.results || [];
  } catch (err) {
    // A skeleton bot may not have a hitl_pending table; that is not an error,
    // it just has no settled HITL cards to report.
    console.warn("[handleHitlSettled] query failed (treating as empty):", err?.message);
    return jsonResponse({ success: true, settled: [] });
  }

  return jsonResponse({ success: true, settled: rows });
}
