// =============================================================================
// lib/botsPageRead.js: the `bots_page_read` tool. Lets a bot read back what it
// generated on its page at https://bots.blackravenit.com: the custom reports it
// filed (list, or one in full) and its own open decision cards. Without it a
// bot answers "I can't see FleetView reports after I file them" and the person
// has to flip to the page and paste the report back in.
//
// POSTs {bot, view, params} to <BOTS_BASE_URL>/api/bot-reply/data signed with
// the bot's OWN inbound callback secret (the one the bots page signs chat
// dispatches with), so the page can pin every read to the calling bot. That
// path sits under the /api/bot-reply Access bypass.
//
// Hard rules: no module-level I/O, no em or en dashes, ES modules only.
// =============================================================================

import { signCallback } from "./callbackSign.js";
import { accessServiceTokenHeaders } from "./fleetviewDelivery.js";

export const BOTS_PAGE_READ_TOOL_NAME = "bots_page_read";
export const DEFAULT_BOTS_URL = "https://bots.blackravenit.com";
const POST_TIMEOUT_MS = 15000;
const VIEWS = new Set(["reports", "report", "cards"]);

/** Tool definition handed to the model. */
export const botsPageReadTool = {
  name: BOTS_PAGE_READ_TOOL_NAME,
  description:
    "Read back what you generated on your page at bots.blackravenit.com. view \"reports\" lists the custom reports " +
    "you filed (id, title, the ask, when); view \"report\" with an id returns one report's full markdown; view " +
    "\"cards\" returns your open decision cards with their text. Use it whenever someone refers to a report or card " +
    "on that page, instead of saying you cannot see it.",
  input_schema: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["reports", "report", "cards"], description: "What to read." },
      id: { type: "string", description: "Report id, required for view \"report\" (from view \"reports\")." },
    },
    required: ["view"],
  },
};

/** System prompt paragraph added with the tool. */
export const BOTS_PAGE_READ_PROMPT =
  "\n\nYOUR PAGE: you can read back the reports you filed and your open decision cards on bots.blackravenit.com " +
  "with bots_page_read. When asked about a report you made, open it with view \"report\" and answer from it; " +
  "never say you cannot see it.";

/**
 * Base URL of the bots page.
 * @param {object} env
 * @returns {string}
 */
export function botsBaseUrl(env) {
  return String(env?.BOTS_BASE_URL || DEFAULT_BOTS_URL).replace(/\/$/, "");
}

/**
 * Build the handler bound to one bot and its inbound secret binding name.
 * @param {string} botName
 * @param {string} secretEnvVar - env binding holding this bot's inbound callback secret
 * @returns {(input: object, env: object) => Promise<object>}
 */
export function createBotsPageReadHandler(botName, secretEnvVar) {
  return async function botsPageReadHandler(input, env) {
    const view = String(input?.view || "");
    if (!VIEWS.has(view)) return { ok: false, error: "view must be reports, report or cards" };
    if (view === "report" && !input?.id) return { ok: false, error: "id is required for view report" };
    const secret = env?.[secretEnvVar];
    if (!secret) return { ok: false, error: `${secretEnvVar} not bound` };
    const rawBody = JSON.stringify({ bot: botName, view, params: input?.id ? { id: String(input.id) } : {} });
    try {
      const { timestamp, signature } = await signCallback(secret, rawBody);
      const res = await fetch(`${botsBaseUrl(env)}/api/bot-reply/data`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Nexus-Timestamp": timestamp,
          "X-Nexus-Signature": signature,
          ...accessServiceTokenHeaders(env),
        },
        body: rawBody,
        redirect: "manual",
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        console.error(`[bots_page_read] ${botName} ${view} failed ${res.status}: ${data?.error || ""}`);
        return { ok: false, error: data?.error || `bots page answered ${res.status}` };
      }
      return data;
    } catch (err) {
      console.error(`[bots_page_read] ${botName} ${view} error: ${err?.message}`);
      return { ok: false, error: `could not reach the bots page: ${err?.message}` };
    }
  };
}

/**
 * Append the read tool when the bot is wired to the bots page (delivery secret
 * bound), its inbound secret is bound, and it has no tool of the same name.
 * @param {Array<object>} tools
 * @param {Record<string, Function>} handlers
 * @param {object} env
 * @param {{botName?: string, secretEnvVar?: string}} who
 * @returns {{tools: Array<object>, handlers: Record<string, Function>, injected: boolean}}
 */
export function injectBotsPageRead(tools, handlers, env, who) {
  const { botName, secretEnvVar } = who || {};
  const hasOwn = (tools || []).some((t) => t?.name === BOTS_PAGE_READ_TOOL_NAME) || Boolean(handlers?.[BOTS_PAGE_READ_TOOL_NAME]);
  if (!env?.FLEETVIEW_DELIVERY_SECRET || !botName || !secretEnvVar || !env?.[secretEnvVar] || hasOwn) {
    return { tools, handlers, injected: false };
  }
  return {
    tools: [...tools, botsPageReadTool],
    handlers: { ...handlers, [BOTS_PAGE_READ_TOOL_NAME]: createBotsPageReadHandler(botName, secretEnvVar) },
    injected: true,
  };
}
