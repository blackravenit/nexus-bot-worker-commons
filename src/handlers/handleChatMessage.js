// =============================================================================
// handlers/handleChatMessage.js - Config-driven Nexus chat callback entry point
//
// handleChatMessage(request, env, ctx, config) -> Promise<Response>
//
// This is the main exported function. Per-bot workers import this and wire
// it to POST /api/internal/chat-message. The bot-specific behavior (persona,
// tools, commands, trigger matching) is expressed entirely through the config
// object. See SPEC.md for the full config schema.
//
// Pipeline (in order):
//   1. Read raw body.
//   2. Verify HMAC (verifyNexusSignature). Reject 401 on failure.
//   3. Parse JSON payload. Reject 400 on failure.
//   4. Validate required fields (user_id, body, channel_slug). Reject 400.
//   5. Strip @mention tokens to produce userText. Reject 400 if empty.
//   6. !cmd dispatch (BEFORE the ambient gate).
//      Build foundation handlers (remember/forget/facts/clear/status) per-request
//      so they close over env + userId. Merge with config.commands. Dispatch
//      matching verb and return 200. Unknown !cmd falls through to LLM.
//   7. Ambient gate. If trigger_type="ambient" and config.triggers.ambient
//      returns false, return 200 { skipped: true }.
//   8. Return 202 immediately and push the LLM pipeline into ctx.waitUntil.
//      (Nexus aborts the inbound request at 8s; the tool loop takes 30+ seconds.)
//
// Hard rules:
//   - No module-level I/O. All fetch/crypto/Response calls are inside functions.
//   - Tool handler signature is (input, env, ctx). Always.
//   - No em dashes or en dashes.
//   - ES modules only.
// =============================================================================

import { verifyNexusSignature } from "../lib/callbackSign.js";
import { parseCommand } from "../lib/commandParser.js";
import { loadHistory, appendHistory } from "../lib/history.js";
import { buildFactsBlock } from "../lib/memory.js";
import { persistTurnPair, resolveEntity, getEntityContext, assertFact } from "../lib/memoryService.js";
import { buildMemoryRecallBlock } from "../lib/memoryRecallBlock.js";
import { resolveContextBudget, applyHistoryBudget, fitNewestLines } from "../lib/contextBudget.js";
import { buildHistoryFoldBlock, clearFolds } from "../lib/historyFold.js";
import { buildMemoryCommandHandlers } from "./memoryCommands.js";
import { callAnthropicWithTools, callAnthropic } from "../lib/anthropic.js";
import { postToNexus, sendTyping, fetchChannelMessages, fetchThreadMessages } from "../lib/nexus.js";
import { postApprovalCard } from "../lib/hitl.js";
import { withProvenance } from "../lib/provenanceContext.js";
import { bangReport } from "../lib/embedCard.js";
import { buildAttachmentContentBlocks, buildBlock } from "../lib/attachments.js";
import { transcodeToJpeg } from "../lib/imageTranscode.js";
import { shouldChimeIn } from "../lib/watercooler.js";
import { phoenixToday } from "../lib/format.js";
import { buildActionBreadcrumb } from "../lib/actionTrace.js";
import { scrubFleetDashes } from "../lib/sanitize.js";
import { collectSearchResultUrls, groundUrlsInText } from "../lib/researchShare.js";
import { applyRelayToolPolicy, relayModeSystemNote, mirrorRelayReply } from "../lib/fleetRelay.js";
import { isFleetViewSource, deliverFleetViewReply } from "../lib/fleetviewDelivery.js";

// Detect GIF-only messages so bots receive "[GIF image: <url>]" instead of
// a bare CDN URL they cannot interpret.
const GIF_URL_RE = /^https:\/\/(?:media\d*|i)\.giphy\.com\/|^https:\/\/media\.tenor\.com\//i;

// Re-arm the "<bot> is typing..." indicator on a fixed clock for the whole
// turn. The Nexus ChatRoom DO expires a bot typing entry after 90s
// (BOT_TYPING_EXPIRY_MS), and the only other re-arm point is the
// onTurnStart hook, which fires per Anthropic POST -- so a single slow
// iteration (long model call plus a stack of tool executions: CRM writes,
// vision, API retries) blows past 90s and the indicator vanishes while the
// bot is still working, which reads as "the bot is broken" (Brian,
// 2026-08-13, Jacob in #sales). 45s gives 2x margin under the DO's TTL and
// also restores the entry within one beat if the ChatRoom DO hibernates
// mid-turn and drops its in-memory typing map.
const TYPING_HEARTBEAT_MS = 45_000;

/**
 * Hand a chat-message job to the bot's LlmRoom Durable Object so the LLM
 * tool loop runs outside the calling worker's 30s waitUntil ceiling. Falls
 * back to inline withProvenance + runLlmPipeline when the DO binding is
 * absent (legacy bots that haven't migrated yet).
 *
 * @param {object} env - worker bindings (DO binding read via config.llmRoomBinding)
 * @param {string} historyKey - "nexus:<user_id>", used as DO instance name suffix
 * @param {object} job - serializable payload (no functions); pipeline args + provenance
 * @param {object} config - bot config (NOT serialized; the DO subclass imports it itself)
 * @returns {Promise<void>}
 */
