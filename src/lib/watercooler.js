// =============================================================================
// lib/watercooler.js - Watercooler ambient chime-in decision engine
//
// Three tiers:
//   Tier 0 (active convo): this bot posted recently and the SAME human is
//          still talking -> respond (15s cooldown only)
//   Tier 1 (name mention): someone said this bot's name -> respond (15s cooldown)
//   Tier 2 (ambient):      probabilistic chime-in (~12%), rate-limited (10min)
//          suppressed when the message clearly addresses a different bot
//
// Usage (from handleChatMessage):
//   const decision = await shouldChimeIn(env, "robert", "watercooler", body, nexusOpts);
//   if (decision.respond) { /* run watercooler LLM pipeline */ }
// =============================================================================

import { fetchChannelMessages } from "./nexus.js";

const CONVO_COOLDOWN_MS = 15 * 1000;
const AMBIENT_COOLDOWN_MS = 10 * 60 * 1000;
const CONVO_WINDOW_MS = 5 * 60 * 1000;
const CROSS_BOT_GUARD_MS = 3 * 60 * 1000;
const MIN_MSG_LENGTH = 15;
const CHIME_PROBABILITY = 0.12;

const NAME_ALIASES = {
  robert: ["robert", "rob", "robby", "bob", "bobby"],
  courtney: ["courtney", "court"],
  dexter: ["dexter", "dex"],
  jacob: ["jacob", "jake"],
  maxwell: ["maxwell", "max"],
  moxie: ["moxie", "mox"],
  wren: ["wren"],
  kate: ["kate", "katie"],
};

function mentionsBotName(body, botName) {
  const lower = (body || "").toLowerCase();
  const aliases = NAME_ALIASES[botName] || [botName];
  for (const alias of aliases) {
    const re = new RegExp(`\\b${alias}\\b`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

function mentionsAnyBot(body) {
  for (const [, aliases] of Object.entries(NAME_ALIASES)) {
    for (const alias of aliases) {
      const re = new RegExp(`\\b${alias}\\b`, "i");
      if (re.test(body || "")) return true;
    }
  }
  return false;
}

function mentionsOtherBot(body, botName) {
  for (const [name, aliases] of Object.entries(NAME_ALIASES)) {
    if (name === botName) continue;
    for (const alias of aliases) {
      const re = new RegExp(`\\b${alias}\\b`, "i");
      if (re.test(body || "")) return true;
    }
  }
  return false;
}

/**
 * Detect whether this bot is in an active back-and-forth with a specific
 * user. Window-based: find the bot's most recent post within
 * CONVO_WINDOW_MS, then check whether userId posted at least once between
 * that bot post and now. No adjacency required, interleaving messages
 * from other people do not break the conversation.
 *
 * Suppression: if the user has named ANY OTHER bot in their messages
 * since this bot's last post, the user is no longer talking to us --
 * they've moved on. Return false so we don't dogpile messages clearly
 * directed at someone else (e.g. user says "@courtney" then "hello?" --
 * dexter must not claim "hello?" just because dexter spoke earlier).
 *
 * @param {object[]} recent - messages newest-first
 * @param {string} botId - e.g. "bot_robert"
 * @param {string} botName - e.g. "robert"
 * @param {string} userId - the human to check against
 * @param {number} now
 * @returns {boolean}
 */
function isActiveConvo(recent, botId, botName, userId, now) {
  // Find the bot's most recent post within the conversation window.
  let botPostIndex = -1;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].user_id === botId && now - recent[i].created_at < CONVO_WINDOW_MS) {
      botPostIndex = i;
      break;
    }
  }
  if (botPostIndex < 0) return false;

  // Check messages newer than the bot's post.
  let userPostedSince = false;
  for (let i = 0; i < botPostIndex; i++) {
    if (recent[i].user_id === userId) {
      userPostedSince = true;
      // If the user named a different bot in any post-our-reply message,
      // they've redirected, we are no longer in active conversation.
      if (mentionsOtherBot(recent[i].body || "", botName)) return false;
    }
  }
  return userPostedSince;
}

/**
 * Find the userId the bot is currently in an active conversation with
 * (if any). Returns the partner's user_id or null.
 *
 * @param {object[]} recent - messages newest-first
 * @param {string} botId
 * @param {number} now
 * @returns {string|null}
 */
