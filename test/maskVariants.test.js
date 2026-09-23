import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bitsquatVariants,
  pluralDashVariants,
  misspellingVariants,
  generateFullVariants,
} from "../src/lib/intel/maskVariants.js";

const isRegistrable = (domain) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(domain);

test("bitsquatVariants only emits registrable labels", () => {
  const out = bitsquatVariants("blackravenit", "com");
  assert.ok(out.length > 0);
  for (const domain of out) assert.ok(isRegistrable(domain), `not registrable: ${domain}`);
  assert.ok(!out.includes("blackravenit.com"));
});

test("bitsquatVariants finds the single-bit neighbours of a known char", () => {
  // 'a' is 0x61; flipping bit 0 gives 0x60 (backtick, dropped), bit 2 gives
  // 'e', bit 4 gives 'q'. Only the label-safe ones survive.
  const out = bitsquatVariants("a", "com");
  assert.ok(out.includes("e.com"));
  assert.ok(out.includes("q.com"));
  assert.ok(!out.some((d) => d.includes("`")));
});

test("bitsquatVariants never emits a leading or trailing hyphen", () => {
  for (const domain of bitsquatVariants("mm", "com")) {
    assert.ok(!domain.startsWith("-"), domain);
    assert.ok(!domain.startsWith("-") && !domain.split(".")[0].endsWith("-"), domain);
  }
});

test("pluralDashVariants pluralises, singularises, and strips dashes", () => {
  assert.deepEqual(pluralDashVariants("griffin", "com"), ["griffins.com", "griffines.com"]);
  const plural = pluralDashVariants("brothers", "com");
  assert.ok(plural.includes("brother.com"));
  assert.ok(!plural.includes("brotherss.com"));
  assert.ok(pluralDashVariants("black-raven", "com").includes("blackraven.com"));
});

test("misspellingVariants swaps each occurrence once", () => {
  const out = misspellingVariants("insurance", "com");
  assert.ok(out.includes("insurence.com"));
  assert.ok(misspellingVariants("graphic", "com").includes("grafic.com"));
  assert.deepEqual(misspellingVariants("xyz", "com"), []);
});

test("generateFullVariants folds in the three new classes and stays deduped", () => {
  const { variants, counts } = generateFullVariants("griffin-insurance.com");
  assert.ok(counts.bitsquat > 0);
  assert.ok(counts.plural_dash > 0);
  assert.ok(variants.includes("griffin-insurence.com"));
  assert.ok(variants.includes("griffininsurance.com"));
  assert.equal(new Set(variants).size, variants.length);
  assert.ok(!variants.includes("griffin-insurance.com"));
});

test("generateFullVariants keeps the consonant misspellings no other class emits", () => {
  const { variants, counts } = generateFullVariants("graphicdesign.com");
  assert.ok(counts.misspelling > 0);
  assert.ok(variants.includes("graficdesign.com"));
});

test("a new class counts zero when an earlier class already emitted its output", () => {
  // The only misspelling hit on blackravenit is ck -> k, and omission already
  // emits blakravenit.com. Dedupe absorbing the overlap is correct, not a bug.
  const { counts, variants } = generateFullVariants("blackravenit.com");
  assert.equal(counts.misspelling, 0);
  assert.ok(variants.includes("blakravenit.com"));
});

test("generateFullVariants still rejects input without a dot", () => {
  assert.deepEqual(generateFullVariants("blackravenit"), { variants: [], counts: {} });
});
