// Pronunciation overrides for anything that speaks aloud.
//
// Each rule here exists because a bot said something wrong out loud on a real
// call. They are cheap to break and expensive to notice, since a wrong reading
// is invisible in code review and only audible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVoicePronunciation } from "../src/lib/ttsPronunciation.js";

test("IT is spelled out so it is not read as the pronoun", () => {
  assert.equal(applyVoicePronunciation("Black Raven IT"), "Black Raven I.T.");
});

test("IT inside ordinary words is left alone", () => {
  const input = "It's got items in ITS queue";
  assert.equal(applyVoicePronunciation(input), input);
});

test("money becomes words, with cents", () => {
  assert.equal(
    applyVoicePronunciation("$1,234.56"),
    "one thousand two hundred thirty-four dollars and fifty-six cents",
  );
});

test("shorthand amounts expand", () => {
  assert.equal(applyVoicePronunciation("$199K"), "one hundred ninety-nine thousand dollars");
});

test("a single dollar is singular", () => {
  assert.equal(applyVoicePronunciation("$1"), "one dollar");
});

test("channel slugs are spelled, not pronounced as words", () => {
  // "courtney-hitl" was spoken as "courtney hiddle".
  assert.equal(applyVoicePronunciation("courtney-hitl"), "courtney H I T L");
  assert.equal(applyVoicePronunciation("jacob-qa"), "jacob Q A");
});

test("email addresses are readable aloud", () => {
  assert.equal(
    applyVoicePronunciation("owner@blackravenit.com"),
    "owner at blackravenit dot com",
  );
});

test("the domain rule does not fire inside an email address", () => {
  const out = applyVoicePronunciation("mail owner@blackravenit.com now");
  assert.ok(!out.includes("Black Raven I.T. dot com"), out);
});

test("the bare domain in prose becomes the brand", () => {
  assert.equal(applyVoicePronunciation("see blackravenit.com"), "see Black Raven I.T. dot com");
});

// Pins the real contract rather than the one the docstring used to claim.
// A second pass re-expands the domain inside an already spoken email address,
// so this must be applied exactly once, at the speak() boundary.
test("a second application would mangle an expanded email, so callers apply once", () => {
  const once = applyVoicePronunciation("Bill owner@blackravenit.com");
  assert.equal(once, "Bill owner at blackravenit dot com");
  assert.equal(
    applyVoicePronunciation(once),
    "Bill owner at Black Raven I.T. dot com",
    "if this ever becomes idempotent, relax the apply-once rule in the docstring",
  );
});

test("non-strings pass through untouched", () => {
  assert.equal(applyVoicePronunciation(null), null);
  assert.equal(applyVoicePronunciation(""), "");
});
