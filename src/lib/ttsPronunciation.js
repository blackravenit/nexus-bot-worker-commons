// =============================================================================
// lib/ttsPronunciation.js: deterministic pronunciation overrides for any
// surface that speaks aloud.
//
// The voice persona prompt asks Claude to say "Black Raven I.T.", and the model
// follows that inconsistently (Brian heard "Black Raven it" on a call
// 2026-06-04 even though the website came out right). A substitution at the
// speak() boundary makes it model independent.
//
// This is the SHARED copy. It started as three: the Nexus VC path
// (nexus-app/worker/src/lib/voicePipeline/ttsPronunciation.js), the phone path
// (voice-agent-bridge/src/util/ttsPronunciation.js, a superset with NATO
// spelling and name overrides), and FleetView, which had none and therefore
// read money and acronyms wrong. Those two carry a comment asking whoever
// touches them to keep the copies in sync by hand, which is how they drifted.
// New surfaces import this one.
//
// Hard rules:
//   - No module-level I/O.
//   - No em dashes or en dashes.
// =============================================================================

const SUBSTITUTIONS = [
  // Company domain in prose ("blackravenit.com" or bare "blackravenit").
  // The negative lookbehind keeps it from firing inside an email address,
  // whose readback is handled by the email rule below. The .com form runs first.
  [/(?<!@)\bblackravenit\.com\b/gi, "Black Raven I.T. dot com"],
  [/(?<!@)\bblackravenit\b/gi, "Black Raven I.T."],

  // Channel slug suffixes spoken aloud. "jacob-qa" was read as "Jacob K" and
  // Brian thought the channel was broken (2026-06-04). Spell the suffix out.
  [/-qa\b/gi, " Q A"],
  [/-hitl\b/gi, " H I T L"],

  // "IT" the acronym, so ElevenLabs says "I-T" and not the pronoun "it".
  // Case sensitive plus a word boundary so "items", "It's" and "ITS" do not
  // match, and an already correct "I.T." does not re-match.
  [/\bIT\b/g, "I.T."],
];

// Read "@" as "at" and "." as "dot" so a spoken address is followable
// ("owner at blackravenit dot com") instead of one mashed token.
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/**
 * Space out an email address for speech.
 * @param {string} addr
 * @returns {string}
 */
function readableEmail(addr) {
  return addr.replace(/@/g, " at ").replace(/\./g, " dot ");
}

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * Spell a number below 1000.
 * @param {number} n
 * @returns {string}
 */
function under1000(n) {
  let s = "";
  if (n >= 100) { s += ONES[Math.floor(n / 100)] + " hundred"; n %= 100; if (n) s += " "; }
  if (n >= 20) { s += TENS[Math.floor(n / 10)]; n %= 10; if (n) s += "-" + ONES[n]; }
  else if (n > 0) { s += ONES[n]; }
  return s;
}

/**
 * Spell a whole number in words.
 * @param {number} n
 * @returns {string}
 */
function intToWords(n) {
  if (n === 0) return "zero";
  const parts = [];
  for (const [name, val] of [["billion", 1e9], ["million", 1e6], ["thousand", 1e3]]) {
    if (n >= val) { parts.push(under1000(Math.floor(n / val)) + " " + name); n %= val; }
  }
  if (n > 0) parts.push(under1000(n));
  return parts.join(" ");
}

const CURRENCY_RE = /\$\s?([\d,]*\.?\d+)(?:\s*([KMB]))?\b/gi;

/**
 * Convert dollar amounts to words. ElevenLabs mangles "$199,000" and "$199K"
 * (heard as "one hundred 9 9" on a call 2026-06-04).
 *
 * @param {string} text
 * @returns {string}
 */
function expandCurrency(text) {
  return text.replace(CURRENCY_RE, (match, num, suffix) => {
    const mult = suffix ? { K: 1e3, M: 1e6, B: 1e9 }[suffix.toUpperCase()] : 1;
    const raw = parseFloat(String(num).replace(/,/g, "")) * mult;
    if (!Number.isFinite(raw)) return match;
    const dollars = Math.floor(raw);
    const cents = Math.round((raw - dollars) * 100);
    let out = `${intToWords(dollars)} dollar${dollars === 1 ? "" : "s"}`;
    if (cents > 0) out += ` and ${intToWords(cents)} cent${cents === 1 ? "" : "s"}`;
    return out;
  });
}

/**
 * Apply pronunciation overrides. Safe on any string; returns the input
 * unchanged when nothing matches.
 *
 * Apply it EXACTLY ONCE, at the speak() boundary. It is deliberately not
 * idempotent: the first pass expands "owner@blackravenit.com" to "owner at
 * blackravenit dot com", and on a second pass that bare "blackravenit" is no
 * longer shielded by the @ lookbehind, so it becomes "owner at Black Raven
 * I.T. dot com". Guarding against that would mean ignoring the domain after
 * the word "at", which would break the ordinary sentence "email us at
 * blackravenit.com". Calling once is the cheaper contract.
 *
 * @param {string} text
 * @returns {string}
 */
export function applyVoicePronunciation(text) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  out = expandCurrency(out);
  out = out.replace(EMAIL_RE, (m) => readableEmail(m));
  return out;
}