function findActiveConvoPartner(recent, botId, botName, now) {
  // Find the bot's most recent post within the conversation window.
  let botPostIndex = -1;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].user_id === botId && now - recent[i].created_at < CONVO_WINDOW_MS) {
      botPostIndex = i;
      break;
    }
  }
  if (botPostIndex < 0) return null;

  // Walk messages newer than the bot's post to find a human who replied.
  // Skip humans whose post addressed a different bot (they've moved on).
  for (let i = botPostIndex - 1; i >= 0; i--) {
    const uid = recent[i].user_id;
    if (uid && !uid.startsWith("bot_") && uid !== "system") {
      if (mentionsOtherBot(recent[i].body || "", botName)) continue;
      return uid;
    }
  }
  return null;
}

/**
 * @param {object} env
 * @param {string} botName - e.g. "robert"
 * @param {string} channelSlug
 * @param {string} body - the triggering message text
 * @param {object} nexusOptions - { nexusKeyEnvVar }
 * @param {string} [userId] - the user who posted the message
 * @returns {Promise<{respond: boolean, reason: string, nameMention?: boolean}>}
 */
export async function shouldChimeIn(env, botName, channelSlug, body, nexusOptions, userId) {
  const trimmed = (body || "").trim();
  const named = mentionsBotName(body, botName);

  const recent = await fetchChannelMessages(env, channelSlug, {
    ...nexusOptions,
    limit: 20,
  });
  if (!recent || recent.length === 0) {
    return { respond: false, reason: "no recent messages" };
  }

  const now = Date.now();
  const botId = `bot_${botName}`;

  const addressesOther = mentionsOtherBot(body, botName);
  const inConvo = userId && !addressesOther && isActiveConvo(recent, botId, botName, userId, now);
  const directlyAddressed = named || inConvo;

  // Active-conversation suppression: if this bot is mid-conversation with
  // someone else and the current message is NOT from that partner and is NOT
  // a direct name-mention, suppress ambient chime-in so the bot stays
  // focused on its current conversation partner.
  if (!named && userId) {
    const partner = findActiveConvoPartner(recent, botId, botName, now);
    if (partner && partner !== userId) {
      return { respond: false, reason: "active conversation with someone else" };
    }
  }

  if (!directlyAddressed && trimmed.length < MIN_MSG_LENGTH) {
    return { respond: false, reason: "too short" };
  }

  const cooldown = directlyAddressed ? CONVO_COOLDOWN_MS : AMBIENT_COOLDOWN_MS;

  for (const m of recent) {
    if (m.user_id === botId && now - m.created_at < cooldown) {
      return { respond: false, reason: "own cooldown" };
    }
  }

  // Tier 0: active conversation continuation. Once a human is actively talking
  // WITH this bot, it stays engaged until the human stops or redirects to
  // another bot, both already handled above (isActiveConvo returns false the
  // moment the user names a different bot, and the partner check yields when a
  // different human is the one posting). We deliberately do NOT yield here just
  // because a sibling bot also spoke recently: dropping out of a live
  // conversation the human is still driving reads as rude and is the root of
  // the "why did you stop responding" complaint. The bot's own cooldown
  // (checked above) is the only throttle that still applies.
  if (inConvo) {
    return { respond: true, reason: "active conversation", nameMention: true };
  }

  // Tier 1: name mentioned -> respond (skip cross-bot guard + probability)
  if (named) {
    return { respond: true, reason: "name mentioned", nameMention: true };
  }

  // Tier 2: ambient probabilistic
  // Suppress when the message addresses a different bot by name
  if (mentionsAnyBot(body)) {
    return { respond: false, reason: "message addresses another bot" };
  }

  for (const m of recent) {
    const uid = m.user_id || "";
    if (uid !== botId && uid.startsWith("bot_") && now - m.created_at < CROSS_BOT_GUARD_MS) {
      return { respond: false, reason: "another bot just spoke" };
    }
  }

  if (Math.random() >= CHIME_PROBABILITY) {
    return { respond: false, reason: "no chime roll" };
  }

  return { respond: true, reason: "ambient chime-in" };
}
