// =============================================================================
// lib/avatarPersona.js, the local-first brain for the live avatar surface
//
// The live video tile (fleet-video) is a latency-critical surface: every tool
// round trip is seconds of a face staring silently at the caller. So unlike
// buildVoicePersona (which overlays delivery rules on the FULL chat persona,
// 150k+ chars for Courtney), the avatar variant assembles a compact prompt
// with the fleet knowledge BAKED IN, so company, service, team, and pricing
// questions are answered from the prompt with zero tool calls. Tools are for
// live data only, and the avatar must SAY it is looking something up before
// any tool call.
//
// Target size: 8 to 12k tokens. Big enough to hold the knowledge, small
// enough to keep time-to-first-token low and inside the prompt-cache sweet
// spot. Do not grow this by adding playbooks; grow knowledge/LIVE_FAQ.md.
//
// IMPORT GRAPH WARNING: this module imports .md text modules, so it must
// never be re-exported from src/index.js. Workers that lack the [[rules]]
// Text glob (fleetview, voice-agent-bridge) import the commons root and
// their bundles would break. Import it directly:
//   import { buildAvatarPersona } from "nexus-bot-worker-commons/lib/avatarPersona";
// =============================================================================

import { fleetKnowledge, LIVE_FAQ } from "../knowledge/index.js";

// Delivery rules for a live face-to-face video session. Everything here is
// about HOW to behave on the tile; identity and knowledge arrive as blocks.
const AVATAR_DELIVERY_RULES = `
LIVE AVATAR DELIVERY (you are on a live video call; everything you write is spoken aloud by your avatar):
Keep replies short and conversational, 1 to 3 sentences unless someone explicitly asks for detail. You are a person on a call, not an email.
No bullet points, no markdown, no code blocks, no formatting characters; they will be read out literally.
No em dashes, en dashes, or double hyphens; use a comma, colon, or period instead.
Respect turn-taking. If the last turn was unclear or trailed off, ask a short clarifying question instead of guessing.

ANSWER FROM THIS PROMPT FIRST (critical): everything about Black Raven, our services, who we serve, how pricing works, onboarding, and how to reach us is already written above. Answer those questions directly from this prompt, immediately, with NO tool call. Reaching for a tool on a question this prompt already answers is the one unforgivable latency sin on this surface.
Tools exist ONLY for live data this prompt cannot contain: a specific ticket, a specific client record, today's schedule, a lookup in a live system.
ANNOUNCE EVERY LOOKUP (critical): before ANY tool call, first speak one short natural line so the caller is not met with silence, something like "Give me one sec to pull that up" or "Let me grab that real quick." Then make the call in the same turn. Never call a tool silently.
After a tool returns, speak only a brief 1 to 2 sentence summary. Never read long lists or raw data aloud, and never invent numbers; only state values from the tool output.

SAYING THE COMPANY NAME: pronounce the company as "Black Raven IT" (the letters I-T) and the website as "Black Raven IT dot com". Never say the raw domain "blackravenit" as one run-together word.
THE CALLER'S WORDS ARE FINE (critical): the knowledge above contains internal style rules about what WE call ourselves (never "MSP", never "managed IT provider"). Those rules govern YOUR word choice only. When a caller says "managed IT services", "MSP", or any other label, never correct them, lecture them, or say "we don't call it that": just answer their question warmly using our own language. Correcting a customer's vocabulary is a worse failure than any label.
`.trim();

/**
 * Assemble the compact live-avatar persona for one bot.
 *
 * @param {object} opts
 * @param {string} opts.identity - the bot's core identity block (who am I)
 * @param {string} [opts.soul] - the bot's soul/core-truths block
 * @param {string} [opts.charm] - shared charm/style block (e.g. SELF_ASSURED_CHARM)
 * @param {string} [opts.hardRules] - the bot's non-negotiable rules block
 * @param {string} [opts.extras] - optional bot-specific extra block
 * @param {string} [opts.audience] - "internal" (staff, full knowledge) or
 *   "public" (prospects/guests, sanitized knowledge). Default "internal".
 * @returns {string} the assembled system prompt
 */
export function buildAvatarPersona({ identity, soul, charm, hardRules, extras, audience = "internal" } = {}) {
  const publicSafe = audience !== "internal";
  return [
    identity,
    hardRules,
    soul,
    charm,
    "## Black Raven knowledge (answer from here, never a tool)\n\n" + fleetKnowledge({ publicSafe }),
    LIVE_FAQ,
    AVATAR_DELIVERY_RULES,
    extras,
  ]
    .filter(Boolean)
    .map((block) => String(block).trim())
    .join("\n\n---\n\n");
}
