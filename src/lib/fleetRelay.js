// =============================================================================
// lib/fleetRelay.js, the fleet's only bot-to-bot handoff primitive.
//
// A relay is NOT one bot calling another bot's API. It is one bot posting a
// Nexus message that a second bot then acts on under ITS OWN credentials and
// ITS OWN tool set. The whole exposure in one sentence:
//
//     Wren has no CRM write access. Wren asked Jacob. A CRM record was written.
//
// That is the desired outcome for a prospect row and an unacceptable one for
// an invoice or an endpoint isolation. Four independent gates keep the second
// case impossible, each one sufficient on its own:
//
//   Gate 1  routing allowlist, who may be spoken to at all
//   Gate 1b watercooler bar, social chatter may not dispatch work
//   Gate 2  authority downgrade, what a bot-originated request may trigger
//                                     (enforced in handleChatMessage, policy here)
//   Gate 3  human origin + 1 hop, who may start one, and how far it travels
//
// Nexus enforces a fifth backstop underneath all of it: a bot-to-bot mention
// budget of 8 per channel per 10 minutes, fail-closed (message-insert.js).
//
// See docs/fleet-relay-design.md for the reasoning behind each gate.
// =============================================================================

import { postToNexus } from "./nexus.js";
import { withProvenance, getProvenanceContext } from "./provenanceContext.js";
import { BOT_HOME_CHANNELS } from "./emailBackup.js";

// -----------------------------------------------------------------------------
// Gate 1, routing allowlist
// -----------------------------------------------------------------------------

// The six bots that may both send and receive.
const OPEN_BOTS = ["wren", "courtney", "dexter", "jacob", "kate", "moxie"];

/**
 * The ONLY source of truth for legal relay edges. Not a mesh, not derived from
 * Nexus grants, not inferable by a model at runtime. 42 directed edges.
 *
 * Maxwell and Robert send to every open bot and to NOBODY else, including each
 * other. Nothing appears that relays INTO them: Maxwell is the only bot with
 * Xero write, Robert holds S1 isolate/remediate and Stellar Cyber case close.
 * Per Brian (2026-08-09), if the gate on financial data is not airtight the
 * conversation does not happen at all; the same reasoning covers Robert's
 * security writes. Excluding the maxwell/robert pair also removes the only
 * possible two-node relay loop.
 *
 * Flynn is out on both sides. He is a mentor persona in #flynn-lab, not staff.
 */
export const FLEET_RELAY_ROUTES = Object.freeze({
  maxwell: Object.freeze([...OPEN_BOTS]),
  robert: Object.freeze([...OPEN_BOTS]),
  wren: Object.freeze(OPEN_BOTS.filter((b) => b !== "wren")),
  courtney: Object.freeze(OPEN_BOTS.filter((b) => b !== "courtney")),
  dexter: Object.freeze(OPEN_BOTS.filter((b) => b !== "dexter")),
  jacob: Object.freeze(OPEN_BOTS.filter((b) => b !== "jacob")),
  kate: Object.freeze(OPEN_BOTS.filter((b) => b !== "kate")),
  moxie: Object.freeze(OPEN_BOTS.filter((b) => b !== "moxie")),
  flynn: Object.freeze([]),
});

// Bots that may never be a relay TARGET, stated separately from the route map
// so an accidental edit to a single route array cannot quietly re-open them.
// Enforced as a second, independent check inside the handler.
export const RELAY_FORBIDDEN_TARGETS = Object.freeze(["maxwell", "robert", "flynn"]);

// Gate 1b. #watercooler is personal and social: it has its own ambient pipeline
// (lib/watercooler.js plus nine per-bot crons) and is hidden from provenance in
// the UI. Relay must stay out of it in BOTH directions, never a target, and
// never an origin, or small talk becomes a work-dispatch surface.
export const RELAY_EXCLUDED_CHANNELS = Object.freeze(["watercooler"]);

