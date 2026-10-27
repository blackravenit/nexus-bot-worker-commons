// =============================================================================
// lib/voiceBangCommand.js
//
// Universal "run a bang command from voice" tool factory.
//
// Each bot's voice surface exposes a SINGLE universal Anthropic tool,
// run_bang_command, that wraps the bot's existing !command handlers plus the
// commons foundation handlers (remember/forget/facts/clear/status/fleet).
//
// Before this helper existed, every bot duplicated ~100 lines of nearly
// identical bangCommand.js code, including subtle import bugs (jacob
// 2026-05-20) where the commandHandlers map silently fell back to {} on bots
// whose tools/registry.js shape differed from Dexter's. This factory removes
// the duplication entirely. Each bot's bangCommand.js becomes ~5 lines that
// pass in the bot's commands + config.
//
// Foundation commands are merged at handler-call time using the bot's config
// (the buildFoundationHandlers closure needs env + userId + historyKey +
// channel_slug + config + nexusOptions). Bot-specific commands win on name
// collision, matches the precedence used by commons handleChatMessage.
//
// Hard rules:
//   - ES modules only.
//   - No em dashes.
// =============================================================================

import { buildFoundationHandlers } from "../handlers/handleChatMessage.js";
import { FOUNDATION_COMMAND_META } from "../handlers/handleCommandList.js";

/**
 * Build the voice run_bang_command tool definition + handler for a bot.
 *
 * @param {object} opts
 * @param {Object.<string, function>} opts.commandHandlers - Bot's verb -> async (ctx) => void map
 * @param {Array<{ trigger: string, description: string, admin?: boolean }>} [opts.commandMeta] - Bot's command metadata (used to populate the tool description)
 * @param {object} opts.botConfig - Full bot config object (needs botName, persona, dbBinding, nexusKeyEnvVar) so foundation handlers can build per-call
 * @returns {{ bangCommandTool: object, handleRunBangCommand: function }}
 */
export function createBangCommandTool({ commandHandlers, commandMeta, botConfig }) {
  if (!commandHandlers || typeof commandHandlers !== "object") {
    throw new Error("createBangCommandTool: commandHandlers map is required");
  }
  if (!botConfig || typeof botConfig !== "object") {
    throw new Error("createBangCommandTool: botConfig is required (needed to build foundation handlers per call)");
  }

  // Merge bot-specific meta with foundation meta for the static tool description.
  // If the bot supplies handlers but no meta (courtney/moxie/maxwell at time of
  // writing), synthesize description-less entries from handler keys so they still
  // appear in the tool description, otherwise the LLM can't see them.
  const botMeta = Array.isArray(commandMeta) ? commandMeta : [];
  const botMetaTriggers = new Set(botMeta.map((m) => m.trigger));
  const handlerKeys = Object.keys(commandHandlers || {});
  const synthesizedMeta = handlerKeys
    .filter((k) => !botMetaTriggers.has(k))
    .sort()
    .map((k) => ({ trigger: k, description: "", admin: false }));
  const allBotMeta = [...botMeta, ...synthesizedMeta];
  const allBotTriggers = new Set(allBotMeta.map((m) => m.trigger));
  const filteredFoundationMeta = FOUNDATION_COMMAND_META.filter((m) => !allBotTriggers.has(m.trigger));
  const mergedMeta = [...allBotMeta, ...filteredFoundationMeta];

  const cmdList = mergedMeta.map((c) => {
    const adminTag = c.admin ? " (admin)" : "";
    return c.description
      ? `- !${c.trigger}${adminTag}: ${c.description}`
      : `- !${c.trigger}${adminTag}`;
  }).join("\n");

  const bangCommandTool = {
    name: "run_bang_command",
    description:
      "Execute one of this bot's bang commands and return its output. " +
      "Use this for ANY operational question that has a matching bang command. " +
      "Output is rich markdown; speak only a 1-2 sentence summary aloud since the full text " +
      "is auto-posted to the bot's text channel.\n\nAvailable commands:\n" + cmdList,
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command name without the leading !. See list above.",
        },
        args: {
          type: "string",
          description: "Arguments string (everything that would follow the command on the !line). Empty for no-arg commands.",
        },
      },
      required: ["command"],
    },
  };

  /**
   * Tool handler. Builds foundation handlers per-call (they need env + ctx)
   * and merges with the bot's static commandHandlers; bot wins on collision.
   *
   * @param {object} input - { command: string, args?: string }
   * @param {object} env - Worker env
   * @param {object} callerCtx - { user_id, display_name, channel_slug }
   * @returns {Promise<{ command: string, args: string, output: string } | { error: string }>}
   */
  async function handleRunBangCommand(input, env, callerCtx) {
    const command = String(input?.command || "").trim().replace(/^!/, "");
    const args = String(input?.args || "").trim();
    if (!command) return { error: "command is required" };

    const userId = callerCtx?.user_id || "voice-session";
    const channelSlug = callerCtx?.channel_slug || "voice";

    // Build foundation handlers per-call (they close over env/userId/etc).
    const foundationHandlers = buildFoundationHandlers(
      env,
      userId,
      `nexus:${userId}`,
      channelSlug,
      botConfig,
      { nexusKeyEnvVar: botConfig.nexusKeyEnvVar },
    );

    // Bot wins on collision, matches handleChatMessage precedence.
    const allHandlers = { ...foundationHandlers, ...commandHandlers };
    const handler = allHandlers[command];
    if (!handler) {
      const known = Object.keys(allHandlers).sort();
      return { error: `unknown command: ${command}. Known: ${known.join(", ")}` };
    }

    // Capturing ctx: reply() pushes chunks into an array instead of posting.
    const captured = [];
    const ctx = {
      verb: command,
      args,
      user_id: userId,
      display_name: callerCtx?.display_name || "Voice",
      channel_slug: channelSlug,
      env,
      reply: async (text) => {
        if (text == null) return;
        captured.push(String(text));
      },
    };

    try {
      await handler(ctx);
    } catch (err) {
      return { error: `command failed: ${err?.message || String(err)}` };
    }

    const rawOutput = captured.join("\n\n").trim();
    const argsPart = args ? ` ${args}` : "";
    const header = `## ⚡ !${command}${argsPart}\n`;
    const output = rawOutput
      ? header + "\n" + rawOutput
      : header + "\n_(command produced no output)_";

    return { command, args, output };
  }

  return { bangCommandTool, handleRunBangCommand };
}
