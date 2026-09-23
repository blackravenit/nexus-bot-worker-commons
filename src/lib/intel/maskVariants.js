// =============================================================================
// lib/intel/maskVariants.js: full-set look-alike generator for the Mask sweep
// (docs/mask-spec.md).
//
// The daily posture pass uses generateVariants (capped at 60, VT-budgeted).
// The monthly Mask sweep resolves candidates itself via DoH, so it wants the
// FULL permutation set plus the classes the capped generator omits:
//   - repetition     (double one char)              example -> exxample
//   - subdomain dot  (split into a subdomain)       example.com -> ex.ample.com
//   - dictionary     (brand plus keyword combos)    example-login.com
//   - IDN homoglyph  (Cyrillic confusables, emitted as punycode xn-- form)
//   - bitsquat       (single bit flip)              example -> examqle
//   - plural / dash  (pluralised, hyphens stripped) example -> examples
//   - misspelling    (curated English swaps)        insurance -> insurence
//
// The last three close the gap against URLCrazy (desk #8026, 2026-09-22),
// which is a Ruby CLI and cannot run in a Worker. Every other URLCrazy class
// was already covered here or in typosquat.js. Bitsquat is the expensive one:
// it grows the candidate set by roughly 2 to 3 per SLD character, so watch the
// Mask sweep DNS budget (500 subrequests per run) as the watch list grows.
//
// Dictionary combos matter most for SaaS watch entries (rev.io has a tiny
// typo space; revio-login.com is what actually gets registered).
//
// Lives in nexus-bot-worker-commons so robert-worker (Mask sweep) and
// scanner-worker (Hawkeye Mask scan) share one engine. Pure: no bindings.
// =============================================================================

import {
  tldSwapVariants,
  homoglyphVariants,
  transpositionVariants,
  omissionVariants,
  vowelSwapVariants,
  hyphenationVariants,
  substitutionVariants,
  additionVariants,
} from "./typosquat.js";

const COMBO_KEYWORDS = ["login", "portal", "support", "secure", "billing", "help", "sso"];

// Latin -> Cyrillic visual confusables. Emitted as punycode: that is the form
// an attacker registers and the form DNS answers for.
const IDN_CONFUSABLES = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", i: "і", s: "ѕ" };

// Common English misspelling swaps, applied as substrings inside the SLD.
// URLCrazy ships a full English misspelling dictionary; a Worker cannot carry
// one, so this is the curated set that actually turns up in brand names.
const MISSPELLINGS = [
  ["ei", "ie"], ["ie", "ei"], ["ance", "ence"], ["ence", "ance"],
  ["able", "ible"], ["ible", "able"], ["tion", "toin"], ["ment", "emnt"],
  ["ph", "f"], ["ck", "k"], ["ou", "u"], ["er", "re"], ["re", "er"],
];

// Registrable label characters. A bit flip landing outside this set, or on a
// leading or trailing hyphen, produces a name nobody can register.
const LABEL_CHARS = /^[a-z0-9-]$/;

/**
 * Repetitions: each character doubled once.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function repetitionVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length; i++) {
    out.push(`${sld.slice(0, i)}${sld[i]}${sld.slice(i)}.${tld}`);
  }
  return out;
}

/**
 * Subdomain dots: one dot inserted, turning a slice into a subdomain.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function subdomainDotVariants(sld, tld) {
  const out = [];
  for (let i = 1; i < sld.length; i++) {
    out.push(`${sld.slice(0, i)}.${sld.slice(i)}.${tld}`);
  }
  return out;
}

/**
 * Dictionary combos: brand joined with the keywords attackers pair with
 * login pages, on the original TLD and .com.
 * @param {string} sld - Second-level domain
 * @param {string} tld - Original TLD
 * @returns {Array<string>} Candidate domains
 */
export function dictionaryVariants(sld, tld) {
  const out = [];
  const tlds = tld === "com" ? [tld] : [tld, "com"];
  for (const kw of COMBO_KEYWORDS) {
    for (const t of tlds) {
      out.push(`${sld}-${kw}.${t}`, `${sld}${kw}.${t}`, `${kw}-${sld}.${t}`);
    }
  }
  return out;
}

/**
 * Converts a possibly-unicode hostname to its punycode (xn--) form.
 * @param {string} host - Hostname that may contain non-ASCII characters
 * @returns {string|null} Punycode hostname, or null when unparseable
 */
function toPunycode(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch (err) {
    console.warn(`[maskVariants] punycode failed for ${host}: ${err?.message}`);
    return null;
  }
}

/**
 * IDN homoglyphs: each Latin char with a Cyrillic confusable substituted
 * once, emitted in registrable punycode form.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains (xn-- form)
 */