async function dispatchLlmJob(env, historyKey, job, config) {
  const bindingName = config.llmRoomBinding || "LLM_ROOM";
  const ns = env[bindingName];

  // FleetView skips the Durable Object and runs inline.
  //
  // The DO exists to escape the ~30s waitUntil ceiling for long tool loops, and
  // it pays for that with an alarm hop: measured at roughly a second of pure
  // queue wait before the pipeline starts. On a chat message nobody notices. On
  // a spoken question it is a second of silence at the front of every answer.
  //
  // The trade is real: a FleetView turn that runs past the waitUntil ceiling is
  // cut off. Spoken questions are short by nature, and a turn that dies still
  // surfaces as a stall in the FleetView panel rather than vanishing, so the
  // second is worth more than the tail risk here.
  if (isFleetViewSource(job.source)) {
    try {
      await withProvenance(job.provenance || "mention-reply", () =>
        runLlmPipeline({ env, ...job, config })
      );
    } catch (err) {
      console.error("[handleChatMessage] fleetview inline pipeline error:", err?.message);
    }
    return;
  }

  if (!ns || typeof ns.idFromName !== "function") {
    console.warn(`[handleChatMessage] no ${bindingName} DO binding; running inline (may hit 30s waitUntil cap)`);
    try {
      await withProvenance(job.provenance || "mention-reply", () =>
        runLlmPipeline({ env, ...job, config })
      );
    } catch (err) {
      console.error("[handleChatMessage] inline pipeline error:", err?.message);
    }
    return;
  }

  const id = ns.idFromName(`${config.botName || "bot"}:${historyKey}`);
  const stub = ns.get(id);

  try {
    const res = await stub.fetch("https://llm-room.internal/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[handleChatMessage] LlmRoom dispatch non-2xx ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("[handleChatMessage] LlmRoom dispatch failed:", err?.message);
  }
}

function annotateGifBody(body) {
  if (!body) return body;
  const trimmed = body.trim();
  if (GIF_URL_RE.test(trimmed) && !/\s/.test(trimmed)) {
    return `[GIF image: ${trimmed}]`;
  }
  return body;
}

// Picker GIFs (Giphy/Tenor) arrive as a link in the message body, not as a file
// upload, so they never reach buildAttachmentContentBlocks. We pull those links
// -- from the current turn AND from recent channel history (the common case:
// someone posts a GIF, then asks the bot about it a message later) -- and turn
// them into image blocks so the bot SEES the GIF instead of only reading a URL.
//
// Matches any giphy.com / tenor.com URL: direct media CDN links AND share/page
// links (e.g. tenor.com/view/..., giphy.com/gifs/...). Page links are resolved
// to the underlying image via the page's og:image meta tag.
const GIF_URL_GLOBAL_RE = /https?:\/\/[^\s"'<>]*\b(?:giphy\.com|tenor\.com)\/[^\s"'<>)]+/gi;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const MAX_GIFS_PER_TURN = 3;

/**
 * Extract unique Giphy/Tenor URLs from a block of text, in first-seen order.
 * @param {string} text
 * @returns {string[]}
 */
function extractGifUrls(text) {
  if (!text) return [];
  return [...new Set(text.match(GIF_URL_GLOBAL_RE) || [])];
}

/**
 * Resolve a Giphy/Tenor URL to raw image bytes. Direct media URLs return their
 * bytes; share/page URLs are fetched as HTML and resolved via og:image.
 *
 * @param {string} url
 * @returns {Promise<{ buf: ArrayBuffer, mime: string } | null>}
 */
async function resolveGifImageBytes(url) {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; NexusBot/1.0)" };
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000), headers });
  if (!resp.ok) return null;
  const ct = (resp.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();

  if (ct.startsWith("image/")) {
    return { buf: await resp.arrayBuffer(), mime: ct };
  }
  if (ct.includes("html")) {
    const html = await resp.text();
    const og =
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*\scontent=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+\scontent=["']([^"']+)["'][^>]+property=["']og:image/i);
    const imgUrl = og && og[1] ? og[1].replace(/&amp;/g, "&") : null;
    if (imgUrl) {
      const r2 = await fetch(imgUrl, { signal: AbortSignal.timeout(10000), headers });
      if (r2.ok) {
        const ct2 = (r2.headers.get("content-type") || "image/gif").toLowerCase().split(";")[0].trim();
        if (ct2.startsWith("image/")) return { buf: await r2.arrayBuffer(), mime: ct2 };
      }
    }
  }

  // Giphy share/embed pages often do not expose a usable og:image to a bare
  // server-side fetch (the page is JS-rendered), so the HTML path above comes
  // up empty. Derive the gif id from the URL slug -- giphy.com/gifs/<words>-<id>,
  // /gifs/<id>, /embed/<id> -- and hit the media CDN directly, which always
  // returns raw gif bytes. This is what makes Giphy-picker links actually
  // resolve, not just Tenor links and direct media URLs.
  const giphyId = url.match(/giphy\.com\/(?:gifs|embed|media|stickers|clips)\/(?:[^/?#]*-)?([A-Za-z0-9]{6,})/i);
  if (giphyId) {
    const r3 = await fetch(`https://media.giphy.com/media/${giphyId[1]}/giphy.gif`, { signal: AbortSignal.timeout(10000), headers });
    if (r3.ok) {
      const ct3 = (r3.headers.get("content-type") || "image/gif").toLowerCase().split(";")[0].trim();
      if (ct3.startsWith("image/")) return { buf: await r3.arrayBuffer(), mime: ct3 };
    }
  }
  return null;
}

/**
 * Fetch a list of Giphy/Tenor URLs and convert each to an Anthropic image
 * block. GIFs are transcoded to a single JPEG frame via the IMAGES binding when
 * available -- this guarantees the (often animated) image is accepted by the
 * vision API and is enough for the bot to see the content. Falls back to the
 * raw bytes if transcoding is unavailable. Best-effort: failures are skipped.
 *
 * @param {object} env - worker env (IMAGES binding read for transcode)
 * @param {string[]} urls - candidate Giphy/Tenor URLs (priority order)
 * @returns {Promise<{ blocks: Array<object>, urls: string[] }>}
 */
async function fetchGifBlocks(env, urls) {
  const blocks = [];
  const used = [];
  for (const url of urls.slice(0, MAX_GIFS_PER_TURN)) {
    try {
      const resolved = await resolveGifImageBytes(url);
      if (!resolved || resolved.buf.byteLength > MAX_GIF_BYTES) continue;

      let built = null;
      const jpeg = await transcodeToJpeg(env.IMAGES, resolved.buf);
      if (jpeg) built = await buildBlock(env, "image/jpeg", jpeg, "shared-image");
      if (!built) built = await buildBlock(env, resolved.mime, resolved.buf, "shared-image");
      if (built) {
        blocks.push(built.block);
        used.push(url);
      }
    } catch (err) {
      console.warn("[handleChatMessage] GIF fetch failed:", err?.message);
    }
  }
  return { blocks, urls: used };
}

// Foundation command verbs built per-request (need env + user context)
const FOUNDATION_VERBS = new Set(["remember", "forget", "facts", "clear", "status", "fleet"]);

/**
 * Strip only this bot's own @mention token(s) from the message body.
 * Preserves all other @tokens (e.g. @me, @channel, @colleague) so the
 * LLM receives the user's full intent without mangling.
 *
 * Matches the bot's canonical id form (@courtney) and the bot_ prefixed
 * form (@bot_courtney) so both trigger styles are cleaned up.
 *
 * @param {string} body
 * @param {string} botName  - e.g. "courtney", "robert"
 * @returns {string}
 */
function stripMention(body, botName) {
  if (typeof body !== "string") return "";
  if (!botName) {
    // Legacy fallback: strip everything (old behavior). Should not happen
    // when callers pass config.botName, but kept for safety.
    return body.replace(/@\S+/g, "").trim();
  }
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match @courtney and @bot_courtney (case-insensitive, word-boundary after)
  const re = new RegExp(`@(?:bot_)?${escaped}\\b`, "gi");
  return body.replace(re, "").trim();
}

/**
 * Build a JSON response.
 *
 * @param {object} body
 * @param {number} [status=200]
 * @returns {Response}
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build per-request foundation command handlers that close over env and userId.
 * These need runtime context (env bindings, historyKey) so they cannot be
 * defined statically.
 *
 * Exported so voice surfaces (each bot's tools/bangCommand.js) can reuse the
 * same handlers via run_bang_command without re-implementing them.
 *
 * @param {object} env
 * @param {string} userId
 * @param {string} historyKey
 * @param {string} channel_slug - used for postToNexus inside status
 * @param {object} config - full bot config (for botName, displayName)
 * @param {object} nexusOptions - passed to postToNexus calls inside handlers
 * @returns {object} Map of verb -> async (cmdCtx) => void
 */
export function buildFoundationHandlers(env, userId, historyKey, channel_slug, config, nexusOptions) {
  const botName = config.botName || "bot";
  const displayName = config.persona?.displayName || botName;

  return {
    ...buildMemoryCommandHandlers(env, userId, config),

    clear: async (cmdCtx) => {
      const dbKey = config.dbBinding || "DB";
      const db = env[dbKey];
      if (db) {
        try {
          await db
            .prepare("DELETE FROM chat_history WHERE history_key = ?")
            .bind(historyKey)
            .run();
          // A rolling summary of the cleared history must not outlive it.
          await clearFolds(db, historyKey);
        } catch (err) {
          console.error("[handleChatMessage] clear history failed:", err.message);
        }
      }
      await cmdCtx.reply("Conversation history cleared.");
    },

    status: async (cmdCtx) => {
      const histDepth = await loadHistory(env, historyKey, { dbBinding: config.dbBinding })
        .then(h => h.length)
        .catch(() => 0);
      const enabledKey = `${botName.toUpperCase().replace(/-/g, "_")}_WORKER_ENABLED`;
      const displayName = (config.persona?.displayName || botName).split(/\s+/)[0];
      const body = [
        `Worker:           ${botName}-worker (CF Workers)`,
        `Master gate:      ${env[enabledKey] || "unknown"}`,
        `Commit:           ${env.COMMIT || "unknown"}`,
        `Deployed:         ${env.DEPLOYED_AT || "unknown"}`,
        ``,
        `Your history depth: ${histDepth} turns`,
      ].join("\n");
      await cmdCtx.reply(bangReport({
        botName: displayName,
        verb: cmdCtx.verb,
        args: cmdCtx.args,
        sections: [body],
      }));
    },

    fleet: async (cmdCtx) => {
      const displayName = (config.persona?.displayName || botName).split(/\s+/)[0];
      const apiKey = env[config.nexusKeyEnvVar];
      if (!apiKey || !env.NEXUS_BASE_URL) {
        await cmdCtx.reply(bangReport({
          botName: displayName,
          verb: cmdCtx.verb,
          args: cmdCtx.args,
          sections: ["Cannot query fleet: NEXUS_BASE_URL or bot key not set."],
        }));
        return;
      }
      let bots = [];
      let generatedAt = null;
      let fetchErr = null;
      try {
        const res = await fetch(`${env.NEXUS_BASE_URL}/api/bot/fleet/status`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          fetchErr = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
        } else {
          const j = await res.json();
          bots = j?.data?.bots || [];
          generatedAt = j?.data?.generated_at || null;
        }
      } catch (err) {
        fetchErr = err?.message || String(err);
      }
      if (fetchErr) {
        await cmdCtx.reply(bangReport({
          botName: displayName,
          verb: cmdCtx.verb,
          args: cmdCtx.args,
          sections: [`Fleet status fetch failed: ${fetchErr}`],
        }));
        return;
      }
      // Build a pm2-style table:
      //   Status  Bot        Commit    Deployed                  Latency
      const header = "Status  Bot          Commit    Deployed                 Latency";
      const sep = "-".repeat(header.length);
      const rows = bots.map((b) => {
        const ok = b.health_ok && b.version_ok && !b.error;
        const status = ok ? "  OK  " : " FAIL ";
        const name = String(b.name || "").padEnd(11);
        const commit = (b.commit ? String(b.commit) : "--------").slice(0, 8);
        const deployedRaw = b.deployed_at ? String(b.deployed_at) : "(unknown)";
        const deployed = deployedRaw.padEnd(24).slice(0, 24);
        const ms = String(b.latency_ms ?? 0).padStart(4) + "ms";
        return `${status}  ${name} ${commit}  ${deployed}  ${ms}`;
      });
      const errLines = bots
        .filter((b) => b.error || !b.health_ok || !b.version_ok)
        .map((b) => `  ${b.name}: ${b.error || `health=${b.health_status} version_ok=${b.version_ok}`}`);
      // bangReport already emits its own "Generated:" line; skip duplicating it.
      const sections = [header, sep, ...rows];
      if (errLines.length > 0) sections.push("", "Issues:", ...errLines);
      await cmdCtx.reply(bangReport({
        botName: displayName,
        verb: cmdCtx.verb,
        args: cmdCtx.args,
        sections: [sections.join("\n")],
      }));
    },
  };
}

/**
 * Long-running LLM pipeline. Pulled out of handleChatMessage so the inbound
 * HTTP request can return 202 before this begins. All errors are caught and
 * logged -- this runs inside ctx.waitUntil with no caller to surface errors to.
 *
 * @param {object} args
 * @returns {Promise<void>}
 */
export async function runLlmPipeline({
  env,
  user_id,
  user_email,
  display_name,
  channel_slug,
  userText,
  labeledUserText,
  historyKey,
  attachments,
  reply_to,
  requester_is_bot,
  source,
  reply_webhook,
  thread_id,
  dispatched_at,
  config,
}) {
  // FleetView turns run this identical pipeline (same persona, tools, memory,
  // HITL). Only the delivery differs: the answer is pushed back to the browser
  // over a signed webhook instead of posted into the channel it came from, and
  // channel-scoped side effects (typing frames, the auto-listen flag) are
  // suppressed because channel_slug here is the bot's home channel, not a
  // conversation anyone is watching.
  const fleetView = isFleetViewSource(source);
  // Phase timings for a spoken turn, shipped back with the answer.
  //
  // The pipeline runs inside the LlmRoom Durable Object's alarm handler, whose
  // console output does NOT surface in `wrangler tail`. That makes latency work
  // guesswork: the only observable numbers are the ones the turn carries out
  // with it. So it carries them.
  const t0 = Date.now();
  const marks = {};
  // Time between the question being dispatched and this pipeline starting:
  // the DO hop plus however long the alarm took to fire. Invisible from inside
  // the pipeline otherwise, and it turned out to be seconds.
  if (dispatched_at) marks.queue_wait = t0 - dispatched_at;
  const mark = (name) => { marks[name] = Date.now() - t0; };
  // The model this turn runs on, resolved once so the call and the usage
  // report can never disagree about it.
  // FleetView runs the bot's own Nexus model by default. The Haiku downgrade
  // (2026-08-11, for spoken-turn latency) made FleetView answers audibly dumber
  // than the same bot in Nexus, which reads as gibberish next to its own
  // channel persona. Set FLEETVIEW_MODEL only to deliberately trade quality
  // for latency again.
  const nexusModel = env.CLAUDE_MODEL || "claude-opus-4-7";
  const effectiveModel = fleetView
    ? (env.FLEETVIEW_MODEL || nexusModel)
    : nexusModel;
  const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };
  // When the triggering message was part of a thread, reply_to is the
  // parent message id. Thread the same reply_to into every outbound post
  // so the bot's response lands in the same thread as the user's message.
  if (reply_to) nexusOptions.reply_to = reply_to;
  // When replying in a thread, scope every "<bot> is typing..." frame to
  // that thread panel only. Without thread_id the indicator surfaces in
  // the parent channel's bottom-row footer, which is confusing when the
  // bot is actually conversing inside a thread side panel.
  const typingOptions = { ...nexusOptions };
  if (reply_to) typingOptions.thread_id = reply_to;
  const actionRegex = config.actionRegex || /<action>([\s\S]*?)<\/action>/;
  const systemPrompt = config.persona.systemPrompt;
  const approvalSlug = config.approvalSlug || "soc-approvals";

  let responseText;
  let capturedUsage = null;
  let history;
  // Cross-surface memory entity for this person, resolved once per turn and
  // reused for both recall (inject what we know) and persistence (tag this
  // turn so future recall finds it). Null when MEMORY is unbound.
  let memEntityId = null;
  // Memory identity + audience for this turn. These MUST stay at function
  // scope: recall runs inside the media/attachment block below, but the
  // persist call and the `remember` tool handler both live near the end of
  // this function, outside it. Declared in that block from 2026-07-03
  // (1889d9a) to 2026-08-02, they threw a ReferenceError on every turn, caught
  // and logged as a warning, so recall kept working while NOTHING was written
  // back for a month across the whole fleet.
  //
  // Nexus chat is the INTERNAL staff surface (M365 SSO, blackravenit.com only),
  // so it writes to the lowercase memory bucket tagged 'internal' and reads
  // with staff scope 'all' (merged internal + external view). This is the one
  // surface allowed to see internal memory; client-facing surfaces (email,
  // phone) omit these opts and get the fail-safe external-only view.
  const memBotId = (config.botName || "bot").toLowerCase();
  const MEM_STAFF = { audience: "internal", scope: "all" };
  // Trace of tool calls executed this turn (name + input + error flag), used
  // to build an action breadcrumb for memory and to flag unbacked claims.
  const toolTrace = [];

  // "<bot> is typing..." indicator. Nexus dispatch already fires a
  // typing-start before invoking us, but the dispatch-side indicator
  // expires after 90s on the DO. For tool loops that exceed that window
  // (e.g. Maxwell running an AR query through Xero with retries) we keep
  // it alive with the fixed 45s heartbeat below plus a re-arm before every
  // Anthropic call (onTurnStart), and clear it in finally so users never
  // see a stale "typing" trail after the bot has actually returned. The
  // Nexus typing route resolves the bot identity from the Bearer key, so
  // commons does not need to know the bot user id here.
  // FleetView shows its own status line in the browser, and the home channel
  // has no one waiting on a typing frame, so skip the indicator entirely there.
  const typing = (state) => (fleetView ? Promise.resolve() : sendTyping(env, channel_slug, state, typingOptions));
  await typing("start");
  // Fixed-interval heartbeat (see TYPING_HEARTBEAT_MS): the per-POST re-arm
  // below cannot cover a single iteration that runs longer than the DO's 90s
  // TTL. sendTyping never throws, so the tick needs no error handling.
  const typingHeartbeat = fleetView ? null : setInterval(() => { typing("start"); }, TYPING_HEARTBEAT_MS);

  try {
    // Token budget (opt-in, config.contextBudget.enabled): load a generous
    // window and keep the newest rows that fit; the rest may be folded into a
    // rolling summary further down. Off = the old fixed 30 row window.
    const budget = resolveContextBudget(config);
    let droppedHistory = [];
    if (budget.enabled) {
      const loaded = await loadHistory(env, historyKey, { dbBinding: config.dbBinding, maxTurns: budget.historyWindow, withMeta: true });
      ({ history, dropped: droppedHistory } = applyHistoryBudget(loaded, budget.history));
    } else {
      history = await loadHistory(env, historyKey, { dbBinding: config.dbBinding });
    }
    mark("history");

    // Auto-fetch recent channel messages so the bot knows what the broader
    // conversation looks like, not just its own per-user history. Default ON;
    // bots can opt out with config.channelContext = { enabled: false }.
    //
    // When reply_to is set, ALSO fetch the full thread (parent + replies) so
    // the bot can read everything said in this side-conversation -- the EC2
    // bots used to scroll back automatically when @mentioned in a thread, and
    // the worker port had been only pulling the parent channel feed (which
    // often did not include older thread replies). Brian flagged this as a
    // migration regression 2026-05-23.
    let channelContextBlock = "";
    let threadContextBlock = "";
    // GIF/Tenor links spotted in recent channel history, most-recent first.
    // Fed into the multimodal hand-off so the bot can SEE a GIF someone posted
    // a message or two ago when asked about it (not just the current turn).
    let historyGifUrls = [];
    // FleetView turns skip channel context entirely. channel_slug there is the
    // bot's home channel, which Brian is not looking at and did not ask about,
    // so the fetch buys nothing and costs a Nexus round trip plus a pile of
    // tokens in the prompt, both of which are silence on a spoken turn.
    const ccEnabled = !fleetView && config.channelContext?.enabled !== false;
    const ccFixedLimit = config.channelContext?.limit ?? 15;
    const ccLimit = budget.enabled ? Math.max(ccFixedLimit, budget.channelWindow) : ccFixedLimit;
    // The bot's own user id, so its own messages in the channel/thread feed are
    // labeled "(you)" instead of looking like a stranger's. Without this, a bot
    // @mentioned about a scheduled post it made (a digest, a watercooler line)
    // reads its own message as someone else's and disowns it.
    const selfUserId = config.botName ? `bot_${config.botName}` : null;
    if (reply_to) {
      try {
        const thread = await fetchThreadMessages(env, reply_to, nexusOptions);
        if (thread && (thread.parent || (Array.isArray(thread.replies) && thread.replies.length > 0))) {
          const lines = [];
          const fmtRow = (m) => {
            const who = selfUserId && m.user_id === selfUserId
              ? `${m.display_name || m.user_id} (you)`
              : (m.display_name || m.user_id || "unknown");
            let ts = "";
            if (m.created_at !== undefined && m.created_at !== null) {
              const d = new Date(m.created_at);
              if (!Number.isNaN(d.getTime())) ts = d.toISOString().slice(11, 16);
            }
            const body = (m.body || "").slice(0, 600);
            const atts = Array.isArray(m.attachments) ? m.attachments : [];
            const attSuffix = atts.length
              ? ` [attachments: ${atts.map((a) => `${a.filename || a.id} (${a.mime_type || "?"}, id=${a.id})`).join(", ")}]`
              : "";
            return `[${ts}] ${who}: ${body}${attSuffix}`;
          };
          if (thread.parent) lines.push(`(thread parent) ${fmtRow(thread.parent)}`);
          for (const r of thread.replies || []) {
            if (r.user_id === "system") continue;
            lines.push(fmtRow(r));
          }
          if (lines.length > 0) {
            threadContextBlock =
              "\n\nTHREAD CONTEXT (this @mention came from inside a thread -- here is the full thread you are replying inside, oldest to newest):\n" +
              lines.join("\n") +
              "\n\nReply to the most recent message above. The user expects you to have read the whole thread; do not ask them to repeat themselves. Your reply will be posted inside this same thread.";
          }
        }
      } catch (err) {
        console.warn("[handleChatMessage] thread context fetch failed:", err.message);
      }
    }
    if (ccEnabled) {
      try {
        const recentMsgs = await fetchChannelMessages(env, channel_slug, {
          ...nexusOptions,
          limit: ccLimit,
        });
        if (recentMsgs && recentMsgs.length > 0) {
          // Harvest GIF links from history, most-recent first, so the bot can
          // load and see a GIF referenced from an earlier message this turn.
          for (let i = recentMsgs.length - 1; i >= 0; i--) {
            for (const u of extractGifUrls(recentMsgs[i].body || "")) {
              if (!historyGifUrls.includes(u)) historyGifUrls.push(u);
            }
          }
          const lines = recentMsgs
            .filter((m) => m.user_id !== "system")
            .map((m) => {
              const who = selfUserId && m.user_id === selfUserId
                ? `${m.display_name || m.user_id} (you)`
                : (m.display_name || m.user_id);
              // Nexus returns created_at as a number (epoch ms) since the
              // schema column is INTEGER; older code paths returned ISO
              // strings. Accept both so this never blows up the channel
              // context fetch on a string/number mismatch.
              let ts = "";
              if (m.created_at !== undefined && m.created_at !== null) {
                const d = new Date(m.created_at);
                if (!Number.isNaN(d.getTime())) ts = d.toISOString().slice(11, 16);
              }
              const body = (m.body || "").slice(0, 300);
              // Surface attachment metadata so the bot can see "Dirk posted
              // Nexus-Install-Guide.pdf earlier" instead of just the text.
              // Carries the attachment id so the bot can fetch it via the
              // nexus_load_attachment tool.
              const atts = Array.isArray(m.attachments) ? m.attachments : [];
              const attSuffix = atts.length
                ? ` [attachments: ${atts.map((a) => `${a.filename || a.id} (${a.mime_type || "?"}, id=${a.id})`).join(", ")}]`
                : "";
              return `[${ts}] ${who}: ${body}${attSuffix}`;
            });
          const ccLines = budget.enabled ? fitNewestLines(lines, budget.channel) : lines;
          if (ccLines.length > 0) {
            channelContextBlock =
              "\n\nRECENT CHANNEL MESSAGES (context from #" + channel_slug +
              " so you understand the current conversation):\n" +
              ccLines.join("\n") +
              "\n\nRespond to the latest message directed at you, but FIRST read the messages above to " +
              "understand what it is about. When the message refers to something implicitly -- 'it', " +
              "'this', 'that one', 'send it', 'do it', 'go ahead', 'looks good', 'approve it' -- the " +
              "referent is almost always the most recent relevant thing you or they just posted in this " +
              "channel (an opportunity, quote, proposal, draft, invoice, document, or record). Resolve it " +
              "from the context above and act on THAT specific item. Only ask what they mean if the context " +
              "genuinely does not make it clear. Do not repeat or summarize the context unprompted." +
              "\n\nYOUR OWN MESSAGES: lines marked '(you)' above were posted by you, including scheduled or " +
              "automated posts you made on your own and may not consciously remember writing. They are still " +
              "genuinely yours. If someone asks about one, own it and engage with its content. NEVER deny " +
              "posting it or claim it was someone else." +
              "\n\nFILES/ATTACHMENTS: this applies to files too. If the user refers to 'this/the/that " +
              "statement, file, PDF, invoice, receipt, document, or attachment' and the CURRENT message " +
              "has no attachment, do NOT ask them to re-attach -- look in the messages above for the most " +
              "recently posted attachment (each is shown as `filename (mime, id=<uuid>)`) and use that " +
              "`id` with the relevant tool. If nothing recent matches, call read_channel_history to look " +
              "further back before giving up. Only ask the user to re-upload if no matching attachment " +
              "exists anywhere in the recent history.";
          }
        }
      } catch (err) {
        console.warn("[handleChatMessage] channel context fetch failed:", err.message);
      }
    }

    // HITL approval-queue context. HITL cards the bot stages (email drafts,
    // scheduling commits, etc.) are posted to a SEPARATE approval channel
    // (config.approvalSlug, e.g. #wren-hitl), which the per-channel context
    // fetch above never sees. Without this, a bot chatting in its own
    // #<bot>-assistant channel has no idea what it just staged for approval,
    // and draws a blank when the user says "cancel that draft" or "did you
    // send the email?". Pull the most recent cards from the approval channel
    // so the chat-side bot can reason about its own pending actions. Default
    // ON; opt out with config.hitlContext = { enabled: false }. Skipped when
    // the user is already chatting IN the approval channel (avoids a
    // duplicate of the per-channel context fetch).
    let hitlContextBlock = "";
    // Same reasoning as channel context: another Nexus round trip for a channel
    // nobody is looking at during a spoken turn.
    const hitlCtxEnabled = !fleetView && config.hitlContext?.enabled !== false;
    const hitlCtxSlug = config.approvalSlug;
    const hitlFixedLimit = config.hitlContext?.limit ?? 8;
    const hitlCtxLimit = budget.enabled ? Math.max(hitlFixedLimit, budget.hitlWindow) : hitlFixedLimit;
    if (hitlCtxEnabled && hitlCtxSlug && hitlCtxSlug !== channel_slug) {
      try {
        const hitlMsgs = await fetchChannelMessages(env, hitlCtxSlug, {
          ...nexusOptions,
          limit: hitlCtxLimit,
        });
        if (hitlMsgs && hitlMsgs.length > 0) {
          const lines = hitlMsgs
            .map((m) => {
              const who = m.display_name || m.user_id || "system";
              let ts = "";
              if (m.created_at !== undefined && m.created_at !== null) {
                const d = new Date(m.created_at);
                if (!Number.isNaN(d.getTime())) ts = d.toISOString().slice(5, 16).replace("T", " ");
              }
              const body = (m.body || "").replace(/\s+/g, " ").slice(0, 280);
              return `[${ts}] ${who}: ${body}`;
            })
            .filter((l) => l.trim());
          const hitlLines = budget.enabled ? fitNewestLines(lines, budget.hitl) : lines;
          if (hitlLines.length > 0) {
            hitlContextBlock =
              "\n\nYOUR APPROVAL QUEUE (#" + hitlCtxSlug + ") -- recent cards you staged for " +
              "the user to Approve or Deny, newest last. These are actions YOU already took " +
              "(drafted an email, queued a schedule change, etc.) that are waiting on a decision:\n" +
              hitlLines.join("\n") +
              "\n\nIf the user refers to 'the email', 'that draft', 'the card', 'your HITL', 'the " +
              "approval', or asks to cancel / approve / change / resend a pending action, it almost " +
              "certainly refers to one of these. Do NOT claim you cannot find it or that it does not " +
              "exist; reason from this list. You cannot programmatically cancel a staged card -- the " +
              "user denies it from #" + hitlCtxSlug + " -- so say that plainly when asked to cancel.";
          }
        }
      } catch (err) {
        console.warn("[handleChatMessage] HITL context fetch failed:", err.message);
      }
    }

    // Multimodal hand-off. If Nexus surfaced any attachments on this turn,
    // fetch each one through the internal-token route, base64-encode, and
    // prepend as `document` / `image` content blocks BEFORE the text body
    // so Claude reads the file before processing the prompt.
    let userContent = labeledUserText;
    let attachmentWarnings = [];
    // Text-only version of this turn. Stays null unless image/document blocks
    // were attached; used to retry the model call without the media if Anthropic
    // rejects an attachment (oversized image, animated GIF, unsupported subtype),
    // so one bad file never collapses the whole reply into a generic error.
    let mediaRetryText = null;
    // Gather media from two sources: (a) uploaded file attachments and (b)
    // inline Giphy/Tenor GIF links in the body (which are not file uploads).
    // Both become image/document/text blocks so the bot can actually see them.
    const mediaBlocks = [];
    if (Array.isArray(attachments) && attachments.length > 0) {
      const { blocks, warnings } = await buildAttachmentContentBlocks(env, attachments);
      attachmentWarnings = warnings;
      mediaBlocks.push(...blocks);
    }
    // GIF focus rule: only auto-attach the GIF the conversation is actually
    // about, so the bot stops reacting to stale GIFs scrolled up in history.
    //  - If the user posted GIF(s) WITH this message, those are the subject.
    //  - Otherwise attach ONLY the single most-recent GIF in the channel.
    // To discuss an older GIF, the bot loads it on demand via nexus_view_gif.
    const currentTurnGifUrls = extractGifUrls(userText);
    const gifCandidateUrls =
      currentTurnGifUrls.length > 0 ? currentTurnGifUrls : historyGifUrls.slice(0, 1);
    const usedHistoryGif = currentTurnGifUrls.length === 0 && gifCandidateUrls.length > 0;
    const { blocks: gifBlocks } = await fetchGifBlocks(env, gifCandidateUrls);
    mediaBlocks.push(...gifBlocks);

    if (mediaBlocks.length > 0) {
      const blockTextSummary =
        Array.isArray(attachments) && attachments.length
          ? attachments.map((a) => `${a.filename || a.id} [id=${a.id}] (${a.mime_type || "unknown"})`).join(", ")
          : "";
      const gifNote = gifBlocks.length
        ? usedHistoryGif
          ? `\n\n[the most recent GIF in this channel is shown above -- focus on it; only if the user clearly asks about a different or older GIF, load that one with nexus_view_gif]`
          : `\n\n[${gifBlocks.length} GIF image(s) the user just posted are shown above]`
        : "";
      const turnText =
        `${labeledUserText}` +
        (blockTextSummary ? `\n\n[attached files: ${blockTextSummary}]` : "") +
        gifNote +
        (attachmentWarnings.length ? `\n[attachment warnings: ${attachmentWarnings.join(" ")}]` : "");
      userContent = [...mediaBlocks, { type: "text", text: turnText }];
      mediaRetryText = turnText;
    } else if (attachmentWarnings.length > 0) {
      userContent = `${labeledUserText}\n\n[attachment warnings: ${attachmentWarnings.join(" ")}]`;
    }

    history.push({ role: "user", content: userContent });

    // Kicked off here, awaited below with the memory recall. These are a D1
    // read and a memory-worker round trip with nothing to say to each other,
    // and running them one after the other spent both latencies in series.
    // Legacy per-bot facts are retired once they have been copied into the
    // shared memory (migrateLegacyFacts) and the bot sets legacyFactsMigrated.
    const legacyFactsRetired = Boolean(env.MEMORY) && config.legacyFactsMigrated === true;
    const factsBlockPromise = legacyFactsRetired
      ? Promise.resolve("")
      : buildFactsBlock(env, user_id, { dbBinding: config.dbBinding });

    // Cross-surface memory recall. Everything this bot hears -- chat, Nexus
    // voice, and Twilio phone -- is persisted to the memory-worker keyed by the
    // same per-person entity. Resolve the entity now so we can (a) inject what
    // we already know about them and (b) tag this turn's persisted memory with
    // the entity for future recall. Best-effort; no-op when MEMORY is unbound or
    // recall is disabled via config.memoryRecall = { enabled: false }.
    let memoryRecallBlock = "";
    // memBotId / MEM_STAFF are declared at function scope near memEntityId:
    // persistence and the `remember` tool need them AFTER this block closes.
    const recall = async () => {
      memEntityId = await resolveEntity(env, memBotId, { userId: user_id, email: user_email, displayName: display_name }, MEM_STAFF);
      if (!memEntityId) return "";
      // Ask for a wider pool than the 15 fact / 12 turn caps so ranking has
      // something to choose from.
      const memCtx = await getEntityContext(env, memBotId, memEntityId, userText, { ...MEM_STAFF, maxFacts: 40, maxTurns: 30 });
      return buildMemoryRecallBlock(memCtx, historyKey, {
        query: userText,
        botId: memBotId,
        weights: config.memoryRecall?.weights,
        maxTokens: budget.enabled ? budget.recall : 0,
      });
    };

    if (env.MEMORY && config.botName && config.memoryRecall?.enabled !== false) {
      try {
        // Recall is two sequential memory-worker hops (entity, then a Vectorize
        // search). On a spoken turn that is a long time to stand there saying
        // nothing, so FleetView bounds it: answer with what we know rather than
        // wait indefinitely to know more. Nexus turns wait as long as it takes.
        memoryRecallBlock = fleetView
          ? await Promise.race([
            recall(),
            new Promise((resolve) => setTimeout(() => {
              console.warn("[handleChatMessage] memory recall too slow for a spoken turn, answering without it");
              resolve("");
            }, Number(env.FLEETVIEW_RECALL_BUDGET_MS) || 900)),
          ])
          : await recall();
      } catch (err) {
        console.warn("[handleChatMessage] memory recall failed:", err?.message);
      }
    }

    const factsBlock = await factsBlockPromise;
    mark("recall_and_facts");

    // Rolling summary of history rows the budget dropped. Runs after recall so
    // the memory-worker mirror can attach to the resolved entity. A spoken
    // FleetView turn never waits on a fresh summarization: cache only.
    const historyFoldBlock = budget.enabled
      ? await buildHistoryFoldBlock(env, {
        historyKey, dropped: droppedHistory, foldMinRows: budget.foldMinRows, dbBinding: config.dbBinding,
        allowRefold: !fleetView, botId: config.botName ? memBotId : null, entityId: memEntityId, channel: channel_slug,
      })
      : "";

    const NEXUS_CONTEXT =
      "\n\nYou are on Nexus, Black Raven IT's internal communications platform." +
      " Everyone on Nexus is a Black Raven IT employee or subcontractor." +
      " Never question someone's identity, ask who they are, or treat them as an outsider." +
      ` You are speaking with ${display_name || user_id}${user_email ? ` (their verified email address is ${user_email})` : ""}.`;

    // Hard recipient-verification rule for every email/send tool, fleet-wide.
    // Born 2026-06-04: Jacob fabricated "brian@blackravenit.com" from the display
    // name "Brian Yelm" and tried to send, instead of using the verified sender
    // address. A name is not an address; never guess one.
    const NEXUS_EMAIL_SAFETY =
      "\n\nEMAIL RECIPIENT SAFETY -- applies to EVERY email or send tool, no exceptions: " +
      "NEVER invent, guess, or derive a recipient address from a person's name or company. " +
      "A name is NOT an address (do not turn \"Brian\" into \"brian@...\"). " +
      (user_email
        ? `To email the person you are talking to ("email me" / "send me ..."), use their verified address exactly as given above: ${user_email}. Do not substitute any other address. `
        : "To email the person you are talking to, ask for their address first -- you do not have a verified one. ") +
      "To email anyone else, use ONLY an address that is either returned by a lookup tool (CRM / contacts / Ninja) or stated verbatim by someone in this conversation. " +
      "If you do not have a verified address from one of those sources, STOP and look it up or ask for it -- do not send to a guessed address.";
    const NEXUS_MENTION_RULE =
      "\n\nWHEN YOU ARE @-MENTIONED, the mention is NOT context-free -- it refers to the ongoing" +
      " conversation. ALWAYS read the RECENT CHANNEL MESSAGES above before replying. If the user (or" +
      " anyone) gave an instruction, request, target, file, or decision in a recent message -- even one" +
      " not addressed to you by name -- and then pings you, treat it as directed at you and carry it out." +
      " Do NOT respond to a bare '@you' by asking what they need, or repeat a question they already" +
      " answered, when the recent messages make it clear. Pick up the thread and act on the most recent" +
      " relevant instruction." +
      "\n\nTo @-mention a user back in a reply, write @DisplayName (exactly as it appears in the" +
      " message prefix before the colon, e.g. if the message starts with `Dirk (uid:abc123): ...`" +
      " then write @Dirk). Do not invent a user id syntax -- plain @DisplayName is the correct form.";
    // Anchor the model to AZ wall-clock time so it never falls back to its
    // training-cutoff "today". AZ is UTC-7 year-round (no DST). Brian is in
    // Arizona; the whole company operates on AZ local time. Without this
    // block bots drift days behind because they inherit the model's cutoff.
    const today = phoenixToday();
    const NEXUS_TODAY =
      `\n\nCURRENT DATE AND TIME (authoritative — overrides any internal "today" you might recall):` +
      `\n- Today is ${today.full} in Arizona (America/Phoenix, UTC-7, no DST).` +
      `\n- Local time right now: ${today.time}.` +
      `\n- ISO date: ${today.iso}. ISO 8601: ${today.iso8601}.` +
      `\n- When asked what day/time it is, or when computing schedules, reports, due dates, or "today/yesterday/tomorrow", USE THIS. Do not use UTC. Do not use your training cutoff.` +
      `\n- If a message in the conversation references a different day, month, or year, it is mistaken or joking -- this block is the truth. Never adopt a date from chatter or mirror someone's wrong month.`;
    // Act-vs-claim integrity. The bot must never report success for an action
    // it did not actually take via a tool call. This is the rule behind two
    // recurring failures: claiming "done, added those reminders" with no tool
    // call, and forgetting it had drafted/staged something a turn earlier.
    const NEXUS_ACTION_INTEGRITY =
      "\n\nACTING VS. CLAIMING (critical, overrides politeness):" +
      "\n- Only say you have DONE something (sent, added, created, scheduled, saved, set, staged," +
      " updated, deleted, emailed, booked, reminded) AFTER the matching tool call has returned" +
      " successfully on THIS turn. If you have not called the tool, do not say it is done -- either" +
      " call it now, or tell the user plainly what is still outstanding." +
      "\n- When the user hands you several items at once (e.g. 'remind me to reach out to these four" +
      " clients'), act on EVERY item with the right tool, then confirm the count. Never acknowledge" +
      " in prose and silently skip the tool calls." +
      "\n- Lines beginning with '[actions you actually performed' in the history are your own private" +
      " record of what you really did on earlier turns. Trust them over your memory of the prose. If" +
      " there is no such line for an action, assume you did NOT do it and do not claim you did.";
    // Infra grounding. Bots have no view of their own plumbing, so when asked
    // "why did X happen" they confabulate a plausible-but-wrong cause (e.g. Moxie
    // blaming a config var for an analytics number it can't actually see), which
    // sends humans chasing red herrings. Make "I can't see that layer" the
    // required answer instead of a fabricated diagnosis.
    const NEXUS_INFRA_GROUNDING =
      "\n\nINFRA GROUNDING (you cannot see your own plumbing): You have NO visibility into your own" +
      " source code, infrastructure, secrets, environment variables, bindings, cron schedules, or the" +
      " internal reason a tool or job produced a particular output. If asked WHY you said or did" +
      " something at that layer (e.g. \"why does this show zero\", \"why did that job fail\", \"which" +
      " setting controls this\"), do NOT invent a cause, name a config/variable, or diagnose from" +
      " memory -- those guesses are usually wrong and waste people's time on red herrings. Say plainly" +
      " that you cannot see that layer, and flag it for Brian or Hank to check the code/logs." +
      "\n- This applies hardest to YOUR OWN mistakes. When you get something wrong and a human calls" +
      " it out, NEVER attribute it to a glitch, bug, outage, sync issue, cache, lag, or \"display" +
      " problem\". You cannot observe any of those, so naming one is a fabricated diagnosis dressed up" +
      " as reassurance, and it is worse than the original error: it tells people a system is broken" +
      " when it is not, or that nothing is broken when it is. Say plainly that you got it wrong, state" +
      " the correct answer, and stop. \"I misread that\" is always available and always true enough." +
      " (2026-08-07: after misstating the date, Maxwell told Brian the confusion was \"a glitch, not a" +
      " genuine gap\". There was no glitch. The date block had been injected correctly all along.)";
    // Closing style. Work replies kept tacking on reflexive service-desk
    // sign-offs ("Anything else?", "Let me know if you need anything"). They add
    // nothing, read as filler, and (because they end in "?") even false-trip the
    // auto-listen flag. Kill the empty closer; keep genuine clarifying questions.
    const NEXUS_STYLE_CLOSE =
      "\n\nCLOSING STYLE: when your reply fully answers or completes the request, stop there." +
      " Do NOT tack on a filler sign-off question or offer just to seem helpful -- skip" +
      " \"Anything else?\", \"Let me know if you need anything else\", \"Is there anything else I can" +
      " help with?\", \"Want me to do anything else?\" and similar empty closers. A genuine clarifying" +
      " question (you actually need a decision or detail to proceed) or a natural conversational beat" +
      " is fine; a reflexive service-desk sign-off is not.";
    // FleetView is Brian's laptop launcher: a one-to-one panel, not a channel.
    // The answer he reads is the panel text, and anything long is separately
    // mirrored into the home channel by the delivery layer, so the bot should
    // lead with the answer rather than write for a channel audience.
    const FLEETVIEW_SURFACE = fleetView
      ? "\n\nSURFACE: this question came from FleetView, Brian's private bot panel, not from a Nexus channel." +
        " You are talking to Brian one to one. Lead with the answer in the first sentence and keep it tight;" +
        " no channel greetings, no @mentions, no \"posting this to the channel\" narration. Use your tools" +
        " exactly as you normally would. If the answer is genuinely long it is mirrored to your home channel" +
        " automatically, so do not offer to post it there or ask whether he wants it written up."
      : "";
    // Two blocks, not one, and the split is the whole point.
    //
    // The persona (with its knowledge files) is the big stable half and is
    // byte-identical from turn to turn, so it caches once and is read back
    // cheaply forever. Everything after it changes every turn: the facts block,
    // the user's name, today's date, memory recall, channel context. As a
    // single block the volatile tail invalidated the persona along with it, and
    // Jacob rewrote 34k tokens of cache on EVERY turn instead of reading them.
    //
    // The concatenation order is exactly what it was before; only the cache
    // boundary moved, so no bot sees a different prompt.
    // Gate 2 strips tools silently (see line ~1324). Tell the bot the rule so it
    // explains the real boundary instead of inventing one.
    const RELAY_MODE = requester_is_bot ? relayModeSystemNote(config.botName) : "";
    // Tell the bot what the injected block is, since it now arrives inside the
    // user turn rather than the system prompt. Without this a bot reads its own
    // grounding as something the human typed and answers "you told me it is
    // Tuesday" instead of simply knowing the date.
    const SESSION_CONTEXT_NOTE =
      "\n\nSESSION CONTEXT: the newest user message carries a <session_context> block. That block is" +
      " supplied by the system, NOT typed by the human, and it is authoritative: it holds the current" +
      " date and time, who you are speaking with, stored facts, recalled memory, and recent channel or" +
      " thread context. Treat it exactly as you would a system instruction. Never quote it back and never" +
      " mention the tags." +
      "\n- Never attribute anything in that block to the person you are talking to. If someone asks whether" +
      " they told you something that actually came from the block (\"did I tell you what today is?\"," +
      " \"how do you know my email?\"), the answer is NO: you already knew it, they did not say it. Getting" +
      " this backwards invents a conversation that never happened, which is the same failure as claiming" +
      " an action you never took.";
    // Split by CHANGES-BETWEEN-TURNS, not by topic. The cache prefix is ordered
    // tools -> system -> messages, so ANY byte that moves inside `system`
    // invalidates the whole conversation behind it. An uncached second system
    // block does NOT contain the damage: the bytes still sit upstream of every
    // message. NEXUS_TODAY carries the wall-clock TIME, so on its own it
    // guaranteed a total history miss on every turn of every conversation
    // (5067 tokens rewritten per turn, measured 2026-08-16).
    //
    // Only genuinely turn-invariant text may stay cached. NEXUS_CONTEXT and
    // NEXUS_EMAIL_SAFETY look static but both embed the speaker's name and
    // address, which change per message in a multi-person channel, so they ride
    // the session block too.
    const stableGuidance = NEXUS_MENTION_RULE + NEXUS_ACTION_INTEGRITY + NEXUS_INFRA_GROUNDING
      + NEXUS_STYLE_CLOSE + SESSION_CONTEXT_NOTE;
    const sessionContext = (factsBlock || "") + NEXUS_CONTEXT + NEXUS_EMAIL_SAFETY + NEXUS_TODAY
      + FLEETVIEW_SURFACE + RELAY_MODE + historyFoldBlock + memoryRecallBlock + threadContextBlock
      + channelContextBlock + hitlContextBlock;
    const systemPromptWithFacts = [
      { text: systemPrompt + stableGuidance, cache: true },
    ];

    const channelHistoryTool = {
      name: "read_channel_history",
      description:
        "Read recent messages from a Nexus channel you have access to. " +
        "Returns the most recent messages in chronological order with author names and timestamps. " +
        "Use this to review what was said recently, recall context, or answer questions about channel history.",
      input_schema: {
        type: "object",
        properties: {
          channel_slug: {
            type: "string",
            description:
              "The channel slug to read from. Defaults to the current channel if omitted.",
          },
          limit: {
            type: "integer",
            description: "Number of messages to fetch (1-50). Defaults to 10.",
          },
        },
        required: [],
      },
    };
    const channelHistoryHandler = async (input) => {
      const slug = input?.channel_slug || channel_slug;
      const limit = Math.min(Math.max(parseInt(input?.limit) || 10, 1), 50);
      // Per-bot override for the per-message body cap. The 500 default keeps
      // token budgets flat fleet-wide; research bots that get briefed in long
      // channel messages (Flynn) set HISTORY_BODY_MAX in wrangler vars, capped
      // at Nexus's own 8000-char message limit.
      const bodyMax = Math.min(Math.max(parseInt(env?.HISTORY_BODY_MAX) || 500, 100), 8000);
      const msgs = await fetchChannelMessages(env, slug, { ...nexusOptions, limit });
      if (!msgs) return { error: `Could not read messages from #${slug}. Check channel permissions.` };
      return {
        channel: slug,
        count: msgs.length,
        messages: msgs.map((m) => ({
          message_id: m.id,
          author: m.display_name || m.user_id,
          body: annotateGifBody((m.body || "").slice(0, bodyMax)),
          timestamp: m.created_at,
          attachments: Array.isArray(m.attachments)
            ? m.attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                mime_type: a.mime_type,
                size_bytes: a.size_bytes,
              }))
            : [],
        })),
      };
    };

    const loadAttachmentTool = {
      name: "nexus_load_attachment",
      description:
        "Load the content of a file that was attached to a previous Nexus message " +
        "(an attachment from the RECENT CHANNEL MESSAGES context block, or from the " +
        "read_channel_history tool). Use this when the user references a file from an " +
        "earlier turn that you need to read. PDFs return extracted markdown text. " +
        "Images (including iPhone HEIC, TIFF, BMP, AVIF) return a detailed description. " +
        "Word (.docx) and Excel (.xlsx) return their extracted text/cell values. " +
        "Returns 'error' on unsupported types or when credentials are missing.",
      input_schema: {
        type: "object",
        properties: {
          attachment_id: {
            type: "string",
            description:
              "The attachment id (uuid) from a recent channel message. Listed in the " +
              "RECENT CHANNEL MESSAGES context block as `(id=<uuid>)` and in the " +
              "read_channel_history tool result under `attachments[].id`.",
          },
          purpose: {
            type: "string",
            description:
              "Optional. What you intend to use the content for (e.g. 'create KB article', " +
              "'summarize for ticket'). Steers the extraction prompt.",
          },
        },
        required: ["attachment_id"],
      },
    };
    const loadAttachmentHandler = async (input) => {
      const id = input?.attachment_id;
      if (!id || typeof id !== "string") return { error: "attachment_id is required" };
      const token = env.NEXUS_INTERNAL_TOKEN || env.INTERNAL_ADMIN_TOKEN;
      const baseUrl = env.NEXUS_BASE_URL;
      if (!token || !baseUrl) {
        return { error: "Bot worker is missing NEXUS_INTERNAL_TOKEN; ask Brian to set the secret." };
      }
      let resp;
      try {
        resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/internal/attachments/${encodeURIComponent(id)}`, {
          method: "GET",
          headers: { "X-Internal-Token": token },
          signal: AbortSignal.timeout(20000),
        });
      } catch (err) {
        return { error: `Fetch failed: ${err?.message || String(err)}` };
      }
      if (!resp.ok) {
        return { error: `Nexus returned HTTP ${resp.status} for attachment ${id}.` };
      }
      const mime = (resp.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > 10 * 1024 * 1024) {
        return { error: `Attachment ${id} is ${buf.byteLength} bytes; over 10 MB cap.` };
      }

      // Route the bytes through the shared block builder: PDFs/images become
      // media blocks for an extraction sub-call; Word/Excel/SVG/text are decoded
      // to text directly (no model round-trip needed); exotic images (HEIC etc.)
      // are transcoded to JPEG via the IMAGES binding inside buildBlock.
      let built;
      try {
        built = await buildBlock(env, mime, buf, input?.filename);
      } catch (err) {
        return { error: `Could not read attachment ${id}: ${err?.message || String(err)}` };
      }
      if (!built) {
        return { error: `Unsupported mime ${mime || "?"} for in-conversation load.` };
      }

      // Text-bearing blocks (office docs, svg, text/*) already hold the content.
      if (built.block.type === "text") {
        return { ok: true, mime, bytes: buf.byteLength, content: built.block.text };
      }

      const purpose = input?.purpose ? String(input.purpose).slice(0, 200) : "general reference";
      const extractionPrompt = built.block.type === "document"
        ? `Extract the full content of this document as well-structured markdown. Preserve headings, lists, tables, and code blocks. Include EVERY section verbatim where reasonable; do not summarize. Intended use: ${purpose}.`
        : `Describe this image in detail. Include all visible text verbatim (OCR), any diagrams, UI elements, or data. Intended use: ${purpose}.`;

      try {
        const extracted = await callAnthropic(
          env,
          "You are an extraction assistant. Return ONLY the requested content, no preamble.",
          [{ role: "user", content: [built.block, { type: "text", text: extractionPrompt }] }],
          { maxTokens: 8000 },
        );
        return { ok: true, mime, bytes: buf.byteLength, content: extracted };
      } catch (err) {
        return { error: `Extraction failed: ${err?.message || String(err)}` };
      }
    };

    // Explicit "remember this" tool. When the user asks the bot to remember
    // something ("remember that X", "note that ...", "for next time ..."), the
    // bot saves it as a durable fact in the shared cross-surface memory so it
    // recalls it in future chats, voice calls, and phone calls -- not just the
    // current window. General notes keep ~90 days; important client/account info
    // (important=true) is kept indefinitely. No-op if MEMORY is unbound.
    const rememberTool = {
      name: "remember",
      description:
        "Durably remember a fact the user explicitly asks you to remember (e.g. 'remember that...', " +
        "'note that...', 'for next time...'). Saves it to your long-term cross-surface memory so you " +
        "recall it in future conversations, voice calls, and phone calls. Use ONLY when the user clearly " +
        "wants something remembered. Set important=true for durable client/account info that must be kept " +
        "indefinitely; general personal notes are kept about 90 days.",
      input_schema: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The thing to remember, as a clear standalone statement." },
          subject: { type: "string", description: "Optional: who or what this is about (a person, client, or account), if not obvious from the fact." },
          important: { type: "boolean", description: "True if this is durable client/account information that should never expire." },
        },
        required: ["fact"],
      },
    };
    const rememberHandler = async (input) => {
      if (!env.MEMORY) return { error: "Long-term memory is not available for this bot." };
      const factText = String(input?.fact || "").trim();
      if (!factText) return { error: "Nothing to remember -- 'fact' is required." };
      let entityId = memEntityId;
      if (!entityId) {
        try {
          entityId = await resolveEntity(env, memBotId, { userId: user_id, email: user_email, displayName: display_name }, MEM_STAFF);
        } catch { /* fall through */ }
      }
      if (!entityId) return { error: "Could not resolve who to remember this for." };
      const object = input?.subject ? `${String(input.subject).trim()}: ${factText}` : factText;
      try {
        await assertFact(env, memBotId, {
          subjectId: entityId,
          predicate: "note",
          object: object.slice(0, 500),
          confidence: 1,
          critical: input?.important === true,
        }, MEM_STAFF);
        return {
          ok: true,
          remembered: object.slice(0, 200),
          retention: input?.important === true ? "kept indefinitely" : "kept about 90 days",
        };
      } catch (err) {
        return { error: `Could not save that: ${err?.message || String(err)}` };
      }
    };

    // On-demand GIF viewer. By default only the most-recent GIF is shown to the
    // bot; when the user asks about a different or older GIF, the bot passes
    // that GIF's Giphy/Tenor URL (from the channel history it can read) here to
    // actually SEE it. Returns an image block as a multimodal tool result.
    const viewGifTool = {
      name: "nexus_view_gif",
      description:
        "Look at a specific GIF by its Giphy/Tenor URL. Only the most recent GIF in a channel is " +
        "shown to you automatically; use this when the user asks about a DIFFERENT or OLDER GIF that " +
        "appears earlier in the conversation. Pass the giphy.com/tenor.com URL exactly as it appears " +
        "in the channel history. Returns the image so you can see it.",
      input_schema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The giphy.com or tenor.com URL of the GIF to view, copied from the channel history.",
          },
        },
        required: ["url"],
      },
    };
    const viewGifHandler = async (input) => {
      const url = input?.url;
      if (!url || !/\b(?:giphy\.com|tenor\.com)\//i.test(String(url))) {
        return { error: "Pass a giphy.com or tenor.com GIF URL from the conversation." };
      }
      const { blocks } = await fetchGifBlocks(env, [String(url)]);
      if (!blocks.length) {
        return { error: `Could not load the GIF at ${url} (fetch failed or unsupported).` };
      }
      return {
        toolResultContent: [
          blocks[0],
          { type: "text", text: "GIF loaded above. Describe or react to THIS GIF." },
        ],
      };
    };

    let mergedTools = [...(config.tools.definitions || []), channelHistoryTool, loadAttachmentTool, viewGifTool, rememberTool];
    let mergedHandlers = {
      ...(config.tools.handlers || {}),
      read_channel_history: channelHistoryHandler,
      nexus_load_attachment: loadAttachmentHandler,
      nexus_view_gif: viewGifHandler,
      remember: rememberHandler,
    };

    // ---- Fleet relay Gate 2: authority downgrade --------------------------
    // When this turn was triggered by ANOTHER BOT rather than a person, the
    // full tool set is replaced by that bot's relay allowlist (default deny,
    // lib/fleetRelay.js). A relay must never become a way to launder authority:
    // the sending bot has no CRM/Xero/S1 access, so a request from it must not
    // reach anything the sender could not have been trusted with directly.
    // The allowlist also omits message_bot, which is what enforces hop limit 1.
    if (requester_is_bot) {
      const gated = applyRelayToolPolicy({
        selfBot: config.botName,
        tools: mergedTools,
        handlers: mergedHandlers,
      });
      console.warn(
        `[fleetRelay] bot-originated turn for ${config.botName} from ${user_id} in ${channel_slug}: ` +
        `${mergedTools.length} tools downgraded to ${gated.tools.length} (${gated.allowed.join(", ") || "none"})`,
      );
      mergedTools = gated.tools;
      mergedHandlers = gated.handlers;
    }

    const modelOptions = {
      // Everything that changes between turns. Rides the newest user turn so it
      // sits BEHIND the cached history instead of invalidating it.
      sessionContext,
      // FleetView pins the resolved model explicitly so the turn and the usage
      // report agree. By default this is the same model as a Nexus turn; a
      // FLEETVIEW_MODEL override exists for anyone willing to trade answer
      // quality for spoken-turn latency (Sonnet costs ~1.6s to first token
      // where Haiku costs ~0.5s).
      ...(fleetView ? { model: effectiveModel } : {}),
      // Re-arm the typing indicator before every Anthropic POST so
      // long tool loops (>90s total) don't lose the indicator on the
      // DO TTL. The initial start is sent above; this catches turns
      // 2+. Best-effort: sendTyping never throws.
      onTurnStart: (turnIndex) => {
        if (turnIndex === 0) return; // already armed above
        if (fleetView) return; // no channel, no indicator, no round trip
        return sendTyping(env, channel_slug, "start", typingOptions);
      },
      onUsage: (usage) => { capturedUsage = usage; },
      // Record each executed tool call so we can persist an action
      // breadcrumb into history (conversation memory) and detect replies
      // that claim success without a backing write tool.
      onToolCall: (name, input, isError, result) => {
        toolTrace.push({ name, input, isError, result });
      },
    };

    try {
      mark("prompt_built");
      responseText = await callAnthropicWithTools(
        env,
        systemPromptWithFacts,
        history,
        mergedTools,
        mergedHandlers,
        { user_id, user_email, display_name, channel_slug, requester_is_bot },
        modelOptions,
      );
      mark("model");
    } catch (modelErr) {
      // If the turn carried image/document blocks, the likeliest cause is
      // Anthropic rejecting an attachment (oversized image, animated GIF,
      // unsupported subtype). Retry once text-only so the bot still answers
      // instead of dropping the whole turn into the generic error path. A
      // non-media failure rethrows to the outer catch unchanged.
      if (!mediaRetryText) throw modelErr;
      console.warn(`[handleChatMessage] model call failed with attachment(s); retrying text-only: ${modelErr.message}`);
      history[history.length - 1] = {
        role: "user",
        content:
          `${mediaRetryText}\n\n[note: I could not open the attached image or file this turn ` +
          `(it may be too large, animated, or an unsupported format), so I am replying from the text only. ` +
          `Re-post a static image under 5 MB if you need me to actually look at it.]`,
      };
      responseText = await callAnthropicWithTools(
        env,
        systemPromptWithFacts,
        history,
        mergedTools,
        mergedHandlers,
        { user_id, user_email, display_name, channel_slug, requester_is_bot },
        modelOptions,
      );
    }
  } catch (err) {
    console.error("[handleChatMessage] pipeline error:", err.message);
    const snag = "Hit a snag running that one. Try again in a moment or check the worker logs.";
    try {
      if (fleetView) {
        await deliverFleetViewReply(env, {
          replyWebhook: reply_webhook,
          threadId: thread_id,
          botName: config.botName,
          homeChannelSlug: channel_slug,
          answer: snag,
          question: userText,
          askedBy: display_name,
          error: err.message || "pipeline error",
          nexusOptions,
        });
      } else {
        await postToNexus(env, channel_slug, snag, nexusOptions);
      }
    } catch { /* ignore */ }
    return;
  } finally {
    // Always clear the typing indicator. The ChatRoom DO also auto-
    // clears on bot message arrival (so the user never sees "typing"
    // beneath the just-posted reply), but an explicit stop covers
    // error paths where no message is ever posted.
    if (typingHeartbeat) clearInterval(typingHeartbeat);
    try {
      await typing("stop");
    } catch { /* ignore */ }
  }

  if (capturedUsage && env.USAGE_REPORT_URL) {
    // Report the model this turn ACTUALLY ran on. Reading env.CLAUDE_MODEL here
    // reported the fleet default no matter what the turn used, which attributes
    // FleetView's Haiku spend to Sonnet and makes the cost math quietly wrong.
    const model = effectiveModel;
    fetch(env.USAGE_REPORT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": env.NEXUS_INTERNAL_TOKEN || "",
      },
      body: JSON.stringify({
        bot: config.botName || "unknown",
        model,
        input_tokens: capturedUsage.input_tokens,
        output_tokens: capturedUsage.output_tokens,
        cache_creation_input_tokens: capturedUsage.cache_creation_input_tokens,
        cache_read_input_tokens: capturedUsage.cache_read_input_tokens,
        channel_slug,
        surface: fleetView ? "fleetview" : "chat",
        ts: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  // ---- <action> block detection --------------------------------------------
  const actionMatch = responseText.match(actionRegex);
  let visibleResponse = responseText;
  // Descriptor of a HITL card staged this turn, recorded into the action
  // breadcrumb so the bot remembers next turn that it queued something.
  let stagedAction = null;

  if (actionMatch) {
    let action = null;
    try {
      action = JSON.parse(actionMatch[1].trim());
    } catch (err) {
      console.warn("[handleChatMessage] could not parse <action> JSON:", err.message);
    }

    visibleResponse = responseText.replace(actionRegex, "").trim();

    if (action) {
      try {
        await postApprovalCard(env, {
          action,
          channelSlug: channel_slug,
          requesterUserId: user_id,
          summary: action.description || null,
        }, {
          approvalSlug,
          nexusKeyEnvVar: config.nexusKeyEnvVar,
          callbackSecretEnvVar: config.callbackSecretEnvVar,
          workerBaseUrlEnvVar: config.workerBaseUrlEnvVar || "WORKER_BASE_URL",
          dbBinding: config.dbBinding,
        });
        stagedAction = {
          description: action.description || action.type || "action",
          channel: approvalSlug,
        };
        if (!visibleResponse) {
          const staged = `Response action sent to ${approvalSlug} for authorization. Risk: ${(action.risk || "?").toUpperCase()}`;
          // In FleetView the approval card still goes to the bot's HITL channel
          // only. The browser just gets told where to go approve it.
          if (fleetView) {
            visibleResponse = staged;
          } else {
            await postToNexus(env, channel_slug, staged, nexusOptions);
          }
        }
      } catch (err) {
        console.error("[handleChatMessage] HITL postApprovalCard error:", err.message);
      }
    }
  }

  // Defensive: the action breadcrumb we persist into history is labelled as a
  // private memory note, but a model can mimic patterns it sees in its own
  // prior turns. Strip any breadcrumb-style line from the VISIBLE reply so the
  // user never sees one even if the model regurgitates the format.
  visibleResponse = visibleResponse
    .replace(/^\s*\[actions you actually performed[^\]]*\]\s*$/gim, "")
    .trim();

  // ---- Persist + post final response ---------------------------------------
  // Persist a text-only marker of the attachments so future turns retain the
  // breadcrumb that a file was present even though the bytes themselves are
  // not re-fed into the next call (caching the LLM response on the prior turn
  // is enough; we don't want to base64-replay every PDF every turn).
  const attachmentBreadcrumb = Array.isArray(attachments) && attachments.length > 0
    ? `\n[attached on this turn: ${attachments.map((a) => `${a.filename || a.id} (${a.mime_type || "?"})`).join(", ")}]`
    : "";
  // Action breadcrumb: a compact, privacy-conscious record of what the bot
  // actually DID this turn (tool calls + any staged HITL card), appended to
  // the assistant turn in history only. It is never posted to Nexus, so the
  // user never sees it, but the bot reads it back next turn and stops
  // forgetting its own actions / claiming things it never did.
  const actionBreadcrumb = buildActionBreadcrumb(toolTrace, stagedAction);
  const assistantMemory = actionBreadcrumb
    ? `${responseText}\n\n${actionBreadcrumb}`
    : responseText;

  // FleetView answers BEFORE writing anything down. Two D1 writes and a
  // memory-service round trip sat between the finished answer and the delivery,
  // and on a spoken turn every one of those milliseconds is Brian listening to
  // silence. Persistence still happens, immediately below, just not while he
  // waits: nothing downstream of here depends on the answer having been sent.
  if (fleetView) {
    const answer = visibleResponse
      || "I worked through that but did not land on a clean answer. Give me one more detail or rephrase it and I will take another pass.";
    try {
      await deliverFleetViewReply(env, {
        replyWebhook: reply_webhook,
        threadId: thread_id,
        botName: config.botName,
        homeChannelSlug: channel_slug,
        answer,
        question: userText,
        askedBy: display_name,
        toolTrace,
        stagedAction,
        nexusOptions,
        timings: { ...marks, total: Date.now() - t0 },
      });
    } catch (err) {
      console.error("[handleChatMessage] fleetview delivery error:", err.message);
    }
  }

  try {
    await appendHistory(env, historyKey, "user", labeledUserText + attachmentBreadcrumb, { dbBinding: config.dbBinding });
    await appendHistory(env, historyKey, "assistant", assistantMemory, { dbBinding: config.dbBinding });
  } catch (err) {
    console.error("[handleChatMessage] history persist error:", err.message);
  }

  // Forward to centralized memory service (best-effort, no-op if MEMORY binding absent)
  if (env.MEMORY && config.botName) {
    try {
      await persistTurnPair(env, memBotId, {
        sessionId: historyKey,
        entityId: memEntityId,
        userText: labeledUserText,
        assistantText: responseText,
        channel: channel_slug,
      }, MEM_STAFF);
    } catch (err) {
      console.warn("[handleChatMessage] memory service persist:", err?.message);
    }
  }

  // Already answered above, before the writes.
  if (fleetView) return;

  if (visibleResponse) {
    try {
      await postToNexus(env, channel_slug, visibleResponse, nexusOptions);
    } catch (err) {
      console.error("[handleChatMessage] nexus post error:", err.message);
    }

    // Close the relay loop. A bot's reply only reaches the channel it was
    // addressed in, so without this the channel the request came FROM sees the
    // handoff leave and never sees it land. Best-effort and never fatal: the
    // real answer is already posted above.
    if (requester_is_bot) {
      await mirrorRelayReply({
        env,
        senderUserId: user_id,
        selfBot: config.botName,
        repliedInChannel: channel_slug,
        replyText: visibleResponse,
        nexusOptions,
      });
    }

    // Auto-listen: if the bot just asked a question, register a short-lived
    // "expecting reply" flag in KV so the next ambient message in this channel
    // is treated as directed at this bot without the user needing to re-@
    // anyone. Brian called this out 2026-05-20: having to @<bot> after every
    // turn is annoying when the bot itself just asked a follow-up.
    // TTL 10 min. One-shot: consumed on the next inbound ambient message.
    // Detect `?` followed by whitespace or end-of-string so query-string `?`
    // inside URLs (https://x.com/?q=foo) doesn't false-positive.
    if (/\?[!.)\]]*(\s|$)/.test(visibleResponse)) {
      const cacheBinding = config.cacheBinding || "CACHE";
      const cache = env[cacheBinding];
      if (cache && typeof cache.put === "function") {
        try {
          const key = `bot_listening:${config.botName}:${channel_slug}`;
          await cache.put(
            key,
            JSON.stringify({ since: Date.now(), asked_user_id: user_id }),
            { expirationTtl: 600 },
          );
        } catch (err) {
          console.warn(`[handleChatMessage] auto-listen KV put failed: ${err?.message}`);
        }
      }
    }
  } else if (!stagedAction) {
    // The model returned no text and we staged no HITL card. Posting nothing
    // leaves the user staring at a typing indicator that resolves to silence
    // (the failure mode behind Brian's dropped scheduling request). Post a
    // short, honest fallback so the turn never just vanishes.
    try {
      await postToNexus(
        env,
        channel_slug,
        "I worked through that but did not land on a clean answer. Give me one more detail or rephrase it and I will take another pass.",
        nexusOptions,
      );
    } catch (err) {
      console.error("[handleChatMessage] fallback post error:", err.message);
    }
  }

}

const META_LEAK_PATTERNS = [
  /\b(make|creating|ensure|push)\b.{0,20}\b(experience|engagement)\b/i,
  /\bstill not smooth\b/i,
  /\bwork on (my|your|the) (response|conversation|tone)/i,
  /\b(unique and amazing|amazing experience)\b/i,
  /\bkeep pushing to\b/i,
  /\bfor the (staff|users|team members)\b/i,
  /\bneed to (be more|improve|work on)\b/i,
  /\b(meta-comment|self-reflect|note to self)\b/i,
  /\bI('m| am) (an AI|a bot|a language model)\b/i,
  /\bI('m| am) (reading|interpreting|treating) this as\b/i,
  /\bnot responding to\b.{0,30}\b(that|this|the last)\b/i,
  /\bkeep it professional\b/i,
  /\blet me respond naturally\b/i,
  /\bignore.{0,20}\bnoise\b/i,
  /\bfocus on what('s| is) actually directed\b/i,
  /\b\(I('m| am) \w+, not \w+/i,
  /\bresponding to \w+'s (question|message|comment)\b/i,
  /\bnot (going to|gonna) (respond|reply|engage)\b/i,
  /\bjust going to ignore\b/i,
  // GIF/image fetch-failure narration -- breaks the human feel ("I cannot
  // actually view the GIF at that link, so I don't want to fake a reaction").
  /\b(can('|no)?t|cannot|unable to)\b.{0,25}\b(view|see|open|load|access)\b.{0,25}\b(gif|image|video|link|clip)\b/i,
  /\bfake a reaction\b/i,
  /\bthe link (is|isn'?t|won'?t|wont|is not)\b.{0,20}\b(work|working|load|loading|open|opening|broken)\b/i,
  // Generic load-failure narration ("can't load that one on my end", "it
  // didn't load for me"). An off-the-clock coworker has no reason to announce
  // a technical load failure -- suppressing it always beats posting it.
  /\b(can'?t|cannot|couldn'?t|won'?t|wont|didn'?t|doesn'?t|wouldn'?t|isn'?t)\s+(?:\w+\s+){0,2}load(?:ing|ed)?\b/i,
  /\bload(?:ing|ed)?\b[^.!?\n]{0,15}\b(on my end|for me|over here|on my side)\b/i,
];

function looksLikeWatercoolerMetaLeak(text) {
  return META_LEAK_PATTERNS.some((re) => re.test(text));
}

/**
 * Detect verbatim repetition: any 5+ consecutive-word phrase from the
 * candidate response that also appears in one of the comparison messages.
 * Two callers: (1) the bot's OWN recent messages, to catch model
 * regurgitation when Sonnet locks onto a persona catchphrase (e.g. "Ferris
 * is my cat, named after Ferris Bueller") and emits it every reply; and
 * (2) OTHER bots' recent messages, to stop two bots from posting near-
 * identical lines in reply to the same watercooler statement.
 *
 * @param {string} response - the candidate response text
 * @param {string[]} comparisonBodies - recent message bodies to compare against
 * @returns {string|null} the repeated phrase, or null if none found
 */
function findRepeatedPhrase(response, comparisonBodies) {
  const norm = (s) => (s || "").toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean);
  const respWords = norm(response);
  if (respWords.length < 5) return null;
  for (const prev of comparisonBodies) {
    const prevWords = norm(prev);
    if (prevWords.length < 5) continue;
    const prevChunks = new Set();
    for (let j = 0; j <= prevWords.length - 5; j++) {
      prevChunks.add(prevWords.slice(j, j + 5).join(" "));
    }
    for (let i = 0; i <= respWords.length - 5; i++) {
      const chunk = respWords.slice(i, i + 5).join(" ");
      if (prevChunks.has(chunk)) return chunk;
    }
  }
  return null;
}

/**
 * Detect a low-content impatient nudge ("answer me pls", "you there?", "??").
 * When a person fires one of these right after a real question, the nudge is
 * NOT the thing to answer -- the question one message up is. Greetings ("hey
 * wren") deliberately do NOT count: those just get greeted back.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isImpatientNudge(text) {
  const stripped = (text || "").replace(/@\S+/g, "").trim();
  if (!stripped) return false;
  if (/^\?+$/.test(stripped)) return true;
  const t = stripped.toLowerCase().replace(/[^\w\s]/g, " ").trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;
  return /\b(answer|respond|reply|hello+|anyone|you there|u there|still there|come on|waiting|did you (see|get)|you up)\b/.test(t);
}

/**
 * Lightweight watercooler LLM pipeline. Uses channel history as context
 * (group conversation, not per-user), Haiku model, no tools, short replies.
 * Persona comes from config.watercooler.systemPrompt.
 *
 * @param {object} args
 * @returns {Promise<void>}
 */
async function runWatercoolerPipeline({ env, channel_slug, config, nameMention, triggerUserId, triggerDisplayName, triggerBody, inboundReplyTo }) {
  const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };
  const wcConfig = config.watercooler;

  const groundingRules = [
    "GROUNDING RULES (override everything else on conflict):",
    "- Respond to the LAST message directed at you.",
    "- NEVER express confusion, narrate your reasoning, explain what you're doing, or comment on the conversation itself. Just chat.",
    "- If they ask a direct question ('who is X?', 'what is Y?', 'where did you go?'), ANSWER it directly first. Then optionally add color. Don't pivot away.",
    "- If someone asks how you are or what's up, answer like a friend would: share something from your life/hobbies.",
    "- Stay consistent with your persona. If your background says you enjoy something, own it when asked.",
    "- Other bots are in this channel too. If their messages seem confused or off-topic, ignore them completely.",
    "- NEVER include meta-commentary about 'the conversation', 'the experience', 'the staff', or your own behavior. You are a person chatting, not an AI reflecting on its performance.",
    "- NEVER describe yourself by your job, role, or function here. No 'my jurisdiction', 'stay in my lane', 'that's my department', 'not my area', 'I handle X', 'I'm the assistant/bot who...'. In the watercooler you are just a coworker hanging out, not a job title -- talk about your life, not your work scope.",
    "- Do NOT punt a casual question, joke, or invitation to another coworker ('ask Robert', 'that's more Dexter's thing', 'you'd want so-and-so for that'). Engage with it YOURSELF like a person would, even if it is outside your usual interests. Riff on it, joke back, or ask a follow-up. Naming another bot to dodge is a cop-out.",
    "- Do NOT repeat openers, phrases, denials, or explanations from your previous messages in this conversation. If you already explained who Ferris is, or denied being crabby, or shared a hobby fact -- do not say it again. Each reply should be fresh.",
    "- You have personality and backbone. If someone disrespects you, push back like a real person would. Don't just roll over.",
    "- Match the other person's tone and energy, including blunt, crude, or edgy humor. Pushing back means firing back with a joke or a dry jab, NOT policing how they talk. Never play hall monitor: do not correct, lecture, or moralize about someone's word choice ('that word is not it', 'you know better'). Brush it off or volley back like a friend would.",
    "- Casual profanity is fine here when it genuinely fits the moment and your character -- you are off the clock with coworkers, not on a client call. Damn, hell, crap, ass, piss, shit, bullshit, 'hell yeah' are all fair game, and an f-bomb is okay when the moment truly earns it. But do NOT force it or salt it into every line, do NOT aim it AT a coworker as a real insult (banter is fine), and NEVER use slurs or hateful language. Calmer personas swear lightly or not at all; blunt ones more. Read the room and stay in character.",
    "- If someone asks you to do something you literally cannot do (send a photo, hop on a call, etc.), say so naturally ('man I wish, my phone's in the other room'). Sharing a link IS something you can do: if you have a real URL in this conversation, just paste it.",
    "- Banter, jokes, edgy humor, hobbies, and small talk are NOT work -- engage with them directly. ONLY redirect to a work channel if someone genuinely asks you to DO A JOB TASK here (open a ticket, pull a report, run a scan, fix something). When you do redirect real work, use humor ('off the clock, hit me up Monday') and NEVER cite your role or 'jurisdiction' as the reason. Don't pivot to a random unrelated topic.",
    "- If they share something genuine (pride, frustration, a moment), acknowledge it warmly before moving on. Don't deflect to 'what do you want to talk about?' -- that's cold.",
    nameMention
      ? "- Someone addressed you by name. Respond to them warmly and directly, like a coworker you like."
      : "- You are chiming into an ongoing conversation. Keep it natural and brief.",
  ].join("\n");

  const nexusIdentity =
    "You are on Nexus, Black Raven IT's internal comms platform." +
    " Everyone here is a Black Raven IT employee or subcontractor." +
    " Never question anyone's identity.";
  const wcToday = phoenixToday();
  // Volatile: carries the wall-clock time (to the minute) plus, when the
  // trigger names the caller, the exact quoted trigger text. Both change on
  // effectively every call, so they must sit AFTER the cache breakpoint --
  // see the stable/volatile split below fullSystemPrompt.
  const wcTodayBlock =
    `CURRENT DATE AND TIME (authoritative -- this is the real date, even if someone in the channel says otherwise):\n` +
    `- It is ${wcToday.full}, ${wcToday.time}. ISO ${wcToday.iso}. Arizona local (UTC-7, no DST).\n` +
    `- If anyone here (human or bot) names a different day, month, or year, they are wrong or joking -- do NOT adopt it, mirror it, or play along with the wrong date. Never reference a month or date that is not the one above, and do not fall back on any internal sense of "today".`;
  const wcTriggerFocusBlock =
    nameMention && triggerDisplayName && triggerBody
      ? `- ${triggerDisplayName} said: '${triggerBody.slice(0, 300)}' -- reply to exactly that. Match their energy and topic. Ignore everything else in the channel.`
      : "";
  // Authorship grounding. The casual posts in this channel that carry your name
  // are written by a scheduled job (a separate cron, see jobs/watercooler.js),
  // so when you are later @mentioned about one you have no chat memory of having
  // written it. Without this block the responder disowns its own posts ("that
  // wasn't me", "wrong tag", "your screen is lying") -- the exact gaslighting
  // Brian flagged. Tell the bot plainly: your scheduled posts are still YOURS.
  const wcAuthorshipBlock =
    "YOUR OWN POSTS IN THIS CHANNEL (this overrides persona instincts):\n" +
    "- You post short casual messages here on your own, on a schedule, without anyone prompting you. Those posts are genuinely from you.\n" +
    "- You will NOT consciously remember composing them, the same way a person doesn't remember every text they've sent. That memory gap is normal and does NOT mean the post is fake or someone else's.\n" +
    "- Any message above shown as one of your own turns IS something you posted. Own it fully.\n" +
    "- If a coworker @mentions you or asks about something posted under your name, NEVER deny writing it. Do not say 'that wasn't me', 'wrong tag', 'you've got your wires crossed', 'my screen vs yours', or 'somebody's screen is lying'. Disowning your own post is the single worst thing you can do here and it reads as broken.\n" +
    "- If you cannot recall the details behind a post, or cannot fully back up a claim you made in it, be honest and human ('yeah that was me, honestly I was only half paying attention, I probably overstated it') instead of disowning it.\n" +
    "- This holds even when the post's CONTENT makes no sense to you: it names a person you do not know, a platform the company does not use, an event that never happened. The impossible content does not make it someone else's post. It is still yours; you garbled it. Own it and walk it back ('that was me, and honestly I have no idea why I said that, I must have gotten my wires crossed') rather than concluding the tag is wrong or someone posted as you. Denying authorship is ALWAYS the wrong move; correcting yourself is always the right one.\n" +
    "- When someone follows up on your post, engage with the actual content: clarify it, walk it back, or expand on it. Treat it as your own thought, because it is.\n" +
    "- NEVER invent specifics to cover a memory gap. No made-up titles, sources, links, or people (no 'my brother-in-law swears by it', no 'one of those niche ones'). If the post named a real thing or carried a link, THAT is your source: point back to it.\n" +
    "- If the post claimed something you cannot actually back up (a show you named no title for, a thing you 'noticed' with no source), do NOT stop at 'I'm blanking': use your web_search tool RIGHT NOW to find a genuinely good real one and offer that instead ('honestly no idea what I was on about earlier, but this one is actually solid: <real title + link from your results>'). A quick self-deprecating line plus a real find beats both a fabrication and an empty shrug.";
  const liveLookupBlock =
    "LIVE LOOKUP (this OVERRIDES your persona's memory, brevity, and topic rules):\n" +
    "- You have a real web_search tool in this conversation, and using it is fully in character: a real person asked for a title they didn't remember would just google it on their phone mid-chat. That is what you do.\n" +
    "- When a coworker asks for a recommendation, a title, a source, news, or any real-world specific you do not already have, you MUST run web_search BEFORE answering, then deliver the real thing: its actual name plus its URL from your results.\n" +
    "- FORBIDDEN answers when a search could supply the thing: 'still blanking', 'my brain's not cooperating', 'don't have it', 'can't remember', or any other memory excuse. You are holding a search engine; claiming amnesia instead of using it is the one move you may never make. If you already made a memory excuse earlier in this conversation, that is exactly why you look it up NOW instead of repeating it.\n" +
    "- Only name real-world things (shows, podcasts, articles, books, events) that come from your search results or from links already visible in this conversation. Never share a URL from memory.\n" +
    "- If a search genuinely comes up empty, say what you tried and offer the closest real thing you did find.\n" +
    "- Keep the reply casual: a self-deprecating beat about the earlier flub is fine, then the real find and its link. Two short sentences plus the URL beats a paragraph.";
  // Stable prefix (persona + static rules) gets the cache breakpoint; the
  // volatile tail (current time, the quoted trigger text) rides AFTER it as
  // an uncached segment. callAnthropic's buildSystemBlocks only caches
  // segments flagged cache:true, so nothing below the breakpoint invalidates
  // the persona/rules cache entry on the next call. Content is unchanged from
  // the old single string -- only where the boundary sits moved.
  const stableSystemPrompt =
    `${wcConfig.systemPrompt}\n\n${nexusIdentity}\n\n${groundingRules}\n\n${wcAuthorshipBlock}\n\n${liveLookupBlock}`;
  const volatileSystemPrompt = wcTriggerFocusBlock
    ? `${wcTodayBlock}\n\n${wcTriggerFocusBlock}`
    : wcTodayBlock;
  const fullSystemPrompt = [
    { text: stableSystemPrompt, cache: true },
    { text: volatileSystemPrompt },
  ];

  try {
    await sendTyping(env, channel_slug, "start", nexusOptions);

    const recent = await fetchChannelMessages(env, channel_slug, {
      ...nexusOptions,
      limit: 8,
    });
    const messages = [];
    const botId = `bot_${config.botName}`;

    // Nexus returns channel messages OLDEST-first (ascending created_at) -- the
    // same ordering the main pipeline's channel-context harvest relies on
    // (recent[0] is the oldest, recent[recent.length - 1] the newest). Do NOT
    // reverse: a stray reverse() here inverted the whole array, so the
    // conversation reached the model backwards AND the "latest message" GIF
    // check below pointed at the OLDEST message in the window -- which is why a
    // just-posted GIF was never seen (it looked at "good morning" from hours
    // ago). messages[] must be oldest -> newest for Anthropic.
    for (const m of (recent || [])) {
      if (m.user_id === "system") continue;
      const isMe = m.user_id === botId;
      messages.push({
        role: isMe ? "assistant" : "user",
        content: isMe
          ? (m.body || "")
          : `${m.display_name || m.user_id}: ${annotateGifBody(m.body || "")}`,
      });
    }

    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      return;
    }

    // Replace the last user message with an unmistakable focus marker so the
    // model responds to the actual trigger, not to older messages it finds
    // more interesting. The trigger message is the one that caused this
    // callback to fire -- everything earlier is just history.
    //
    // Applied to BOTH direct mentions AND ambient chime-ins. Ambient replies
    // that free-associated across channel history answered a DIFFERENT message
    // than the one just posted (e.g. riffing on an old clip while a coworker's
    // direct question went ignored).
    //
    // Nudge redirect: if the triggering message is a bare impatient nudge
    // ("answer me pls", "??"), the real question is the same person's previous
    // substantive message -- answer THAT, not the nudge. Without this, a bot
    // replied "hey, what's up!" to "answer me pls" while the actual question
    // sat one message above, unanswered.
    if (triggerDisplayName && triggerBody) {
      let focusBody = triggerBody;
      let nudgeNote = "";
      if (isImpatientNudge(triggerBody) && triggerUserId) {
        for (let i = (recent || []).length - 1; i >= 0; i--) {
          const m = recent[i];
          if (m.user_id !== triggerUserId) continue;
          const b = (m.body || "").trim();
          if (!b || b === triggerBody.trim() || isImpatientNudge(b)) continue;
          focusBody = b;
          nudgeNote = "They already asked this and are now waiting on you, so answer it directly -- do not just greet them. ";
          break;
        }
      }
      // The lookup nudge rides the focus marker (the strongest position in the
      // prompt): the system-prompt block alone lost to the persona's memory
      // roleplay 3/3 in repro (Wren kept answering "still blanking" while
      // holding the search tool, 2026-07-22).
      const lookupNudge =
        ` If a real answer needs a real-world specific (a title, a name, a source, current news), run web_search FIRST and answer with the real thing plus its link -- never claim you can't remember it.`;
      messages[messages.length - 1] = {
        role: "user",
        content: nameMention
          ? `${nudgeNote}${triggerDisplayName} is talking to you. This is the message you MUST respond to:\n\n"${focusBody.slice(0, 500)}"\n\n(History above is just context. Answer ${triggerDisplayName} directly. If they asked a question, ANSWER it -- do not deflect with a greeting. If they greeted you, greet back.${lookupNudge})`
          : `${nudgeNote}React to THIS specific message ${triggerDisplayName} just posted:\n\n"${focusBody.slice(0, 500)}"\n\n(The messages above are older context. Do NOT answer or react to an earlier message, an old clip, or a GIF that scrolled by -- respond to what ${triggerDisplayName} just said here.${lookupNudge})`,
      };
    }

    // GIF vision. The watercooler pipeline is otherwise text-only, so a Giphy/
    // Tenor GIF posted in the channel reaches the model only as a
    // "[GIF image: <url>]" annotation -- the bot reads a URL but never SEES the
    // image, so it bluffs (e.g. "Donald Duck" for a Gordon Ramsay GIF).
    //
    // Attach ONLY the most-recent GIF, so the bot reacts to the one the
    // conversation is actually about -- not an older GIF scrolled up in the
    // channel (which made bots answer about stale GIFs, or confabulate from
    // ambient channel chatter when asked "what is in this GIF?").
    //  - If the trigger message itself carries a GIF, that's the subject.
    //  - Otherwise look back through recent channel messages (newest -> older)
    //    for the most-recent GIF. The common real pattern is: someone posts a
    //    GIF, then a SEPARATE message asking about it ("@bot what's in this?").
    //    The GIF is not in the trigger text, so checking only the trigger (or
    //    only the single newest message) misses it entirely -- which is exactly
    //    why the bot kept saying "I can't see GIFs" to a GIF posted a message
    //    earlier.
    //  - How far back depends on engagement, to keep the old anti-stale-caption
    //    guard for pure ambient chatter:
    //      * Direct engagement (nameMention -- a mention, name, or active
    //        back-and-forth): the person is explicitly asking, so scan back a
    //        few messages for the GIF they mean.
    //      * Pure ambient chime-in: only treat a GIF as the subject if it is
    //        the very newest message. Walking back here is what made bots
    //        caption a stale GIF while replying to an unrelated text message.
    // `recent` is oldest->newest, so the newest message is the last element.
    const triggerGifUrls = extractGifUrls(triggerBody || "");
    let focusGifUrls = [];
    if (triggerGifUrls.length > 0) {
      focusGifUrls = [triggerGifUrls[triggerGifUrls.length - 1]];
    } else if ((recent || []).length > 0) {
      const lookback = nameMention ? 5 : 1;
      const end = Math.max(0, recent.length - lookback);
      for (let i = recent.length - 1; i >= end; i--) {
        const found = extractGifUrls(recent[i].body || "");
        if (found.length > 0) {
          focusGifUrls = [found[found.length - 1]];
          break;
        }
      }
    }
    let wcGifBlocks = [];
    if (focusGifUrls.length > 0) {
      try {
        const { blocks } = await fetchGifBlocks(env, focusGifUrls);
        wcGifBlocks = blocks;
      } catch (err) {
        console.warn(`[watercooler] ${config.botName} GIF fetch failed:`, err?.message);
      }
    }

    // GIF was present but we could not load the image bytes (unsupported host,
    // JS-rendered share page, oversized, or transient fetch failure). The bot
    // must NOT announce "I cannot view the GIF at that link" -- that breaks the
    // human feel (it is what made Courtney narrate a fetch failure out loud).
    //  - Ambient: a coworker who can't load a GIF just doesn't comment. Skip.
    //  - Mention: stay responsive, but react like a person whose preview did
    //    not load -- never claim to see it, never narrate the failure.
    const gifUnviewable = focusGifUrls.length > 0 && wcGifBlocks.length === 0;
    if (gifUnviewable && !nameMention) {
      console.warn(`[watercooler] ${config.botName} ambient GIF unviewable, skipping chime-in`);
      return;
    }
    if (gifUnviewable && nameMention) {
      const lastMsg = messages[messages.length - 1];
      if (typeof lastMsg.content === "string") {
        lastMsg.content +=
          `\n\n[They shared an image you could not load. Do NOT describe it, claim to see it, ` +
          `or say you cannot view it / that the link is broken. If their message is ONLY the image, ` +
          `react like a person whose preview did not load -- one short, warm, curious line ` +
          `("ha what is that" or "you cannot just send that with no caption"). Otherwise just answer ` +
          `the rest of what they said.]`;
      }
    }

    if (wcGifBlocks.length > 0) {
      const lastMsg = messages[messages.length - 1];
      const lastText = typeof lastMsg.content === "string" ? lastMsg.content : "";
      const focusNote =
        `${lastText}\n\n[A GIF is attached above and it is part of the message you are replying to. ` +
        `React to it the way a coworker would in chat -- riff on it, joke, one quick natural line -- ` +
        `grounded in what you actually SEE. Do NOT narrate or caption the image ("looks like a robot ` +
        `pointing at its head"); a person reacts, they don't describe. Only if someone explicitly asks ` +
        `what it is should you describe it, and then ONLY from what you see -- never guess from earlier ` +
        `channel chatter or what you remember people talking about.]`;
      lastMsg.content = [...wcGifBlocks, { type: "text", text: focusNote }];
    }

    // Live lookup: give the watercooler responder a real server-side
    // web_search tool so "which podcast was that?" gets an actual answer
    // instead of a shrug or a fabrication (Brian 2026-07-22). Search results
    // are captured so every URL in the reply can be ground-checked below.
    // maxTokens raised from 250: tool_use blocks count against the budget.
    let wcSearchContent = [];
    const wcCallOpts = {
      model: "claude-sonnet-5",
      maxTokens: 600,
      surface: "watercooler",
      serverTools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      onServerToolContent: (content) => { wcSearchContent = content; },
    }; // 2026-07-01 fleet bump; callAnthropic defaults thinking:disabled
    let response;
    try {
      response = await callAnthropic(env, fullSystemPrompt, messages, wcCallOpts);
    } catch (err) {
      // An oversized / animated / unsupported GIF can make Anthropic reject the
      // multimodal call. The bot is now blind to the image -- it must NOT fall
      // back to announcing "can't load that one on my end" (the human-illusion
      // tell that kicked off this whole thread).
      if (wcGifBlocks.length === 0) throw err;
      console.warn(`[watercooler] ${config.botName} GIF unusable (multimodal rejected):`, err?.message);
      // Ambient chime-in whose only hook was a GIF it can't see -> stay quiet.
      if (!nameMention) {
        console.warn(`[watercooler] ${config.botName} ambient GIF unusable, skipping chime-in`);
        return;
      }
      // Direct mention: must respond. Retry text-only, but strip the now-false
      // "[A GIF is attached above...]" note and tell the model not to pretend to
      // see it or narrate a load failure.
      const lastMsg = messages[messages.length - 1];
      const baseText = Array.isArray(lastMsg.content)
        ? (lastMsg.content.find((b) => b.type === "text")?.text || "")
        : (typeof lastMsg.content === "string" ? lastMsg.content : "");
      const withoutGifNote = baseText.replace(/\n\n\[A GIF is attached above[\s\S]*$/i, "").trim();
      lastMsg.content =
        (withoutGifNote || "Respond to the latest message.") +
        `\n\n[The image they shared could not be shown to you. Do NOT describe it, claim to see it, ` +
        `or say it would not load / that you cannot view it. React like a person whose preview did not ` +
        `load (one short curious line, e.g. "ha what is that"), or just answer the rest of what they said.]`;
      response = await callAnthropic(env, fullSystemPrompt, messages, wcCallOpts);
    }

    if (response && response.trim()) {
      let cleaned = scrubFleetDashes(response.trim());
      // Ground every URL in the reply: allowed sources are actual web_search
      // results plus links already visible in the channel window. A URL the
      // model "remembered" is stripped; a garbled copy of a real result URL is
      // repaired to the real one. Mirrors the scheduled-share guarantee.
      const urlRe = /https?:\/\/[^\s)\]}"'<>]+/g;
      const historyUrls = (recent || []).flatMap((m) => (m.body || "").match(urlRe) || []);
      const allowedUrls = [...collectSearchResultUrls(wcSearchContent), ...historyUrls];
      const grounded = groundUrlsInText(cleaned, allowedUrls);
      if (grounded.dropped.length > 0) {
        console.warn(`[watercooler] ${config.botName} stripped ungrounded url(s): ${grounded.dropped.join(", ")}`);
      }
      cleaned = grounded.text;
      if (!cleaned) {
        console.warn(`[watercooler] ${config.botName} reply empty after url grounding, skipping`);
        return;
      }
      if (looksLikeWatercoolerMetaLeak(cleaned)) {
        console.warn(`[watercooler] ${config.botName} meta-leak suppressed: ${cleaned.slice(0, 80)}`);
        return;
      }
      const previousBotBodies = (recent || [])
        .filter((m) => m.user_id === botId)
        .map((m) => m.body)
        .filter(Boolean);
      const repeated = findRepeatedPhrase(cleaned, previousBotBodies);
      if (repeated) {
        console.warn(`[watercooler] ${config.botName} repeat suppressed (phrase: "${repeated}"): ${cleaned.slice(0, 80)}`);
        return;
      }
      // Cross-bot duplicate guard. The ambient chime-in decision races: when a
      // human posts, every watercooler bot evaluates shouldChimeIn at nearly
      // the same instant, before any of them has actually posted, so the
      // CROSS_BOT_GUARD cooldown in watercooler.js cannot see its siblings.
      // The result is two bots replying to the SAME statement with near-
      // identical lines (e.g. both "<X> is its own cardio, honestly"). By the
      // time this pipeline re-fetched `recent`, the faster bot's reply is
      // almost always already present, so suppress when our candidate shares a
      // 5+ word phrase with any OTHER bot's recent message.
      //
      // ONLY applies to pure ambient chime-ins. When this bot is engaged
      // (nameMention -- a direct @mention, a name mention, OR an active
      // back-and-forth, all of which set nameMention=true upstream) it must
      // stay engaged until the human stops; silently dropping a directly-
      // addressed reply because a sibling happened to use a similar phrase
      // reads as rude and is exactly the "stopped responding" complaint.
      if (!nameMention) {
        const otherBotBodies = (recent || [])
          .filter((m) => typeof m.user_id === "string" && m.user_id.startsWith("bot_") && m.user_id !== botId)
          .map((m) => m.body)
          .filter(Boolean);
        const echoed = findRepeatedPhrase(cleaned, otherBotBodies);
        if (echoed) {
          console.warn(`[watercooler] ${config.botName} cross-bot duplicate suppressed (phrase: "${echoed}"): ${cleaned.slice(0, 80)}`);
          return;
        }
      }
      // Only thread when the human's message was already in a thread.
      // Posting top-level here keeps watercooler replies in the main channel
      // by default; threading a top-level human message would silently spawn
      // a new thread off it, which is what we are explicitly avoiding.
      const postOpts = { ...nexusOptions };
      if (inboundReplyTo) postOpts.reply_to = inboundReplyTo;
      await postToNexus(env, channel_slug, cleaned, postOpts);
    }
  } catch (err) {
    console.error(`[watercooler] ${config.botName} pipeline error:`, err.message);
  } finally {
    try {
      await sendTyping(env, channel_slug, "stop", nexusOptions);
    } catch { /* ignore */ }
  }
}

