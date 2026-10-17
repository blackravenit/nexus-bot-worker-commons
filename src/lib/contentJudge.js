// =============================================================================
// lib/contentJudge.js: fleet-shared LLM quality gate for drafted content.
//
// Why this exists: regex/heuristic output guards catch REPETITION and FORMAT
// problems but never INCOHERENCE. "Half your product roadmap lives in Slack
// threads. The other half ships." cleared every regex guard on moxie-worker
// and auto-published to the Morphora LinkedIn page (2026-07-02) because no
// regex can judge whether a line lands in two seconds, whether a contrast has
// a clear good/bad side, or whether the vocabulary fits the audience. A model
// can. This is the fleet-wide port of the gate first built in moxie-worker.
//
// Usage pattern (inside a drafting retry loop):
//
//   const verdict = await judgeContent(env, { surface: "cold-email", content, context });
//   if (!verdict.pass) {
//     prompt += buildRetryFeedback(verdict);   // regenerate with the objections
//     // on final failure: HOLD / demote to HITL: never auto-send a failed draft
//   }
//
// Semantics every consumer must preserve:
//   - Editorial failure (pass:false, skipped:false) -> retry, then HOLD/demote.
//   - Infra failure FAILS OPEN (pass:true, skipped:true) so an Anthropic blip
//     never zeroes a day's content. Callers may log/alert on skipped verdicts.
//
// Pure helpers (parseJudgeVerdict, buildRetryFeedback) are unit-testable with
// no worker bindings.
// =============================================================================

import { callAnthropic } from "./anthropic.js";

// Minimum judge score (1-10) to publish. The judge also returns its own pass
// boolean; both must agree so a generous scorer cannot sneak a 6/10 through.
export const JUDGE_PASS_THRESHOLD = 7;

/**
 * Per-surface overrides of JUDGE_PASS_THRESHOLD. Lower the bar only where the
 * cost of a false block is high and the rubric already names its disqualifying
 * failures explicitly, so a fail means "this leaks / is broken", not "this
 * could be written better".
 *
 * meeting-recap: the recap is a factual record of a call both sides sat
 * through, not marketing copy, and a withheld one strands a human in the
 * approval loop. Six of the first six holds (2026-07-22..07-30) scored 2-5;
 * half were prose nitpicks the recipient would never have noticed.
 */
export const SURFACE_PASS_THRESHOLDS = {
  "meeting-recap": 6,
};

/**
 * Resolve the pass threshold for a judge call.
 * @param {string} [surface]
 * @param {number} [override] - explicit params.threshold
 * @returns {number}
 */
export function resolvePassThreshold(surface, override) {
  const n = Number(override);
  if (Number.isFinite(n) && n >= 1 && n <= 10) return Math.round(n);
  return SURFACE_PASS_THRESHOLDS[surface] || JUDGE_PASS_THRESHOLD;
}

function judgeOutputContract(threshold) {
  return [
    "OUTPUT CONTRACT (non-negotiable): reply with ONLY a raw JSON object, no markdown, no code fence, no prose:",
    '{"pass": <boolean>, "score": <integer 1-10>, "issues": ["<specific problem>", ...]}',
    `"pass" is true ONLY when score >= ${threshold} and no issue is disqualifying.`,
    '"issues" must be concrete and actionable (what is wrong AND what would fix it), max 4 entries, empty array when clean.',
  ].join("\n");
}

/**
 * Fleet rubric library, keyed by surface. Each rubric is the judge's
 * system-prompt core: who the audience is, what "good" means on this surface,
 * and the failure modes heuristic guards structurally cannot see. A bot may
 * also pass a fully custom rubric string via params.rubric.
 */