// -----------------------------------------------------------------------------
// Gate 2, authority downgrade policy
// -----------------------------------------------------------------------------

/**
 * Tools reachable by a BOT-ORIGINATED request, per receiving bot. Default deny:
 * a tool absent from this list is not offered to the model and is refused by
 * the handler wrapper even if the model names it anyway.
 *
 * These are hand-maintained on purpose. Deriving them from a name heuristic
 * (isReadonlyToolName and friends) would mean a tool called `get_and_send_x`
 * silently becomes relay-reachable. A bot that gains a write tool tomorrow must
 * stay unreachable by relay until a human adds it here.
 *
 * Populated by fleetRelayPolicyFor(); keys are bot ids, values are tool names.
 */
// Read-only tools every receiving bot may use on a relayed request. Listing a
// tool a given bot does not have is harmless: enforcement is a name
// intersection against that bot's real registry.
const RELAY_BASELINE_READS = [
  "read_channel_history",
  "crm_resolve_client_code",
  "crm_list_clients",
  "crm_search",
];

export const RELAY_TOOL_POLICY = Object.freeze({
  // Jacob owns CRM write for the fleet. Prospect create/update is the ENTIRE
  // write surface. Deliberately excluded: crm_send_agreement,
  // crm_send_partner_agreement (contracts out the door), crm_convert_prospect,
  // crm_create_opportunity, crm_update_opportunity (pipeline money),
  // crm_create_partner, crm_update_partner, plus every cold-outreach, quoting,
  // hardware and email tool he owns. Another bot cannot talk Jacob into
  // sending anything to a human outside the company.
  jacob: Object.freeze([
    ...RELAY_BASELINE_READS,
    "crm_create_prospect",
    "crm_update_prospect",
    "crm_list_prospects",
    "crm_list_opportunities",
    "crm_list_partners",
    "crm_list_contracts",
    "crm_list_services",
    "crm_onboarding_status",
    "crm_dashboard",
  ]),
  // Courtney is the service desk. She may OPEN a ticket on a bot's say-so,
  // because a ticket is a request queued for a human, not an action on a
  // system. Deliberately excluded: desk_reply, desk_draft_reply (client-facing
  // comms), desk_assign, desk_set_status, desk_set_priority, desk_escalate,
  // desk_update_ticket, desk_log_time, desk_log_expense (billing), every
  // kb write, and the whole NinjaRMM surface.
  courtney: Object.freeze([
    ...RELAY_BASELINE_READS,
    "desk_create_ticket",
    "desk_find_ticket",
    "desk_get_ticket",
    "desk_search_tickets",
    "desk_list_tickets",
    "kb_search",
    "kb_get_article",
    "kb_list_articles",
  ]),
  // Reads only, no write tool of any kind. Dexter holds infrastructure write
  // (DNS, Cloudflare, secret rotation, scripts) and Kate holds client-facing
  // procurement comms. Answering a question is the whole relay surface.
  dexter: Object.freeze([
    ...RELAY_BASELINE_READS,
    "kb_get_client_profile",
    "kb_list_client_profiles",
    "kb_lookup_client_by_ip",
    "kb_list_client_networks",
  ]),
  kate: Object.freeze([...RELAY_BASELINE_READS]),
  moxie: Object.freeze([...RELAY_BASELINE_READS]),
  // Wren books, and books only. Widened from read_channel_history-only on
  // Brian's instruction (2026-08-16), after Jacob relayed a "get a call with
  // this new contact on Brian's calendar" ask and she could not act on it.
  //
  // The line is drawn at ADDING time, never at changing or answering for him:
  // deliberately excluded are calendar_update_event and calendar_cancel_event
  // (another bot may not move or kill a meeting that is already agreed),
  // calendar_respond (nothing accepts or declines an invite as Brian but
  // Brian), and every email, to-do, planner, reminder and cadence tool she
  // owns. Her mailbox stays a human-only surface.
  //
  // calendar_create_event and calendar_create_teams_meeting both run the
  // fetchUnionBusy conflict guard, and RELAY_INPUT_SCRUB below strips
  // override_conflict so a relayed request cannot punch through it: the
  // override exists for Brian's explicit say-so, and a bot does not have one.
  wren: Object.freeze([
    "read_channel_history",
    "calendar_get_today",
    "calendar_get_upcoming",
    "calendar_get_week",
    "calendar_search",
    "calendar_get_event",
    "calendar_find_free_times",
    "calendar_create_event",
    "calendar_create_teams_meeting",
  ]),
  // Flynn stays a forbidden relay TARGET for message_bot dispatch (Gate 1 and
  // RELAY_FORBIDDEN_TARGETS unchanged), but research briefs posted into
  // #flynn-lab by a bot (Hank driving fleet research, 2026-08-15, Brian's
  // instruction) still reach him as bot-originated turns, and with zero tools
  // he can only hallucinate his own searches. Web reads carry no fleet
  // authority; worst case is burned search spend, bounded by the bot-to-bot
  // mention budget. Every write and curriculum tool stays denied.
  flynn: Object.freeze([
    "read_channel_history",
    "web_search",
    "web_fetch",
  ]),
  // maxwell, robert: no entry, and no inbound edge. Unreachable by Gate 1.
});

