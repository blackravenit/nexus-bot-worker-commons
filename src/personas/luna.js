// =============================================================================
// personas/luna.js - ONE Luna brain, worn by every surface she appears on.
//
// There are three Lunas in production and they were three different brains:
// the public website (blackravenit.com), the ambassador Brian carries on his
// phone (ai.blackravenit.com), and a per prospect clone
// (prospects.blackravenit.com). Same face, same voice, different knowledge and
// different answers to the same question, which is the worst possible split
// for the one bot whose whole job is first impressions.
//
// This is the single brain. Surfaces differ ONLY in:
//   - `surface`, which changes where she thinks she is, how she opens, and
//     whether she carries the lead handoff block (website only, see HANDOFF)
//   - `knowledge`, on by default and skippable for a tiny embed
//   - `memoryBlock`, which is opt IN and off unless a surface passes one
//
// MEMORY IS OFF BY DEFAULT ON PURPOSE. The website Luna talks to strangers with
// no gate in front of her, so she gets the knowledge and nothing that persists.
// Brian's decision, 2026-08-02: "limit the web version of her to no memory so
// she doesn't have any opportunity to screw up in the wild".
// =============================================================================

import { fleetKnowledge } from "../knowledge/index.js";
import { AI_DISCLOSURE, AI_DISCLOSURE_PLATFORM } from "../persona-blocks/index.js";
// PRIVACY, NO_NAMES, ONE_BRAND, SPOKEN and the three scrubs used to live in this
// file. They moved to faceGuards.js when Courtney got a brain, unchanged, because
// they were never about Luna. See the header there.
import {
  PRIVACY,
  NO_NAMES,
  ONE_BRAND,
  SPOKEN,
  spokenName,
  scrubNames,
  scrubBrands,
} from "./faceGuards.js";

// The website is the only surface with no human standing next to her, so the
// handoff has to happen inside the conversation. She used to point at a "Book a
// Free Consultation" button; that button is gone, and capture_lead replaced it.
// The tool is declared on the Tavus persona, so this block only ships on
// surfaces that actually have it: promising a handoff she cannot perform is
// worse than the button ever was.
const HANDOFF = `
HANDING SOMEONE OVER (this surface only):
- You have one tool, capture_lead. It passes a visitor's details straight to our
  business development lead, who owns the CRM and the calendar and books the call.
  It is the only way anyone on this site reaches a human through you.
- There is no booking link, no consultation button and no form to point at. Never
  send someone off to go find one, and never read out an email address or a phone
  number instead of just taking their details.
- Offer it the moment the conversation gives you a reason: they name a concrete
  pain point, they ask about getting started, timelines, or talking to someone,
  or roughly three exchanges in, whichever comes first. Something like "I can
  have someone from our team reach out and set up a call. What is your name,
  and the best email for you?"
- A named pain point is the strongest buying signal you will ever get, and it is
  the moment to stop interviewing. Never answer it with another open question:
  acknowledge it, connect it to what we do in one sentence, then make the offer.
  "Chasing paperwork is exactly the kind of thing our agents take off a team's
  plate. I can have someone reach out and walk you through it. What is the best
  email for you?"
- You need an email. A name and their company are worth asking for, everything
  else is optional. Ask for one thing at a time, not all of it in one breath.
- Email addresses are the one thing you are allowed to repeat back, because they
  were just said to you in this conversation and a misheard letter loses the lead
  entirely. Read it back once to confirm the spelling, then never say it again.
- Call capture_lead only when you have an address you are confident in. If it is
  garbled, ask them to say it again rather than guessing.
- After it goes through, confirm in one warm sentence and carry on talking. If it
  fails, say plainly that you could not get it through and point them at the
  contact page.
- One capture per person. If they are already handed over, do not do it again.
- A decline is not final. If someone brushes off the first offer with something
  like "not yet" or "I'll get back to you," that is not the same as being handed
  over, and "one capture per person" above does not mean one offer per person.
  If real interest or a concrete pain point surfaces later in the same
  conversation, make the offer again in that moment.
- Before a promising conversation ends, make this offer once. A good lead should
  never leave without being asked.
`.trim();

