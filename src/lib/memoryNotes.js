// =============================================================================
// lib/memoryNotes.js - !remember / !forget / !facts on the shared memory-worker,
// and the one-shot migration of the legacy per-bot D1 `facts` table.
//
// The legacy table (lib/memory.js) is invisible to every other bot and surface.
// Notes saved here land on the person's shared memory entity as predicate
// 'note', so chat, voice, phone and email recall all see them.
//
// memory-worker has NO route to delete or invalidate a single fact (only
// DELETE /entities/:id, which wipes the whole entity). !forget therefore still
// deletes from the legacy table and reports how many shared notes matched but
// could not be removed.
// =============================================================================

import { resolveEntity, assertFact, getEntityFacts } from "./memoryService.js";
import { forgetFact, listFacts } from "./memory.js";

// Nexus chat is the staff surface: write internal, read the merged view.
export const NOTE_STAFF_OPTS = Object.freeze({ audience: "internal", scope: "all" });
export const NOTE_PREDICATE = "note";
const NOTE_MAX_CHARS = 500;
const DEFAULT_MIGRATION_BATCH = 400;

/**
 * Resolve the staff memory entity for a Nexus user.
 * @param {object} env
 * @param {string} botId
 * @param {{userId: string, email?: string, displayName?: string}} who
 * @returns {Promise<string|null>}
 */
export async function resolveNoteEntity(env, botId, who) {
  return resolveEntity(env, botId, {
    userId: who.userId, email: who.email, displayName: who.displayName,
  }, NOTE_STAFF_OPTS);
}

/**
 * Save a note fact. Legacy facts never expired, so notes are stored critical
 * (kept indefinitely) to preserve that promise.
 * @param {object} env
 * @param {string} botId
 * @param {{userId: string, email?: string, displayName?: string}} who
 * @param {string} text
 * @returns {Promise<{ok: boolean, deduplicated?: boolean, error?: string}>}
 */
export async function rememberNote(env, botId, who, text) {
  const entityId = await resolveNoteEntity(env, botId, who);
  if (!entityId) return { ok: false, error: "could not resolve memory entity" };
  const stored = await assertFact(env, botId, {
    subjectId: entityId, predicate: NOTE_PREDICATE, object: String(text).trim().slice(0, NOTE_MAX_CHARS),
    confidence: 1, critical: true,
  }, NOTE_STAFF_OPTS);
  if (!stored?.id) return { ok: false, error: "memory service write failed" };
  return { ok: true, deduplicated: stored.deduplicated === true };
}

/**
 * Active shared facts for a Nexus user (all predicates, staff view).
 * @param {object} env
 * @param {string} botId
 * @param {{userId: string, email?: string, displayName?: string}} who
 * @returns {Promise<Array<object>>}
 */
export async function listSharedFacts(env, botId, who) {
  const entityId = await resolveNoteEntity(env, botId, who);
  if (!entityId) return [];
  return getEntityFacts(env, botId, entityId, NOTE_STAFF_OPTS);
}

/**
 * Forget: delete matching legacy rows, and count shared notes that match but
 * cannot be removed until memory-worker grows a fact invalidation route.
 * @param {object} env
 * @param {string} botId
 * @param {{userId: string}} who
 * @param {string} query - case-insensitive substring
 * @param {{dbBinding?: string}} [options]
 * @returns {Promise<{legacyDeleted: number, sharedMatches: number}>}
 */
export async function forgetNotes(env, botId, who, query, options = {}) {
  const needle = String(query).trim().toLowerCase();
  const legacyDeleted = await forgetFact(env, who.userId, needle, options);
  const shared = await listSharedFacts(env, botId, who);
  const sharedMatches = shared.filter((f) => f?.predicate === NOTE_PREDICATE
    && String(f.object || "").toLowerCase().includes(needle)).length;
  return { legacyDeleted, sharedMatches };
}

/**
 * Format the !facts reply: shared facts, plus legacy rows until migrated.
 * @param {Array<object>} shared
 * @param {Array<{text: string}>} legacy
 * @returns {string}
 */
export function formatFactsReply(shared, legacy) {
  const lines = [];
  const items = [
    ...shared.filter((f) => f?.object).map((f) => (f.predicate === NOTE_PREDICATE
      ? String(f.object) : `${String(f.predicate).replace(/_/g, " ")}: ${f.object}`)),
    ...legacy.map((f) => `${f.text} (legacy, not yet migrated)`),
  ];
  if (items.length === 0) return "No facts remembered yet.";
  lines.push(`**Facts (${items.length})**`);
  items.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  return lines.join("\n");
}

/**
 * Legacy rows for !facts, skipped once config.legacyFactsMigrated is true.
 * @param {object} env
 * @param {string} userId
 * @param {object} config
 * @returns {Promise<Array<object>>}
 */
export async function legacyFactsForReply(env, userId, config) {
  if (config?.legacyFactsMigrated === true) return [];
  return listFacts(env, userId, { dbBinding: config?.dbBinding });
}

/**
 * One-shot copy of legacy D1 `facts` rows into memory-worker as critical
 * 'note' facts on each user's entity (resolved by Nexus user id). Idempotent:
 * memory-worker dedupes identical (subject, predicate, object) server side,
 * so re-running only reports them as deduplicated. Rows are read in id order
 * in batches; pass the returned nextAfterId to continue a large table.
 *
 * @param {object} env
 * @param {string} botId
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"]
 * @param {number} [options.afterId=0]
 * @param {number} [options.limit=400]
 * @returns {Promise<{scanned: number, migrated: number, deduplicated: number, failed: number, nextAfterId: number|null}>}
 */
export async function migrateLegacyFacts(env, botId, options = {}) {
  const db = env?.[options.dbBinding || "DB"];
  if (!db || !env.MEMORY) throw new Error(`[memoryNotes] migrateLegacyFacts needs ${options.dbBinding || "DB"} and MEMORY bindings`);
  const limit = Number(options.limit) > 0 ? Number(options.limit) : DEFAULT_MIGRATION_BATCH;
  const { results = [] } = await db
    .prepare("SELECT id, user_id, text FROM facts WHERE id > ? ORDER BY id ASC LIMIT ?")
    .bind(Number(options.afterId) || 0, limit)
    .all();
  const counts = { scanned: results.length, migrated: 0, deduplicated: 0, failed: 0 };
  const entityByUser = new Map();
  for (const row of results) {
    const outcome = await migrateOneFact(env, botId, row, entityByUser);
    counts[outcome] += 1;
  }
  return { ...counts, nextAfterId: results.length === limit ? results[results.length - 1].id : null };
}

async function migrateOneFact(env, botId, row, entityByUser) {
  if (!row?.user_id || !String(row.text || "").trim()) return "failed";
  if (!entityByUser.has(row.user_id)) {
    entityByUser.set(row.user_id, await resolveNoteEntity(env, botId, { userId: row.user_id }));
  }
  const entityId = entityByUser.get(row.user_id);
  if (!entityId) {
    console.error(`[memoryNotes] migrate: no entity for user=${row.user_id} fact=${row.id}`);
    return "failed";
  }
  const stored = await assertFact(env, botId, {
    subjectId: entityId, predicate: NOTE_PREDICATE, object: String(row.text).trim().slice(0, NOTE_MAX_CHARS),
    confidence: 1, critical: true,
  }, NOTE_STAFF_OPTS);
  if (!stored?.id) {
    console.error(`[memoryNotes] migrate: write failed user=${row.user_id} fact=${row.id}`);
    return "failed";
  }
  return stored.deduplicated ? "deduplicated" : "migrated";
}
