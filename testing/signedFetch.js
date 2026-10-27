// =============================================================================
// testing/signedFetch.js, fire a Nexus-signed callback at a worker route in a
// vitest-pool-workers test. Takes the `fetcher` (the bot's test passes `SELF`
// from "cloudflare:test") as a PARAMETER so this commons file never imports the
// virtual `cloudflare:test` module, which would not resolve from the symlinked
// commons package and would pollute commons' own node:test run.
// =============================================================================

import { signCallback } from "../src/lib/callbackSign.js";

export const TEST_ORIGIN = "https://bot-worker.test";

/**
 * POST a body to a worker route with a valid (or deliberately broken) Nexus
 * signature, via the provided fetcher (pass `SELF`).
 *
 * @param {{ fetch: Function }} fetcher - the worker fetcher (SELF from cloudflare:test)
 * @param {string} path - route path, e.g. "/api/internal/button-click"
 * @param {object} body - payload object (JSON.stringify'd here, signed as-sent)
 * @param {string} secret - HMAC secret the route verifies with
 * @param {object} [opts]
 * @param {boolean} [opts.tamper=false] - mutate the body after signing -> bad sig
 * @param {number} [opts.timestamp] - unix seconds override (stale => replay reject)
 * @param {string} [opts.origin=TEST_ORIGIN]
 * @returns {Promise<Response>}
 */
export async function postSigned(fetcher, path, body, secret, { tamper = false, timestamp, origin = TEST_ORIGIN } = {}) {
  const raw = JSON.stringify(body);
  const { timestamp: ts, signature } = await signCallback(secret, raw, timestamp ? { timestamp } : {});
  return fetcher.fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Nexus-Timestamp": ts,
      "X-Nexus-Signature": signature,
    },
    body: tamper ? `${raw} ` : raw,
  });
}

/**
 * POST a body with NO signature headers (expect 401 on a verified route).
 * @param {{ fetch: Function }} fetcher
 * @param {string} path
 * @param {object} body
 * @param {string} [origin=TEST_ORIGIN]
 * @returns {Promise<Response>}
 */
export async function postUnsigned(fetcher, path, body, origin = TEST_ORIGIN) {
  return fetcher.fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
