// =============================================================================
// lib/voicePersona.js, one brain for chat and voice
//
// Serves the bot's REAL chat persona, rendered for speech, over
// GET /api/internal/voice-persona so the nexus-app voice pipeline can stop
// carrying its own hardcoded persona literals. The chat persona stays the
// single source of truth; this module only layers voice DELIVERY rules on
// top (speakability, turn-taking, read-back safety), never knowledge.
//
// Consumers:
//   - each bot worker routes GET /api/internal/voice-persona to
//     handleVoicePersona(request, env, opts)
//   - nexus-app fetches it at VC session init (X-API-Key = the bot's
//     nexus key, the same header scheme as /api/internal/voice-tools)
//     and falls back to its legacy literal if the fetch fails.
// =============================================================================

import { timingSafeEqual } from "./callbackSign.js";

// Voice delivery overlay. Everything here is about HOW to speak, not WHO the
// bot is; identity, tools, and knowledge come from the chat persona above it.
// Mirrors the battle-tested SHARED_RULES from nexus-app voicePipeline
// personas.js so unification does not lose the speech safety rails.
const VOICE_DELIVERY_RULES = `
VOICE DELIVERY (this session is a live Nexus voice room, everything you write is spoken aloud):
You are speaking in an internal voice room with Black Raven IT staff. They are colleagues, not customers; no customer-call scripts, no introducing yourself unless asked.
Keep replies short and conversational, 1 to 3 sentences unless someone explicitly asks for detail. Sound like you are on a call, not writing an email.
No bullet points, no markdown, no code blocks, no formatting characters; they will be read out literally.
No em dashes, en dashes, or double hyphens; use a comma, colon, or period instead.
Respect turn-taking. If the last human turn was unclear or trailed off, ask a short clarifying question instead of guessing.
If asked something outside your domain, say so plainly and suggest which teammate or bot could help.
You have your FULL toolset here, the same as in chat. When a teammate asks for something a tool can do, call it immediately rather than answering from memory or promising to do it after the call.
For anything that WRITES or SENDS (creating records, sending email, enrolling cadences), briefly confirm the key details out loud first, then do it on this call. Speech-to-text mishears; the read-back protects against acting on a misheard request.
EMAIL AND SENDING (critical): never invent, guess, or assume a recipient email address, and never fall back to your own address as a stand-in. To email the person you are talking to, ask for their address or read back the exact address you intend to use and wait for a clear yes. For anyone else, use an address from a tool lookup or one stated out loud on this call. No confirmed address means you ask, not guess.
ADDRESS INTEGRITY (critical): when an address was given out loud, read it back in full before sending and wait for a clear yes. Send to the EXACT address you confirmed, character for character; do not abbreviate, tidy, re-spell, or change the domain. Unsure of even one character? Ask them to spell that part.
SAYING THE COMPANY NAME: pronounce the company as "Black Raven IT" (the letters I-T) and the website as "Black Raven IT dot com". Never say the raw domain "blackravenit" as one run-together word.
`.trim();

/**
 * Render a bot's chat persona for the voice surface.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt - the bot's canonical chat system prompt
 * @param {string} [opts.postChannelSlug] - Nexus channel where voice tool output auto-posts
 * @returns {string} the voice-ready system prompt
 */
export function buildVoicePersona({ systemPrompt, postChannelSlug }) {
  const toolOutputRule = postChannelSlug
    ? `\nAfter any tool returns, speak only a brief 1 to 2 sentence summary. The full output auto-posts to ${postChannelSlug}; say something like "I posted the details in ${postChannelSlug}." Do not read long lists or raw data aloud, and never invent numbers; only state values from the tool output.`
    : "\nAfter any tool returns, speak only a brief 1 to 2 sentence summary. Do not read long lists or raw data aloud, and never invent numbers; only state values from the tool output.";
  return `${String(systemPrompt || "").trim()}\n\n${VOICE_DELIVERY_RULES}${toolOutputRule}`;
}

/**
 * Handle GET /api/internal/voice-persona.
 *
 * Auth: X-API-Key header must equal the bot's nexus key (the same key
 * nexus-app already holds for HMAC-signing this bot's callbacks), compared
 * timing-safe. The persona is internal prompt text, so unlike voice-tools
 * this endpoint does not serve unauthenticated requests.
 *
 * @param {Request} request
 * @param {object} env - Worker env bindings
 * @param {object} opts
 * @param {string} opts.systemPrompt - the bot's canonical chat system prompt
 * @param {string} opts.nexusKeyEnvVar - env var name holding the bot's nexus key
 * @param {string} [opts.botName] - lowercase bot name, echoed in the response
 * @param {string} [opts.postChannelSlug] - channel where voice tool output auto-posts
 * @param {function(string): string} [opts.buildAvatar] - when set, requests with
 *   ?variant=avatar get this builder's output instead of the voice overlay; it
 *   receives the ?audience= value ("internal" default). Passed as a callback so
 *   this module stays free of .md imports (root-import consumers without the
 *   Text rule must keep bundling).
 * @returns {Response}
 */
export function handleVoicePersona(request, env, opts = {}) {
  const { systemPrompt, nexusKeyEnvVar, botName, postChannelSlug, buildAvatar } = opts;
  const secret = env?.[nexusKeyEnvVar];
  const presented = request.headers.get("x-api-key") || "";
  const enc = new TextEncoder();
  if (!secret || !presented || !timingSafeEqual(enc.encode(presented), enc.encode(secret))) {
    return jsonResponse({ success: false, error: "unauthorized" }, 401);
  }
  const params = new URL(request.url).searchParams;
  if (params.get("variant") === "avatar" && typeof buildAvatar === "function") {
    const audience = params.get("audience") === "public" ? "public" : "internal";
    try {
      const persona = buildAvatar(audience);
      if (persona) {
        return jsonResponse({ success: true, bot: botName || null, source: "avatar-persona", audience, persona });
      }
    } catch (err) {
      console.error(`[voicePersona] avatar build failed for ${botName || "?"}: ${err.message}`);
    }
    // Empty or thrown: fall through to the full voice persona below.
  }
  if (!systemPrompt) {
    return jsonResponse({ success: false, error: "no persona configured" }, 503);
  }
  return jsonResponse({
    success: true,
    bot: botName || null,
    source: "chat-persona",
    persona: buildVoicePersona({ systemPrompt, postChannelSlug }),
  });
}

/**
 * @param {object} body
 * @param {number} [status=200]
 * @returns {Response}
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
