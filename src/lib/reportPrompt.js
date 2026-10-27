// =============================================================================
// reportPrompt.js, shared LLM prompt builder for fleet "house style" reports.
//
// Every bot that generates a narrative briefing/digest with an LLM (Robert's
// CISO brief, Wren's evening/weekly recaps, Moxie's analytics analysis, etc.)
// used to hand-roll its own prompt, so the section structure drifted bot to bot.
//
// buildReportPrompt() returns the { system, user } strings that instruct the
// model to emit the canonical FLEET_OUTPUT_STYLE section shape:
//
//     <emoji> **Section Title**
//     <prose or bullets>
//
//     <emoji> **Section Title**
//     ...
//
// Section titles are parallel categories, not an ordered sequence, so headers
// are bulleted rather than numbered: the palette emoji reads as the bullet, so
// an emoji-led header carries no extra marker; an emoji-less header gets a "• ".
// The emoji + title for each section are baked into the prompt by the CALLER
// (via the `sections` spec), not chosen by the model. This removes
// freelance-emoji violations and keeps headers deterministic. The model only
// fills the body under each pre-specified header.
//
// The caller passes the returned narrative to buildReport({ ..., body }) so the
// `##` document title, subtitle, and footer are added deterministically and the
// sections are NOT double-wrapped.
// =============================================================================

/**
 * @typedef {object} ReportPromptSection
 * @property {string} emoji   - palette glyph for this section header (caller-chosen, from PALETTE)
 * @property {string} title   - section title, sentence case (e.g. "Risk Posture Summary")
 * @property {"prose"|"bullets"} [kind="prose"] - body shape the model should produce
 * @property {string} [hint]  - per-section instruction (e.g. "2-3 sentences on overall posture")
 */

/**
 * Build the { system, user } prompt pair for a house-style narrative report.
 *
 * @param {object} opts
 * @param {string} opts.role         - the bot's reporting role, e.g. "CISO-level SOC analyst"
 * @param {string} opts.botName      - "Robert" / "Wren" / etc.
 * @param {string} opts.period       - reporting window, e.g. "the past 24 hours", "this week"
 * @param {ReportPromptSection[]} opts.sections - ordered section spec (emoji + title + body shape)
 * @param {string} [opts.data]       - serialized metrics/context the model must ground itself in
 * @param {string[]} [opts.caveats]  - data caveats the model must respect
 * @returns {{ system: string, user: string }}
 */
export function buildReportPrompt(opts = {}) {
  const {
    role = "analyst",
    botName = "the assistant",
    period = "the latest period",
    sections = [],
    data,
    caveats = [],
  } = opts;

  const cleanSections = (Array.isArray(sections) ? sections : [])
    .filter(sec => sec && typeof sec === "object" && sec.title);
  // Bullet an emoji-less header only when there are 2+ sections; a single
  // section reads as a plain header, matching buildReport's behavior. An
  // emoji-led header needs no marker since the emoji reads as the bullet.
  const multiSection = cleanSections.length > 1;
  const specLines = cleanSections.map((sec) => {
    const emoji = sec.emoji ? `${sec.emoji} ` : "";
    const kind = sec.kind === "bullets" ? "bullets" : "prose";
    const shape = kind === "bullets"
      ? 'bullets of the form "- **Lead term:** detail"'
      : "1-3 full sentences in an executive voice";
    const hint = sec.hint ? `: ${sec.hint}` : "";
    const bulletPrefix = multiSection && !emoji ? "• " : "";
    return `${emoji}**${bulletPrefix}${sec.title}**\n(${shape}${hint})`;
  });

  const caveatBlock = caveats.length
    ? `\n\nData caveats (respect these strictly):\n${caveats.map(c => `- ${c}`).join("\n")}`
    : "";

  const dataBlock = data ? `\n\nContext:\n${data}` : "";

  const system = `You are ${botName}, ${role} for Black Raven IT. Write concise, executive-level `
    + `briefings for the MSP leadership team. Direct, crisp, no jargon padding, no fluff. `
    + `Do not use em dashes, en dashes, or double hyphens (--); separate clauses with commas like a person does.`;

  const user = `You are ${botName}, ${role} for Black Raven IT. Write a brief covering ${period}.`
    + dataBlock
    + `\n\nReproduce the section headers below EXACTLY as written (same emoji, same marker, same `
    + `title), then write the body underneath each one. Do not add, remove, or reorder sections, and `
    + `do not number the section headers. Do not add a document title (it is added separately). Do not use \`#\`, \`##\`, `
    + `or \`###\` markdown headers anywhere. Do not introduce any emoji other than the ones shown.\n\n`
    + specLines.join("\n\n")
    + `\n\nRules: use specific numbers from the context, never invent facts, names, or details not `
    + `present above. If a section has nothing to report, say so plainly rather than manufacturing `
    + `content or urgency. No em dashes, en dashes, or double hyphens (--); use commas to separate clauses.`
    + caveatBlock;

  return { system, user };
}
