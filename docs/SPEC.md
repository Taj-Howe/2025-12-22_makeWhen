# MakeWhen Spec (Source of Truth)

This doc defines the non-negotiable domain truths, what is stored vs computed,
and what each UI view is allowed to do.

## Architecture rules (current)

- UI is a Next.js App Router client (React + TypeScript).
- Postgres is the source of truth (Neon), accessed via Kysely.
- UI never runs SQL.
- All writes go through `POST /api/ops` (ops-only).
- All reads go through `POST /api/query` (named queries returning view models).
- Derived logic lives server-side in `lib/domain/*` and `lib/views/*`.

## Source of truth (canonical)

- Scheduling: `scheduled_blocks` with `{ start_at, duration_minutes }`. End time is derived.
- Deadlines: `items.due_at` (optional).
- Dependencies: `dependencies` edges. `blocked_by` / `blocking` are projections only.
- Blockers: `blockers` table (active = `cleared_at IS NULL`).
- Completion: `items.completed_at` set when status becomes `done`.
- Archiving: `items.archived_at` (non-null means archived).
- Assignment: single assignee per item (`items.assignee_user_id`).
- Subtasks: an item of type `task` whose parent is another task.

## Stored vs computed

Stored (examples):
- items: `id`, `project_id`, `parent_id`, `type`, `title`, `status`, `priority`,
  `due_at`, `estimate_mode`, `estimate_minutes`, `notes`, `health`,
  `completed_at`, `archived_at`, `assignee_user_id`
- scheduled_blocks: `id`, `item_id`, `start_at`, `duration_minutes`
- dependencies: `item_id`, `depends_on_id`, `type`, `lag_minutes`
- blockers, time_entries, project_members, op_log

Computed (examples):
- `planned_start_at` / `planned_end_at` (from scheduled_blocks)
- `slack_minutes` (due_at - planned_end_at; null if no blocks or no due_at)
- `blocked_by` / `blocking` (from dependency edges + schedule timing)
- rollups for milestones/projects/tasks with children (estimate/actual/schedule)

## Scheduling invariant

- The only scheduling primitive is `scheduled_blocks`.
- End time is always `start_at + duration_minutes`.
- UI must never store a separate scheduled_for field on items.

## Dependencies invariant

- Dependencies are stored as edges and are the only truth.
- `blocked_by` and `blocking` are computed projections for display.
- Dependency satisfaction is computed from block timing (FS/SS/FF/SF + lag).

## Completion + archiving

- When status transitions to `done`, `completed_at` is set.
- Archiving uses `archived_at` to hide items from active lists.
- Archived items remain in the DB with all related data intact.

## Assignments

- Single assignee per item.
- User scope views include only items directly assigned to that user (no parent inference).

## View responsibilities (UI)

- UI renders server view models and formats values only.
- UI must not compute rollups, dependency projections, or schedule math.
- List/Calendar/Gantt/Kanban/Dashboard all share the server's canonical data.
- Command palette (CLI) and editor drawer use the same ops/query contracts.

## Operations (writes)

- All mutations occur via `POST /api/ops` (ops-only RPC).
- UI never constructs SQL or bypasses ops.
- Every op is validated for permissions and invariants, then logged.

## Scope model

- Scope is either `project` or `user`.
- Project scope uses the project subtree.
- User scope includes only items assigned to that user (no parent inference).

## Legacy architecture (deprecated)

The old SQLite/Web Worker system is deprecated. Legacy files live under
`legacy/db-worker/` and the Vite-based entrypoints in `legacy/vite/`. Do not build new features
against the legacy worker path.