export function idnVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length; i++) {
    const glyph = IDN_CONFUSABLES[sld[i]];
    if (!glyph) continue;
    const puny = toPunycode(`${sld.slice(0, i)}${glyph}${sld.slice(i + 1)}.${tld}`);
    if (puny && puny !== `${sld}.${tld}`) out.push(puny);
  }
  return out;
}

/**
 * Bitsquats: every single-bit flip of every SLD character that still lands on
 * a registrable label character. This is the one class URLCrazy has that the
 * rest of the engine does not: it catches the domains single-bit memory and
 * transmission errors resolve to, not the ones humans mistype.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function bitsquatVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const flipped = String.fromCharCode(sld.charCodeAt(i) ^ (1 << bit));
      if (!LABEL_CHARS.test(flipped)) continue;
      const candidate = `${sld.slice(0, i)}${flipped}${sld.slice(i + 1)}`;
      if (candidate.startsWith("-") || candidate.endsWith("-")) continue;
      out.push(`${candidate}.${tld}`);
    }
  }
  return out;
}

/**
 * Plural and dash forms: the brand pluralised or singularised, and the same
 * name with its hyphens stripped. Cheap, and both get registered in practice.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function pluralDashVariants(sld, tld) {
  const out = [];
  if (sld.endsWith("es") && sld.length > 2) out.push(`${sld.slice(0, -2)}.${tld}`);
  if (sld.endsWith("s") && sld.length > 1) out.push(`${sld.slice(0, -1)}.${tld}`);
  if (!sld.endsWith("s")) out.push(`${sld}s.${tld}`, `${sld}es.${tld}`);
  if (sld.includes("-")) {
    const stripped = sld.replace(/-/g, "");
    if (stripped) out.push(`${stripped}.${tld}`);
  }
  return out.filter((v) => !v.startsWith("-") && !v.startsWith("."));
}

/**
 * Misspellings: each MISSPELLINGS pair applied at each position it occurs, one
 * swap per candidate.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function misspellingVariants(sld, tld) {
  const out = [];
  for (const [from, to] of MISSPELLINGS) {
    let at = sld.indexOf(from);
    while (at !== -1) {
      const candidate = `${sld.slice(0, at)}${to}${sld.slice(at + from.length)}`;
      if (candidate && !candidate.startsWith("-") && !candidate.endsWith("-")) {
        out.push(`${candidate}.${tld}`);
      }
      at = sld.indexOf(from, at + 1);
    }
  }
  return out;
}

/**
 * Generate the FULL look-alike candidate set for the Mask sweep: every class,
 * no cap, deduped, original excluded, with per-class counts for logging.
 *
 * exclude drops named classes before generation. The Mask sweep drops
 * "addition": it is 58 percent of the candidate set across our watch list and
 * the weakest signal in it (every letter appended at every position), and the
 * sweep only has DNS_BUDGET_PER_RUN subrequests to spend.
 * @param {string} domain - "example.com"
 * @param {{exclude?: Array<string>}} [options] - Class names to skip
 * @returns {{variants: Array<string>, counts: Record<string, number>}}
 */
export function generateFullVariants(domain, options = {}) {
  const exclude = new Set(options.exclude || []);
  const original = (domain || "").toLowerCase().trim();
  if (!original.includes(".")) return { variants: [], counts: {} };
  const lastDot = original.lastIndexOf(".");
  const sld = original.slice(0, lastDot);
  const tld = original.slice(lastDot + 1);
  if (!sld || !tld) return { variants: [], counts: {} };

  const classes = {
    tld_swap: tldSwapVariants(sld, tld),
    homoglyph: homoglyphVariants(sld, tld),
    idn: idnVariants(sld, tld),
    transposition: transpositionVariants(sld, tld),
    omission: omissionVariants(sld, tld),
    repetition: repetitionVariants(sld, tld),
    vowel_swap: vowelSwapVariants(sld, tld),
    hyphenation: hyphenationVariants(sld, tld),
    subdomain_dot: subdomainDotVariants(sld, tld),
    dictionary: dictionaryVariants(sld, tld),
    substitution: substitutionVariants(sld, tld),
    addition: additionVariants(sld, tld),
    bitsquat: bitsquatVariants(sld, tld),
    plural_dash: pluralDashVariants(sld, tld),
    misspelling: misspellingVariants(sld, tld),
  };

  const seen = new Set([original]);
  const variants = [];
  const counts = {};
  for (const [name, list] of Object.entries(classes)) {
    if (exclude.has(name)) continue;
    counts[name] = 0;
    for (const v of list) {
      if (seen.has(v)) continue;
      seen.add(v);
      variants.push(v);
      counts[name]++;
    }
  }
  return { variants, counts };
}
