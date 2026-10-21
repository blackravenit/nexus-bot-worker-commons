// =============================================================================
// lib/colleagues.js
//
// Pulls the right human into a watercooler topic they actually care about.
//
// Brian, 2026-10-21: "I'd also like for the agents in that channel to mention
// other BRIT employees when things that are interesting to them. E.g. When
// Jacob talk about Fourrunners, @william etc."
//
// The roster lives in config/colleague-interests.json and is read off what
// those people have actually said in #watercooler, never guessed. See the
// _comment block in that file before adding anyone.
//
// Design note: the matching happens HERE, in code, not in the model. Handing a
// model the whole roster and asking it to decide who would like a post invites
// exactly the failure the fleet keeps hitting, a plausible-sounding claim about
// a real coworker. Keyword matching means a bot can only name someone when the
// post genuinely contains their topic, and the prompt it gets back either names
// one person or forbids mentioning anyone at all.
// =============================================================================

import rosterConfig from "../config/colleague-interests.json" with { type: "json" };

/** @typedef {{handle: string, name: string, interests: string, match: string[]}} Colleague */

/** @type {Colleague[]} */
export const COLLEAGUES = Array.isArray(rosterConfig?.colleagues)
  ? rosterConfig.colleagues
  : [];

/**
 * Find the colleagues whose interests a post genuinely touches.
 *
 * Matching is on whole words so "nfa" does not fire inside another word, with
 * multi-word terms ("land cruiser") matched as phrases. Ranked by how many of
 * a person's terms hit, so a post about a 4Runner build on the trail puts
 * William ahead of someone who matched one incidental word.
 *
 * @param {string} text  the drafted post, or the topic seed
 * @param {{ limit?: number }} [opts]
 * @returns {Colleague[]} best match first, empty when nothing really matches
 */
