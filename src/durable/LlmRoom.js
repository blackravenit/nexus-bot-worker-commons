// =============================================================================
// durable/LlmRoom.js, Shared Durable Object base class for LLM tool loops.
//
// Bot worker chat-message callbacks were running the LLM pipeline inside
// ctx.waitUntil(), which has a ~30s wall-clock ceiling. Maxwell + Courtney
// pipelines that ingest a multimodal PDF on the current turn routinely
// exceed that and get cancelled mid-flight, the bot receives the
// callback, starts the Anthropic call, then gets killed before posting
// back to Nexus. The user sees "bot is typing" then silence.
//
// The DO sidesteps this: the chat-message handler hands the payload to
// this DO via a sub-fetch, the DO queues it in storage and schedules an
// immediate alarm, then returns 202 in <1s. The alarm handler is its
// own invocation context with no shared waitUntil ceiling, so the LLM
// loop has the full DO compute budget (CPU bounded, wall-clock bounded
// only by DO eviction which doesn't fire while the alarm is active).
//
// One DO instance per (botName, historyKey): that gives natural
// single-flight per conversation: two rapid pings from the same user
// queue up rather than fanning out parallel tool loops that clobber
// chat_history on the way back. Different users get different DOs and
// run concurrently.
//
// Subclassing contract: each bot worker provides a thin subclass that
// imports its own config (persona + tools + dbBinding etc.) and exposes
// it via getConfig(). The DO uses that to call runLlmPipeline.
//
// Hard rules:
//   - No em dashes or en dashes.
//   - ES modules only.
//   - The DO and the calling bot worker live in the SAME script, so the
//     subclass can import everything the chat-message handler imports
//     (tools, persona, db helpers). The DO is NOT a separate worker.
// =============================================================================

import { runLlmPipeline } from "../handlers/handleChatMessage.js";
import { withProvenance } from "../lib/provenanceContext.js";

const QUEUE_KEY = "llm_room_queue";
const QUEUE_DEPTH_CAP = 20;

// Recently-seen message ids, for exactly-once delivery. Per-(bot,conversation)
// single-flight already serializes turns, but it does NOT dedup: if Nexus
// retries a webhook (timeout/at-least-once delivery) the SAME message_id arrives
// twice, both copies queue, and the bot answers the same message twice. We keep
// a short rolling list of processed ids and drop a repeat at enqueue time.
const RECENT_IDS_KEY = "llm_room_recent_ids";
const RECENT_IDS_CAP = 50;

/**
 * Base class. Each bot worker subclasses this and supplies its config:
 *
 *   import { LlmRoomBase } from "nexus-bot-worker-commons";
 *   import { courtneyConfig } from "../handlers/chatMessage.js";
 *
 *   export class LlmRoom extends LlmRoomBase {
 *     getConfig() { return courtneyConfig; }
 *   }
 */
export class LlmRoomBase {
  /**
   * @param {DurableObjectState} state
   * @param {object} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Override to return the bot's config object. The DO can't be
   * subclass-instantiated without a config, so we throw loudly if a
   * bot wires its worker but forgets the subclass.
   *
   * @returns {object}
   */
  getConfig() {
    throw new Error("LlmRoom subclass must implement getConfig()");
  }

  /**
   * fetch handler. Only one route: POST /run, enqueues a job and
   * arms an alarm to process it. Returns 202 immediately so the
   * caller's waitUntil completes well under the 30s ceiling.
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    let job;
    try {
      job = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const queue = (await this.state.storage.get(QUEUE_KEY)) || [];

    // Exactly-once: drop a duplicate delivery of the same message_id (already
    // processed, or still sitting in the queue). Without this a retried webhook
    // double-answers. Messages with no id (legacy callers) skip the check.
    const msgId = job && job.message_id;
    if (msgId) {
      const recentIds = (await this.state.storage.get(RECENT_IDS_KEY)) || [];
      const inQueue = queue.some((j) => j && j.message_id === msgId);
      if (recentIds.includes(msgId) || inQueue) {
        console.log(`[LlmRoom] duplicate message_id ${msgId}, skipping (already ${inQueue ? "queued" : "processed"})`);
        return new Response(JSON.stringify({ duplicate: true, skipped: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      recentIds.push(msgId);
      if (recentIds.length > RECENT_IDS_CAP) recentIds.splice(0, recentIds.length - RECENT_IDS_CAP);
      await this.state.storage.put(RECENT_IDS_KEY, recentIds);
    }

    if (queue.length >= QUEUE_DEPTH_CAP) {
      console.warn(`[LlmRoom] queue full (${queue.length}): dropping job`);
      return new Response(JSON.stringify({ error: "Queue full" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }

    queue.push(job);
    await this.state.storage.put(QUEUE_KEY, queue);

    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      await this.state.storage.setAlarm(Date.now() + 50);
    }

    return new Response(JSON.stringify({ queued: true, depth: queue.length }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }

  /**
   * alarm handler. Processes ONE job per alarm fire so each invocation
   * has its own CPU budget. If more jobs remain in the queue, reschedule
   * an alarm for the next.
   *
   * Anthropic tool-loop calls are mostly network I/O wait, so even when
   * wall-clock runs into the minutes, CPU usage stays low and the
   * alarm completes cleanly.
   *
   * @returns {Promise<void>}
   */
  async alarm() {
    let config;
    try {
      config = this.getConfig();
    } catch (err) {
      console.error("[LlmRoom] getConfig() failed:", err?.message);
      return;
    }

    const queue = (await this.state.storage.get(QUEUE_KEY)) || [];
    if (queue.length === 0) return;

    const job = queue.shift();
    await this.state.storage.put(QUEUE_KEY, queue);

    const { provenance, ...args } = job || {};
    const label = `${config.botName || "?"}/${args.channel_slug || "?"}/${(args.user_id || "?").slice(0, 8)}`;
    const startedAt = Date.now();
    console.log(`[LlmRoom] starting job ${label}`);

    try {
      await withProvenance(provenance || "mention-reply", () =>
        runLlmPipeline({ env: this.env, ...args, config })
      );
      console.log(`[LlmRoom] done ${label} in ${Date.now() - startedAt}ms`);
    } catch (err) {
      console.error(`[LlmRoom] pipeline error ${label}:`, err?.stack || err?.message);
    }

    const remaining = (await this.state.storage.get(QUEUE_KEY)) || [];
    if (remaining.length > 0) {
      await this.state.storage.setAlarm(Date.now() + 50);
    }
  }
}
