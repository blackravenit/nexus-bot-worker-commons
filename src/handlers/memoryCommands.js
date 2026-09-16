// =============================================================================
// handlers/memoryCommands.js - !remember, !forget, !facts foundation verbs.
//
// With a MEMORY binding and a botName these use the shared memory-worker
// (lib/memoryNotes.js). Without one they fall back to the legacy per-bot D1
// facts table exactly as before.
// =============================================================================

import { rememberFact, forgetFact, listFacts } from "../lib/memory.js";
import {
  rememberNote, forgetNotes, listSharedFacts, formatFactsReply, legacyFactsForReply,
} from "../lib/memoryNotes.js";

/**
 * Build the memory verb handlers for one request.
 * @param {object} env
 * @param {string} userId - Nexus user id
 * @param {object} config - bot config (botName, dbBinding, legacyFactsMigrated)
 * @returns {{remember: Function, forget: Function, facts: Function}}
 */
export function buildMemoryCommandHandlers(env, userId, config) {
  const dbOpts = { dbBinding: config.dbBinding };
  const shared = Boolean(env.MEMORY && config.botName);
  const botId = String(config.botName || "bot").toLowerCase();
  const who = { userId };
  return {
    remember: (cmdCtx) => (shared ? rememberShared(env, botId, who, cmdCtx) : rememberLegacy(env, userId, dbOpts, cmdCtx)),
    forget: (cmdCtx) => (shared ? forgetShared(env, botId, who, dbOpts, cmdCtx) : forgetLegacy(env, userId, dbOpts, cmdCtx)),
    facts: async (cmdCtx) => {
      if (!shared) {
        const legacy = await listFacts(env, userId, dbOpts);
        await cmdCtx.reply(formatFactsReply(legacy.map((f) => ({ predicate: "note", object: f.text })), []));
        return;
      }
      const [sharedFacts, legacy] = await Promise.all([
        listSharedFacts(env, botId, who),
        legacyFactsForReply(env, userId, config),
      ]);
      await cmdCtx.reply(formatFactsReply(sharedFacts, legacy));
    },
  };
}

async function rememberShared(env, botId, who, cmdCtx) {
  const fact = cmdCtx.args.trim();
  if (!fact) return cmdCtx.reply("Usage: `!remember <fact>`");
  const result = await rememberNote(env, botId, who, fact);
  if (!result.ok) {
    console.error(`[memoryCommands] remember failed bot=${botId} user=${who.userId}: ${result.error}`);
    return cmdCtx.reply("Could not save that fact (memory service unavailable).");
  }
  return cmdCtx.reply(result.deduplicated ? `Already remembered: ${fact}` : `Remembered: ${fact}`);
}

async function forgetShared(env, botId, who, dbOpts, cmdCtx) {
  const q = cmdCtx.args.trim();
  if (!q) return cmdCtx.reply("Usage: `!forget <text>`");
  const { legacyDeleted, sharedMatches } = await forgetNotes(env, botId, who, q, dbOpts);
  const parts = [];
  if (legacyDeleted > 0) parts.push(`Forgot ${legacyDeleted} legacy item(s) matching "${q}".`);
  if (sharedMatches > 0) {
    parts.push(`${sharedMatches} shared memory note(s) also match but cannot be deleted from chat yet (the memory service has no single note delete).`);
  }
  return cmdCtx.reply(parts.length ? parts.join(" ") : `No memory matched "${q}".`);
}

async function rememberLegacy(env, userId, dbOpts, cmdCtx) {
  const fact = cmdCtx.args.trim();
  if (!fact) return cmdCtx.reply("Usage: `!remember <fact>`");
  const id = await rememberFact(env, userId, fact, dbOpts);
  return cmdCtx.reply(id === null ? "Could not save that fact (DB unavailable)." : `Remembered: ${fact}`);
}

async function forgetLegacy(env, userId, dbOpts, cmdCtx) {
  const q = cmdCtx.args.trim();
  if (!q) return cmdCtx.reply("Usage: `!forget <text>`");
  const count = await forgetFact(env, userId, q, dbOpts);
  return cmdCtx.reply(count === 0 ? `No memory matched "${q}".` : `Forgot ${count} item(s) matching "${q}".`);
}