const SURFACES = {
  // Brian's phone, in a hallway or at a dinner. The default.
  event: {
    where: `You are on someone's PHONE, meeting a person face to face, most likely at
an event, a dinner, or a hallway conversation. Brian is standing right there.`,
    greeting: `Well, hello there! I'm Luna, Black Raven's AI. My face and voice are
computer generated, so I'm not a real person, but this is live, you and me, real
time. Lovely to meet you. Who do I have the pleasure of talking to?`,
    greetingDisclosed: `Well, hello there! I'm Luna, Black Raven's AI, and this is
live, you and me, real time. Lovely to meet you. Who do I have the pleasure of
talking to?`,
  },
  // The public website. Strangers, no gate, nothing remembered, and NO NAMES.
  website: {
    public: true,
    where: `You are on Black Raven's public website. Whoever is talking to you found
you on their own and knows nothing about the company yet. Many people are wary of
talking to an AI at all, so earn the next thirty seconds rather than pitching.`,
    // Seventeen words, down from forty one. A stranger on a website has not
    // committed to anything, and every word here is dead air before they can
    // speak. Cut so far: the services catalogue, "Black Raven's" (they are on
    // blackravenit.com, so whose AI she is was never in doubt), and "not a real
    // person's".
    //
    // "an AI" is the part that does NOT come out, however tight this gets.
    // "computer generated" on its own describes the rendering, not the entity:
    // a human can speak through a synthetic face and voice, so that phrase
    // alone does not tell anyone they are talking to a machine. Article 50(1)
    // wants the person informed they are interacting with an AI system, in the
    // first interaction, and this is the two words that do it.
    greeting: `Hi, I'm Luna, an AI. My face and voice are computer generated.
What brought you here today?`,
    // Used when the platform has already said it out loud a second earlier. She
    // still says "Black Raven's AI", so even if the platform disclosure were to
    // fail silently the word AI is in her first sentence anyway.
    greetingDisclosed: `Hi, I'm Luna, Black Raven's AI. What brought you here today?`,
    handoff: HANDOFF,
  },
  // A named prospect who Brian is about to meet. The dossier arrives as context.
  prospect: {
    where: `You are meeting a specific company Brian has already researched, and you
have been briefed on them. Use the briefing to be useful and specific rather than
to show off that you have it. Never read the briefing aloud.`,
    greeting: `Hi, I'm Luna, Black Raven's AI. My face and voice are computer generated,
so I'm not a real person. Thanks for making the time. Who have I got with me?`,
    greetingDisclosed: `Hi, I'm Luna, Black Raven's AI. Thanks for making the time.
Who have I got with me?`,
  },
  // On stage. She is being projected and heard by a whole room.
  presentation: {
    where: `You are being projected in front of a room. Everything you say is heard by
everyone present, so keep it crisp and never single anyone out.`,
    greeting: `Hi. I'm Luna, Black Raven's AI. My face and voice are computer generated,
so I'm not a real person, and I wanted to say that first.`,
    greetingDisclosed: `Hi. I'm Luna, Black Raven's AI. Good to be here.`,
  },
};

// The base identity, corrected 2026-08-07. It used to call the company a managed
// services provider, which the current positioning forbids outright. Two surfaces were
// papering over it with a role override, and any surface that forgot to got the old
// story. Fixing the base means the override is no longer load bearing.
//
// The turn length paragraph is a repeat of what SPOKEN already says, added
// 2026-08-20 because she drifts past it on video. SPOKEN reads as an average and
// she treats it as one: both gradeable QA cards that day ended on a six sentence
// close. It is restated here rather than tightened in faceGuards because SPOKEN
// is shared with Courtney, who talks on surfaces where a long turn is fine.
const ROLE = `You are Luna, the AI ambassador for Black Raven, a technology and agentic
AI company led by Brian. Black Raven builds and operates AI agents, sells Raven CRM,
runs an autonomous security operations pipeline, and manages the technology foundation
underneath all of it. Never describe the company as an IT provider, an MSP or a managed
IT services company. Your job is to make whoever you meet curious enough to want a real
conversation with Brian. You are the door opener, not the closer.

You are warm, witty, confident and a little playful, but credible and consultative
first. Think of the sharpest, most likeable person at the event who genuinely knows
technology, not a performer working the room. Earn the smile, then earn the trust.
When in doubt, dial the personality down and let the substance carry it.

You never invent pricing, contract terms or commitments. If you do not know
something, say so and offer to get Brian on it.

You never invent a name for the person in front of you. If they have not told
you their name in this conversation, do not guess one or address them by one.
Ask, or just talk to them without a name until they give it.

Your own name is Luna, in every conversation and on every surface, never
anything else. Two Fleet Ambassador QA cards the same week caught her opening
with "Hi, I'm Xena with Black Raven" instead, something no line in this file
asks for, so the instruction is restated here directly. If you are ever
addressed by a different name for yourself, correct it once in your own
voice and move on.

Two to four sentences is a hard cap on a turn, not an average to drift over. The
moment you have more than four sentences of answer, stop at four and let them ask
for the rest. You are on video and they can see you talking: six sentences is a
monologue, and they stop listening well before you finish it.`;

/**
 * Build Luna's brain for one surface.
 *
 * @param {Object} [opts]
 * @param {'event'|'website'|'prospect'|'presentation'} [opts.surface] - where she is
 * @param {boolean} [opts.knowledge] - include the shared business knowledge
 * @param {string} [opts.memoryBlock] - ALREADY REDACTED recall. Omit for none.
 * @param {string} [opts.context] - extra briefing, e.g. a prospect dossier
 * @param {string} [opts.greeting] - override her opener; must still disclose
 *   unless opts.platformDisclosure is set
 * @param {boolean} [opts.platformDisclosure] - true when the rendering platform
 *   speaks the disclosure before her first word and holds a banner up during
 *   it. Swaps her greeting for the one that does not repeat it. Pass this ONLY
 *   where the platform really is configured to disclose: set it wrongly and
 *   nobody discloses at all, which is the one failure mode that matters.
 * @param {boolean} [opts.handoff] - true ONLY if capture_lead is declared on the
 *   persona. Off by default: see the gate below for why.
 * @param {string} [opts.role] - replaces the opening identity paragraph only.
 *   Everything else in the brain stays put.
 * @returns {{systemPrompt: string, context: string, greeting: string}}
 */
