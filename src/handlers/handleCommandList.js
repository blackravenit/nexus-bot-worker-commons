// =============================================================================
// handlers/handleCommandList.js - Command list endpoint for Nexus autocomplete
//
// GET /bot/commands/list
//
// Returns the merged command list for this bot worker: foundation commands
// (remember, forget, facts, clear, status) plus any bot-specific commands
// declared in config.commandMeta.
//
// Response shape:
//   {
//     "commands": [
//       { "trigger": "help", "description": "Show command list", "usage": "!help", "admin": false },
//       ...
//     ]
//   }
//
// Auth: X-API-Key matching config.listKeyEnvVar (falls back to nexusKeyEnvVar).
//   Pass the same outbound Nexus key so the Nexus frontend can call this without
//   adding a new secret. The key never leaves the backend, callers must present
//   it in the X-API-Key header.
//
// Hard rules:
//   - No module-level I/O.
//   - ES modules only.
//   - No em dashes or en dashes.
// =============================================================================

/**
 * Foundation commands provided by nexus-bot-worker-commons on every bot.
 * These are always included in the command list regardless of what the bot
 * declares in its own commandMeta.
 *
 * @type {Array<{ trigger: string, description: string, usage: string, admin: boolean }>}
 */
export const FOUNDATION_COMMAND_META = [
  {
    trigger: "remember",
    description: "Save a fact to your personal memory",
    usage: "!remember <fact>",
    admin: false,
  },
  {
    trigger: "forget",
    description: "Remove a saved fact by keyword",
    usage: "!forget <text>",
    admin: false,
  },
  {
    trigger: "facts",
    description: "List all facts saved for you",
    usage: "!facts",
    admin: false,
  },
  {
    trigger: "clear",
    description: "Clear your conversation history with this bot",
    usage: "!clear",
    admin: false,
  },
  {
    trigger: "status",
    description: "Show worker status and config",
    usage: "!status",
    admin: false,
  },
  {
    trigger: "fleet",
    description: "Show fleet health across all bot workers",
    usage: "!fleet",
    admin: false,
  },
];

/**
 * Handle GET /bot/commands/list
 *
 * Merges FOUNDATION_COMMAND_META with the bot-specific commandMeta from config
 * and returns JSON. Foundation entries for verbs that the bot overrides in its
 * own commandMeta are replaced by the bot-specific entry (bot wins).
 *
 * Auth: X-API-Key header must match env[config.listKeyEnvVar] or
 * env[config.nexusKeyEnvVar] as a fallback. Returns 401 if missing or wrong.
 *
 * @param {Request} request - Inbound CF Workers Request
 * @param {object} env - CF Workers environment bindings
 * @param {object} config - Per-bot configuration object
 * @param {string} [config.nexusKeyEnvVar] - Env var name for the outbound Nexus key
 * @param {string} [config.listKeyEnvVar] - Env var name for a dedicated list endpoint key (optional)
 * @param {Array<{ trigger: string, description: string, usage: string, admin: boolean }>} [config.commandMeta] - Bot-specific command metadata
 * @returns {Response}
 */
export function handleCommandList(request, env, config) {
  // ---- Auth ------------------------------------------------------------------
  // Use a dedicated list key if the bot declares one; fall back to the shared
  // Nexus key so bots don't need to add a new secret for this endpoint.
  const keyEnvVar = config.listKeyEnvVar || config.nexusKeyEnvVar;
  const expectedKey = keyEnvVar ? env[keyEnvVar] : null;
  const presentedKey = request.headers.get("x-api-key");

  if (!expectedKey || !presentedKey || presentedKey !== expectedKey) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // ---- Merge foundation + bot-specific meta ----------------------------------
  // Bot-specific entries win: build a map keyed by trigger so duplicates
  // (e.g. the bot overriding the foundation "status" entry) resolve cleanly.
  const botMeta = Array.isArray(config.commandMeta) ? config.commandMeta : [];

  const botTriggers = new Set(botMeta.map((m) => m.trigger));

  // Foundation entries that the bot has NOT overridden
  const filteredFoundation = FOUNDATION_COMMAND_META.filter(
    (m) => !botTriggers.has(m.trigger),
  );

  // Bot entries come first (own commands), then remaining foundation entries
  const commands = [...botMeta, ...filteredFoundation];

  return new Response(JSON.stringify({ commands }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