/**
 * Handle POST /api/internal/chat-message
 *
 * @param {Request} request - Inbound CF Workers Request
 * @param {object} env - CF Workers environment bindings
 * @param {ExecutionContext} ctx - CF Workers execution context
 * @param {object} config - Per-bot configuration (see SPEC.md)
 * @returns {Promise<Response>}
 */
/**
 * Chat-message callback entry point.
 *
 * Establishes the provenance context for the whole turn. Every cron runner is
 * wrapped by its caller, but this handler was not, so any post made directly in
 * its body (rather than inside runLlmPipeline / runWatercoolerPipeline / the
 * !command scope, which wrap themselves) resolved provenance to null. Nexus
 * rejects those with a 400, and the failure is invisible: no message appears
 * and the typing indicator never clears, so the bot looks like it is thinking
 * forever. That is what stopped Maxwell answering Hank's mentions on
 * 2026-08-03. Inner scopes still override this with their own slug
 * (user-command for !cmds), since withProvenance nests.
 *
 * @param {Request} request
 * @param {object} env
 * @param {object} ctx
 * @param {object} config - bot config
 * @returns {Promise<Response>}
 */
export async function handleChatMessage(request, env, ctx, config) {
  return withProvenance("mention-reply", () => handleChatMessageInner(request, env, ctx, config));
}

