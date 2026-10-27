// =============================================================================
// lib/embedCard.js: bangReport / bangAlert helpers for Nexus bot output.
//
// 2026-05-17 fleet-wide format reset:
//
//   - Discord-style embed cards retired. Every bot post is a bangReport-style
//     code-block-wrapped plain-text report. The Nexus UI renders these as
//     monospace dark blocks with marked.js + highlight.js auto-detect.
//   - Per-bot canonical colors deleted. Left-border accent is now sourced from
//     msg.provenance via PROVENANCE_COLORS on the message-row wrapper.
//
// Usage:
//   bangReport({ botName: "Dexter", verb: "status", args: "fleet", sections })
//     -> ```\nDexter !status, fleet\nGenerated: ...\n=====\n<sec>\n```
//
//   bangAlert({ botName: "Courtney", verb: "ticket-alert", sections })
//     -> ```\nCourtney ticket-alert\nGenerated: ...\n=====\n<sec>\n```
//
// The leading-! is a bangReport convention for !command output; bangAlert is
// for cron / handler / webhook output where there's no chat command.
//
// Sections is an array of strings (each with embedded newlines) OR an array
// of arrays of strings (per-section line arrays, joined with \n).
// =============================================================================

/**
 * Sanitize a string for safe inclusion in a bangReport title or section.
 *
 * Strips `[` and `]` characters so any historical embed-attribute parsers
 * downstream don't choke, and collapses runs of whitespace. Promoted from
 * courtney-worker so every caller hits the same definition.
 *
 * @param {string} str
 * @returns {string}
 */
export function safeEmbedTitle(str) {
  return String(str ?? "")
    .replace(/[\[\]]/g, " ")
    .replace(/  +/g, " ")
    .trim();
}

// ─── bangReport: dexter device-count style structured plain-text report ───────

const REPORT_WIDTH = 72;
const HEADER_RULE = "=".repeat(REPORT_WIDTH);
const SECTION_RULE = "-".repeat(REPORT_WIDTH);

/**
 * Build a dexter-style structured plain-text report wrapped in a code block.
 *
 * @param {object} opts
 * @param {string} opts.botName - "Dexter" / "Jacob" / etc. (first word of display name)
 * @param {string} opts.verb - bang command verb without leading !
 * @param {string} [opts.args] - args string from the command invocation
 * @param {Array<string|string[]>} opts.sections - per-section body (string or array of lines)
 * @param {string} [opts.subtitle] - optional override for the title line; default `${botName} !${verb}{, args}`
 * @returns {string} markdown-ready report (code-block wrapped)
 */
export function bangReport({ botName, verb, args, sections, subtitle } = {}) {
  const argsPart = args ? `: ${args}` : "";
  const title = subtitle || `${botName} !${verb}${argsPart}`;
  const out = [
    title,
    `Generated: ${new Date().toISOString()}`,
    HEADER_RULE,
  ];
  const list = Array.isArray(sections) ? sections : [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      out.push("");
      out.push(SECTION_RULE);
    }
    const s = list[i];
    if (Array.isArray(s)) out.push(s.join("\n"));
    else if (typeof s === "string") out.push(s);
  }
  return "```\n" + out.join("\n") + "\n```";
}

export const BANG_REPORT_RULES = { HEADER_RULE, SECTION_RULE };

// postToNexus hard-truncates a message body at 8000 chars, silently. A report
// longer than that loses its tail with no marker, which reads as a complete
// report that simply ends. Anything row-oriented and unbounded (breach records,
// device lists, audit tables) must be split before posting, not after.
const NEXUS_BODY_LIMIT = 8000;
const CHUNK_SAFETY_MARGIN = 400; // fences, continuation header, rounding

/**
 * Split an already-built bangReport into as many code-block-wrapped messages as
 * it takes to carry every line. Splits only on line boundaries, and stamps each
 * part with "part N of M" so a reader can tell the report continues.
 *
 * Post the returned parts IN ORDER, one postToNexus / ctx.reply call each.
 *
 * @param {string} report - output of bangReport (code-block wrapped) or raw text
 * @param {object} [opts]
 * @param {number} [opts.limit] - max chars per message (default 8000)
 * @returns {string[]} one or more code-block-wrapped message bodies
 */