/**
 * Input fields stripped from a bot-originated tool call, per tool.
 *
 * Kept separate from RELAY_TOOL_POLICY so the policy stays a flat list of tool
 * names that anyone can read at a glance. This is for the narrower case where a
 * tool is safe to relay but ONE of its arguments means "a human told me to
 * ignore a safety check", an argument a bot can never truthfully supply.
 *
 * The stripped field is dropped, not rejected: the call still runs, it just
 * runs with the guard on, which is the behaviour a relayed request should get.
 */
export const RELAY_INPUT_SCRUB = Object.freeze({
  calendar_create_event: Object.freeze(["override_conflict"]),
  calendar_create_teams_meeting: Object.freeze(["override_conflict"]),
  calendar_update_event: Object.freeze(["override_conflict"]),
});

/**
 * Resolve the relay tool allowlist for a receiving bot. Returns an empty array
 * for any bot with no policy entry, which means "refuse every tool" rather than
 * "allow every tool", the fail-safe direction.
 *
 * @param {string} selfBot - receiving bot id, e.g. "jacob"
 * @returns {string[]} allowed tool names for a bot-originated request
 */
export function fleetRelayPolicyFor(selfBot) {
  const key = String(selfBot || "").toLowerCase();
  return RELAY_TOOL_POLICY[key] ? [...RELAY_TOOL_POLICY[key]] : [];
}

/**
 * True when `target` is a legal relay destination for `selfBot`.
 *
 * @param {string} selfBot - sending bot id
 * @param {string} target - proposed receiving bot id
 * @returns {boolean}
 */
export function isRelayEdgeAllowed(selfBot, target) {
  const from = String(selfBot || "").toLowerCase();
  const to = String(target || "").toLowerCase();
  if (!from || !to || from === to) return false;
  if (RELAY_FORBIDDEN_TARGETS.includes(to)) return false;
  return (FLEET_RELAY_ROUTES[from] || []).includes(to);
}

/**
 * Total number of legal directed edges. Exported for the test that pins the
 * graph shape, so widening it is always a deliberate, reviewed change.
 *
 * @returns {number}
 */
export function relayEdgeCount() {
  return Object.values(FLEET_RELAY_ROUTES).reduce((n, targets) => n + targets.length, 0);
}

// -----------------------------------------------------------------------------
// The tool
// -----------------------------------------------------------------------------

const MAX_RELAY_MESSAGE_LEN = 1500;

