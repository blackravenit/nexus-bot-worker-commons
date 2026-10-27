// Print one surface of Luna's brain, exactly as a Worker would assemble it.
//
//   node --import ./testing/register-md.mjs scripts/print-luna-brain.mjs website
//   node --import ./testing/register-md.mjs scripts/print-luna-brain.mjs website --json
//
// This replaces a hand written mirror of buildLunaBrain() that parsed this
// file's source with string indexes to rebuild the prompt outside a Worker. It
// drifted, which is how the website persona ended up carrying rules the brain
// no longer had. Now that the test runner can import the knowledge markdown,
// there is no reason to mirror anything: call the real function.
//
// Refuses to print anything it does not believe in, because the output goes
// straight onto a public persona.

import { buildLunaBrain, LUNA_SURFACES } from "../src/personas/luna.js";

const args = process.argv.slice(2);
const surface = args.find((a) => !a.startsWith("--")) || "website";
const asJson = args.includes("--json");

if (!LUNA_SURFACES.includes(surface)) {
  console.error(`Unknown surface "${surface}". One of: ${LUNA_SURFACES.join(", ")}`);
  process.exit(1);
}

// The website is the only surface with a lead handoff tool declared on it.
const brain = buildLunaBrain({ surface, handoff: surface === "website" });

/** Anything that must never reach a customer facing persona. */
const REFUSALS = [
  [/morphora/i, "another company is named"],
  [/\bYelm\b/i, "the founder's surname is present"],
  [/[\u2014\u2013\u2015]/, "em or en dash punctuation"],
];

const whole = [brain.systemPrompt, brain.context, brain.greeting].join("\n");
for (const [pattern, why] of REFUSALS) {
  // The founder's first name is allowed off the public surfaces: at an event he
  // is standing next to her, and refusing to say his name there is bizarre.
  if (pattern.source === "\\bYelm\\b" && surface !== "website") continue;
  if (pattern.test(whole)) {
    console.error(`[print-luna-brain] Refusing: ${why}.`);
    process.exit(1);
  }
}

if (brain.systemPrompt.length < 2000) {
  console.error("[print-luna-brain] Refusing: the prompt came out suspiciously short.");
  process.exit(1);
}

if (asJson) {
  process.stdout.write(JSON.stringify(brain));
} else {
  process.stdout.write(brain.systemPrompt);
}
