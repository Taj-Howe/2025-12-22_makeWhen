ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_items_parent_sort ON items(parent_id, sort_order, due_at);