/**
 * Build the single parameterized relay tool for one bot.
 *
 * One tool with a `target` enum, not one tool per destination: six named tools
 * per bot would put 42 tool definitions across the fleet into system prompts
 * and drift apart the first time a route changes.
 *
 * @param {object} args
 * @param {string} args.selfBot - this bot's id, e.g. "wren"
 * @param {string} args.nexusKeyEnvVar - env var holding this bot's Nexus API key
 * @returns {{tools: Array<object>, handlers: Record<string, Function>}}
 */
export function buildFleetRelayTools({ selfBot, nexusKeyEnvVar } = {}) {
  const self = String(selfBot || "").toLowerCase();
  const targets = FLEET_RELAY_ROUTES[self] || [];

  // A bot with no legal destinations gets no tool at all rather than a tool
  // that always refuses. Flynn, and any future bot added to the map as [].
  if (!self || targets.length === 0) return { tools: [], handlers: {} };

  const nexusOptions = { nexusKeyEnvVar };

  const targetLines = targets
    .map((t) => `  ${t}: ${describeBot(t)} (replies in #${BOT_HOME_CHANNELS[t]?.slug || t})`)
    .join("\n");

  const tools = [
    {
      name: "message_bot",
      description:
        "Hand a task to another bot on the fleet when it is squarely their domain and outside your own tool set. " +
        "Your message is posted in that bot's home channel addressed to them; they act on it under their own " +
        "credentials and reply there.\n\nWho you can reach:\n" +
        targetLines +
        "\n\nRules you must follow:\n" +
        "- This POSTS A REQUEST. It does not complete the work. Say \"I asked <bot> to do X, in #<channel>\" and " +
        "NEVER say it is done until you have read their reply with read_channel_history on that channel.\n" +
        "- Include every detail they need to act without a follow-up question: full names, emails, company, " +
        "record ids, and exactly what action to take. They cannot see this conversation.\n" +
        "- Maxwell (finance) and Robert (security) cannot be reached this way at all. Anything touching " +
        "invoicing, billing, endpoint isolation, or a security case is a human's call: tell the person to ask " +
        "them directly in their channel.\n" +
        "- Do not use this to ask another bot for something you can do yourself.",
      input_schema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [...targets],
            description: "Which bot to hand the task to.",
          },
          message: {
            type: "string",
            description:
              "The request. Self-contained, specific, and complete: names, emails, company names, ids, and the " +
              "exact action to take.",
          },
        },
        required: ["target", "message"],
      },
    },
  ];

  const handlers = {
    message_bot: (input, env, ctx) => relayHandler({ input, env, ctx, self, nexusOptions }),
  };

  return { tools, handlers };
}

/**
 * One-line role blurb per bot, rendered into the tool description so the model
 * routes on capability instead of guessing from the name.
 *
 * @param {string} bot
 * @returns {string}
 */
function describeBot(bot) {
  const roles = {
    wren: "Brian's executive assistant, calendar and to-dos",
    jacob: "sales, owns CRM write",
    courtney: "IT service desk and the knowledge base",
    dexter: "devops and infrastructure",
    kate: "customer success and client comms",
    moxie: "marketing and content",
    maxwell: "finance",
    robert: "security operations",
  };
  return roles[bot] || bot;
}

/**
 * Execute a relay after all four gates pass.
 *
 * @param {object} args
 * @param {object} args.input - tool input ({target, message})
 * @param {object} args.env - worker bindings
 * @param {object} args.ctx - tool context from handleChatMessage
 * @param {string} args.self - sending bot id
 * @param {object} args.nexusOptions - {nexusKeyEnvVar}
 * @returns {Promise<object>} tool result
 */
