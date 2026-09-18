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
 * Generate the FULL look-alike candidate set for the Mask sweep: every class,
 * no cap, deduped, original excluded, with per-class counts for logging.
 * @param {string} domain - "example.com"
 * @returns {{variants: Array<string>, counts: Record<string, number>}}
 */
export function generateFullVariants(domain) {
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
  };

  const seen = new Set([original]);
  const variants = [];
  const counts = {};
  for (const [name, list] of Object.entries(classes)) {
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
