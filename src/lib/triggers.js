// =============================================================================
// lib/triggers.js - Ambient trigger pattern matching for Nexus bot workers
//
// When a bot has ambient_listen=1 on a channel, Nexus fires a callback for
// every message (trigger_type="ambient"). This module decides whether the
// bot should actually respond to that message.
//
// Factory function:
//   makeShouldRespond(botName, aliases) -> (body, replyTo, lastMsgId) => boolean
//
// Match patterns (any one is sufficient to return true):
//   1. body contains @<alias> mention (case-insensitive, word-boundary-safe)
//   2. body contains "<botName>:" at the start or after whitespace
//   3. body starts with "<botName> " (case-insensitive)
//   4. replyTo === lastMsgId (both non-null): user replied to bot's last message
//
// botName is always added as an implicit alias alongside the supplied aliases.
//
// Examples:
//   makeShouldRespond("robert", ["rob", "bob"])
//   makeShouldRespond("dexter", ["dex"])
//   makeShouldRespond("maxwell", [])
// =============================================================================

/**
 * Build a pattern that matches @alias tokens in a message body.
 * Handles word boundaries on both sides without using \b (which is ASCII-only).
 *
 * @param {string} alias
 * @returns {RegExp}
 */
function aliasPattern(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)@${escaped}(?:\\s|$|[^a-zA-Z0-9_])`, "i");
}

/**
 * Factory: returns a shouldRespond function configured for a specific bot.
 *
 * @param {string} botName - Primary bot name (e.g. "robert", "dexter")
 * @param {string[]} [aliases=[]] - Additional aliases (e.g. ["rob", "bob"])
 * @returns {(body: string, replyTo: string|null, lastMsgId: string|null) => boolean}
 */
export function makeShouldRespond(botName, aliases = []) {
  const allAliases = [botName, ...aliases];
  const aliasPatterns = allAliases.map(aliasPattern);

  return function shouldRespond(body, replyTo, lastMsgId) {
    if (typeof body !== "string" || body.length === 0) return false;

    if (replyTo && lastMsgId && replyTo === lastMsgId) return true;

    for (const re of aliasPatterns) {
      if (re.test(body)) return true;
    }

    return false;
  };
}
