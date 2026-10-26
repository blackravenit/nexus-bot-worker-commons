/**
 * @file aiEgress.js
 * Pins outbound calls to Eastern North America, for any caller whose egress
 * LOCATION matters. Named for its first use (AI), since the binding name
 * `AI_EGRESS` is now live in several repos and renaming it would be churn.
 *
 * Second use, 2026-10-25: outbound MAIL. Microsoft restricted
 * ava.raven@getblackraven.com for "sending from multiple countries" (Desk
 * 11372) because every cold send left from whatever colo the cron tick landed
 * in. Mail has a STRICTER requirement than AI: Anthropic only needs "not Hong
 * Kong", while Microsoft is measuring whether the country VARIES. So mail
 * passes `jurisdiction: "us"`, which is a hard constraint, where AI relies on
 * `locationHint`, which Cloudflare documents as best effort and honours only at
 * object creation.
 *
 * A Worker invoked by a Cron Trigger has no client to be near, so Cloudflare
 * runs the tick wherever it has capacity. Measured 2026-10-22 across 600 fleet
 * AI Gateway calls: only 25% executed in the US or Canada, and 27% executed in
 * HKG. Anthropic refuses egress from Hong Kong, rejecting at its edge with
 * `403 {"type":"forbidden","message":"Request not allowed"}` in about 6ms with
 * zero tokens billed. That cost us 24 Stellar Cyber cases triaged blind in one
 * day and, on 2026-10-21, three real threats that no human ever saw.
 *
 * Smart Placement cannot fix it: Cloudflare's docs are explicit that it "only
 * affects the execution of fetch event handlers" and that "Workers without a
 * fetch event handler are ignored", and every failing call here is a cron tick.
 *
 * A Durable Object can. A fetch issued from inside an object egresses from
 * where the OBJECT lives, not from where the caller ran, and `locationHint`
 * places a new object in a chosen region. So the request takes one hop into an
 * object pinned to `enam` and leaves from there.
 *
 * Two properties worth preserving if this is ever rewritten:
 *
 * 1. Without an `AI_EGRESS` binding this is a plain `fetch`, byte for byte what
 *    the caller did before. That is what makes a gradual rollout safe: a repo
 *    that has not adopted the binding yet behaves exactly as it does today.
 * 2. If the object cannot be reached, it falls back to a direct fetch rather
 *    than failing the call. A direct fetch might land in HKG and 403, which is
 *    today's behaviour, so the pin can never make a bot worse than not having
 *    it.
 */

/** Region hint for the egress object. Nearby placement is still North America. */
const EGRESS_HINT = "enam";

/** Default number of objects per bot, so a burst does not queue behind one. */
const DEFAULT_SHARDS = 4;

/** Upper bound on a single proxied call, matching the Anthropic client timeout. */
const PROXY_TIMEOUT_MS = 120000;

/**
 * Base class for the per-bot egress object. A bot subclasses it, exports the
 * subclass, and binds it as `AI_EGRESS`.
 *
 * It holds no state. It exists purely to be somewhere, which is the entire
 * point: `locationHint` decides where, and the fetch inherits that location.
 */
export class AiEgressBase {
  /**
   * @param {DurableObjectState} state
   * @param {object} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Forward the request to its original target from this object's location.
   *
   * The stub is called with the REAL target URL, so `request.url` is already
   * where this needs to go and no out-of-band addressing is needed. The
   * request is rebuilt rather than re-sent so the body is read once here
   * instead of being a consumed stream.
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    const target = request.url;
    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.arrayBuffer();
    }
    try {
      return await fetch(target, {
        method: request.method,
        headers: request.headers,
        body,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch (err) {
      // Surface the failure as a status the caller's retry logic understands
      // rather than throwing across the stub boundary, where the error message
      // would be flattened to "internal error".
      console.error(`[aiEgress] proxy to ${new URL(target).host} failed: ${err.message}`);
      return new Response(
        JSON.stringify({ error: { type: "egress_failed", message: err.message } }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  }
}

/**
 * Pick the object name for this call. Stable per bot so the `locationHint`,
 * which is only honoured when an object is first created, keeps applying.
 *
 * @param {object} env
 * @returns {string}
 */
function shardName(env, pool) {
  const bot = env.AI_GATEWAY_BOT || env.WORKER_NAME || "fleet";
  const count = Number(env.AI_EGRESS_SHARDS) > 0 ? Number(env.AI_EGRESS_SHARDS) : DEFAULT_SHARDS;
  // No pool keeps the original name, so existing AI objects keep their identity
  // and their placement. A pool gives mail its own objects rather than queueing
  // a send behind a 2-minute model call on the same object.
  const prefix = pool ? `${bot}-${pool}` : bot;
  return `${prefix}-${EGRESS_HINT}-${Math.floor(Math.random() * count)}`;
}

/**
 * Drop-in replacement for `fetch` on a call whose egress location matters.
 *
 * @param {object} env - Worker env, optionally carrying an AI_EGRESS binding
 * @param {string} url - Absolute target URL
 * @param {RequestInit} [init] - Standard fetch init
 * @param {{jurisdiction?: "us"|"eu"|"fedramp", pool?: string}} [opts]
 *   `jurisdiction` constrains the object to that region's datacentres. Unlike
 *   `locationHint` this is a HARD guarantee, so pass it when the country must
 *   not vary. `pool` gives this traffic its own objects.
 * @returns {Promise<Response>}
 */
export async function egressFetch(env, url, init = {}, opts = {}) {
  const ns = env && env.AI_EGRESS;
  if (!ns) return fetch(url, init);

  try {
    // A jurisdictional namespace yields DIFFERENT ids for the same name, so this
    // never collides with the plain objects above. Guarded because a test double
    // or an older runtime may not implement jurisdiction().
    const scoped =
      opts.jurisdiction && typeof ns.jurisdiction === "function"
        ? ns.jurisdiction(opts.jurisdiction)
        : ns;
    const name = shardName(env, opts.pool);
    const stub = scoped.get(scoped.idFromName(name), { locationHint: EGRESS_HINT });
    return await stub.fetch(url, init);
  } catch (err) {
    console.warn(`[aiEgress] object unreachable, falling back to direct fetch: ${err.message}`);
    return fetch(url, init);
  }
}
