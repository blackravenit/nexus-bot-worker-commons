// Fleet rule: no em dashes or en dashes in this package's shipped source.
// The banned characters are written as unicode escapes so this file does not
// flag itself, and so the assertion never carries what it forbids.
//
// WHY THIS EXISTS ALONGSIDE scripts/check-dashes.mjs: that script is the
// stricter prompt-file tripwire (em/en dashes AND double hyphens) and npm test
// points it at src/persona-blocks only, because a dash in a persona is one
// refactor away from being sent to a model. That left the rest of the package
// unguarded, and em dashes had accumulated in library comments and in one
// string that really was sent to the model: the "CURRENT DATE AND TIME
// (authoritative ...)" line in handlers/handleChatMessage.js.
//
// npm test now points that script at src, scripts, contracts, docs and
// testing, so double hyphens are enforced there too and the package is clean
// of both forms. This test stays as the belt to that script's braces: it also
// covers .json, which the script's extension list deliberately leaves out
// because other repos vendor it and may legitimately carry an argument
// separator in a package.json script.
//
// test/ is excluded: the sanitizer's fixtures must contain real dash
// characters to prove scrubFleetDashes strips them. lib/sanitize.js,
// lib/colleagues.js and the two scripts that DETECT dashes use unicode escapes
// for the same reason this file does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SCAN = ["src", "scripts", "contracts", "testing"];
const SKIP = new Set(["node_modules", ".git", ".wrangler", "dist", "build", "test", "tests"]);
const EXTS = new Set([".js", ".mjs", ".md", ".txt", ".json"]);
const BAD = new RegExp("[\\u2012\\u2013\\u2014\\u2015]");

/**
 * Recursively collect scannable files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (EXTS.has(extname(name))) out.push(full);
  }
  return out;
}

test("no em or en dashes in the shipped source", () => {
  const offenders = [];
  for (const dir of SCAN) {
    const base = join(ROOT, dir);
    let exists = true;
    try { statSync(base); } catch { exists = false; }
    if (!exists) continue;
    for (const file of collectFiles(base)) {
      const text = readFileSync(file, "utf8");
      if (!BAD.test(text)) continue;
      const line = text.split(/\r?\n/).findIndex(l => BAD.test(l)) + 1;
      offenders.push(`${file.slice(ROOT.length)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `em or en dash found in: ${offenders.join(", ")}. Use a comma, colon or period. `
    + "If the code must MATCH a dash, write it as a unicode escape.",
  );
});
