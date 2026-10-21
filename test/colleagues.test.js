// Unit tests for src/lib/colleagues.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLLEAGUES,
  findInterestedColleagues,
  buildColleagueMentionRules,
} from "../src/lib/colleagues.js";

test("a post about a 4Runner pulls in William", () => {
  const [hit] = findInterestedColleagues("Put a new set of all terrains on the 4Runner");
  assert.equal(hit?.handle, "william");
});

test("ranks by how many of a person's terms the post hits", () => {
  // Both Ryan and Joseph list metra; only Joseph lists thunderstorm.
  const [hit] = findInterestedColleagues("Metra halted every train in the thunderstorm");
  assert.equal(hit?.handle, "joseph");
});

test("an unrelated post matches nobody", () => {
  assert.deepEqual(findInterestedColleagues("Made a decent carbonara last night"), []);
  assert.deepEqual(findInterestedColleagues(""), []);
});

test("a short term does not fire inside a longer word", () => {
  // "nfa" is a William term; "nfarious" must not trip it.
  assert.deepEqual(findInterestedColleagues("Something nfarious happened"), []);
});

test("matched rules name exactly one handle and forbid the rest", () => {
  const rules = buildColleagueMentionRules("Thinking about a suppressor for the range");
  assert.match(rules, /@william/);
  assert.match(rules, /MENTIONING COWORKERS/);
  // The guard against inventing detail about a real person must survive any
  // future reword of this block; it is the whole reason the matching is in code.
  assert.match(rules, /Do NOT name or @ anybody except/);
  assert.equal(rules.includes("@edgar"), false);
});

test("unmatched rules explicitly forbid naming anyone", () => {
  const rules = buildColleagueMentionRules("Formula 1 qualifying was wild");
  assert.match(rules, /do NOT mention or name anyone/);
  assert.equal(/@[a-z]/.test(rules), false);
});

test("every roster entry is complete and lower-case matchable", () => {
  assert.ok(COLLEAGUES.length > 0);
  for (const person of COLLEAGUES) {
    assert.ok(person.handle && person.handle === person.handle.toLowerCase(), `handle: ${person.handle}`);
    assert.ok(person.name, `name for ${person.handle}`);
    assert.ok(person.interests, `interests for ${person.handle}`);
    assert.ok(Array.isArray(person.match) && person.match.length > 0, `match for ${person.handle}`);
    for (const term of person.match) {
      assert.equal(term, term.toLowerCase(), `term not lower-case: ${term}`);
    }
  }
});

test("no dash punctuation in the generated prompt", () => {
  for (const text of ["new tires for the 4Runner", "carbonara"]) {
    const rules = buildColleagueMentionRules(text);
    assert.equal(/[\u2013\u2014]|--/.test(rules), false);
  }
});
