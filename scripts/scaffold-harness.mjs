#!/usr/bin/env node
// =============================================================================
// scaffold-harness.mjs, one-command, idempotent setup of the Vitest test
// harness in a bot worker repo. Run FROM a bot repo:
//
//   node ../nexus-bot-worker-commons/scripts/scaffold-harness.mjs [--dry-run]
//
// Flags:
//   --dir=<path>   target repo (default: cwd)
//   --bot=<PREFIX> override the env-var prefix (default: derived from pkg name)
//   --kv=<NAME>    override the KV binding name for the health test
//   --dry-run      print planned actions, write nothing
//
// Automates: install pinned vitest + pool, vitest.config.js, generated
// vitest.workers.config.js, package.json scripts, node:test->vitest migration of
// existing units, test/integration templates (route-gated), and the deploy gate.
// Hand-written afterward: bot-specific modal-submit side-effect tests + new units.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const VITEST_PIN = "4.1.7";
const POOL_PIN = "0.16.10";
// node:test named imports that map 1:1 onto vitest globals (safe to auto-swap).
const SAFE_NODE_TEST_NAMES = new Set(["test", "it", "describe", "suite", "beforeEach", "afterEach"]);

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name) => args.includes(`--${name}`);
const DRY = has("dry-run");
const dir = resolve(flag("dir") || process.cwd());

const log = (...m) => console.log(DRY ? "[dry]" : "[scaffold]", ...m);
const warn = (...m) => console.warn("[scaffold][warn]", ...m);

function read(p) { return readFileSync(join(dir, p), "utf8"); }
function write(p, content) {
  if (DRY) { log(`would write ${p} (${content.length} bytes)`); return; }
  const full = join(dir, p);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, content);
  log(`wrote ${p}`);
}

// ---- detect repo facts ------------------------------------------------------
const pkg = JSON.parse(read("package.json"));
const workerName = pkg.name; // e.g. "courtney-worker"
const prefix = (flag("bot") || workerName.replace(/-worker$/, "")).toUpperCase().replace(/[^A-Z0-9]/g, "_");
const shortName = workerName.replace(/-worker$/, "");

const wrangler = read("wrangler.toml");
// KV binding: prefer an explicit --kv, else CACHE if present, else first kv binding.
let kvBinding = flag("kv");
if (!kvBinding) {
  const kvBlocks = wrangler.split("[[kv_namespaces]]").slice(1);
  const bindings = kvBlocks.map((b) => b.match(/binding\s*=\s*"([^"]+)"/)?.[1]).filter(Boolean);
  kvBinding = bindings.includes("CACHE") ? "CACHE" : (bindings[0] || "CACHE");
}

// External service bindings (to OTHER workers) must be stubbed so workerd boots
// in the isolated pool. A self-binding (service === this worker) resolves on its
// own and is excluded.
const serviceStubs = wrangler.split("[[services]]").slice(1).map((b) => {
  const binding = b.match(/binding\s*=\s*"([^"]+)"/)?.[1];
  const service = b.match(/service\s*=\s*"([^"]+)"/)?.[1];
  return binding && service && service !== workerName ? binding : null;
}).filter(Boolean);

const indexSrc = existsSync(join(dir, "src/index.js")) ? read("src/index.js") : "";
const hasRoute = (p) => indexSrc.includes(`/api/internal/${p}`);
const routes = {
  chatMessage: hasRoute("chat-message"),
  buttonClick: hasRoute("button-click"),
  modalSubmit: hasRoute("modal-submit"),
};

log(`target: ${workerName} | prefix: ${prefix} | kv: ${kvBinding} | routes:`, routes, `| serviceStubs:`, serviceStubs);

// ---- 1. install pinned devDeps ----------------------------------------------
const dev = pkg.devDependencies || {};
const needVitest = dev.vitest !== VITEST_PIN;
const needPool = dev["@cloudflare/vitest-pool-workers"] !== POOL_PIN;
if (needVitest || needPool) {
  const spec = [needVitest && `vitest@${VITEST_PIN}`, needPool && `@cloudflare/vitest-pool-workers@${POOL_PIN}`].filter(Boolean).join(" ");
  if (DRY) log(`would: npm i -D ${spec}`);
  else { log(`npm i -D ${spec}`); execSync(`npm i -D ${spec}`, { cwd: dir, stdio: "inherit" }); }
} else log("devDeps already pinned");

// ---- 2. vitest.config.js (identical for all bots) ---------------------------
write("vitest.config.js", `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.js", "src/**/*.test.js"],
    exclude: ["test/integration/**", "node_modules/**"],
  },
});
`);