export function chunkBangReport(report, opts = {}) {
  const limit = Math.max(1000, opts.limit || NEXUS_BODY_LIMIT) - CHUNK_SAFETY_MARGIN;
  const raw = String(report ?? "");
  if (raw.length <= limit) return [raw];

  const fenced = raw.startsWith("```");
  const inner = fenced ? raw.replace(/^```\n?/, "").replace(/\n?```$/, "") : raw;
  const lines = inner.split("\n");

  const pages = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    // A single line longer than the limit still has to ship; give it its own
    // page rather than dropping it.
    const lineLen = line.length + 1;
    if (currentLen + lineLen > limit && current.length > 0) {
      pages.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) pages.push(current);

  const total = pages.length;
  return pages.map((pageLines, i) => {
    const header = `(part ${i + 1} of ${total})`;
    const body = i === 0 ? [pageLines[0], header, ...pageLines.slice(1)] : [header, ...pageLines];
    const joined = body.join("\n");
    return fenced ? "```\n" + joined + "\n```" : joined;
  });
}

/**
 * bangAlert: non-command variant of bangReport for cron jobs, pollers, and
 * webhook handlers. Same output shape as bangReport (code-block-wrapped,
 * 72-wide rules, sections) but the title line is "Botname verb" (no leading
 * `!`), since the post isn't the response to a chat command.
 *
 * The fleet-wide format mandate (2026-05-17): every cron/handler post uses
 * this instead of asRichEmbedCard. Left-border color comes from the
 * message's provenance slug at the renderer level; the bot does not pick
 * a color here.
 *
 * @param {object} opts
 * @param {string} opts.botName - "Courtney" / "Dexter" / etc.
 * @param {string} opts.verb - kind of post (e.g. "ticket-alert", "uptime-alert")
 * @param {string} [opts.args] - optional args string appended after `--`
 * @param {Array<string|string[]>} opts.sections - per-section body
 * @returns {string} code-block-wrapped report ready to pass to postToNexus
 */
export function bangAlert({ botName, verb, args, sections } = {}) {
  const argsPart = args ? `: ${args}` : "";
  return bangReport({
    botName,
    verb,
    args,
    sections,
    subtitle: `${botName} ${verb}${argsPart}`,
  });
}

// =============================================================================
// buildReport: rich markdown card for human-facing reports.
//
// Hybrid format reset (2026-05-20): bangReport stays for diagnostics / monospace
// output (errors, JSON dumps, monitor lines, command echoes). buildReport is the
// new path for human-facing briefings, digests, recaps, HITL approvals, and
// anything a person will skim. See persona-blocks/FLEET_OUTPUT_STYLE.md.
//
// Output is pure markdown, no surrounding code fence. The Nexus renderer
// (MessageBody.jsx → marked.js + DOMPurify) handles GFM, custom emoji, mention
// chips, channel chips, and Discord-style <t:UNIX:X> timestamp tokens.
//
// Toast/push preview rule: the first 140 chars after stripMarkdown() must
// stand alone. The title line is emitted first, no timestamp token in it.
// =============================================================================

import {
  fmtList as _fmtList,
  nexusTimestamp as _nexusTimestamp,
  stripMarkdown as _stripMarkdown,
} from "./format.js";

const MAX_POST_CHARS = 6000;   // soft cap; postToNexus hard cap is 8000
const SECTION_DIVIDER = "\n\n---\n\n";

/**
 * Build a rich-markdown report.
 *
 * @param {object} opts
 * @param {string} opts.botName        - "Dexter" / "Wren" / etc.
 * @param {string} [opts.emoji]        - palette glyph prefixed to the title (e.g. PALETTE.METRICS)
 * @param {string} opts.title          - sentence-case title, e.g. "Morning Briefing"
 * @param {string} [opts.subtitle]     - one-liner under the title (italic)
 * @param {Array<ReportSection>} opts.sections
 * @param {string} [opts.body]         - pre-formatted markdown narrative (e.g. an LLM brief that
 *                                       already carries its own emoji+bold sections).
 *                                       Renders verbatim; takes precedence over `sections`.
 * @param {string} [opts.footer]       - optional footer prose; "{botName} · {title}" is the default
 * @param {Date|number|string} [opts.generatedAt] - timestamp used in default footer; current time if omitted
 * @returns {string} markdown ready to pass to postToNexus
 *
 * @typedef {object} ReportSection
 * @property {string} [emoji]      - palette glyph (e.g. PALETTE.SCHEDULE)
 * @property {string} title        - section title; renders as `emoji **bold**` (a `• ` marker leads the title only when the section has no emoji)
 * @property {number} [count]      - optional "(N)" suffix after the title
 * @property {string[]} [items]    - bullet list lines (already markdown-formatted)
 * @property {string} [lines]      - raw multi-line content; mutually exclusive with items
 * @property {number} [max=8]      - overflow cap on items (Infinity to disable)
 * @property {string} [overflowLabel] - override "_+N more_"
 * @property {string} [empty]      - text when items is empty (default "(none)")
 */
