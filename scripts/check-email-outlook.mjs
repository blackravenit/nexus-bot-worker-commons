#!/usr/bin/env node
// check-email-outlook.mjs -- fail the build when an email template uses CSS that
// classic Outlook silently drops.
//
// Outlook on Windows renders mail through Word, not a browser engine. Word
// ignores background-color and font-family on a <div> and ignores background
// on an inline <a>. Templates written that way arrive as black bars on a grey
// page in Times New Roman, with invisible buttons. That shipped to clients twice
// before this check existed.
//
// Usage:
//   node scripts/check-email-outlook.mjs <path> [<path> ...]
//
// Only pass paths that build EMAIL html. Web page markup in the same repo is
// allowed to use divs however it likes, so scoping is the caller's job.
//
// Exit code 1 on any finding, with file:line and the reason.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SOURCE_EXT = new Set([".js", ".mjs", ".ts", ".jsx", ".tsx"]);

/** Rules applied line by line. Each returns a reason string, or null. */
const RULES = [
  {
    name: "div-background",
    test: /<div\b[^>]*\bbackground(-color)?\s*:/i,
    reason: "background on a <div>. Word drops it and paints only behind the text. Use emailRow from lib/emailChrome, which fills a <td bgcolor>.",
  },
  {
    name: "anchor-background",
    test: /<a\b[^>]*\bbackground(-color)?\s*:/i,
    reason: "background on an inline <a>. Word drops it and the button degrades to a bare link. Use emailButton from lib/emailChrome, which ships a VML fallback.",
  },
  {
    name: "div-font-family",
    test: /<div\b[^>]*\bfont-family\s*:/i,
    reason: "font-family on a <div>. Word drops it and the message falls back to Times New Roman. Put the font on the element that holds the text, via emailText.",
  },
];

/**
 * Recursively collect source files under a path.
 * @param {string} target
 * @returns {string[]}
 */
function collect(target) {
  let info;
  try {
    info = statSync(target);
  } catch {
    console.error(`check-email-outlook: cannot read ${target}`);
    process.exit(1);
  }
  if (info.isFile()) return SOURCE_EXT.has(extname(target)) ? [target] : [];

  const found = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const next = join(target, entry.name);
    if (entry.isDirectory()) found.push(...collect(next));
    else if (SOURCE_EXT.has(extname(entry.name))) found.push(next);
  }
  return found;
}

/**
 * Scan one file and report every rule violation.
 * @param {string} file
 * @returns {{file: string, line: number, reason: string}[]}
 */
function scan(file) {
  const findings = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/check-email-outlook-allow/.test(line)) return;
    for (const rule of RULES) {
      if (rule.test.test(line)) {
        findings.push({ file, line: index + 1, reason: rule.reason });
        break;
      }
    }
  });
  return findings;
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("check-email-outlook: no paths given");
  process.exit(1);
}

const files = targets.flatMap(collect);
const findings = files.flatMap(scan);

if (findings.length) {
  console.error(`check-email-outlook: ${findings.length} issue(s) that classic Outlook will drop\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.reason}\n`);
  }
  console.error("Add a check-email-outlook-allow comment on the line only when the markup is genuinely not email.");
  process.exit(1);
}

console.log(`check-email-outlook: clean (${files.length} files scanned)`);