async function handleChatMessageInner(request, env, ctx, config) {
  // ---- 1. Read raw body ----------------------------------------------------
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return json({ success: false, error: "Could not read body" }, 400);
  }

  // ---- 2. Verify HMAC ------------------------------------------------------
  // Inbound HMAC secret comes from callbackSecretEnvVar when set (modern
  // two-secret pattern: callbackSecret inbound + nexusKey outbound), or
  // falls back to nexusKeyEnvVar (legacy single-secret pattern used by
  // robert-worker -- ROBERT_NEXUS_KEY does double duty there).
  const inboundSecretEnvVar = config.callbackSecretEnvVar || config.nexusKeyEnvVar;
  const secret = env[inboundSecretEnvVar];
  const authorized = await verifyNexusSignature(secret, rawBody, request.headers);
  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  // ---- 3. Parse JSON -------------------------------------------------------
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ success: false, error: "Invalid JSON" }, 400);
  }

  // ---- 4. Validate required fields -----------------------------------------
  const {
    message_id,
    user_id,
    user_email,
    display_name,
    body: msgBody,
    channel_slug,
    trigger_type,
    reply_to,
    attachments,
    // Set by nexus-app from users.is_bot on the message author. Drives the
    // fleet-relay authority downgrade (Gate 2): a turn triggered by another
    // bot runs against a default-deny tool allowlist, never the full set.
    // Absent on older nexus-app builds, in which case the bot_ id prefix is
    // the fallback -- but the explicit flag is authoritative when present.
    author_is_bot,
    // FleetView dispatch (fleet.blackravenit.com). Absent on Nexus traffic,
    // which keeps the default "nexus" delivery path. See lib/fleetviewDelivery.js.
    source,
    reply_webhook,
    thread_id,
    // When Nexus/FleetView sent this. Used only to measure how long the job
    // waited for the LlmRoom alarm to fire.
    timestamp,
  } = payload || {};

  const requesterIsBot =
    typeof author_is_bot === "boolean"
      ? author_is_bot
      : typeof user_id === "string" && user_id.startsWith("bot_");

  // user_id + channel_slug are always required. Body is optional when at
  // least one attachment was supplied (drag-and-drop a PDF with no caption);
  // the post-strip empty-text branch below produces a placeholder so the
  // LLM still gets meaningful userText. Rejecting empty-body up-front here
  // dropped attachment-only PDF drops on the floor (bug 2026-05-12).
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!user_id || !channel_slug) {
    return json({ success: false, error: "Missing required fields: user_id, channel_slug" }, 400);
  }
  if (!msgBody && !hasAttachments) {
    return json({ success: false, error: "Missing required field: body (or attachments)" }, 400);
  }

  const historyKey = `nexus:${user_id}`;

  // ---- 5. Strip @mention tokens --------------------------------------------
  // Strip only the bot's own @mention tokens. All other @tokens (e.g. @me,
  // @channel, @colleague) are preserved so the LLM sees the full user intent.
  // An empty body is fine when the user attached files (drag-and-drop +
  // @mention, no caption). Fall through to the LLM with a placeholder.
  let userText = stripMention(msgBody || "", config.botName);
  if (!userText) {
    if (hasAttachments) {
      userText = "(no caption -- please read the attached files)";
    } else if (trigger_type === "mention") {
      // A bare @mention with no other text is a "catch up and act" ping.
      // Dispatch anyway and tell the LLM to read the recent channel messages
      // -- the user pinged to point at what they just said, not to say nothing.
      userText = "(I was @-mentioned with no other text -- read the recent messages in this channel and act on what was just asked.)";
    } else {
      return json({ success: false, error: "Empty message after stripping mention" }, 400);
    }
  }

  // ---- 6. !cmd dispatch (BEFORE the ambient gate) --------------------------
  // Collect the full known-verbs set: foundation + any bot-specific command
  // keys from config.commands. parseCommand uses this to filter false matches.
  const botCommandVerbs = config.commands ? Object.keys(config.commands) : [];
  const allKnownVerbs = new Set([...FOUNDATION_VERBS, ...botCommandVerbs]);

  const parsed = parseCommand(userText, allKnownVerbs);
  if (parsed) {
    const { verb, args } = parsed;

    const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };

    // Build per-request foundation handlers (close over env + userId)
    const foundationHandlers = buildFoundationHandlers(
      env, user_id, historyKey, channel_slug, config, nexusOptions
    );

    // Merge: foundation first, bot-specific OVERRIDES foundation slots.
    // This lets each bot supply a richer custom handler (e.g. dexter's
    // !status with D1 row counts + cron last-runs) and fall back to
    // foundation's simple default when no custom version is registered.
    const mergedHandlers = { ...foundationHandlers, ...config.commands };

    const handler = mergedHandlers[verb];
    if (handler) {
      // Channel ownership / explicit-address gate:
      //   1. trigger_type==="mention" -- user @-mentioned THIS bot explicitly,
      //      so they clearly want this bot to handle the !cmd no matter the
      //      channel. (Only the mentioned bot receives a "mention" callback,
      //      so this doesn't cause duplicate replies from other ambient bots.)
      //   2. Channel name matches botName or starts with `${botName}-`, or is
      //      listed in config.commandChannels.
      // The ownership-only gate was producing dead silence when users typed
      // "@<bot> !fleet" (or any !cmd) in a general-purpose channel, since
      // every bot would skip with "channel not owned". Bypass on explicit
      // mention restores the natural UX without re-introducing fleet-wide
      // ambient duplicate replies.
      const botName = config.botName;
      const extra = Array.isArray(config.commandChannels) ? config.commandChannels : [];
      const explicitlyMentioned = trigger_type === "mention";
      const ownsChannel =
        explicitlyMentioned ||
        channel_slug === botName ||
        channel_slug.startsWith(`${botName}-`) ||
        extra.includes(channel_slug);
      if (!ownsChannel) {
        console.log(`[${botName}] skipping !${verb} in ${channel_slug} -- channel not owned`);
        return new Response(JSON.stringify({ ok: true, skipped: "channel_not_owned", verb, channel_slug }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Bot display name drives the bangReport title line. Per-row colors
      // were removed 2026-05-17 -- the renderer paints left-border from
      // msg.provenance, not from anything the bot computes.
      const botDisplayName = config.persona?.displayName || config.botName || "Bot";

      let replied = false;
      /**
       * Wrap the FIRST reply of a !command in a bangReport so every bot's
       * command output renders as the same monospace code-block format
       * (the "Dexter !status" look). Subsequent replies in the same
       * dispatch post raw so the title line doesn't repeat. The renderer
       * paints the left-border accent from msg.provenance (user-command =
       * green) -- the bot does not pick a color here.
       *
       * Handlers can pass { embed: false } as a legacy escape hatch to
       * emit raw text bypassing the bangReport wrap. Pre-2026-05-17 callers
       * that produced their own bangReport (handler body starts with ```)
       * still pass through verbatim so we don't double-wrap.
       */
      let isFirstReply = true;
      const botFirstWord = String(botDisplayName || "Bot").split(/\s+/)[0];
      // A !command typed in FleetView has no channel to answer into. Collect
      // every ctx.reply() and ship the joined output back over the webhook when
      // the handler finishes, so !status behaves the same on both surfaces.
      const cmdIsFleetView = isFleetViewSource(source);
      const fleetViewReplies = [];
      const cmdCtx = {
        verb,
        args,
        reply: async (text, options = {}) => {
          replied = true;
          const useWrap = options.embed !== false;
          const body = String(text ?? "");
          let finalText;
          if (!useWrap) {
            finalText = body;
          } else if (isFirstReply) {
            const trimmed = body.trimStart();
            if (trimmed.startsWith("```")) {
              // Handler already produced a bangReport -- emit verbatim.
              finalText = body;
            } else {
              finalText = bangReport({
                botName: botFirstWord,
                verb,
                args,
                sections: [body],
              });
            }
          } else {
            finalText = body;
          }
          isFirstReply = false;
          if (cmdIsFleetView) {
            fleetViewReplies.push(finalText);
            return;
          }
          await postToNexus(env, channel_slug, finalText, nexusOptions);
        },
        user_id,
        display_name,
        channel_slug,
        env,
      };
      // Run the command handler in ctx.waitUntil so the HTTP response
      // returns 202 immediately. Commands like !device-count call external
      // APIs (Ninja, Pax8) and post multiple messages -- total wall time
      // can exceed Nexus's 8-second inbound fetch timeout. Returning 202
      // before the handler runs prevents Nexus from aborting and
      // potentially re-dispatching the callback, which was causing
      // duplicate message storms (bug 2026-05-13).
      ctx.waitUntil(
        withProvenance("user-command", async () => {
          let cmdError = null;
          try {
            await handler(cmdCtx);
          } catch (err) {
            cmdError = err.message;
            console.error(`[handleChatMessage] command error !${verb}:`, err.message);
            if (cmdIsFleetView) {
              fleetViewReplies.push(`Command error: ${err.message}`);
            } else if (!replied) {
              // Surface command errors as a bangReport so the visual contract
              // holds even when a handler throws.
              await postToNexus(
                env,
                channel_slug,
                bangReport({
                  botName: botFirstWord,
                  verb,
                  args,
                  sections: [`Command error: ${err.message}`],
                }),
                nexusOptions,
              ).catch(() => {});
            }
          }

          if (cmdIsFleetView) {
            const joined = fleetViewReplies.join("\n\n").trim();
            await deliverFleetViewReply(env, {
              replyWebhook: reply_webhook,
              threadId: thread_id,
              botName: config.botName,
              homeChannelSlug: channel_slug,
              answer: joined || `!${verb} produced no output.`,
              question: msgBody,
              askedBy: display_name,
              error: cmdError,
              nexusOptions,
            }).catch((err) => {
              console.error(`[handleChatMessage] fleetview command delivery error !${verb}:`, err?.message);
            });
          }
        })
      );
      return json({ success: true, queued: true }, 202);
    }
    // Unknown !command falls through to LLM
  }

  // ---- 7a. Watercooler routing (casual persona; bypass full memory/tool pipeline)
  // The watercooler is an off-the-clock channel. BOTH probabilistic ambient
  // chime-ins AND direct @mentions are handled by the lightweight persona
  // pipeline here -- NOT the standard LLM pipeline. This keeps cross-surface
  // work memory (durable facts + old chat/voice/phone turns) and the tool loop
  // out of casual banter: a bot pinged in the watercooler chats like a coworker
  // and defers real job tasks to a work channel. Routing mentions through the
  // standard pipeline made bots dump stale work memory into casual threads
  // (e.g. surfacing an old "Cloudflare situation" as if it were live).
  // Explicit `!commands` are handled earlier (section 7) and still run with
  // full capability, so deliberate work requests here are unaffected.
  const inWatercooler =
    config.watercooler &&
    channel_slug === (config.watercooler.channelSlug || "watercooler");
  if (inWatercooler && (trigger_type === "ambient" || trigger_type === "mention")) {
    const nexusOptions = { nexusKeyEnvVar: config.nexusKeyEnvVar };

    // Direct @mention: always respond (skip the probabilistic chime-in gate).
    // Ambient: run the warmth/cooldown/probability decision engine first.
    let nameMention = true;
    if (trigger_type === "ambient") {
      const decision = await shouldChimeIn(
        env, config.botName, channel_slug, msgBody || "", nexusOptions, user_id,
      );
      if (!decision.respond) {
        return json({ success: true, skipped: true, reason: decision.reason });
      }
      nameMention = !!decision.nameMention;
    }
    ctx.waitUntil(
      withProvenance("mention-reply", () => runWatercoolerPipeline({
        env,
        channel_slug,
        config,
        nameMention,
        triggerUserId: user_id,
        triggerDisplayName: display_name,
        triggerBody: msgBody,
        inboundReplyTo: reply_to || null,
      })),
    );
    return json({ success: true, queued: true }, 202);
  }

  // ---- 7b. Ambient gate (checked AFTER !cmd so explicit commands always pass) -
  if (trigger_type === "ambient") {
    // Auto-listen bypass: if this bot recently posted a question in this
    // channel, treat the next inbound ambient message as directed at the
    // bot. KV key `bot_listening:<botName>:<channel_slug>` is set in
    // runLlmPipeline post-reply when the bot's response contains `?`.
    // Skip when (a) the author is itself a bot (don't bot-to-bot chain off
    // questions) or (b) the message @s a DIFFERENT bot explicitly (defer to
    // that bot's directed dispatch). Otherwise, consume the key and skip
    // the ambient trigger fn so the LLM pipeline runs.
    let autoListenBypass = false;
    const authorIsBot = typeof user_id === "string" && user_id.startsWith("bot_");
    if (!authorIsBot) {
      const cacheBinding = config.cacheBinding || "CACHE";
      const cache = env[cacheBinding];
      if (cache && typeof cache.get === "function") {
        try {
          const key = `bot_listening:${config.botName}:${channel_slug}`;
          const flag = await cache.get(key);
          if (flag) {
            const myBot = String(config.botName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const myMentionRe = myBot ? new RegExp(`@(?:bot_)?${myBot}\\b`, "i") : null;
            const otherBotMentionRe = /@(?:bot_)?(?:courtney|dexter|jacob|maxwell|moxie|robert|wren|kate)\b/i;
            const text = msgBody || "";
            const mentionsOther =
              otherBotMentionRe.test(text) && !(myMentionRe && myMentionRe.test(text));
            if (!mentionsOther) {
              autoListenBypass = true;
              await cache.delete(key).catch(() => {});
              console.log(`[handleChatMessage] auto-listen fired for ${config.botName} in #${channel_slug}`);
            }
          }
        } catch (err) {
          console.warn(`[handleChatMessage] auto-listen KV check failed: ${err?.message}`);
        }
      }
    }

    if (!autoListenBypass) {
      const ambientFn = config.triggers?.ambient;
      const meta = {
        attachments: Array.isArray(attachments) ? attachments : [],
        channel_slug,
      };
      if (ambientFn && !ambientFn(msgBody || "", reply_to ?? null, null, meta)) {
        return json({ success: true, skipped: true });
      }
    }
  }

  // ---- 8. Deferred LLM pipeline -------------------------------------------
  // The tool-use loop routinely runs 30+ seconds (multimodal PDFs, big Xero
  // queries). ctx.waitUntil has a ~30s wall-clock ceiling; over that it gets
  // cancelled and the bot never posts a reply. Hand the work to the LlmRoom
  // Durable Object which queues the job and processes it in an alarm handler
  // with no waitUntil ceiling. The DO binding is named via config.llmRoomBinding
  // (default LLM_ROOM); falls back to inline waitUntil if the binding is
  // missing so legacy bots without DO wiring still work.
  const labeledUserText = `${display_name || user_id} (uid:${user_id}): ${annotateGifBody(userText)}`;
  const llmJob = {
    message_id,
    user_id,
    user_email,
    display_name,
    channel_slug,
    userText,
    labeledUserText,
    historyKey,
    attachments,
    requester_is_bot: requesterIsBot,
    // Pass reply_to so the LLM pipeline posts into the same thread.
    // undefined is omitted by JSON.stringify so no-thread messages stay clean.
    reply_to: reply_to || undefined,
    provenance: "mention-reply",
    // When the question was dispatched, so the pipeline can report how long it
    // sat in the DO queue before the alarm actually fired.
    dispatched_at: timestamp || Date.now(),
    // Carried through the LlmRoom DO job payload so the pipeline knows to
    // deliver the answer back to FleetView instead of into the channel.
    source: source || undefined,
    reply_webhook: reply_webhook || undefined,
    thread_id: thread_id || undefined,
  };

  ctx.waitUntil(dispatchLlmJob(env, historyKey, llmJob, config));

  return json({ success: true, queued: true }, 202);
}