export function buildReport(opts = {}) {
  const {
    botName,
    emoji,
    title,
    subtitle,
    sections = [],
    body,
    footer,
    generatedAt,
  } = opts;

  const titlePrefix = emoji ? `${emoji} ` : "";
  const titleLine = `## ${titlePrefix}${title || botName || "Report"}`;

  const out = [titleLine];
  if (subtitle) out.push(`*${subtitle}*`);

  // `body` is a pre-formatted markdown narrative (e.g. an LLM-generated brief that
  // already carries its own emoji+bold sections). When present it renders
  // verbatim with no section wrapper, so we do not re-wrap or re-mark it.
  const hasBody = typeof body === "string" && body.trim().length > 0;
  const sectionList = hasBody ? [] : (Array.isArray(sections) ? sections : []);
  // A bullet marker only earns its keep with 2+ sections. A lone section gets a
  // clean emoji+bold header with no marker, so single-item cards stop reading
  // like an auto-generated cron report.
  const multiSection = sectionList.length > 1;
  const renderedSections = sectionList
    .map((sec, i) => renderSection(sec, i, multiSection))
    .filter(Boolean);

  if (hasBody) {
    out.push("");
    out.push(body.trim());
  } else if (renderedSections.length > 0) {
    out.push("");
    out.push(renderedSections.join(SECTION_DIVIDER));
  }

  const stamp = generatedAt ? _nexusTimestamp(generatedAt, "f") : _nexusTimestamp(Date.now(), "f");
  const defaultFooter = botName && title ? `${botName} · ${title}` : (botName || title || "");
  const footerLine = footer || defaultFooter;
  if (footerLine) {
    out.push("");
    out.push(`---`);
    out.push(`*${footerLine} · ${stamp}*`);
  }

  let report = out.join("\n");

  // Soft length guard. Walk sections from the end and trim until we're under cap.
  if (report.length > MAX_POST_CHARS && renderedSections.length > 1) {
    const head = [titleLine];
    if (subtitle) head.push(`*${subtitle}*`);
    let kept = renderedSections.slice();
    while (kept.length > 1) {
      kept.pop();
      const trimmed = [
        ...head,
        "",
        kept.join(SECTION_DIVIDER),
        "",
        "---",
        `*${defaultFooter} · ${stamp} · _truncated_*`,
      ].join("\n");
      if (trimmed.length <= MAX_POST_CHARS) {
        report = trimmed;
        break;
      }
    }
  }

  return report;
}

function renderSection(sec, index = 0, multiSection = true) {
  if (!sec || typeof sec !== "object") return "";
  const headerEmoji = sec.emoji ? `${sec.emoji} ` : "";
  const countSuffix = typeof sec.count === "number" ? ` *(${sec.count})*` : "";
  // House style: emoji+bold section headers, no markdown `###`. Section titles
  // are parallel categories, not an ordered sequence, so they are bulleted, not
  // numbered. The palette emoji already reads as the bullet, so an emoji-led
  // header carries no extra marker; an emoji-less header in a multi-section card
  // gets a "• " so it still reads as a list. The `index` is retained for callers
  // and future ordinal needs but no longer stamps a number.
  const bulletPrefix = multiSection && !headerEmoji ? "• " : "";
  const heading = `${headerEmoji}**${bulletPrefix}${sec.title || ""}**${countSuffix}`.trim();

  let body;
  if (typeof sec.lines === "string" && sec.lines.length > 0) {
    body = sec.lines;
  } else if (Array.isArray(sec.items)) {
    if (sec.items.length === 0) {
      body = sec.empty ?? "(none)";
    } else {
      body = _fmtList(sec.items, {
        bullet: "•",
        max: typeof sec.max === "number" ? sec.max : 8,
        overflowSuffix: sec.overflowLabel,
      });
    }
  } else {
    body = sec.empty ?? "";
  }

  return `${heading}\n${body}`.trim();
}

/**
 * Helper for callers that want to verify their report's preview line is
 * readable (the first 140 chars after stripMarkdown). Intended for tests.
 */
export function previewOf(report) {
  return _stripMarkdown(report).slice(0, 140);
}
