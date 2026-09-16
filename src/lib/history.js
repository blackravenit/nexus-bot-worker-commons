// =============================================================================
// lib/history.js - D1-backed conversation history for Nexus chat bots
//
// history_key format: nexus:<user_id>
// Each user gets an isolated conversation thread per bot. Per-bot isolation
// is achieved by using separate D1 databases (one DB binding per bot worker).
//
// Functions:
//   loadHistory(env, historyKey, [options])  - returns last N turns, chronological
//   appendHistory(env, historyKey, role, content, [options]) - inserts one row
//
// Cap: last 30 turns per key by default. Rows are pruned automatically in
// appendHistory when the per-key row count exceeds MAX_PRUNE_THRESHOLD (200).
// Pruning deletes rows with the smallest ids (oldest) beyond the keep window,
// keeping exactly MAX_PRUNE_KEEP (150) rows per key. This prevents unbounded
// table growth that causes D1 timeout errors on the loadHistory query.
//
// Query ordering uses ORDER BY id DESC (primary key) rather than ORDER BY
// created_at DESC, id DESC. Since id is AUTOINCREMENT it is strictly
// monotonic -- equivalent to insertion order. Ordering by id alone lets D1
// satisfy the query from the primary-key index scoped by the history_key
// covering index, avoiding a full in-memory sort across all rows for a key.
//
// options:
//   dbBinding    {string} - env binding name for the D1 database (default: "DB")
//   maxTurns     {number} - max turns to return (default: 30)
//   skipPrune    {boolean} - skip automatic pruning in appendHistory (default: false)
//
// Errors are caught, logged, and swallowed. loadHistory returns []; appendHistory
// is a no-op on failure. History loss is better than crashing the bot.
// =============================================================================

const DEFAULT_DB_BINDING = "DB";
const DEFAULT_MAX_TURNS = 30;

// Pruning: once a history_key accumulates more than MAX_PRUNE_THRESHOLD rows,
// trim back to MAX_PRUNE_KEEP rows (keeping the most recent ones by id).
// Fire-and-forget -- errors are logged but do not block the insert.
const MAX_PRUNE_THRESHOLD = 200;
const MAX_PRUNE_KEEP = 150;

/**
 * Load the last maxTurns conversation turns for a given history key.
 * Returns rows in chronological order (oldest first).
 *
 * @param {object} env - Worker environment bindings
 * @param {string} historyKey - e.g. "nexus:12345"
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @param {number} [options.maxTurns=30] - Max turns to return
 * @param {boolean} [options.withMeta=false] - also return row id and created_at
 *   (callers must strip them before sending rows to the model)
 * @returns {Promise<Array<{role: string, content: string, id?: number, created_at?: number}>>}
 */
export async function loadHistory(env, historyKey, options = {}) {
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const db = env[dbKey];

  if (!db) {
    console.warn(`[history] DB binding "${dbKey}" not available -- returning empty history`);
    return [];
  }
  try {
    // ORDER BY id DESC: id is AUTOINCREMENT so it is strictly monotonic --
    // equivalent to insertion order but satisfiable from the primary-key index
    // scoped by the history_key covering index. This avoids the two-column
    // (created_at DESC, id DESC) sort that requires an in-memory pass over
    // all rows for the key when the table is large, which was causing D1
    // timeout errors and LlmRoom DO resets on high-volume bots.
    const result = await db
      .prepare(
        "SELECT id, role, content, created_at FROM chat_history WHERE history_key = ? ORDER BY id DESC LIMIT ?",
      )
      .bind(historyKey, maxTurns)
      .all();

    const rows = result?.results || [];
    // Rows come back newest-first; reverse for chronological order.
    if (options.withMeta) {
      return rows.reverse().map(({ id, role, content, created_at }) => ({ id, role, content, created_at }));
    }
    return rows.reverse().map(({ role, content }) => ({ role, content }));
  } catch (err) {
    console.error("[history] loadHistory failed:", err.message);
    return [];
  }
}

/**
 * Append a single conversation turn to D1.
 * After inserting, automatically prunes old rows for the key if the row count
 * exceeds MAX_PRUNE_THRESHOLD, keeping MAX_PRUNE_KEEP most-recent rows.
 * Pruning is fire-and-forget -- errors are logged but do not block the insert.
 * Errors are logged and swallowed.
 *
 * @param {object} env - Worker environment bindings
 * @param {string} historyKey - e.g. "nexus:12345"
 * @param {"user"|"assistant"} role
 * @param {string} content
 * @param {object} [options]
 * @param {string} [options.dbBinding="DB"] - D1 binding name on env
 * @param {boolean} [options.skipPrune=false] - skip automatic pruning
 * @returns {Promise<void>}
 */
export async function appendHistory(env, historyKey, role, content, options = {}) {
  const dbKey = options.dbBinding || DEFAULT_DB_BINDING;
  const db = env[dbKey];

  if (!db) {
    console.warn(`[history] DB binding "${dbKey}" not available -- skipping append`);
    return;
  }
  const createdAt = Math.floor(Date.now() / 1000);
  try {
    await db
      .prepare(
        "INSERT INTO chat_history (history_key, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(historyKey, role, content, createdAt)
      .run();
  } catch (err) {
    console.error("[history] appendHistory failed:", err.message);
    return;
  }

  // Pruning: trim oversized per-key history so the table never grows large
  // enough to cause D1 timeout errors on loadHistory queries. Uses the
  // minimum id of the rows we want to keep as a cheap delete boundary --
  // no subquery required, one index seek.
  if (options.skipPrune) return;
  try {
    const countResult = await db
      .prepare("SELECT COUNT(*) as cnt FROM chat_history WHERE history_key = ?")
      .bind(historyKey)
      .first();
    const rowCount = countResult?.cnt ?? 0;
    if (rowCount > MAX_PRUNE_THRESHOLD) {
      // Find the id of the MAX_PRUNE_KEEP-th most-recent row (OFFSET-based).
      // Rows with id < cutoffId are the oldest ones; delete them.
      const cutoffResult = await db
        .prepare(
          "SELECT id FROM chat_history WHERE history_key = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
        )
        .bind(historyKey, MAX_PRUNE_KEEP - 1)
        .first();
      if (cutoffResult?.id != null) {
        const deleted = await db
          .prepare("DELETE FROM chat_history WHERE history_key = ? AND id < ?")
          .bind(historyKey, cutoffResult.id)
          .run();
        console.log(
          `[history] pruned ${deleted?.meta?.changes ?? "?"} rows for key=${historyKey} (was ${rowCount}, keep=${MAX_PRUNE_KEEP})`,
        );
      }
    }
  } catch (err) {
    console.error("[history] pruning failed (non-fatal):", err.message);
  }
}
