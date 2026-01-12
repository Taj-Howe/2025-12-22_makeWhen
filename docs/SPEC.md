# MakeWhen Spec (Source of Truth)

This doc defines the non-negotiable domain truths, what is stored vs computed, and what each UI view is allowed to do.

## Architecture rules

- UI is a Vite + React + TypeScript SPA.
- SQLite-WASM runs only in a Web Worker (OPFS + sahpool).
- UI never runs SQL.
- All writes go through worker mutate ops.
- All reads go through worker named queries.
- Derived logic lives in the worker (and `src/db-worker/rollup.ts`), not in UI.

## Source of truth (canonical)

- Scheduling: `scheduled_blocks` with `{ start_at, duration_minutes }`. End time is derived.
- Deadlines: `items.due_at` (optional).
- Dependencies: `dependencies` edges. `blocked_by` / `blocking` are projections only.
- Blockers: `blockers` table (active = `cleared_at IS NULL`).
- Completion: `items.completed_at` set when status becomes `done`.
- Archiving: `items.archived_at` (non-null means archived).
- Assignment: `item_assignees` (single assignee enforced in UI/ops).
- Subtasks: an item of type `task` whose parent is another task.

## Stored vs computed

Stored (examples):
- items: `id`, `type`, `title`, `parent_id`, `status`, `priority`, `due_at`, `estimate_mode`, `estimate_minutes`, `notes`, `health`, `health_mode`, `sort_order`, `completed_at`, `archived_at`
- scheduled_blocks: `block_id`, `item_id`, `start_at`, `duration_minutes`, `locked`, `source`
- dependencies: `item_id`, `depends_on_id`, `type`, `lag_minutes` (type/lag may default if missing in older data)
- blockers, time_entries, item_tags, item_assignees, settings, audit_log, running_timers

Computed (examples):
- `planned_start_at` / `planned_end_at` (from scheduled_blocks)
- `slack_minutes` (due_at - planned_end_at; null if no blocks or no due_at)
- `blocked_by` / `blocking` (from dependency edges + schedule timing)
- rollups for milestones/projects/tasks with children (estimates, actuals, scheduled minutes)

## Scheduling invariant

- The only scheduling primitive is `scheduled_blocks`.
- UI never edits an “end time” field; end is always `start_at + duration_minutes`.
- “Scheduled For” in UI is derived from earliest block start.

## Dependencies invariant

- Dependencies are stored as edges and are the only truth.
- `blocked_by` and `blocking` are computed projections for display.
- Dependency status (satisfied/violated/unknown) is computed from block timing.

## Completion + archiving

- When status transitions to `done`, `completed_at` is set.
- Archiving uses `archived_at` to hide items from active lists.
- Archived items remain in the DB with all related data intact.

## Assignments

- Single assignee per item (enforced by ops: replace existing assignee row).
- User scope views include only items assigned to that user (no parent inference).

## View responsibilities (UI)

- UI renders worker query results and formats values only.
- UI must not compute rollups, dependency projections, or schedule math.
- List/Calendar/Gantt/Kanban/Dashboard all share the worker’s canonical data.
- Command palette (CLI) and editor drawer also use the same mutate/query contracts.

## Operations (writes)

- All mutations occur via worker ops (mutate RPC).
- UI never constructs SQL or bypasses ops.

## Scope model

- Scope is either `project` or `user`.
- Project scope uses the project subtree.
- User scope includes only items directly assigned to that user.
