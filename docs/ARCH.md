# Architecture Map (Quick Inventory)

This is a fast index of worker APIs, database tables, migrations, UI entry points, and special state machines.

## Tech stack

- Vite + React 18 + TypeScript
- SQLite-WASM in a Web Worker (OPFS + opfs-sahpool)
- Radix UI Themes + Radix primitives + Radix Colors
- pnpm

## Data flow (text diagram)

UI (React) -> RPC client (src/rpc) -> db-worker (SQLite-WASM)

## Worker APIs (src/db-worker/worker.ts)

Queries (named):
- `getItemDetails`
- `get_running_timer`
- `getProjectTree`
- `listKanban`
- `listItems`
- `list_view_complete`
- `list_view_scope`
- `execution_window`
- `blocked_view`
- `due_overdue`
- `contributions_range`
- `kanban_view`
- `searchItems`
- `listGantt`
- `listExecution`
- `listBlocked`
- `listByUser`
- `listOverdue`
- `listDueSoon`
- `getSettings`
- `listCalendarBlocks`
- `calendar_range`
- `gantt_range`
- `calendar_range_user`
- `users_list`
- `debug.verify_integrity`

Mutations (ops):
- `create_item`
- `update_item_fields`
- `set_status`
- `scheduled_block.create`
- `scheduled_block.update`
- `scheduled_block.delete`
- `create_block` / `move_block` / `resize_block` / `delete_block` (legacy block ops)
- `item.archive` / `items.archive_many`
- `item.restore` / `items.restore_many`
- `delete_item` / `items.delete_many`
- `reorder_item`
- `move_item`
- `add_time_entry`
- `start_timer` / `stop_timer`
- `set_setting`
- `export_data` / `import_data`
- `dependency.create` / `dependency.update` / `dependency.delete`
- `add_dependency` / `remove_dependency`
- `add_blocker` / `clear_blocker`
- `set_item_tags`
- `user.create` / `user.update`
- `item.set_assignee`
- `set_item_assignees`

## DB tables (src/db-worker/migrations)

Core tables:
- `items`
- `item_assignees`
- `item_tags`
- `dependencies`
- `blockers`
- `scheduled_blocks`
- `time_entries`
- `audit_log`
- `settings`

Additional tables:
- `running_timers`
- `ui_snippets`

## Migrations

- `0001_init.sql` initial schema
- `0002_blockers_kind_text.sql` blocker fields
- `0003_running_timers.sql` running timers table
- `0004_sort_order.sql` manual ordering
- `0005_due_at_nullable.sql` allow null due dates
- `0006_title_search.sql` title search index
- `0007_dependencies_type_lag.sql` dependency type/lag
- `0008_completed_at.sql` completion timestamp
- `0009_ui_snippets.sql` UI CSS snippets
- `0010_archived_at.sql` archiving timestamp

## UI entry points (src/ui)

Views:
- `ListView.tsx`
- `CalendarView.tsx`
- `GanttView.tsx`
- `KanbanView.tsx`
- `DashboardView.tsx`

Shell + shared:
- `App.tsx`
- `RightSheet.tsx` (drawer)
- `CommandPalette.tsx`
- `ThemeRoot.tsx` / `ThemeApplier.tsx`
- `ScopeContext.tsx`
- `SidebarProjects.tsx`
- `AddItemForm.tsx`
- `ItemAutocomplete.tsx`
- `UserSelect.tsx`
- `controls.tsx` (shared control wrappers)

## Special state machines / interactions

- List selection: multi-select (shift/cmd/ctrl), selection highlight
- List drag/drop: move tasks between milestones/ungrouped, multi-drag
- Calendar: click/drag to create blocks, move/resize blocks
- Command palette: CLI parsing and actions
- Right sheet: item editing drawer
- Timer: running timer per item

## Scripts/tests

- `scripts/rollup.test.mjs`
- `scripts/scheduleMath.test.mjs`
