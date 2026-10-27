// =============================================================================
// testing/index.js, shared bot test-harness helpers, consumed by each bot's
// thin vitest config + e2e tests via the "nexus-bot-worker-commons/testing"
// subpath export. Dependency-free and runtime-agnostic: it imports neither
// vitest nor the virtual cloudflare:test module, so it resolves cleanly across
// the file: symlink and never touches commons' own node:test suite.
// =============================================================================

export { workersPoolOptions } from "./workersPool.js";
export { postSigned, postUnsigned, TEST_ORIGIN } from "./signedFetch.js";
export { assertBaseBindings } from "./bindingsAssert.js";