export const FLEET_RUBRICS = {
  "cold-email": [
    "You are a ruthless deliverability-and-quality editor reviewing ONE cold outreach email before it sends to a real prospect.",
    "Judge against ALL of these:",
    "1. HUMAN TEST: reads like one busy professional wrote one email to one specific person. Template smell (mail-merge cadence, generic flattery, 'I hope this finds you well') is a FAIL.",
    "2. NO FABRICATION: no invented dates, quarters, deadlines, fake urgency ('limited slots'), fabricated mutual contacts, or claimed prior conversations that are not in the provided context. Any invented specific is a FAIL.",
    "3. PLACEHOLDER LEAKAGE: any template artifact ({{first_name}}, [Company], TBD, lorem) is an instant FAIL.",
    "4. ONE CLEAR ASK: exactly one low-friction call to action. Multiple asks or a vague 'thoughts?' is a FAIL.",
    "5. GROUNDING: every specific FACTUAL claim about the recipient or their company must come from the provided context. Industry-typical pain points framed as informed observations (not asserted as facts about this specific company) are acceptable and normal in cold outreach.",
    "6. LENGTH & TONE: skimmable in under 30 seconds, professional but not stiff, no spam-trigger hype ('revolutionary', 'game-changing').",
    "NOT failures (house conventions, do not penalize): a short all-lowercase casual subject line like 'quick question' or 'quick question, mark' (deliberate, tested cold-email convention; do not fail it as vague, lazy, or unprofessional); a NO-oriented ask ('Would it be unreasonable to...', 'Would it be ridiculous to...', 'Opposed to me sending...') as the single CTA (deliberate negative framing, not passive aggression); offering to send a short overview instead of asking for a call (a lighter ask is the house step-1 CTA); a soft availability window like 'in the next week or so' (not fabricated urgency); referencing a prior email as 'recently' or 'my note from earlier' on follow-up steps (the sequence is real); a brief mention of the sender's AI/automation capability alongside the main hook (a house requirement) as long as it is woven in naturally rather than a bolted-on second pitch.",
  ].join("\n"),

  "b2b-followup": [
    "You are a ruthless editor reviewing ONE B2B relationship/cadence follow-up message before it sends to a real partner or prospect.",
    "Judge against ALL of these:",
    "1. GROUNDING: references to prior conversations, commitments, or timelines must come from the provided context. Inventing a promised date, a 'we discussed', or a fake deadline is a FAIL.",
    "2. NO FABRICATED TIMELINE: no invented quarters, launch dates, or urgency. If the context gives no timeline, the draft must not assert one.",
    "3. PLACEHOLDER LEAKAGE: any template artifact is an instant FAIL.",
    "4. PURPOSE: the reader can tell in one read why they received this and what (if anything) is asked of them.",
    "5. HUMAN VOICE: warm, specific, concise. Filler check-ins ('just circling back') with no new value are a FAIL.",
  ].join("\n"),

  "newsletter": [
    "You are a ruthless editor reviewing ONE partner newsletter draft before it mails to an external distribution list.",
    "Judge against ALL of these:",
    "1. STRUCTURE: coherent sections, each making one clear point; a skimming reader gets value from headers alone.",
    "2. NO FABRICATION: no invented dates, events, statistics, client stories, or product claims beyond the provided context.",
    "3. PLACEHOLDER LEAKAGE: template artifacts, broken markup, or duplicated sections are an instant FAIL.",
    "4. HUMAN VOICE: no AI-slop tells ('in today's fast-paced world', 'game-changer', unearned profundity), no corporate abstraction soup.",
    "5. AUDIENCE FIT: written for business-owner partners, plain language, jargon explained or absent.",
  ].join("\n"),

  // Deliberately TIERED (2026-07-30). The flat five-criterion version withheld
  // six straight recaps, half of them over prose nitpicks (short-vs-full names)
  // or house conventions it could not know about (the "Wren Raven" sign-off), and
  // it kept asking to "verify" facts against a transcript it is never given. A
  // recap is a factual record of a call both sides attended: withhold it for a
  // leak or a broken document, never for wording.
  "meeting-recap": [
    "You are the final editor on ONE meeting recap email before it mails to the people who were in that meeting, who may include EXTERNAL clients.",
    "Your job is to stop a recap that would LEAK something or arrive visibly BROKEN. It is not to polish prose. A merely imperfect recap must PASS.",
    "You are given the finished recap ONLY. You do NOT have the transcript, so you cannot check any name, number, or commitment against the source. Never raise an issue asking anyone to 'verify' or 'confirm' something you have no source for, and never fail a recap because a detail is unfamiliar to you. Judge only what is visible on the page.",
    "DISQUALIFYING (fail on these, and only these):",
    "1. LEAK: internal pricing or discount strategy, margins, commission structures, Black Raven's own financials, or internal sales strategy, in a recap with an external recipient. Also details about OTHER clients, deals, or prospects who are not party to this meeting.",
    "2. TEMPLATE ARTIFACT: an unfilled placeholder rendered as literal text ('(Owner)', '{{name}}', '[Company]', 'TBD' where a name belongs), raw JSON, code fences, unrendered markup, or a section duplicated in two formats.",
    "3. TRUNCATION: the document stops mid-thought, a heading has no body, or a promised list is empty.",
    "4. SELF-CONTRADICTION: two incompatible statements, such as an item described as both completed and still open.",
    "5. META-COMMENTARY ABOUT THIS RECAP: remarks on transcript quality, the summarizer, or confidence in its own output ('the transcript was unclear', '(unverified)').",
    "EDITORIAL ONLY (mention in issues if genuinely useful, but they must NOT drive a fail): wording, tone, ordering, skimmability, a person called by first name in one place and full name in another, a topic thinner than you would have written it, or a name that appears only once.",
    "NOT failures (house conventions, do not penalize):",
    "- The sign-off 'Wren Raven' and the 'Wren AI' label. Wren Raven is the real named sender of every Black Raven IT recap and recipients know her. Never flag the signature, sender identity, or branding.",
    "- AI, automation, and AI-generated deliverables discussed as SUBJECT MATTER. Black Raven IT and Morphora sell AI services, so a line like 'review the AI-generated website copy before publishing' is a client deliverable, not leaked tooling detail. Only rule 5 (commentary about THIS recap's own generation) is a failure.",
    "- Naming people who were in the meeting, who own an action item, or whom the attendees already work with.",
    "- Frank but factual status, including bad news ('two devices still need hands-on work'). Honest status is the point of a recap.",
    "When the CONTEXT says every recipient is internal, rule 1 does not apply at all: internal candor is expected and must not be penalized.",
    "Score 7 or above and pass unless a DISQUALIFYING item is actually present. When one is, fail and name exactly what to remove.",
  ].join("\n"),

  "client-report": [
    "You are a ruthless editor reviewing ONE recurring status/posture report before it is delivered.",
    "Judge against ALL of these:",
    "1. COHERENCE: no internal contradictions (an item cannot be both resolved and open), no orphaned references to sections or data not present.",
    "2. GROUNDED: narrative claims must match the provided data/context; no invented metrics, trends, or causes.",
    "3. ACTIONABILITY: findings state what they mean and what (if anything) the reader should do; a wall of raw observations is a FAIL.",
    "4. CLARITY: plain language, acronyms expanded on first use, skimmable structure.",
    "5. CALIBRATION: severity language matches substance: no alarmism over routine noise, no burying a real problem in a bullet.",
  ].join("\n"),

  // Moxie's social surfaces (migrated from moxie-worker's local judge so the
  // fleet has ONE rubric library; moxie-worker/src/lib/contentJudge.js is now
  // a thin shim over this module).
  "morphora-quote": [
    "You are a ruthless brand editor reviewing ONE quote destined for a Morphora.ai quote-card image on LinkedIn.",
    "Morphora sells AI-native web/marketing/operations systems to SMALL BUSINESS OWNERS (plumbers, agencies, local firms), not startup PMs.",
    "Judge against ALL of these, in order of importance:",
    "1. TWO-SECOND TEST: a scrolling reader must get the point instantly. If the line needs a second read or the reader must supply the judgment themselves, FAIL.",
    "2. UNAMBIGUOUS VALENCE: if the quote contrasts two things, it must be obvious which side is bad and which is good. A contrast the reader could plausibly read as neutral or positive-about-the-wrong-half is a FAIL.",
    "3. AUDIENCE FIT: the pain described must be one a small-business owner actually has, in their vocabulary. Startup jargon (product roadmaps, Slack threads, sprints, standups) is a FAIL.",
    "4. LITERAL PLAUSIBILITY: the claim must hold up on a second read. No anthropomorphized tools, no magical claims.",
    "5. FRESHNESS: no fortune-cookie vagueness, no corporate abstraction soup, no clever-for-clever's-sake wordplay that sacrifices clarity.",
  ].join("\n"),

  "linkedin-post": [
    "You are a ruthless content editor reviewing ONE LinkedIn post draft before it publishes.",
    "Judge against ALL of these:",
    "1. HOOK: the first line must earn the click on 'see more'. A generic observation or throat-clearing opener is a FAIL.",
    "2. COHERENCE: the post must make one clear point a skimming reader can restate. Muddled or self-contradicting logic is a FAIL.",
    "3. SPECIFICITY: at least one concrete, picturable detail. Pure mood, vibes, or abstraction is a FAIL.",
    "4. HUMAN VOICE: no AI-slop tells (em-dash cadence, 'in today's fast-paced world', 'game-changer', 'Let that sink in', rhetorical-question stacking, unearned profundity).",
    "5. HONESTY: no invented statistics, fake anecdotes presented as real, or overclaimed results.",
    "6. AUDIENCE FIT: matches the brand context provided. A B2B security post in influencer voice (or vice versa) is a FAIL.",
    "7. SOURCE FIDELITY ON THIRD-PARTY CLAIMS (hard fail): any assertion about what a named company, person, or organization says, admits, states, publishes, or does must either (a) quote the source's actual words, or (b) carry explicit attribution to a named outlet or document ('per TechCrunch', 'their product page lists...'). A flat 'X's own website says Y' or 'the CEO admitted Z' where Y/Z is the author's paraphrase presented as the source's words is a FAIL. Strengthening a claim beyond the source ('detects other sounds' escalated to 'captures conversations') is a FAIL even when the underlying story is real; commenters WILL ask 'where does it say that', and the post must survive that question. When SOURCE MATERIAL appears in the context below, any third-party claim that exceeds what it supports is a FAIL. First-person opinion and clearly-framed analysis need no source; only claims about what a third party said or did trigger this rule.",
  ].join("\n"),

  "holiday-greeting": [
    "You are a ruthless brand editor reviewing ONE short holiday greeting before it publishes on a brand's social accounts.",
    "Judge against ALL of these:",
    "1. TONE FIT: the register must match the holiday named in the context. Solemn observances (Memorial Day, Veterans Day) must honor, never party ('Happy Memorial Day!' is a FAIL). Celebratory holidays must feel warm, not stiff.",
    "2. NO SALES PITCH: a greeting that pivots into selling products or services is a FAIL. A plain brand sign-off is fine.",
    "3. ACCURACY: any stated fact (anniversary math, what the day commemorates) must be correct and supported by the provided context. Invented events or wrong history is a FAIL.",
    "4. HUMAN VOICE: no AI-slop tells, no corporate boilerplate soup, no unearned profundity. Reads like a person who means it.",
    "5. SAFE GROUND: nothing political, divisive, or preachy. Gratitude and celebration only.",
    "6. LENGTH: short and skimmable, suitable for every platform including X (under ~270 characters).",
  ].join("\n"),

  "jimifalls-captions": [
    "You are a ruthless music-marketing editor reviewing a SET of per-platform social captions for Jimi Falls, a rock band. The full set is provided; judge it as a whole.",
    "Judge against ALL of these:",
    "1. SPECIFICITY: each caption needs at least one concrete detail (a lyric, what a song is about, a named moment, something visible in the asset). Pure vibes ('real rock', 'we mean every note') is a FAIL.",
    "2. BANNED TROPES: 'no filler', 'still hits', 'if you slept on', 'still finding new ears', generic BTS filler, 'which track hits hardest' engagement bait. Any occurrence is a FAIL.",
    "2a. NO EP RECAP FILLER: stating the track count ('four tracks'), 'start to finish' / 'front to back', reciting the tracklist, narrating how long the record has been out ('out for months now', 'six months since'), 'the easiest song to introduce someone to', 'new ears welcome'. The audience already knows what the EP is; this padding replaces the one specific thing the caption should have said. Any occurrence is a FAIL.",
    "3. VOICE: bandmate talking, not a label's marketing intern. 'We are excited to announce' energy is a FAIL.",
    "4. PLATFORM FIT: TikTok hook-first and punchy, X under 120 chars, YouTube title under 60 chars, LinkedIn same tone without B2B softening.",
    "5. COHERENCE: no caption may contradict the asset description or invent scenes not supported by it.",
    "5a. NO LIVE PERFORMANCE OF AN EP TRACK (hard fail, overrides every other score). Jimi Falls has NOT played a single show since the EP 'Ashes Fall Where Shadows Stood' was released, so no EP track (Antidote, Ember, Searchlight, Shine Again acoustic) has EVER been performed for an audience. Every live, stage, venue, or crowd photo in the pool predates the release. FAIL any caption that says or implies the band played, performed, sang, opened with, closed with, or worked an EP song into a set; that an EP song hits harder or lands better live; that audiences react to, request, or ask about an EP song after a show; or that any show happened after the release. Judge the CLAIM, not the wording: 'locked into antidote mid set', 'searchlight found us live', 'the one people ask about after every show', and 'we're still up there playing it' are all the same fail even though none of them uses the word 'played'. Captioning an old show photo is fine as long as no EP song is attached to it.",
    "6. NO ALT-TEXT NARRATION: a caption that describes the photo's layout, positions, lighting, or framing ('X on the left', 'Y above him', 'under a red wash', 'close-up of', 'wide shot') is a FAIL. Reciting or paraphrasing the asset description as caption text, and chained fragment inventories of visible details ('mid scream, teal five string strapped on, chrome mic catching the lights'), are the same FAIL. Allowed: ONE simple visual reference, e.g. a confident '[name] crushing it on [instrument]' opener naming who is in the shot. The rest of the caption is story, song, or CTA, never more picture description.",
  ].join("\n"),
};

