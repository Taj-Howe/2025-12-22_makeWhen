CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  estimate_mode TEXT NOT NULL,
  estimate_minutes INTEGER NOT NULL,
  health TEXT NOT NULL,
  health_mode TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_assignees (
  item_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL,
  PRIMARY KEY (item_id, assignee_id)
);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE IF NOT EXISTS dependencies (
  item_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (item_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS blockers (
  blocker_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);

CREATE TABLE IF NOT EXISTS scheduled_blocks (
  block_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  locked INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
  entry_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  note TEXT,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  log_id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  op_name TEXT NOT NULL,
  actor TEXT NOT NULL,
  ts INTEGER NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_parent_id ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_due_at ON items(due_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_blocks_start_at ON scheduled_blocks(start_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_blocks_item_id ON scheduled_blocks(item_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_item_id ON dependencies(item_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on_id ON dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_blockers_item_id_cleared_at ON blockers(item_id, cleared_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_item_id ON time_entries(item_id);
