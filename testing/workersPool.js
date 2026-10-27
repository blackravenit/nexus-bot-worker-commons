// =============================================================================
// testing/workersPool.js, builds the @cloudflare/vitest-pool-workers options
// object for a bot's e2e tier. Returns a PLAIN object only; it deliberately does
// NOT import the pool plugin or vitest, because this file lives in the commons
// package and is consumed by bots through a file: symlink, a bare import of
// `@cloudflare/vitest-pool-workers` here would resolve from commons' own
// node_modules (where it isn't installed), not the bot's. The bot's
// vitest.workers.config.js imports `cloudflareTest` from its OWN node_modules
// and wraps the object this returns.
// =============================================================================

/**
 * Build the options object passed to `cloudflareTest(...)` in a bot's
 * vitest.workers.config.js. Inherits D1/KV/DO/SELF + the .md Text rule from the
 * bot's wrangler.toml; `bindings` injects the per-bot test secrets (Nexus key,
 * callback secret, Anthropic key) that aren't in wrangler.toml.
 *
 * `serviceStubs` lists binding names for EXTERNAL service bindings (to other
 * workers, e.g. MEMORY -> memory-worker) that don't exist in the isolated pool.
 * workerd refuses to boot a worker whose declared service binding references an
 * undefined service, so each is replaced with an in-host stub returning `{}`.
 * (A self-binding like SELF -> this worker resolves on its own; don't stub it.)
 * Pass `serviceStubResponse` to customise the stub body.
 *
 * @param {object} params
 * @param {Record<string, string>} params.bindings - test-only env bindings
 * @param {string} [params.wranglerPath="./wrangler.toml"]
 * @param {string[]} [params.serviceStubs=[]] - external service binding names to stub
 * @param {string} [params.serviceStubResponse="{}"] - stub response body
 * @returns {object} options for cloudflareTest(...)
 */
export function workersPoolOptions({ bindings, wranglerPath = "./wrangler.toml", serviceStubs = [], serviceStubResponse = "{}" } = {}) {
  const miniflare = { bindings: bindings || {} };
  if (serviceStubs && serviceStubs.length) {
    miniflare.serviceBindings = {};
    for (const name of serviceStubs) {
      miniflare.serviceBindings[name] = () =>
        new Response(serviceStubResponse, { status: 200, headers: { "content-type": "application/json" } });
    }
  }
  return { wrangler: { configPath: wranglerPath }, miniflare };
}