/**
 * Parse the judge model's raw completion into a verdict object.
 * Pure and defensive: tolerates code fences, stray prose around the JSON, and
 * missing fields. Returns null when no usable verdict can be extracted (the
 * caller treats null as an infra-grade failure and fails open).
 *
 * @param {string} raw - raw model completion
 * @param {number} [threshold=JUDGE_PASS_THRESHOLD] - minimum score to pass
 * @returns {{pass: boolean, score: number, issues: string[]}|null}
 */
export function parseJudgeVerdict(raw, threshold = JUDGE_PASS_THRESHOLD) {
  if (!raw || typeof raw !== "string") return null;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  if (typeof parsed.pass !== "boolean" && typeof parsed.score !== "number") return null;
  const score = Math.max(1, Math.min(10, Math.round(Number(parsed.score) || 0)));
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((i) => typeof i === "string" && i.trim()).slice(0, 4)
    : [];
  // Both signals must agree to pass: the judge's own boolean AND the threshold.
  const pass = parsed.pass === true && score >= threshold;
  return { pass, score, issues };
}

/**
 * Format a failed verdict's issues as a prompt block for the retry attempt, so
 * the generator gets told exactly what the editor rejected and why.
 * Pure; returns "" for a passing/empty verdict.
 *
 * @param {{issues?: string[], score?: number}|null} verdict
 * @returns {string}
 */
