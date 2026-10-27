// =============================================================================
// lib/memory.js - D1-backed facts store for Nexus bot workers
//
// Facts are scoped to a user_id. The system prompt builder calls
// buildFactsBlock() to inject the relevant facts before each Anthropic call.
//
// Functions:
//   rememberFact(env, userId, text, [options])  - INSERT a fact
//   forgetFact(env, userId, text, [options])    - DELETE by substring match (LIKE)
//   listFacts(env, userId, [options])           - SELECT user facts (newest first)
//   buildFactsBlock(env, userId, [options])     - returns formatted block for system prompt
//
// options:
//   dbBinding {string} - env binding name for the D1 database (default: "DB")
//
// D1 table: facts (id, user_id, text, created_at)
// Migration: migrations/002_memory_facts.sql
// =============================================================================

const DEFAULT_DB_BINDING = "DB";

/**
 * Save a fact for a user. Returns the new row id, or null if DB is unavailable.
 *
 * @param {object} env - Worker environment bindings (env.DB = D1)
 * @param {string} userId - user id (nexus user_id or similar)
 * @param {string} text - The fact text to remember
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @returns {Promise<number|null>}
 */
export async function rememberFact(env, userId, text, options = {}) {
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const db = env[dbKey];

  if (!db) {
    console.warn(`[memory] DB binding "${dbKey}" not available, skipping rememberFact`);
    return null;
  }
  const createdAt = Math.floor(Date.now() / 1000);
  try {
    const result = await db
      .prepare("INSERT INTO facts (user_id, text, created_at) VALUES (?, ?, ?)")
      .bind(userId, text.trim(), createdAt)
      .run();
    return result?.meta?.last_row_id ?? null;
  } catch (err) {
    console.error("[memory] rememberFact failed:", err.message);
    return null;
  }
}

/**
 * Delete facts for a user that contain the given substring (case-insensitive).
 * Returns the number of rows deleted.
 *
 * @param {object} env
 * @param {string} userId
 * @param {string} text - Substring to match against stored facts
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @returns {Promise<number>}
 */
export async function forgetFact(env, userId, text, options = {}) {
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const db = env[dbKey];

  if (!db) {
    console.warn(`[memory] DB binding "${dbKey}" not available, skipping forgetFact`);
    return 0;
  }
  const pattern = `%${text.trim()}%`;
  try {
    const result = await db
      .prepare("DELETE FROM facts WHERE user_id = ? AND text LIKE ?")
      .bind(userId, pattern)
      .run();
    return result?.meta?.changes ?? 0;
  } catch (err) {
    console.error("[memory] forgetFact failed:", err.message);
    return 0;
  }
}

/**
 * Return all facts for a user, newest first.
 *
 * @param {object} env
 * @param {string} userId
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @returns {Promise<Array<{id: number, text: string, created_at: number}>>}
 */
export async function listFacts(env, userId, options = {}) {
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const db = env[dbKey];

  if (!db) {
    console.warn(`[memory] DB binding "${dbKey}" not available, returning empty facts`);
    return [];
  }
  try {
    const result = await db
      .prepare("SELECT id, text, created_at FROM facts WHERE user_id = ? ORDER BY created_at DESC")
      .bind(userId)
      .all();
    return result?.results || [];
  } catch (err) {
    console.error("[memory] listFacts failed:", err.message);
    return [];
  }
}

/**
 * Build a formatted block suitable for injection into the system prompt.
 * Returns an empty string if the user has no facts.
 *
 * @param {object} env
 * @param {string} userId
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @returns {Promise<string>}
 */
export async function buildFactsBlock(env, userId, options = {}) {
  const facts = await listFacts(env, userId, options);
  if (facts.length === 0) return "";
  const lines = facts.map((f, i) => `${i + 1}. ${f.text}`);
  return `\n\n[Remembered facts for this user]\n${lines.join("\n")}\n[End of remembered facts]`;
}
