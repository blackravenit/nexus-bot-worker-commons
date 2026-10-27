// =============================================================================
// lib/sanitize.js -- fleet-wide content sanitizers.
//
// Single source of truth for output normalization rules that apply across
// every bot surface (Nexus posts, Graph email, voice TTS prompts, social
// captions). These run on the final outbound string regardless of whether
// the upstream prompt told the model not to produce them; LLMs leak.
// =============================================================================

// Segments the scrubber must never rewrite: fenced code blocks (including an
// unterminated trailing fence in streamed/partial text), inline code spans,
// and HTML <pre>/<code> bodies in email HTML. Splitting on ONE capture group
// puts protected segments at the odd indices of String.split's result.
const PROTECTED_SEGMENT_RE =
  /(```[\s\S]*?(?:```|$)|`[^`\n]+`|<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>)/gi;

/**
 * Rewrite the dash tells inside one prose (non-code) segment. See
 * scrubFleetDashes for the full rules. Kept separate so the code-fence
 * splitter can apply it to prose segments only.
 *
 * @param {string} segment
 * @returns {string}
 */
function scrubDashProse(segment) {
  return segment
    .replace(/\s*[\u2014\u2015]\s*/g, ", ")
    .replace(/\s*(?:&mdash;|&#8212;|&#x2014;|&horbar;|&#8213;)\s*/gi, ", ")
    .replace(/ +-{2} +/g, ", ")
    .replace(/(?<=\d)-{2}(?=\d)/g, "-")
    .replace(/(?<=[A-Za-z])-{2}(?=[A-Za-z])/g, ", ")
    .replace(/[\u2013\u2012]/g, "-")
    .replace(/(?:&ndash;|&#8211;|&#x2013;)/gi, "-")
    .replace(/,\s*,/g, ",");
}

/**
 * Replace em-dashes (U+2014), en-dashes (U+2013), AND the ASCII double-hyphen
 * dash substitute with forms a human would naturally type. The fleet rule
 * (2026-07-02, "Operation Dash Genocide") bans all three outright; the model
 * is told not to produce them AND this scrubber rewrites any that leak.
 *
 * Rules, applied to prose only:
 *   - Em-dash (and &mdash; / &#8212; / &#x2014;): collapses with surrounding
 *     whitespace into ", " so "alpha - beta" and "alpha-beta" both become
 *     "alpha, beta" (not "alpha ,  beta").
 *   - En-dash (and &ndash; / &#8211; / &#x2013;): becomes "-" (ranges read
 *     fine either way).
 *   - Spaced double-hyphen pause ("alpha -- beta"): becomes ", ".
 *   - Unspaced double-hyphen between digits ("2024--2025"): becomes a single
 *     hyphen (a range, not a pause).
 *   - Unspaced double-hyphen between letters ("alpha--beta"): becomes ", ".
 *   - Adjacent commas from chained replacements are collapsed.
 *
 * Never rewritten (functional double hyphens):
 *   - CLI flags (--skip-tests): the hyphens follow whitespace, not a letter.
 *   - Fenced code blocks, inline code spans, and HTML <pre>/<code> bodies:
 *     excluded wholesale so SQL comments, git separators, and pasted shell
 *     commands survive verbatim.
 *   - Hyphen runs of 3+ (markdown horizontal rules, ASCII art): no rule
 *     matches exactly-two hyphens inside a longer run.
 *
 * Why: em/en dashes and "--" are a dead giveaway that text came from an LLM.
 * Office workers rarely type them; their presence in an email / voice line /
 * Nexus post makes the bot legible as a bot. Strip them at every seam.
 *
 * Non-strings pass through untouched so this is safe to call on any value.
 *
 * @param {*} text
 * @returns {*}
 */
export function scrubFleetDashes(text) {
  if (typeof text !== "string") return text;
  const parts = text.split(PROTECTED_SEGMENT_RE);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = scrubDashProse(parts[i]);
  }
  return parts.join("");
}

// -----------------------------------------------------------------------------
// Warn-only detectors. These do not rewrite -- they return booleans that
// callers (postToNexus) can use to flag non-conformant outbound text.
// -----------------------------------------------------------------------------

/**
 * The PALETTE emoji codepoints, as a Set, for the freelance-emoji check.
 * Built lazily so format.js's PALETTE update doesn't require a cycle.
 *
 * @type {Set<string>|null}
 */
let _paletteSet = null;
function _loadPaletteSet() {
  if (_paletteSet) return _paletteSet;
  // Inlined snapshot of PALETTE values, kept in sync with format.js. Each
  // emoji is the *value* the LLM is likely to produce; if format.js adds a
  // key, mirror it here.
  _paletteSet = new Set([
    "📅","📧","✅","⏰","📝","💰",
    "📊","🖥","🔍","⚠️","🚨","❌",
    "🛡","🔓","🆕","⏳","🏁","🛑",
    "💬","🎫","🔗",
    // Deprecated keys retained so existing call sites don't trip the detector:
    "🌤","📋","📈","👤",
  ]);
  return _paletteSet;
}

// Detect emoji *anywhere* in a string. Range covers the common pictographic
// blocks; not exhaustive, intentionally loose. Used only as a filter before
// the palette membership check.
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * True if any `### **Title**` line contains an emoji that is NOT in the
 * canonical PALETTE. Other lines (body bullets, etc.) are not inspected --
 * one-emoji-per-section-header is the only enforced rule.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectFreelanceEmoji(text) {
  if (typeof text !== "string" || !text) return false;
  const palette = _loadPaletteSet();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // Match a section header line. Two shapes:
    //   - legacy / HITL `## ` or `### ` headers (emoji sits before the title)
    //   - house-style numbered sections: "<emoji> **1. Title**" (no markdown header)
    if (!/^#{2,3}\s/.test(line) && !/^\S+\s+\*\*\d+\.\s/.test(line)) continue;
    const matches = line.match(EMOJI_RE);
    if (!matches) continue;
    for (const m of matches) {
      if (!palette.has(m)) return true;
    }
  }
  return false;
}