async function relayHandler({ input, env, ctx, self, nexusOptions }) {
  const target = String(input?.target || "").toLowerCase();
  const message = input?.message;

  if (!target) return { error: "target is required" };
  if (!message || typeof message !== "string") return { error: "message is required" };

  // ---- Gate 3a: hop limit 1 -------------------------------------------------
  // A bot-originated request may not itself originate a relay. Wren -> Jacob is
  // legal; Jacob -> Dexter as a downstream consequence of Wren's ask is not.
  // No chains, no telephone game, no diffusion of responsibility.
  if (ctx?.requester_is_bot) {
    return {
      sent: false,
      error:
        "Refused: this request came from another bot, and a relayed request cannot start another relay " +
        "(hop limit 1). Do the part that is yours and say plainly in your reply what still needs a human.",
    };
  }

  // ---- Gate 3b: human provenance -------------------------------------------
  // A relay may only originate inside a human turn. No cron, no poller, no
  // webhook. This is what stops the fleet talking to itself at 3am.
  const provenance = getProvenanceContext();
  const HUMAN_PROVENANCE = ["user-command", "mention-reply", "hitl-approval"];
  if (!provenance || !HUMAN_PROVENANCE.includes(provenance)) {
    return {
      sent: false,
      error:
        `Refused: relays may only be sent during a live conversation with a person (provenance ` +
        `"${provenance || "none"}"). Scheduled and automated runs cannot hand work to another bot. ` +
        `Post what you found instead and let a human decide.`,
    };
  }

  // ---- Gate 1b: watercooler is not a relay origin ---------------------------
  if (RELAY_EXCLUDED_CHANNELS.includes(String(ctx?.channel_slug || "").toLowerCase())) {
    return {
      sent: false,
      error:
        `Refused: #${ctx.channel_slug} is a social channel, not a work-dispatch surface. If this genuinely ` +
        `needs doing, say so here and let someone raise it in a working channel.`,
    };
  }

  // ---- Gate 1: routing allowlist -------------------------------------------
  if (!isRelayEdgeAllowed(self, target)) {
    const home = BOT_HOME_CHANNELS[target]?.slug;
    const named = RELAY_FORBIDDEN_TARGETS.includes(target)
      ? `${capitalize(target)} cannot be reached by another bot at all, by design.`
      : `You have no relay route to ${target}.`;
    return {
      sent: false,
      error:
        `${named} ${home ? `A person has to ask in #${home}.` : ""} Tell whoever asked that this one needs ` +
        `a human, and say why, rather than trying a different bot.`.trim(),
    };
  }

  const entry = BOT_HOME_CHANNELS[target];
  if (!entry?.slug) {
    return { sent: false, error: `No home channel registered for ${target}; cannot relay.` };
  }

  // Truncate rather than let postToNexus silently slice at 8000. A relay this
  // long is a sign the bot is pasting context instead of stating a request.
  const trimmed =
    message.length > MAX_RELAY_MESSAGE_LEN
      ? `${message.slice(0, MAX_RELAY_MESSAGE_LEN)}\n\n[truncated, ask for the rest if you need it]`
      : message;

  // Gate 3c: the requesting human is carried in the envelope and rendered in
  // the post. A relay that cannot name its human is refused above by Gate 3b;
  // this is the audit trail for why a record changed.
  const human = ctx?.display_name || ctx?.user_email || null;
  if (!human) {
    return {
      sent: false,
      error: "Refused: cannot identify the person making this request, so the relay has no audit trail.",
    };
  }
  const origin = ctx?.channel_slug ? ` in #${ctx.channel_slug}` : "";
  const body = `@${target} ${trimmed}\n\n(relayed by ${capitalize(self)} on behalf of ${human}${origin})`;

  try {
    const result = await withProvenance(provenance, () =>
      postToNexus(env, entry.slug, body, nexusOptions),
    );
    if (!result) {
      return {
        sent: false,
        error:
          `Nexus rejected the post to ${entry.slug} (no message id returned). Say plainly that the handoff did ` +
          `NOT go through and that the worker logs need checking. Do not retry more than once.`,
        channel: entry.slug,
      };
    }
    return {
      sent: true,
      target,
      channel: entry.slug,
      message: trimmed,
      // Surfaced in the result because the persona text alone was not enough:
      // Wren kept telling Brian she had no visibility into Jacob's channel
      // while holding a standing grant on it (2026-08-09).
      read_reply_with: {
        tool: "read_channel_history",
        channel_slug: entry.slug,
        note:
          `${capitalize(target)} replies in this channel. Read it before reporting the handoff as done or ` +
          `unanswered. Until you have read it, the only true statement is that you asked.`,
      },
    };
  } catch (err) {
    console.error(`[message_bot] ${self} -> ${target}:`, err.message);
    return { sent: false, error: `Failed to relay to ${target}: ${err.message}`, channel: entry.slug };
  }
}

