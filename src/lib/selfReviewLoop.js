// =============================================================================
// lib/selfReviewLoop.js: fleet-shared self-review loop.
//
// Generalizes the pattern first built in moxie-worker (jobs/self-review.js):
//   propose -> self-critique/classify -> dedup by fingerprint -> HITL-gate
//   (Approve/Skip card) -> execute-on-approval (compare-and-swap guarded).
//
// A recommending bot reads its OWN output (analytics recs, posture findings,
// ops suggestions), critiques each into an actionable proposal or an advisory
// note, and cards the actionable ones so its research is acted on once a human
// approves instead of dying in a digest. The bot supplies the content callbacks
// (propose / critique / execute) and its storage; commons owns the cards,
// buttons, dedup, and the compare-and-swap idempotency that stops a double
// click from executing twice.
//
// The bot owns its proposals table + migration. Expected columns (mirror
// moxie's self_review_proposals): id, source_id, item, fingerprint,
// action_type, action_args, status, nexus_message_id, created_at, resolved_at,
// result_note.
// =============================================================================

import { postToNexus, attachButtons, settleHitlCard } from "./nexus.js";
import { buildReport } from "./embedCard.js";
import { PALETTE } from "./format.js";

// Default dedup window: a fingerprint stays "already proposed" for 30 days so
// the loop does not re-card the same recommendation every run while a human is
// still deciding.
const DEFAULT_DEDUP_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * Normalize a recommendation into a stable dedup key (lowercased alnum words,
 * sorted, capped). Identical to moxie's fingerprint(); exported as the fleet
 * default so adopters do not each re-invent it.
 * @param {string} text
 * @returns {string}
 */
export function recommendationFingerprint(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .slice(0, 12)
    .join(" ");
}