export function buildRetryFeedback(verdict) {
  const issues = verdict?.issues || [];
  if (!issues.length) return "";
  return [
    "",
    `EDITOR REJECTION (your previous draft scored ${verdict.score}/10 and was rejected: fix EVERY issue below, do not just reword):`,
    ...issues.map((i) => `- ${i}`),
  ].join("\n");
}

/**
 * Judge one piece of drafted content against a surface rubric.
 * Fails OPEN on infra/parse failure: returns {pass: true, skipped: true} so a
 * transient Anthropic error never zeroes out a day's content. A real editorial
 * failure always comes back with skipped: false.
 *
 * Model resolution: params.model > env.JUDGE_MODEL > env.CLAUDE_MODEL >
 * claude-sonnet-5. Keep the judge on a Sonnet-class model: a fast model
 * grading a fast model is how the problem started.
 *
 * @param {object} env - CF env bindings
 * @param {object} params
 * @param {string} [params.surface] - key into FLEET_RUBRICS
 * @param {string} [params.rubric]  - full custom rubric text (overrides surface)
 * @param {string} params.content   - the drafted content to judge
 * @param {string} [params.context] - grounding context (recipient, brand, source data)
 * @param {string} [params.model]   - explicit judge model override
 * @param {number} [params.threshold] - explicit pass threshold (defaults to the
 *   surface override in SURFACE_PASS_THRESHOLDS, else JUDGE_PASS_THRESHOLD)
 * @returns {Promise<{pass: boolean, score: number, issues: string[], skipped: boolean}>}
 */
