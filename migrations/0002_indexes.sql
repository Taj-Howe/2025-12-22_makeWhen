CREATE INDEX IF NOT EXISTS idx_items_project_parent ON items(project_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_items_assignee ON items(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_items_due_at ON items(due_at);

CREATE INDEX IF NOT EXISTS idx_blocks_item_start ON scheduled_blocks(item_id, start_at);

CREATE INDEX IF NOT EXISTS idx_dependencies_item ON dependencies(item_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on ON dependencies(depends_on_id);

CREATE INDEX IF NOT EXISTS idx_blockers_item_resolved ON blockers(item_id, resolved_at);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

CREATE INDEX IF NOT EXISTS idx_time_entries_item_user_start ON time_entries(item_id, user_id, start_at);