export function findInterestedColleagues(text, opts = {}) {
  const { limit = 1 } = opts;
  const haystack = String(text || "").toLowerCase();
  if (!haystack) return [];

  const scored = [];
  for (const person of COLLEAGUES) {
    let hits = 0;
    for (const term of person.match || []) {
      const t = String(term).toLowerCase();
      if (!t) continue;
      // Word-boundary match so a short term cannot fire inside another word.
      // Terms are plain words in our own config; stripping anything else keeps
      // the pattern injection-proof without an escape dance.
      const safe = t.replace(/[^a-z0-9 -]/g, "");
      if (!safe) continue;
      if (new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`).test(haystack)) hits += 1;
    }
    if (hits > 0) scored.push({ person, hits });
  }

  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, limit).map((s) => s.person);
}

/**
 * Build the prompt fragment that tells a bot whether to pull somebody in.
 *
 * Returns a block that either names ONE colleague and why, or states plainly
 * that nobody is to be named. Both branches are explicit on purpose: a bot
 * persona that merely omits permission to name people has historically been
 * read by the model as permission to invent them.
 *
 * @param {string} text  the drafted post, or the topic seed
 * @returns {string} prompt lines, or "" when the roster is empty
 */
export function buildColleagueMentionRules(text) {
  if (COLLEAGUES.length === 0) return "";
  const [match] = findInterestedColleagues(text);

  if (!match) {
    return [
      "",
      "MENTIONING COWORKERS:",
      "Nothing in this post touches a coworker's known interests, so do NOT mention or name anyone. Write it as a general post.",
    ].join("\n");
  }

  return [
    "",
    "MENTIONING COWORKERS:",
    `This post touches something ${match.name} is genuinely into: ${match.interests}.`,
    `Address them in the post as @${match.handle}, written exactly like that, lowercase, once. Nexus turns it into a real mention and notifies them.`,
    "Make it natural, the way you would tag a coworker who would actually want to see it: a direct aside or a question to them. Do not force it in at the end as an afterthought.",
    `Do NOT name or @ anybody except @${match.handle}, and do not describe what they own, drive, did, or said. You know what they are interested in, nothing more. Inventing a detail about a real coworker is the worst thing you can do here.`,
  ].join("\n");
}

/**
 * Take a finished watercooler post and, if it touches a colleague's interests,
 * return it with that person tagged naturally inside it.
 *
 * This runs AFTER drafting on purpose. A grounded share is written in the same
 * model turn as the web search, so what the post is actually ABOUT is unknown
 * until it exists: a topic seed of "an interesting tech story" cannot tell you
 * that today's story is a Land Cruiser. Matching the finished text is the only
 * signal that is always right, and it costs one Haiku call on the rare day
 * something matches.
 *
 * Every failure returns the original post. A missing tag is a non-event; a
 * mangled post, a dropped link or an invented claim about a coworker is not.
 *
 * @param {object} env
 * @param {string} post  the drafted post
 * @param {{ voice?: string, model?: string }} [opts]
 *   voice: one line of the bot's own voice so the rewrite does not flatten it.
 * @returns {Promise<string>} the post, tagged or untouched
 */
export async function weaveColleagueMention(env, post, opts = {}) {
  const original = String(post || "");
  if (!original.trim() || !env?.ANTHROPIC_API_KEY) return original;

  const [match] = findInterestedColleagues(original);
  if (!match) return original;

  // Any link in the post must survive verbatim: it was ground-checked against
  // real search results upstream, and a rewritten URL is a fabricated source.
  const urls = original.match(/https?:\/\/\S+/g) || [];

  const system = [
    "You add one coworker tag to an already-finished chat message. You are not rewriting it.",
    `The message is going to the team watercooler channel. ${match.name} is genuinely into: ${match.interests}. This message touches that, so they should be tagged.`,
    `Return the SAME message with @${match.handle} worked into it naturally, lowercase, exactly once: an aside or a short direct question to them.`,
    "Keep the original wording, length, voice and any link exactly as they are. Add at most a handful of words.",
    "Do NOT add any fact about this coworker. Do not say what they own, drive, did, said or think. You know their interests and nothing else.",
    "Do NOT tag or name anybody else. No greetings, no sign-off, no hashtags, no emoji.",
    "Do NOT use em dashes, en dashes, or double hyphens.",
    opts.voice ? `Voice: ${opts.voice}` : "",
    "Return only the message text.",
  ].filter(Boolean).join("\n");

  let out;
  try {
    const { callAnthropic } = await import("./anthropic.js");
    out = await callAnthropic(
      env,
      system,
      [{ role: "user", content: original }],
      { model: opts.model || "claude-haiku-4-5-20251001", maxTokens: 300 },
    );
  } catch (err) {
    console.warn("[colleagues] mention weave failed, posting untagged:", err?.message);
    return original;
  }

  // A SPACED single hyphen is a dash in everything but codepoint, and the
  // model reaches for it once the em dash is banned. scrubFleetDashes leaves
  // it alone, correctly, since it cannot tell this from a hyphenated word in
  // arbitrary text. In a one-line chat post " - " never is one.
  const tagged = String(out || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/ +- +/g, ", ");
  if (!tagged) return original;

  // Validate rather than trust. Each check below has a plausible failure mode:
  // the model drops the tag, tags the wrong person, rewrites the URL, or
  // decides to write its own post from scratch.
  const handleRe = new RegExp(`@${match.handle}([^a-z0-9]|$)`, "i");
  if (!handleRe.test(tagged)) {
    console.warn("[colleagues] weave came back without the tag, posting untagged");
    return original;
  }
  const otherHandles = COLLEAGUES.filter((c) => c.handle !== match.handle);
  for (const other of otherHandles) {
    if (new RegExp(`@${other.handle}([^a-z0-9]|$)`, "i").test(tagged)) {
      console.warn("[colleagues] weave tagged someone else too, posting untagged");
      return original;
    }
  }
  for (const url of urls) {
    if (!tagged.includes(url)) {
      console.warn("[colleagues] weave altered a grounded link, posting untagged");
      return original;
    }
  }
  if (/[–—]|--/.test(tagged)) {
    console.warn("[colleagues] weave introduced dash punctuation, posting untagged");
    return original;
  }
  // A tag plus an aside, not a new post. Generous ceiling, tight floor.
  if (tagged.length > original.length + 120 || tagged.length < original.length - 20) {
    console.warn("[colleagues] weave changed the post length too much, posting untagged");
    return original;
  }

  console.log(`[colleagues] tagged @${match.handle} into a watercooler post`);
  return tagged;
}
