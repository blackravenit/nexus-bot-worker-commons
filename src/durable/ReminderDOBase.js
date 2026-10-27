// =============================================================================
// ReminderDOBase, Durable Object base class that replaces every-minute
// reminder polling with exact-time Cloudflare DO Alarms.
//
// The OLD pattern (`* * * * *` cron + scan D1 for due rows) wasted ~1440
// invocations/day per bot to do "fired:0,errors:0", 99% of the captured QA
// noise pre-Batch-1.1. The NEW pattern:
//
//   1. When a reminder is inserted into D1, the create-tool also calls
//      scheduleReminderAlarm(env, "REMINDER_SCHEDULER", dueAtMs).
//   2. The DO sets state.storage.setAlarm(min(currentAlarm, newDueAt)).
//   3. CF wakes the DO at the exact moment via the alarm() method.
//   4. alarm() invokes the subclass's fireDue() (which does the existing
//      query+post-to-Nexus+mark-fired flow), then recomputes the next alarm
//      from D1's earliest remaining unfired row.
//
// Result: ZERO polling, exact-second precision, billed only for actual fires.
//
// Subclasses MUST override:
//   - getDueAt(env)  -> Promise<number | null>   (earliest unfired due_at, ms)
//   - fireDue(env)   -> Promise<{fired:number, errors:number}>  (existing
//                                                                 fire-due-
//                                                                 reminders fn)
//
// See dexter-worker / maxwell-worker / robert-worker `src/durable/reminder-do.js`
// for canonical subclasses.
// =============================================================================

/**
 * Base class for per-bot Reminder DO implementations.
 */
import { withProvenance } from "../lib/provenanceContext.js";

export class ReminderDOBase {
  /**
   * @param {DurableObjectState} state
   * @param {object} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /**
   * HTTP-style entry. Two endpoints:
   *   POST /schedule  body {fireAt:number}   -> sets alarm to min(existing, fireAt)
   *   POST /bootstrap                          -> reseeds alarm from D1 (idempotent)
   *
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/schedule" && req.method === "POST") {
        const { fireAt } = await req.json();
        if (typeof fireAt !== "number" || !Number.isFinite(fireAt)) {
          return new Response("fireAt must be a finite ms timestamp", { status: 400 });
        }
        await this._scheduleAt(fireAt);
        return new Response("ok");
      }
      if (url.pathname === "/bootstrap" && req.method === "POST") {
        await this._bootstrap();
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error("[ReminderDO] fetch failed:", err?.stack || err);
      return new Response(`error: ${err?.message || err}`, { status: 500 });
    }
  }

  /**
   * Set the alarm to min(existing, newFireAt). A no-op if the new time is
   * later than (or equal to) the already-pending alarm.
   *
   * @param {number} fireAtMs
   */
  async _scheduleAt(fireAtMs) {
    const cur = await this.state.storage.getAlarm();
    if (cur === null || fireAtMs < cur) {
      await this.state.storage.setAlarm(fireAtMs);
    }
  }

  /**
   * Reseed the alarm from D1's earliest unfired reminder. Called by:
   *   - alarm() at end (after a fire batch)
   *   - the bootstrap endpoint (deploy-time + safety failsafe)
   *
   * Idempotent and safe to call repeatedly.
   */
  async _bootstrap() {
    const next = await this.getDueAt(this.env);
    if (next === null || next === undefined) {
      // No pending reminders, explicitly clear any stale alarm.
      await this.state.storage.deleteAlarm();
      return;
    }
    const cur = await this.state.storage.getAlarm();
    if (cur === null || next < cur) {
      await this.state.storage.setAlarm(next);
    }
  }

  /**
   * Called by Cloudflare when the alarm time arrives. Fires due reminders
   * via the subclass, then recomputes the next alarm. Errors do not abort
   * the rescheduling step, a broken row should not stop future fires.
   */
  async alarm() {
    let res;
    try {
      // A DO alarm is a bare entry point: no scheduled() wrapper ever ran, so
      // postToNexus inside fireDue would carry no provenance and Nexus 400s it
      // (the 2026-08-14 lost-canary bug). Wrap here so every subclass is safe.
      res = await withProvenance("scheduled-cron", () => this.fireDue(this.env));
      console.log(`[ReminderDO] alarm() fired ${res?.fired ?? "?"} reminders, ${res?.errors ?? "?"} errors`);
    } catch (err) {
      console.error("[ReminderDO] fireDue threw:", err?.stack || err);
    }
    // Always re-seed next alarm from D1, even after errors.
    try {
      await this._bootstrap();
    } catch (err) {
      console.error("[ReminderDO] post-fire reseed failed:", err?.stack || err);
    }
  }

  // --- Subclass contract ---------------------------------------------------

  /**
   * Subclass: return the earliest unfired reminder's fire-at (ms), or null.
   *
   * @abstract
   * @param {object} env
   * @returns {Promise<number | null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getDueAt(env) {
    throw new Error("ReminderDOBase: subclass must override getDueAt(env)");
  }

  /**
   * Subclass: fire all reminders whose due_at <= now. Should match the
   * behavior of the pre-migration runReminderFire / runReminderFiring /
   * runReminderSweep job (post to Nexus, mark fired).
   *
   * @abstract
   * @param {object} env
   * @returns {Promise<{fired: number, errors: number}>}
   */
  // eslint-disable-next-line no-unused-vars
  async fireDue(env) {
    throw new Error("ReminderDOBase: subclass must override fireDue(env)");
  }
}

/**
 * Helper for tool/handler code to schedule a reminder alarm without
 * constructing a fetch request inline. Call this AFTER inserting the
 * reminder row into D1.
 *
 * @param {object} env
 * @param {string} bindingName - the DO binding name (e.g., "REMINDER_SCHEDULER")
 * @param {number} fireAtMs - the due_at timestamp in ms
 * @returns {Promise<void>}
 */
export async function scheduleReminderAlarm(env, bindingName, fireAtMs) {
  const binding = env[bindingName];
  if (!binding) {
    console.warn(`[scheduleReminderAlarm] no env.${bindingName} binding; skipping`);
    return;
  }
  if (typeof fireAtMs !== "number" || !Number.isFinite(fireAtMs)) {
    console.warn(`[scheduleReminderAlarm] invalid fireAtMs=${fireAtMs}`);
    return;
  }
  const id = binding.idFromName("global");
  const stub = binding.get(id);
  try {
    const r = await stub.fetch("https://reminder-do/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fireAt: fireAtMs }),
    });
    if (!r.ok) {
      console.warn(`[scheduleReminderAlarm] DO returned ${r.status}: ${await r.text()}`);
    }
  } catch (err) {
    console.error(`[scheduleReminderAlarm] DO call failed: ${err?.message || err}`);
  }
}

/**
 * One-shot bootstrap (typically called from a deploy admin route post-deploy
 * OR a daily safety-net cron). Seeds the DO alarm from D1's current state.
 *
 * @param {object} env
 * @param {string} bindingName
 * @returns {Promise<void>}
 */
export async function bootstrapReminderAlarm(env, bindingName) {
  const binding = env[bindingName];
  if (!binding) return;
  const id = binding.idFromName("global");
  const stub = binding.get(id);
  try {
    await stub.fetch("https://reminder-do/bootstrap", { method: "POST" });
  } catch (err) {
    console.error(`[bootstrapReminderAlarm] DO call failed: ${err?.message || err}`);
  }
}
