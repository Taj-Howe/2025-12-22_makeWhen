PRAGMA foreign_keys=off;
BEGIN TRANSACTION;

CREATE TABLE items_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  due_at INTEGER,
  estimate_mode TEXT NOT NULL,
  estimate_minutes INTEGER NOT NULL,
  health TEXT NOT NULL,
  health_mode TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO items_new (
  id,
  type,
  title,
  parent_id,
  status,
  priority,
  due_at,
  estimate_mode,
  estimate_minutes,
  health,
  health_mode,
  notes,
  created_at,
  updated_at,
  sort_order
)
SELECT
  id,
  type,
  title,
  parent_id,
  status,
  priority,
  due_at,
  estimate_mode,
  estimate_minutes,
  health,
  health_mode,
  notes,
  created_at,
  updated_at,
  COALESCE(sort_order, 0)
FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE INDEX IF NOT EXISTS idx_items_parent_id ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_due_at ON items(due_at);
CREATE INDEX IF NOT EXISTS idx_items_parent_sort ON items(parent_id, sort_order, due_at);

COMMIT;
PRAGMA foreign_keys=on;