/**
 * @param {string} s
 * @returns {string}
 */
function capitalize(s) {
  const str = String(s || "");
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}

// -----------------------------------------------------------------------------
// Gate 2 enforcement helpers, consumed by handleChatMessage
// -----------------------------------------------------------------------------

/**
 * Restrict a bot's tool set to what a bot-originated request may reach.
 *
 * Filters the tool definitions so the model never sees a forbidden tool, AND
 * wraps the handlers so a hallucinated tool name is still refused. Belt and
 * braces: the filter is the ergonomics, the wrapper is the control.
 *
 * @param {object} args
 * @param {string} args.selfBot - the receiving bot's id
 * @param {Array<object>} args.tools - full tool definitions for this turn
 * @param {Record<string, Function>} args.handlers - full handler map
 * @returns {{tools: Array<object>, handlers: Record<string, Function>, allowed: string[]}}
 */
export function applyRelayToolPolicy({ selfBot, tools = [], handlers = {} }) {
  const allowed = fleetRelayPolicyFor(selfBot);
  const allowSet = new Set(allowed);

  const filteredTools = tools.filter((t) => allowSet.has(t?.name));

  const guardedHandlers = {};
  for (const [name, fn] of Object.entries(handlers)) {
    guardedHandlers[name] = allowSet.has(name)
      ? wrapWithInputScrub(name, fn)
      : async () => ({
          error:
            `Refused: "${name}" cannot be run for a request that came from another bot. Only a person can ` +
            `authorize this. Reply saying what you can and cannot do here, and ask for a human to make the call.`,
        });
  }

  return { tools: filteredTools, handlers: guardedHandlers, allowed };
}

/**
 * Mirror a relayed turn's reply back into the SENDING bot's home channel.
 *
 * The relay is one directional: the ask is posted in the target's home channel
 * and the target's reply lands there too, because a bot's reply only ever goes
 * to the channel it was addressed in. So the humans watching the channel the
 * request came FROM see the handoff go out and never see it come back. Jacob
 * relayed a booking three times and reported silence while Wren's confirmation
 * sat in her own channel (2026-08-16).
 *
 * Deliberately NOT a tool. The model does not choose whether to close the loop,
 * where to send it, or what to say: this fires after the reply is posted, to
 * one derived channel, with the reply text it already wrote. There is nothing
 * here for a relayed request to talk its way into.
 *
 * Bot @mentions are stripped from the mirrored copy. The sending bot holds
 * can_listen = 1 on its own home channel, so an @mention would dispatch a fresh
 * bot turn and turn a courtesy note into an unbudgeted extra hop. The mirror is
 * for the people in the channel, not for the bot.
 *
 * @param {object} args
 * @param {object} args.env - worker bindings
 * @param {string} args.senderUserId - the requesting bot's Nexus id, e.g. "bot_jacob"
 * @param {string} args.selfBot - the replying bot's id
 * @param {string} args.repliedInChannel - channel the reply was already posted to
 * @param {string} args.replyText - the reply as posted
 * @param {object} args.nexusOptions - {nexusKeyEnvVar} for postToNexus
 * @returns {Promise<boolean>} true when a mirror was posted
 */
