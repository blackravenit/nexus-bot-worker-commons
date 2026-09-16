-- Rolling summaries of chat_history rows folded out of the token budget
-- (lib/historyFold.js, config.contextBudget.enabled). One row per fold,
-- keyed by history_key plus the id of the newest chat_history row covered.
-- lib/historyFold.js creates this table on first use if it is missing, so
-- applying this migration is tidy but not a deploy blocker.
CREATE TABLE IF NOT EXISTS history_summaries (
  history_key TEXT NOT NULL,
  upto_id INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (history_key, upto_id)
);
