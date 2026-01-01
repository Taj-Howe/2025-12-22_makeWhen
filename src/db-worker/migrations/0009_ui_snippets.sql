CREATE TABLE IF NOT EXISTS ui_snippets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  css TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ui_snippets_sort
  ON ui_snippets (sort_order, updated_at);
