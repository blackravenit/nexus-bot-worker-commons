// =============================================================================
// lib/provenanceContext.js, AsyncLocalStorage-backed provenance tagging.
//
// Bot workers wrap their handler entry points with:
//
//   import { withProvenance } from "nexus-bot-worker-commons";
//
//   export default {
//     async scheduled(controller, env, ctx) {
//       return withProvenance("scheduled-cron", () => runCronWork(env));
//     },
//   };
//
// Any postToNexus() call inside the wrapped scope automatically picks up
// the provenance via getProvenanceContext(). Explicit options.provenance
// passed at the call site overrides the context.
//
// Requires `compatibility_flags = ["nodejs_compat"]` in the consuming
// worker's wrangler.toml.
// =============================================================================

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/**
 * Run `fn` inside a provenance context. Nested calls override the parent
 * context for the duration of the inner scope.
 *
 * @param {string} slug - one of the ALLOWED_PROVENANCE values
 * @param {Function} fn - async function to execute
 * @returns {Promise<*>} whatever fn returns
 */
export function withProvenance(slug, fn) {
  return storage.run(slug, fn);
}

/**
 * Read the current provenance slug, or null if no context is active.
 * Used by postToNexus to default the message tag when the caller did
 * not pass an explicit options.provenance.
 *
 * @returns {string|null}
 */
export function getProvenanceContext() {
  return storage.getStore() ?? null;
}