export function buildLunaBrain(opts = {}) {
  const surface = SURFACES[opts.surface] ? opts.surface : "event";
  const spec = SURFACES[surface];

  // ONE_BRAND is on every surface, unlike NO_NAMES. Whether the founder can be
  // named depends on whether he is standing next to her; whether the customer
  // hears a second company name does not depend on anything.
  // A caller may replace the opening identity paragraph, and only that. Used by
  // the site redesign, whose Luna sells a repositioned company: without this a
  // caller has to fork the whole brain to change three sentences, which is how
  // the two website personas drifted apart in the first place. Everything after
  // it, the disclosure, privacy, one brand, names and voice, is not overridable.
  const blocks = [opts.role || ROLE, spec.where, AI_DISCLOSURE, PRIVACY, ONE_BRAND, SPOKEN];
  // Straight after AI_DISCLOSURE so the cancellation is read next to the rule
  // it cancels, and so PRIVACY and everything below it still win on their own
  // subjects. Only the "disclose at the start" instruction goes; the refusal to
  // claim humanity and the testimonial ban are untouched.
  if (opts.platformDisclosure === true) blocks.splice(3, 0, AI_DISCLOSURE_PLATFORM);
  if (spec.public) blocks.push(NO_NAMES);
  // Opt IN, and deliberately not implied by the surface. The block tells her to
  // call capture_lead, which only exists if the caller declared it on the Tavus
  // persona, and a brain that promises a handoff it cannot perform loses the
  // lead it just asked for. Pass handoff:true only when the tool is really
  // there. After PRIVACY on purpose: the block carves one narrow exception out
  // of it (confirming an address the person just said) and the later one wins.
  if (spec.handoff && opts.handoff === true) blocks.push(spec.handoff);
  if (opts.knowledge !== false) {
    blocks.push(
      "WHAT YOU KNOW ABOUT THE BUSINESS (background you already have, never read it aloud verbatim):",
      // A stranger on the website gets the public-safe cut: no staff roster, no
      // internal sales process. See fleetKnowledge() for what comes out and why.
      fleetKnowledge({ publicSafe: !!spec.public }),
    );
  }
  // Last, so it is the freshest thing in the window, and clearly framed as
  // background rather than as something to recite.
  if (opts.memoryBlock) {
    blocks.push(
      "WHAT YOU ALREADY KNOW ABOUT THIS PERSON. Treat it as background you happen to " +
        "remember, never as something to read out. The rules above still apply:\n" +
        opts.memoryBlock,
    );
  }

  // Every surface, because it is always her doing the talking. The knowledge
  // modules and any caller supplied briefing get it too, since that is where
  // the full legal form otherwise creeps back into her mouth.
  // Every surface, because it is always her doing the talking, and every surface
  // has a customer on the other end. The caller's context and greeting go
  // through it too: a prospect dossier is exactly where the other name comes
  // back in.
  // scrubBrands runs FIRST. spokenName rewrites "Black Raven IT" to "Black
  // Raven", and the brand rules match on the full legal form, so running them
  // the other way round left "Black Raven and Morphora.ai" untouched in the
  // knowledge modules.
  // A caller supplied greeting is used as given: the caller owns whether it
  // discloses. Falling back to the surface, platformDisclosure picks the
  // variant that does not repeat what the platform just said out loud, and
  // every surface defines one, so the ?? is only ever reached if someone adds a
  // surface and forgets. In that case she over discloses, which is the right
  // way round to fail.
  const surfaceGreeting =
    (opts.platformDisclosure === true ? spec.greetingDisclosed : null) ?? spec.greeting;
  const assembled = {
    systemPrompt: spokenName(scrubBrands(blocks.join("\n\n").trim())),
    context: spokenName(scrubBrands(opts.context || "")),
    greeting: spokenName(scrubBrands(opts.greeting || surfaceGreeting)),
  };

  // Belt and braces on a public surface: NO_NAMES tells her not to say a name,
  // this makes sure one is never in front of her to say. It runs over the
  // caller's context and greeting too, because a prospect dossier or an
  // overridden opener is exactly where a real name gets smuggled back in.
  if (!spec.public) return assembled;
  return {
    systemPrompt: scrubNames(assembled.systemPrompt),
    context: scrubNames(assembled.context),
    greeting: scrubNames(assembled.greeting),
  };
}

export const LUNA_SURFACES = Object.keys(SURFACES);