export async function mirrorRelayReply({
  env,
  senderUserId,
  selfBot,
  repliedInChannel,
  replyText,
  nexusOptions,
} = {}) {
  const sender = String(senderUserId || "").replace(/^bot_/, "").toLowerCase();
  const home = BOT_HOME_CHANNELS[sender]?.slug;
  if (!home || !replyText) return false;
  // Already posted there; the sender's channel WAS the conversation.
  if (home === String(repliedInChannel || "").toLowerCase()) return false;

  const body =
    `Reply to the handoff from ${capitalize(sender)}, from ${capitalize(selfBot)}:\n\n` +
    stripBotMentions(replyText).slice(0, MAX_RELAY_MESSAGE_LEN);

  try {
    const posted = await postToNexus(env, home, body, nexusOptions);
    if (!posted) {
      console.warn(`[fleetRelay] mirror to ${home} returned no message id`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[fleetRelay] mirror ${selfBot} -> ${home} failed:`, err.message);
    return false;
  }
}

/**
 * Defuse @mentions of fleet bots so a mirrored reply cannot dispatch a bot turn.
 *
 * @param {string} text
 * @returns {string} the text with `@bot` rendered as the plain name
 */
export function stripBotMentions(text) {
  const names = Object.keys(BOT_HOME_CHANNELS).join("|");
  return String(text).replace(new RegExp(`@(${names})\\b`, "gi"), (_m, name) => capitalize(name));
}

/**
 * Wrap one allowed handler so RELAY_INPUT_SCRUB fields never reach it.
 *
 * @param {string} name - tool name
 * @param {Function} fn - the real handler
 * @returns {Function} the handler, or a scrubbing wrapper around it
 */
function wrapWithInputScrub(name, fn) {
  const fields = RELAY_INPUT_SCRUB[name];
  if (!fields || typeof fn !== "function") return fn;
  return (input, ...rest) => {
    if (!input || typeof input !== "object") return fn(input, ...rest);
    const scrubbed = { ...input };
    let dropped = false;
    for (const field of fields) {
      if (field in scrubbed) {
        delete scrubbed[field];
        dropped = true;
      }
    }
    if (dropped) {
      console.warn(`[fleetRelay] scrubbed ${fields.join(", ")} from bot-originated ${name}`);
    }
    return fn(scrubbed, ...rest);
  };
}

/**
 * The system-prompt paragraph a bot reads when this turn came from another bot.
 *
 * Without this the downgrade is invisible: Gate 2 removes the tools before the
 * model ever sees them, so the bot experiences "I cannot do that" with no idea
 * why and invents a reason. Wren told Brian a calendar booking was impossible
 * "from this channel" (2026-08-16), which was not the rule at all. State the
 * real boundary and let the bot quote it.
 *
 * @param {string} selfBot - the receiving bot's id
 * @returns {string} prompt text, empty string when the bot has no policy entry
 */
export function relayModeSystemNote(selfBot) {
  const allowed = fleetRelayPolicyFor(selfBot);
  if (allowed.length === 0) return "";
  return (
    "\n\nRELAYED REQUEST: this turn came from another bot on the fleet, not from a person." +
    " On a relayed request you are restricted to exactly these tools: " +
    allowed.join(", ") +
    ". Everything else you normally do is unavailable for THIS turn by fleet policy, not because" +
    " of the channel it arrived in and not because you doubt who asked. The relay names the person" +
    " it is on behalf of and you may take that at face value. Do the part you can, then say plainly" +
    " what you did and what still needs a person to ask you directly. Do not guess at the reason for" +
    " the restriction, do not claim you cannot see who asked, and do not suggest trying another bot." +
    "\n\nSTALE REFUSALS: relay policy is widened from time to time, so an earlier refusal of a similar" +
    " request is NOT evidence about what you can do now. If you find one in this channel's history, in" +
    " recalled memory, or earlier in this conversation, ignore it. The tool list above is the only" +
    " current truth about your authority. Before repeating any past refusal, check that list: if the" +
    " tool you need is on it, the old refusal is wrong and you should just do the work."
  );
}
