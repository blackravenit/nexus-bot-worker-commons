#!/usr/bin/env node
// check-dashes.mjs, the fleet dash tripwire (Operation Dash Genocide, 2026-07-02).
//
// Scans prompt-bearing files (personas, skills, knowledge, persona-blocks) for
// the three banned dash forms and exits non-zero on any hit, so a regression
// fails `npm test` before it ever ships:
//   1. literal em dash (U+2014) or en dash (U+2013), anywhere in the file
//   2. spaced double-hyphen pause (" -- ") outside fenced code blocks
//   3. unspaced letter-to-letter double-hyphen ("alpha--beta") outside fences
//
// Prompt files must be TOTALLY clean (comments included): everything in a
// persona/knowledge file is either sent to the model or sitting one refactor
// away from being sent. Functional double hyphens that must stay (a CLI flag
// in a runbook line outside a fence) get the literal marker "dash-ok" on the
// same line to skip that line.
//
// Usage: node check-dashes.mjs <dir-or-file> [...more]
//   Paths are relative to cwd; missing paths are skipped so every worker can
//   pass the same standard arg list. Default args when none are given:
//   src/personas knowledge src/persona-blocks

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".md", ".txt"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".wrangler", ".wrangler-dry", "test", "tests"]);
const EM_EN_RE = /[\u2013\u2014\u2012\u2015]/;
const SPACED_DH_RE = / -{2} /;
const PROSE_DH_RE = /(?<=[A-Za-z])-{2}(?=[A-Za-z])/;
const SKIP_MARKER = "dash-ok";

/**
 * Recursively collect scannable files under a path.
 * @param {string} target - File or directory path.
 * @param {string[]} found - Accumulator of file paths.
 * @returns {string[]} All matching file paths.
 */
function collectFiles(target, found = []) {
  const stats = statSync(target);
  if (stats.isFile()) {
    if (SCAN_EXTENSIONS.has(extname(target))) found.push(target);
    return found;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    collectFiles(join(target, entry), found);
  }
  return found;
}

/**
 * Find banned-dash violations in one file's content.
 * @param {string} content - File text.
 * @returns {Array<{line: number, kind: string, excerpt: string}>} Violations found.
 */
function findViolations(content) {
  const violations = [];
  let inFence = false;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (line.includes(SKIP_MARKER)) continue;
    if (EM_EN_RE.test(line)) {
      violations.push({ line: i + 1, kind: "em/en dash", excerpt: line.trim().slice(0, 120) });
      continue;
    }
    if (inFence) continue;
    if (SPACED_DH_RE.test(line) || PROSE_DH_RE.test(line)) {
      violations.push({ line: i + 1, kind: "double hyphen", excerpt: line.trim().slice(0, 120) });
    }
  }
  return violations;
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["src/personas", "knowledge", "src/persona-blocks"];

let totalViolations = 0;
let scannedFiles = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  for (const file of collectFiles(target)) {
    scannedFiles++;
    const violations = findViolations(readFileSync(file, "utf8"));
    for (const v of violations) {
      totalViolations++;
      console.error(`${file}:${v.line} [${v.kind}] ${v.excerpt}`);
    }
  }
}

if (totalViolations > 0) {
  console.error(`\ncheck-dashes: ${totalViolations} banned dash(es) in ${scannedFiles} scanned file(s). Use a comma, colon, or period; mark functional lines with "${SKIP_MARKER}".`);
  process.exit(1);
}
console.log(`check-dashes: clean (${scannedFiles} files scanned)`);