// ---- 3. vitest.workers.config.js (per-bot; skip if hand-tuned) ---------------
if (existsSync(join(dir, "vitest.workers.config.js"))) {
  warn("vitest.workers.config.js exists, leaving it (may be hand-tuned)");
} else {
  const stubsLine = serviceStubs.length
    ? `\n      // External service bindings absent in the pool; stubbed so workerd boots.\n      serviceStubs: [${serviceStubs.map((s) => `"${s}"`).join(", ")}],`
    : "";
  write("vitest.workers.config.js", `import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { workersPoolOptions } from "nexus-bot-worker-commons/testing";

// Route-level e2e: boots the real worker in workerd with wrangler.toml bindings;
// injects per-bot test secrets. Run with: npm run test:e2e
export default defineConfig({
  plugins: [
    cloudflareTest(workersPoolOptions({
      bindings: {
        // Both set to the SAME value so one test signature verifies on any route
        // regardless of whether it checks the nexus key or the callback secret
        // (the route -> secret mapping varies per bot).
        ${prefix}_NEXUS_KEY: "test-shared-secret-0123456789",
        ${prefix}_CALLBACK_SECRET: "test-shared-secret-0123456789",
        ANTHROPIC_API_KEY: "test-anthropic-key",
        CLAUDE_MODEL: "claude-haiku-4-5-20251001",
      },${stubsLine}
    })),
  ],
  test: { include: ["test/integration/**/*.test.js"] },
});
`);
}

// ---- 4. package.json scripts -------------------------------------------------
{
  const scripts = pkg.scripts || {};
  scripts.test = "vitest run";
  scripts["test:watch"] = "vitest";
  scripts["test:e2e"] = "vitest run -c vitest.workers.config.js";
  scripts["test:all"] = "vitest run && vitest run -c vitest.workers.config.js";
  pkg.scripts = scripts;
  if (needVitest) (pkg.devDependencies ||= {}).vitest = VITEST_PIN;
  if (needPool) (pkg.devDependencies ||= {})["@cloudflare/vitest-pool-workers"] = POOL_PIN;
  write("package.json", JSON.stringify(pkg, null, 2) + "\n");
}

