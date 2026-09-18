// =============================================================================
// lib/intel/typosquat.js: dnstwist-style typosquat domain generator
//
// Generates plausible attacker-registered look-alike variants of a target
// domain using the standard transformation set:
//   - tld swap       (com -> net/org/co/...)        example.com -> example.net
//   - homoglyph      (visually similar char)        example -> exarnple, examp1e
//   - transposition  (swap adjacent chars)          example -> xeample, eaxmple
//   - omission       (remove one char)              example -> exampl, examle
//   - vowel swap     (swap one vowel for another)   example -> ixample, examplo
//   - hyphenation    (insert hyphen between chars)  example -> ex-ample
//   - substitution   (single-char replace, neighbor) example -> ezample, exsmple
//   - addition       (add one char anywhere)        example -> aexample, examplea
//
// The MAX_VARIANTS cap is filled by round-robin across the classes in the
// priority order above, so every class survives the cap. The previous
// insertion-order slice let omission + addition consume all 60 slots on any
// real-length domain, which discarded the classes attackers actually
// register (homoglyphs, TLD swaps) before they were ever checked.
//
// Returns deduped lowercase candidate domains. The caller (posture-monitor)
// passes each through enrich_ioc_external (VT/urlscan) to find which are
// actually registered + malicious.
//
// Lives in nexus-bot-worker-commons so robert-worker (Mask sweep) and
// scanner-worker (Hawkeye Mask scan) share one engine. Pure: no bindings.
// =============================================================================

const QWERTY_NEIGHBORS = {
  q: "12wa",  w: "23qsae",  e: "34wsdr",  r: "45edft",  t: "56rfgy",
  y: "67tghu", u: "78yhji",  i: "89ujko",  o: "90iklp",  p: "0olp",
  a: "qwsxz",  s: "qweadzx", d: "wersfcx", f: "ertdgvc", g: "rtyfhbv",
  h: "tyugjnb", j: "yuihknm", k: "uiojlm",  l: "iopkm",
  z: "asx",   x: "zsdc",    c: "xdfv",    v: "cfgb",    b: "vghn",
  n: "bhjm",  m: "njk",
};

const HOMOGLYPHS = {
  a: "4", e: "3", i: "1l", l: "1i", o: "0", s: "5$", t: "7", g: "9", z: "2",
  b: "8", h: "n", m: "rn", w: "vv", q: "9", c: "k",
};

const VOWELS = "aeiou";

const TLD_SWAPS = ["com", "net", "org", "co", "io", "info", "biz", "us", "online", "site", "store", "app", "xyz", "shop"];

const MAX_VARIANTS = 60; // cap to avoid 1000s of VT lookups per client

/**
 * TLD swaps: same SLD on the common alternative TLDs.
 * @param {string} sld - Second-level domain
 * @param {string} tld - Original TLD (excluded from output)
 * @returns {Array<string>} Candidate domains
 */
export function tldSwapVariants(sld, tld) {
  return TLD_SWAPS.filter((t) => t !== tld).map((t) => `${sld}.${t}`);
}

/**
 * Homoglyphs: one visually similar character substituted per variant.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function homoglyphVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length; i++) {
    for (const g of HOMOGLYPHS[sld[i]] || "") {
      out.push(`${sld.slice(0, i)}${g}${sld.slice(i + 1)}.${tld}`);
    }
  }
  return out;
}

/**
 * Transpositions: each pair of adjacent characters swapped once.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function transpositionVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length - 1; i++) {
    if (sld[i] === sld[i + 1]) continue;
    out.push(`${sld.slice(0, i)}${sld[i + 1]}${sld[i]}${sld.slice(i + 2)}.${tld}`);
  }
  return out;
}

/**
 * Omissions: one character removed per variant; 1-char SLDs are dropped.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function omissionVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length; i++) {
    const v = sld.slice(0, i) + sld.slice(i + 1);
    if (v.length >= 2) out.push(`${v}.${tld}`);
  }
  return out;
}

/**
 * Vowel swaps: each vowel replaced by each other vowel.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function vowelSwapVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length; i++) {
    if (!VOWELS.includes(sld[i])) continue;
    for (const v of VOWELS) {
      if (v !== sld[i]) out.push(`${sld.slice(0, i)}${v}${sld.slice(i + 1)}.${tld}`);
    }
  }
  return out;
}

/**
 * Hyphenations: one hyphen inserted per variant.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function hyphenationVariants(sld, tld) {
  const out = [];
  for (let i = 1; i < sld.length; i++) {
    out.push(`${sld.slice(0, i)}-${sld.slice(i)}.${tld}`);
  }
  return out;
}

/**
 * Substitutions: each character replaced by its QWERTY neighbors.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function substitutionVariants(sld, tld) {
  const out = [];
  for (let i = 0; i < sld.length; i++) {
    for (const n of QWERTY_NEIGHBORS[sld[i]] || "") {
      out.push(`${sld.slice(0, i)}${n}${sld.slice(i + 1)}.${tld}`);
    }
  }
  return out;
}

/**
 * Additions: each lowercase letter inserted at each position.
 * @param {string} sld - Second-level domain
 * @param {string} tld - TLD appended unchanged
 * @returns {Array<string>} Candidate domains
 */
export function additionVariants(sld, tld) {
  const out = [];
  for (let i = 0; i <= sld.length; i++) {
    for (const c of "abcdefghijklmnopqrstuvwxyz") {
      out.push(`${sld.slice(0, i)}${c}${sld.slice(i)}.${tld}`);
    }
  }
  return out;
}

/**
 * Round-robins across the class lists in order, deduping and excluding the
 * original, until the cap is reached or every class is exhausted. Guarantees
 * each non-empty class lands entries in the output.
 * @param {Array<Array<string>>} classLists - Per-class candidates, priority order
 * @param {number} cap - Maximum variants to return
 * @param {string} exclude - The original domain, never emitted
 * @returns {Array<string>} Interleaved, deduped candidates
 */
function interleaveClasses(classLists, cap, exclude) {
  const out = [];
  const seen = new Set([exclude]);
  const indices = classLists.map(() => 0);
  let exhausted = 0;
  while (out.length < cap && exhausted < classLists.length) {
    exhausted = 0;
    for (let c = 0; c < classLists.length && out.length < cap; c++) {
      const list = classLists[c];
      let i = indices[c];
      while (i < list.length && seen.has(list[i])) i++;
      indices[c] = i;
      if (i >= list.length) {
        exhausted++;
        continue;
      }
      seen.add(list[i]);
      out.push(list[i]);
      indices[c] = i + 1;
    }
  }
  return out;
}

/**
 * Generate typosquat variants of a domain, balanced across transform classes.
 * @param {string} domain - "example.com"
 * @returns {Array<string>} candidate domains (lowercased, deduped, original excluded)
 */
export function generateVariants(domain) {
  const original = (domain || "").toLowerCase().trim();
  if (!original.includes(".")) return [];
  const lastDot = original.lastIndexOf(".");
  const sld = original.slice(0, lastDot);
  const tld = original.slice(lastDot + 1);
  if (!sld || !tld) return [];

  const classLists = [
    tldSwapVariants(sld, tld),
    homoglyphVariants(sld, tld),
    transpositionVariants(sld, tld),
    omissionVariants(sld, tld),
    vowelSwapVariants(sld, tld),
    hyphenationVariants(sld, tld),
    substitutionVariants(sld, tld),
    additionVariants(sld, tld),
  ];
  return interleaveClasses(classLists, MAX_VARIANTS, original);
}