function makeProposalId() {
  return `srp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * True if this fingerprint was already proposed inside the dedup window.
 * @param {object} db - D1 binding
 * @param {string} table
 * @param {string} fp
 * @param {number} windowMs
 * @returns {Promise<boolean>}
 */
async function alreadyProposed(db, table, fp, windowMs) {
  const cutoff = Date.now() - windowMs;
  const row = await db
    .prepare(`SELECT id FROM ${table} WHERE fingerprint = ? AND created_at > ? LIMIT 1`)
    .bind(fp, cutoff)
    .first();
  return !!row;
}

/**
 * Default Approve/Skip card renderer. A bot may pass its own buildCard.
 * @param {object} p - { item, summary, botName, subtitle, cardTitle }
 * @returns {object} buildReport embed
 */
function defaultBuildCard({ item, summary, botName, subtitle, cardTitle }) {
  return buildReport({
    botName,
    emoji: PALETTE.PENDING,
    title: cardTitle || "My own recommendation - want me to run with it?",
    subtitle,
    body:
      `I flagged this in my own review:\n\n> ${item}\n\n` +
      `**If you approve:** ${summary}\n\n` +
      `Approve to proceed, or Skip to leave it alone.`,
  });
}

/**
 * Persist a proposal + post its Approve/Skip card.
 * @returns {Promise<boolean>} true if a card was posted
 */
async function postProposal(env, cfg, p) {
  const id = makeProposalId();
  const callbackSecret = cfg.callbackSecret;
  const card = (cfg.buildCard || defaultBuildCard)({
    item: p.item, summary: p.summary, botName: cfg.botName, subtitle: p.subtitle, cardTitle: cfg.cardTitle,
  });
  const msg = await postToNexus(env, cfg.channelSlug, card, { nexusKeyEnvVar: cfg.nexusKeyEnvVar });
  if (!msg || !msg.id) {
    console.warn("[selfReviewLoop] postToNexus returned no message id; proposal not carded");
    return false;
  }
  const btn = (verb, style) => ({
    button_id: `${cfg.buttonPrefix}-${verb}:${id}`,
    label: verb === "approve" ? "Approve" : "Skip",
    style,
    callback_url: cfg.callbackUrl,
    ...(callbackSecret ? { callback_secret: callbackSecret } : {}),
  });
  await attachButtons(env, msg.id, [btn("approve", "primary"), btn("skip", "secondary")], { nexusKeyEnvVar: cfg.nexusKeyEnvVar });
  await cfg.db
    .prepare(
      `INSERT INTO ${cfg.table} (id, source_id, item, fingerprint, action_type, action_args, status, nexus_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`
    )
    .bind(id, p.sourceId || "", p.item, p.fingerprint, p.actionType || null, JSON.stringify(p.actionArgs || {}), msg.id, Date.now())
    .run();
  return true;
}

/**
 * Run the self-review loop: propose -> critique -> dedup -> card actionable,
 * recap advisory.
 *
 * @param {object} env
 * @param {object} cfg
 * @param {object} cfg.db - D1 binding
 * @param {string} cfg.table - proposals table (bot owns the migration)
 * @param {string} cfg.channelSlug - HITL channel
 * @param {string} cfg.nexusKeyEnvVar - env var holding the outbound Nexus key
 * @param {string} cfg.callbackUrl - button callback URL
 * @param {string} [cfg.callbackSecret] - HMAC secret stamped on buttons
 * @param {string} cfg.buttonPrefix - e.g. "postrec" -> "postrec-approve:"/"postrec-skip:"
 * @param {string} cfg.botName - card branding
 * @param {number} [cfg.dedupWindowMs]
 * @param {(env) => Promise<Array>} cfg.propose - returns raw candidate items
 * @param {(env, candidates) => Promise<Array<{item, actionType, actionArgs, summary, advisoryLine, sourceId}>>} cfg.critique
 * @param {(item) => string} [cfg.fingerprint] - dedup key fn (defaults to recommendationFingerprint over item.item)
 * @param {(args) => object} [cfg.buildCard]
 * @param {(env, advisoryLines) => Promise<void>} [cfg.onAdvisory]
 * @param {string} [cfg.subtitle]
 * @param {string} [cfg.cardTitle]
 * @returns {Promise<{proposed: number, advisory: number, skipped_dupes: number}>}
 */
export async function runSelfReviewLoop(env, cfg) {
  const { db } = cfg;
  if (!db) {
    console.warn("[selfReviewLoop] no DB binding; skipping");
    return { proposed: 0, advisory: 0, skipped_dupes: 0 };
  }
  const dedupWindowMs = cfg.dedupWindowMs || DEFAULT_DEDUP_WINDOW_MS;
  const fpFn = cfg.fingerprint || ((c) => recommendationFingerprint(c.item));

  const candidates = await cfg.propose(env);
  if (!Array.isArray(candidates) || !candidates.length) {
    console.log("[selfReviewLoop] nothing to review");
    return { proposed: 0, advisory: 0, skipped_dupes: 0 };
  }
  let critiqued = [];
  try {
    critiqued = (await cfg.critique(env, candidates)) || [];
  } catch (err) {
    // Critique failure degrades to zero proposals, never a crash.
    console.warn("[selfReviewLoop] critique failed, no proposals this run:", err.message);
    return { proposed: 0, advisory: 0, skipped_dupes: 0 };
  }

  let proposed = 0;
  let advisory = 0;
  let skippedDupes = 0;
  const advisoryLines = [];
  for (const c of critiqued) {
    if (!c || !c.item) continue;
    // No actionType => advisory: surface it so nothing is hidden, but never card.
    if (!c.actionType) {
      advisory++;
      advisoryLines.push(c.advisoryLine || `- ${c.item}`);
      continue;
    }
    const fp = fpFn(c);
    if (await alreadyProposed(db, cfg.table, fp, dedupWindowMs)) {
      skippedDupes++;
      continue;
    }
    const ok = await postProposal(env, cfg, {
      item: c.item, fingerprint: fp, actionType: c.actionType, actionArgs: c.actionArgs,
      summary: c.summary || "act on this recommendation", sourceId: c.sourceId, subtitle: cfg.subtitle,
    });
    if (ok) proposed++;
  }

  if (advisoryLines.length && typeof cfg.onAdvisory === "function") {
    await cfg.onAdvisory(env, advisoryLines).catch((err) =>
      console.warn("[selfReviewLoop] advisory recap failed:", err.message)
    );
  }
  console.log(`[selfReviewLoop] ${cfg.botName}: ${proposed} proposed, ${advisory} advisory, ${skippedDupes} dupes`);
  return { proposed, advisory, skipped_dupes: skippedDupes };
}

/**
 * Stamp a proposal's final status + note.
 */
async function markResolved(db, table, id, status, note) {
  await db
    .prepare(`UPDATE ${table} SET status = ?, resolved_at = ?, result_note = ? WHERE id = ?`)
    .bind(status, Date.now(), String(note || "").slice(0, 500), id)
    .run();
}

/**
 * Handle an Approve / Skip click on a self-review proposal card. Compare-and-swap
 * claims the row so a double click cannot execute twice; on approve the bot's
 * execute(env, row) runs (default: acknowledge-only, no side effect), then the
 * outcome is posted and the card settled.
 *
 * @param {object} env
 * @param {object} payload - { button_id, user_id, display_name }
 * @param {object} cfg
 * @param {object} cfg.db - D1 binding
 * @param {string} cfg.table
 * @param {string} cfg.buttonPrefix
 * @param {string} cfg.channelSlug
 * @param {string} cfg.nexusKeyEnvVar
 * @param {string} cfg.botName
 * @param {(env, row) => Promise<{ok: boolean, message?: string, error?: string}>} [cfg.execute]
 * @param {string} [cfg.cardTitle]
 * @returns {Promise<{handled: boolean}>}
 */
export async function handleSelfReviewLoopClick(env, payload, cfg) {
  const buttonId = payload?.button_id;
  if (typeof buttonId !== "string") return { handled: false };
  const approvePrefix = `${cfg.buttonPrefix}-approve:`;
  const skipPrefix = `${cfg.buttonPrefix}-skip:`;
  const isApprove = buttonId.startsWith(approvePrefix);
  const isSkip = buttonId.startsWith(skipPrefix);
  if (!isApprove && !isSkip) return { handled: false };
  const db = cfg.db;
  if (!db) return { handled: true };
  const id = buttonId.slice((isApprove ? approvePrefix : skipPrefix).length);
  const who = payload?.display_name || "Brian";
  const post = (text) => postToNexus(env, cfg.channelSlug, text, { nexusKeyEnvVar: cfg.nexusKeyEnvVar });

  // Compare-and-swap claim: a double click after the first resolves is a no-op.
  const claim = await db
    .prepare(`UPDATE ${cfg.table} SET status = ?, resolved_at = ? WHERE id = ? AND status = 'proposed'`)
    .bind(isApprove ? "approved" : "skipped", Date.now(), id)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return { handled: true };

  const row = await db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).bind(id).first();
  if (row?.nexus_message_id) {
    await settleHitlCard(env, row.nexus_message_id, {
      botName: cfg.botName, title: cfg.cardTitle || "Self-Review Proposal",
      status: isApprove ? "Approved" : "Skipped", actor: who, rejected: isSkip,
    }, { nexusKeyEnvVar: cfg.nexusKeyEnvVar }).catch((err) =>
      console.warn("[selfReviewLoop] settle failed:", err.message)
    );
  }
  if (isSkip) {
    await post(`${cfg.botName}: skipping my recommendation per ${who}. Left as-is.`);
    return { handled: true };
  }

  // Approve. Default is acknowledge-only (advisory-day-one): no executor wired.
  if (typeof cfg.execute !== "function") {
    await markResolved(db, cfg.table, id, "acknowledged", "approved (no auto-execute)");
    await post(`${cfg.botName}: noted. ${who} approved my recommendation. I have logged it for follow-up.`);
    return { handled: true };
  }
  try {
    const res = await cfg.execute(env, row);
    if (!res || !res.ok) {
      await markResolved(db, cfg.table, id, "failed", res?.error || "execute failed");
      await post(`${cfg.botName}: approved by ${who}, but the action failed, ${res?.error || "unknown"}. Nothing applied.`);
      return { handled: true };
    }
    await markResolved(db, cfg.table, id, "executed", res.message || "done");
    await post(`${cfg.botName}: done. ${who} approved my recommendation, so I ${res.message}`);
  } catch (err) {
    await markResolved(db, cfg.table, id, "failed", err.message);
    await post(`${cfg.botName}: approved but hit an error applying it, ${err.message}. Nothing applied.`);
  }
  return { handled: true };
}
