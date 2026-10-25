// =============================================================================
// lib/fleetviewReport.js: the `fleetview_report` tool every bot gets when it is
// wired to FleetView (FLEETVIEW_DELIVERY_SECRET bound). The bot gathers figures
// with its read tools, then files the finished markdown here; FleetView stores
// it per bot and serves it on the Custom Reports page.
//
// The POST is signed exactly like a FleetView reply (signCallback over the raw
// body, same headers, same Access service token headers).
//
// Hard rules: no module-level I/O, no em or en dashes, ES modules only.
// =============================================================================

import { signCallback } from "./callbackSign.js";
import { accessServiceTokenHeaders } from "./fleetviewDelivery.js";
import { CHART_FENCE_GUIDE } from "./reportChartSpec.js";

export const FLEETVIEW_REPORT_TOOL_NAME = "fleetview_report";
export const REPORT_TITLE_MAX = 120;
export const REPORT_MARKDOWN_MAX = 60000;
const DEFAULT_FLEETVIEW_URL = "https://fleet.blackravenit.com";
const POST_TIMEOUT_MS = 15000;
const WHERE = "FleetView Custom Reports";

/** Tool definition handed to the model. */
export const fleetviewReportTool = {
  name: FLEETVIEW_REPORT_TOOL_NAME,
  description:
    "File a finished report on Brian's Custom Reports page in FleetView. Call it IN THE SAME TURN as the ask, " +
    "after gathering the figures with your read tools. `markdown` is the full report body (headings, tables, " +
    "short notes). " + CHART_FENCE_GUIDE,
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: `Short report title, ${REPORT_TITLE_MAX} characters max.` },
      request: { type: "string", description: "Brian's ask, verbatim, so the report can be rebuilt later." },
      markdown: { type: "string", description: `Full report markdown, ${REPORT_MARKDOWN_MAX} characters max.` },
    },
    required: ["title", "request", "markdown"],
  },
};

/** System prompt paragraph added when the tool is injected. */
export const FLEETVIEW_REPORT_PROMPT =
  "\n\nCUSTOM REPORTS: when Brian asks for a report, table, breakdown, chart or graph, gather the figures with your " +
  "read tools, then call fleetview_report IN THE SAME TURN with the full markdown (and a chart fence when the data " +
  "is a comparison or a trend). Reply with one or two sentences of the headline numbers plus \"it is on your " +
  "Custom Reports page in FleetView\". Never promise to file it later. " + CHART_FENCE_GUIDE;

/**
 * Validate and clamp tool input.
 * @param {object} input
 * @returns {{ok: true, title: string, request: string, markdown: string}|{ok: false, error: string}}
 */
export function normalizeReportInput(input) {
  const title = String(input?.title || "").trim().slice(0, REPORT_TITLE_MAX);
  const request = String(input?.request || "").trim();
  const markdown = String(input?.markdown || "").trim().slice(0, REPORT_MARKDOWN_MAX);
  if (!title) return { ok: false, error: "title is required" };
  if (!markdown) return { ok: false, error: "markdown is required" };
  return { ok: true, title, request, markdown };
}

/**
 * Build the handler bound to one bot name.
 * @param {string} botName - this bot's own name, e.g. "kate"
 * @returns {(input: object, env: object) => Promise<object>}
 */
export function createFleetviewReportHandler(botName) {
  return async function fleetviewReportHandler(input, env) {
    const parsed = normalizeReportInput(input);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const secret = env?.FLEETVIEW_DELIVERY_SECRET;
    if (!secret) return { ok: false, error: "FLEETVIEW_DELIVERY_SECRET not bound" };
    const base = (env.FLEETVIEW_BASE_URL || DEFAULT_FLEETVIEW_URL).replace(/\/$/, "");
    const rawBody = JSON.stringify({
      bot: botName,
      title: parsed.title,
      request: parsed.request,
      markdown: parsed.markdown,
      created_at: Date.now(),
    });
    try {
      const { timestamp, signature } = await signCallback(secret, rawBody);
      const res = await fetch(`${base}/api/bot-reply/report`, {
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
      if (!res.ok || !data?.ok) {
        console.error(`[fleetview_report] ${botName} post failed ${res.status}: ${data?.error || ""}`);
        return { ok: false, error: data?.error || `FleetView answered ${res.status}` };
      }
      return { ok: true, id: data.id, title: parsed.title, where: WHERE };
    } catch (err) {
      console.error(`[fleetview_report] ${botName} post error: ${err?.message}`);
      return { ok: false, error: `could not reach FleetView: ${err?.message}` };
    }
  };
}

/**
 * True when the secret is bound and the bot has not registered its own tool of
 * the same name.
 * @param {Array<object>} tools
 * @param {Record<string, Function>} handlers
 * @param {object} env
 * @returns {boolean}
 */
export function shouldInjectFleetviewReport(tools, handlers, env) {
  if (!env?.FLEETVIEW_DELIVERY_SECRET) return false;
  const hasOwn = (tools || []).some((t) => t?.name === FLEETVIEW_REPORT_TOOL_NAME)
    || Boolean(handlers?.[FLEETVIEW_REPORT_TOOL_NAME]);
  return !hasOwn;
}

/**
 * Append the report tool when FleetView is wired and the bot has no tool of the
 * same name. A bot's own fleetview_report always wins.
 *
 * @param {Array<object>} tools - current tool definitions
 * @param {Record<string, Function>} handlers - current handlers
 * @param {object} env - worker bindings
 * @param {string} botName
 * @returns {{tools: Array<object>, handlers: Record<string, Function>, injected: boolean}}
 */
export function injectFleetviewReport(tools, handlers, env, botName) {
  if (!shouldInjectFleetviewReport(tools, handlers, env)) return { tools, handlers, injected: false };
  return {
    tools: [...tools, fleetviewReportTool],
    handlers: { ...handlers, [FLEETVIEW_REPORT_TOOL_NAME]: createFleetviewReportHandler(botName || "bot") },
    injected: true,
  };
}