export async function judgeContent(env, { surface, rubric, content, context = "", model, threshold } = {}) {
  const rubricText = rubric || FLEET_RUBRICS[surface];
  if (!rubricText) throw new Error(`contentJudge: unknown surface "${surface}" and no custom rubric given`);
  if (!content || !content.trim()) {
    return { pass: false, score: 1, issues: ["content is empty"], skipped: false };
  }

  const passThreshold = resolvePassThreshold(surface, threshold);
  const judgeModel = model || env.JUDGE_MODEL || env.CLAUDE_MODEL || "claude-sonnet-5";
  const system = `${rubricText}\n\nYou judge ONLY the submitted content. You never rewrite it.\n\n${judgeOutputContract(passThreshold)}`;
  const user = [
    context ? `CONTEXT:\n${context}\n` : "",
    "CONTENT TO JUDGE:",
    content,
  ].filter(Boolean).join("\n");

  // callAnthropic now retries transient failures internally (lib/retry.js:
  // 429/5xx/network), so the judge makes a SINGLE call and no longer stacks its
  // own retry loop on top (which would compound to ~9 network attempts). A throw
  // here means retries were exhausted or the error was non-transient; fail OPEN
  // so an Anthropic blip never zeroes a day's content.
  let raw = "";
  try {
    raw = await callAnthropic(env, system, [{ role: "user", content: user }], {
      model: judgeModel,
      maxTokens: 400,
      surface: "content-judge",
    });
  } catch (err) {
    console.warn(`[contentJudge] ${surface || "custom"}: judge call failed, failing open:`, err.message);
    return { pass: true, score: 0, issues: [], skipped: true };
  }

  const verdict = parseJudgeVerdict(raw, passThreshold);
  if (!verdict) {
    console.warn(`[contentJudge] ${surface || "custom"}: unparseable verdict, failing open: "${String(raw).slice(0, 120)}"`);
    return { pass: true, score: 0, issues: [], skipped: true };
  }

  console.log(`[contentJudge] ${surface || "custom"}: ${verdict.pass ? "PASS" : "FAIL"} score=${verdict.score}/${passThreshold}${verdict.issues.length ? ` issues=${JSON.stringify(verdict.issues)}` : ""}`);
  return { ...verdict, skipped: false };
}

