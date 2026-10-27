// =============================================================================
// testing/bindingsAssert.js, assert a bot worker booted with its base
// bindings inside the pool. Throws on failure (the caller's vitest `it(...)`
// turns the throw into a failed test) so this file imports no test framework.
// =============================================================================

/**
 * Assert the standard fleet bindings are present on the pool `env`.
 *
 * @param {object} env - the cloudflare:test `env`
 * @param {object} opts
 * @param {string} opts.kvBinding - KV binding name (e.g. "CACHE" or "MOXIE_KV")
 * @param {string} opts.keyEnvVar - the bot's Nexus key env var (e.g. "COURTNEY_NEXUS_KEY")
 * @param {string} [opts.secretEnvVar] - the bot's callback secret env var, if it has one
 * @param {string} [opts.doBinding="LLM_ROOM"] - Durable Object binding name
 */
export function assertBaseBindings(env, { kvBinding, keyEnvVar, secretEnvVar, doBinding = "LLM_ROOM" } = {}) {
  const missing = [];
  if (!env.DB) missing.push("DB");
  if (kvBinding && !env[kvBinding]) missing.push(kvBinding);
  if (doBinding && !env[doBinding]) missing.push(doBinding);
  if (keyEnvVar && !env[keyEnvVar]) missing.push(keyEnvVar);
  if (secretEnvVar && !env[secretEnvVar]) missing.push(secretEnvVar);
  if (missing.length) {
    throw new Error(`Missing expected bindings in test env: ${missing.join(", ")}`);
  }
}
