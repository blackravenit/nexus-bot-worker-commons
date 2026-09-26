// =============================================================================
// lib/deskFinding.js - file an engineering finding on a Desk board.
//
// For the fleet's DETECTOR jobs: the scheduled work that notices a problem
// rather than doing something about it. Those jobs used to end at a Nexus post,
// and chat has no state, so nothing aged and nothing was tracked. A finding that
// recurred for two months looked exactly like one seen once (measured
// 2026-09-25: 122 dead-number dials across 27 numbers, every one announced in
// chat, worked by nobody). A Desk ticket has state, so it goes on a board.
//
// This is deliberately the ONLY definition in the fleet. Five bots each writing
// their own fetch is how two copies of a rule drift apart, which is what broke
// Jacob's follow-up email for a week.
//
// THE KEY IS THE CONTRACT. `key` must name the CONDITION, not the occurrence:
//   good: 'robert:nexus-self-probe:csp-missing'
//   good: 'maxwell:cron-watchdog:verify-invoices'
//   BAD:  'robert:nexus-self-probe:2026-09-26'   <- a ticket per day
//   BAD:  'maxwell:cron-watchdog:run-8842'       <- a ticket per run
// Desk upserts on the key, so a stable key means a detector on a 10 minute cron
// touches one ticket and appends a note each time. A key with a date or a run id
// in it turns this helper into a ticket-spam machine, which is worse than the
// silence it replaced.
//
// Posting is best-effort by design, but NEVER silent: a failure logs as an error
// with the key so `wrangler tail` can find it. A detector must not lose its own
// run because the Desk API had a bad minute.
// =============================================================================

import { scrubFleetDashes } from "./sanitize.js";

/** Dev boards a detector may file onto. Client-facing queues are not valid. */
const VALID_QUEUES = new Set(["bugs", "agents", "ams", "busa", "crm"]);

const VALID_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);

/**
 * File or update an engineering finding as a Desk ticket.
 *
 * Idempotent on (key, queue): the first call creates the ticket, every later
 * call appends a timestamped note to that same ticket, and a call with
 * `cleared: true` resolves it. A finding that recurs after someone closed the
 * ticket reopens it, because a condition that came back is not resolved.
 *
 * @param {object} env - Worker env. Needs a Desk key; DESK_API_URL optional.
 * @param {object} finding
 * @param {string} finding.key - STABLE condition key. See the header.
 * @param {string} finding.title - short human title for the board.
 * @param {string} finding.detector - the job that found it, e.g. 'maxwell:cron-watchdog'.
 * @param {string} [finding.description] - long-form detail, used on create.
 * @param {string} [finding.note] - this occurrence's measurement, appended as an internal note.
 * @param {"urgent"|"high"|"normal"|"low"} [finding.priority='normal']
 * @param {string} [finding.queue='bugs'] - dev board to file on.
 * @param {boolean} [finding.cleared=false] - the condition no longer holds.
 * @returns {Promise<{ok: boolean, created?: boolean, reopened?: boolean, resolved?: boolean, skipped?: boolean, number?: number, error?: string}>}
 */
export async function reportFinding(env, finding = {}) {
  const key = String(finding.key || "").trim();
  const detector = String(finding.detector || "").trim();
  if (!key) {
    console.error(`[deskFinding] refused a finding with no key (detector=${detector || "unset"})`);
    return { ok: false, error: "key required" };
  }

  // A dated key is the one mistake that makes this worse than chat, so it is
  // caught here rather than discovered as 80 tickets on a Monday.
  if (/\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(key) || /\bepoch|\btimestamp/i.test(key)) {
    console.error(`[deskFinding] refused key "${key}": it names an occurrence, not a condition, and would file one ticket per run`);
    return { ok: false, error: "key must name the condition, not the occurrence" };
  }

  const apiKey = env.DESK_API_KEY || env.DESK_API_KEY_HANK || "";
  if (!apiKey) {
    console.error(`[deskFinding] no Desk API key on env, finding "${key}" was not filed`);
    return { ok: false, error: "no desk api key" };
  }

  const queue = VALID_QUEUES.has(finding.queue) ? finding.queue : "bugs";
  const priority = VALID_PRIORITIES.has(finding.priority) ? finding.priority : "normal";
  const base = (env.DESK_API_URL || "https://desk.blackravenit.com").replace(/\/+$/, "");

  const body = {
    external_id: key,
    queue,
    priority,
    detector,
    title: scrubFleetDashes(String(finding.title || key)),
    description: scrubFleetDashes(String(finding.description || "")),
    note: scrubFleetDashes(String(finding.note || "")),
    resolved: finding.cleared === true,
  };

  try {
    const res = await fetch(`${base}/api/internal/finding`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[deskFinding] ${key} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      return { ok: false, error: `http_${res.status}` };
    }
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // A 200 whose body is not JSON means something answered that is not Desk
      // (a CF Access interstitial does exactly this and returns HTML), so the
      // write did NOT land and must not be reported as success.
      console.error(`[deskFinding] ${key} got a non-JSON 200, treating as failed: ${text.slice(0, 200)}`);
      return { ok: false, error: "non_json_response" };
    }
    return {
      ok: true,
      created: parsed.created === true,
      reopened: parsed.reopened === true,
      resolved: parsed.resolved === true,
      skipped: parsed.skipped === true,
      number: parsed.ticket?.number,
    };
  } catch (err) {
    console.error(`[deskFinding] ${key} threw: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