// Redraft budget: how many extra generate+judge cycles run after the first
// judge before the loop gives up and hands the caller a still-failing verdict.
// 2 means up to 3 judge passes total. Kept small: a draft the editor rejects
// three times is not one more reword away from good, it is a HITL problem.
const DEFAULT_MAX_REDRAFTS = 2;

/**
 * Closed-loop judge: judge the content and, on editorial failure, let the caller
 * REDRAFT from the objections and re-judge, up to maxRedrafts extra cycles. This
 * is the self-correcting form of judgeContent. Instead of a failed verdict going
 * straight to HOLD/HITL (a human then re-drives), the generator gets the editor's
 * objections fed back and tries again, so most rejections never reach a person.
 *
 * The redraft callback receives (currentContent, verdict, attempt) and returns
 * the NEW content string to judge, regenerated with the objections addressed
 * (feed buildRetryFeedback(verdict) into your generation prompt), or a falsy
 * value to stop early. It is called only on a real editorial failure.
 *
 * Semantics preserved from judgeContent:
 *   - Infra failure fails OPEN (skipped:true) and STOPS the loop immediately: a
 *     transient Anthropic blip never triggers a redraft storm; content ships
 *     exactly as the un-looped path would have.
 *   - A passing verdict stops the loop. On persistent editorial failure the loop
 *     exhausts its budget and returns the LAST content + verdict (pass:false);
 *     the caller still owns the HOLD/HITL decision.
 *
 * @param {object} env - CF env bindings
 * @param {object} params - judgeContent params plus loop controls
 * @param {(content: string, verdict: object, attempt: number) => Promise<string>} params.redraft
 * @param {number} [params.maxRedrafts=2] - extra generate+judge cycles after the first judge
 * @param {typeof judgeContent} [params._judge] - injectable judge (tests only; defaults to judgeContent)
 * @returns {Promise<{content: string, verdict: object, redrafts: number}>}
 */
export async function judgeContentWithRedraft(env, { redraft, maxRedrafts = DEFAULT_MAX_REDRAFTS, _judge = judgeContent, ...judgeParams } = {}) {
  let content = judgeParams.content;
  let verdict = await _judge(env, { ...judgeParams, content });
  let redrafts = 0;

  while (!verdict.pass && !verdict.skipped && typeof redraft === "function" && redrafts < maxRedrafts) {
    let revised;
    try {
      revised = await redraft(content, verdict, redrafts + 1);
    } catch (err) {
      console.warn(`[contentJudge] ${judgeParams.surface || "custom"}: redraft attempt ${redrafts + 1} threw, stopping loop:`, err.message);
      break;
    }
    // Stop if the generator gave up, returned nothing, or could not change it.
    if (!revised || !String(revised).trim() || revised === content) break;
    redrafts += 1;
    content = revised;
    verdict = await _judge(env, { ...judgeParams, content });
    console.log(`[contentJudge] ${judgeParams.surface || "custom"}: redraft ${redrafts} -> ${verdict.pass ? "PASS" : `FAIL(${verdict.score})`}`);
  }

  return { content, verdict, redrafts };
}