// ---- 5. migrate existing node:test units -> vitest import --------------------
{
  const testDir = join(dir, "test");
  const files = existsSync(testDir)
    ? readdirSync(testDir).filter((f) => f.endsWith(".test.js")).map((f) => `test/${f}`)
    : [];
  for (const f of files) {
    const src = read(f);
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']node:test["']/);
    if (!m) continue; // already vitest or no node:test import
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const unsafe = names.filter((n) => !SAFE_NODE_TEST_NAMES.has(n));
    if (unsafe.length) {
      warn(`${f}: uses node:test { ${unsafe.join(", ")} } not 1:1 in vitest, MIGRATE BY HAND`);
      continue;
    }
    write(f, src.replace(/from\s*["']node:test["']/, 'from "vitest"'));
  }
}

// ---- 6. test/integration templates (route-gated; skip if dir non-empty) -----
{
  const intDir = join(dir, "test/integration");
  const existing = existsSync(intDir) ? readdirSync(intDir).filter((f) => f.endsWith(".test.js")) : [];
  if (existing.length) {
    warn(`test/integration already has ${existing.length} file(s): leaving them`);
  } else {
    write("test/integration/health.test.js", `import { env, SELF } from "cloudflare:test";
import { it, expect } from "vitest";
import { assertBaseBindings } from "nexus-bot-worker-commons/testing";

it("GET /health returns ok", async () => {
  const res = await SELF.fetch("https://${shortName}.test/health");
  expect(res.status).toBe(200);
});

it("base bindings are present in the test env", () => {
  assertBaseBindings(env, { kvBinding: "${kvBinding}", keyEnvVar: "${prefix}_NEXUS_KEY", secretEnvVar: "${prefix}_CALLBACK_SECRET" });
});
`);

    const blocks = [];
    if (routes.chatMessage) blocks.push(`describe("POST /api/internal/chat-message", () => {
  const chat = { ...fixtures["chat-message"], channel_slug: "${shortName}-test", mentioned_bot_id: "bot_${shortName}", body: "@${shortName} status?" };

  it("accepts a correctly-signed mention (2xx)", async () => {
    const res = await postSigned(SELF, "/api/internal/chat-message", chat, SECRET);
    expect(res.status).toBeLessThan(300);
  });

  it("rejects an unsigned message (401)", async () => {
    const res = await postUnsigned(SELF, "/api/internal/chat-message", chat);
    expect(res.status).toBe(401);
  });

  it("does NOT 400 on a bare @mention", async () => {
    const res = await postSigned(SELF, "/api/internal/chat-message", { ...chat, body: "@${shortName}" }, SECRET);
    expect(res.status).not.toBe(400);
  });
});`);
    if (routes.buttonClick) blocks.push(`describe("POST /api/internal/button-click", () => {
  // The bot-agnostic guarantee is "authenticated (not 401) and no crash (<500)".
  // The shared fixture's button_id is unrecognized by most bots -> some return
  // 200 handled:false, 202 queued, or 400 unknown-prefix. Recognized-prefix
  // success is a per-bot side-effect test.
  it("accepts a correctly-signed click (authenticated)", async () => {
    const res = await postSigned(SELF, "/api/internal/button-click", fixtures["button-click"], SECRET);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });
  it("rejects a tampered body (401)", async () => {
    const res = await postSigned(SELF, "/api/internal/button-click", fixtures["button-click"], SECRET, { tamper: true });
    expect(res.status).toBe(401);
  });
  it("rejects a stale timestamp (401)", async () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const res = await postSigned(SELF, "/api/internal/button-click", fixtures["button-click"], SECRET, { timestamp: stale });
    expect(res.status).toBe(401);
  });
  it("rejects an unsigned click (401)", async () => {
    const res = await postUnsigned(SELF, "/api/internal/button-click", fixtures["button-click"]);
    expect(res.status).toBe(401);
  });
});`);
    if (routes.modalSubmit) blocks.push(`describe("POST /api/internal/modal-submit", () => {
  // HMAC-level guard. A side-effect test (assert \`values\` persists) is
  // hand-written per bot, see maxwell-worker/test/integration/modal-submit.test.js.
  it("accepts a correctly-signed submit (authenticated)", async () => {
    const res = await postSigned(SELF, "/api/internal/modal-submit", fixtures["modal-submit"], SECRET);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });
  it("rejects an unsigned submit (401)", async () => {
    const res = await postUnsigned(SELF, "/api/internal/modal-submit", fixtures["modal-submit"]);
    expect(res.status).toBe(401);
  });
});`);

    write("test/integration/callbacks.test.js", `import { SELF } from "cloudflare:test";
import { it, expect, describe } from "vitest";
import { postSigned, postUnsigned } from "nexus-bot-worker-commons/testing";
import { fixtures } from "nexus-bot-worker-commons/contracts";

// Route-level e2e for ${workerName}. One shared test secret: the pool binds both
// the nexus key and the callback secret to this value, so one signature verifies
// on any route regardless of which secret that route checks.
const SECRET = "test-shared-secret-0123456789";

${blocks.join("\n\n")}
`);
  }
}

// ---- 7. deploy gate ----------------------------------------------------------
{
  const p = "scripts/deploy.mjs";
  if (!existsSync(join(dir, p))) {
    warn("no scripts/deploy.mjs, skipping deploy gate (add manually)");
  } else {
    const src = read(p);
    if (src.includes("test:all")) {
      log("deploy gate already present");
    } else {
      const anchor = src.match(/\n(let cfToken;)/);
      if (!anchor) {
        warn("could not find the `let cfToken;` anchor in deploy.mjs, INSERT THE GATE BY HAND (copy maxwell-worker/scripts/deploy.mjs). Aborting gate step.");
      } else {
        // Uses execSync (imported in every bot's deploy.mjs) so the gate works
        // regardless of whether the script also imports spawnSync.
        const gate = `
// Pre-deploy gate: run the test harness and refuse to ship on red. Emergency
// override: \`npm run deploy -- --skip-tests\` (logged). dash-ok
if (!process.argv.includes('--skip-tests')) {
  try {
    console.log('[deploy] pre-deploy gate: npm run test:all ...');
    execSync('npm run test:all', { stdio: 'inherit' });
    console.log('[deploy] gate passed.');
  } catch {
    console.error('[deploy] ABORTED: tests failed. Fix the harness, or override with \`npm run deploy -- --skip-tests\` (logged).'); // dash-ok
    process.exit(1);
  }
} else {
  console.warn('[deploy] WARNING: --skip-tests set, deploying WITHOUT the test gate.');
}

`;
        write(p, src.replace(/\nlet cfToken;/, `${gate}let cfToken;`));
      }
    }
  }
}

log("done.", DRY ? "(dry-run, nothing written)" : "Next: hand-write any modal-submit side-effect test, then `npm run test:all`.");