/**
 * True if a line that looks like a bot-authored header is written as
 * bare ALL-CAPS (e.g. "OPEN TICKETS:"). The style guide section 2 forbids
 * this -- use a numbered emoji+bold section line ("<emoji> **1. Title**") instead.
 *
 * Heuristic: a standalone line that is 3+ words, all-uppercase with at most
 * one trailing colon, and not a fenced-block marker.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectBareCapsHeader(text) {
  if (typeof text !== "string" || !text) return false;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("```")) continue;
    if (line.startsWith("#")) continue;     // proper markdown header
    if (line.startsWith(">")) continue;
    if (line.startsWith("-") || line.startsWith("•")) continue;
    // Drop trailing colon for the check.
    const stripped = line.endsWith(":") ? line.slice(0, -1) : line;
    if (stripped.length < 8) continue;       // too short to be a "header"
    if (stripped.length > 80) continue;      // probably a sentence
    // Must contain only A-Z, digits, spaces, and a few punctuation marks.
    if (!/^[A-Z0-9 _'/\-&]+$/.test(stripped)) continue;
    // At least one letter and at least two words.
    if (!/[A-Z]/.test(stripped)) continue;
    if (stripped.split(/\s+/).length < 2) continue;
    return true;
  }
  return false;
}

/**
 * True if the text contains any em-dash (U+2014), en-dash (U+2013), or a
 * prose double-hyphen (spaced pause or letter-to-letter). After
 * scrubFleetDashes has already run, this should always be false. A hit means
 * a code path bypassed the sanitizer. Code fences / inline code / HTML
 * pre+code bodies are ignored, matching the scrubber's protected segments.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function detectEmDashLeak(text) {
  if (typeof text !== "string") return false;
  if (/[\u2013\u2014\u2012\u2015]/.test(text)) return true;
  const parts = text.split(PROTECTED_SEGMENT_RE);
  for (let i = 0; i < parts.length; i += 2) {
    if (/ -{2} /.test(parts[i])) return true;
    if (/(?<=[A-Za-z])-{2}(?=[A-Za-z])/.test(parts[i])) return true;
  }
  return false;
}

/**
 * Bundle the three detectors for one-call telemetry from postToNexus.
 *
 * @param {string} text
 * @returns {{has_em_dash:boolean, has_bare_caps:boolean, has_freelance_emoji:boolean}}
 */
export function inspectOutboundText(text) {
  return {
    has_em_dash: detectEmDashLeak(text),
    has_bare_caps: detectBareCapsHeader(text),
    has_freelance_emoji: detectFreelanceEmoji(text),
  };
}
