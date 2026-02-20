# MakeWhen — Offline-First Time-Blocked Personal PM

MakeWhen is a personal planning app built around one core idea:

**Plan your life by blocking real time on your calendar, not by just managing a list.**

This repository includes both product behavior and implementation details. If an agent loses context, this README is the source of truth for expected app logic and architecture constraints.

---

## Core design principle

Most task apps treat scheduling as a single date field. MakeWhen treats scheduling as explicit blocks of time.

- `due_at` is a deadline marker (optional), not your schedule.
- Work plans are made from one or more **Scheduled Blocks**.
- Items can be split across multiple days/weeks by adding multiple blocks.
- Projects/milestones roll up from child tasks and blocks.

If you only remember one thing: **the schedule is the blocks**.

---

## What the app is

Everything is an Item:

- `project`
- `milestone`
- `task`

Every item can have:

- an estimate (`estimate_minutes`; required on create)
- optional due date (`due_at`)
- status, priority, notes, tags, assignee
- dependencies and blockers
- scheduled blocks

---

## How to use the app (practical workflow)

### 1) Create your structure

1. Create a **project**.
2. Add **milestones** (optional but useful for grouping).
3. Add **tasks/subtasks** with estimates.

### 2) Put real time on your calendar

1. Open Calendar or use item edit actions.
2. Create one or more **scheduled blocks** for each task.
3. Drag/resize blocks to shape your week.

Use multiple smaller blocks when work is fragmented.

### 3) Add execution logic

- Add **dependencies** when order matters between items.
- Add **blockers** when a task is blocked by a qualitative/external issue.

### 4) Execute and adapt

- Use Dashboard/List to see:
  - actionable now
  - blocked items
  - due/overdue
  - scheduled but blocked
- Mark status as you move (`ready`, `in_progress`, `review`, `done`, etc.).
- Replan by moving blocks, not just rewriting due dates.

---

## App logic (conceptual model)

### Deadlines vs schedule

- `due_at` answers: “When should this be done?”
- Scheduled blocks answer: “When will I actually work on it?”

These are intentionally separate.

### Dependencies vs blockers

Dependencies:

- link one item to another item in your system
- represent ordering/precedence constraints
- support edge type + lag:
  - `FS`, `SS`, `FF`, `SF` + `lag_minutes`

Blockers:

- freeform constraints attached to an item
- represent qualitative/external impediments (e.g. “waiting for package”, “legal approval”)
- not links to other items
- active until cleared

### What “blocked” means

An item is blocked if **any** of these are true:

- status is `blocked`
- it has at least one active blocker (`cleared_at IS NULL`)
- it has at least one unmet dependency (predecessor missing or not `done`)

Note: dependency `type/lag` drives planning/projections (especially timeline views), while blocked/unblocked readiness is based on unmet predecessor completion.

---

## View guide

- **List**: fast editing, dependency management, bulk sorting/grouping.
- **Calendar**: schedule editing with draggable/resizable blocks.
- **Gantt**: timeline context and dependency relationships.
- **Kanban**: status-oriented workflow.
- **Dashboard**: “now/next”, blocked, and due/overdue focus.

---

## Getting started (setup + dev)

### Prerequisites

- Node.js (LTS recommended)
- `pnpm@9` (per `package.json` `packageManager`)

### Install dependencies

```sh
pnpm install
```

### Run dev server

```sh
pnpm dev
```

You can also run:

```sh
npm run dev
```

Open the URL printed by Vite.

### Build + preview

```sh
pnpm build
pnpm preview
```

### Lint + typecheck

```sh
pnpm lint
pnpm typecheck
```

---

## Non-negotiable implementation requirements

### 1) Offline-first + speed

- Local persistence is SQLite-WASM in a Web Worker.
- Storage uses OPFS + `opfs-sahpool` VFS.
- UI must not block on DB work.

### 2) AI-safe writes

- No direct SQL from UI.
- All writes go through validated operations.
- Ops validate input, enforce invariants, run in transaction, and append audit log entries.

### 3) Estimates required, due dates optional

- Creating any item requires an estimate.
- `due_at` is optional for all item types.

### 4) Scheduling is blocks

- Items can have zero or many scheduled blocks.
- Multi-day work must be represented as multiple blocks.

---

## Architecture

### UI (main thread)

- React SPA
- Uses RPC to query/mutate worker
- Owns presentation state, not domain truth

### DB worker (domain/data gateway)

- Owns SQLite, migrations, queries, operations, and audit log
- Exposes `query(name, args)` and `mutate(operationEnvelope)`

---

## Data model (canonical objects)

### Item

Stored fields:

- `id`, `type`, `title`, `parent_id`
- `status`: `backlog | ready | in_progress | blocked | review | done | canceled`
- `priority` (0–5)
- `due_at` (optional)
- `estimate_mode`: `manual | rollup`
- `estimate_minutes`
- `health`, `health_mode`
- `notes`, tags, assignee, `sort_order`

Computed fields:

- `is_blocked`
- due metrics (`days_until_due`, `days_overdue`, `is_overdue`)
- rollups (estimate/actual/remaining/start/end/blocked/overdue)
- dependency projections (`blocked_by`, `blocking`)
- sequence rank and hierarchy projections (`project_id`, `depth`)

### ScheduledBlock

- `block_id`, `item_id`, `start_at`, `duration_minutes`, `locked`, `source`

### TimeEntry

- `entry_id`, `item_id`, `start_at`, `end_at`, `duration_minutes`, `note`, `source`

---

## DB schema (SQLite)

Tables:

- `items`
- `item_assignees`
- `item_tags`
- `dependencies`
- `blockers`
- `scheduled_blocks`
- `time_entries`
- `running_timers`
- `audit_log`
- `settings`

Key indexes:

- `items(parent_id)`, `items(status)`, `items(due_at)`
- `items(title COLLATE NOCASE)` (search/autocomplete)
- `scheduled_blocks(start_at)`, `scheduled_blocks(item_id)`
- `dependencies(item_id)`, `dependencies(depends_on_id)`
- `blockers(item_id, cleared_at)`
- `time_entries(item_id)`

---

## Operation contract (writes)

All writes happen via operations. Current core set includes:

- `create_item`
- `update_item_fields`
- `set_status`
- `dependency.create` / `dependency.update` / `dependency.delete`
- `add_dependency` / `remove_dependency` (legacy/simple edge ops)
- `add_blocker` / `clear_blocker`
- `scheduled_block.create` / `scheduled_block.update` / `scheduled_block.delete`
- `create_block` / `move_block` / `resize_block` / `delete_block` (legacy aliases)
- `add_time_entry`
- `start_timer` / `stop_timer`
- `delete_item`
- `reorder_item` / `move_item`
- `set_item_tags` / `item.set_assignee`
- `set_setting`
- `item.archive` / `items.archive_many` / `item.restore` / `items.restore_many`
- `export_data` / `import_data`

Operation envelope:

- `op_id`, `op_name`, `actor_type`, `actor_id?`, `ts`, `args`

Operation result shape:

- `ok`, `result`, `error`, `warnings`, `invalidate`

Audit log:

- append-only record of each mutation payload + result

---

## Named queries (reads)

Important queries:

- `listItems(...)` (primary list)
- `getItemDetails({ itemId })`
- `list_view_complete(...)`
- `listCalendarBlocks(...)`
- `listGantt(...)`
- `execution_window(...)`
- `blocked_view(...)`
- `due_overdue(...)`
- `listBlocked(...)`
- `listByUser(...)`
- `searchItems(...)`
- `get_running_timer()`

UI must not contain raw SQL.

---

## Multi-tab policy (v1)

Planned, not implemented yet:

- single-active-tab policy via BroadcastChannel

---

## Theming

- Theme API via CSS variables on `.app-root`
- Radix Themes base + semantic tokens
- Theme picker persisted in local storage

---

## Dev checks (manual smoke)

1. Create a project and task (estimate required, due optional).
2. Create two scheduled blocks across different days.
3. Refresh page and verify persistence.
4. Add dependency + blocker and verify blocked state reflects.
5. Move/resize a block and verify persistence.
6. Verify audit log entries are written for mutations.

---

## Current implementation status

Implemented:

- Vite + React + TypeScript SPA with dedicated DB worker
- typed RPC (`mutate`, `query`, diagnostics)
- SQLite-WASM + OPFS SAH pool + migrations
- core item/dependency/blocker/scheduled-block/time-entry flows
- audit log for all mutations
- list/calendar/gantt/kanban/dashboard views
- command palette + worker-backed search autocomplete
- Radix-based theming and persisted theme selection

Not implemented yet:

- multi-tab leader election/read-only policy
- some deeper health mode workflows and additional polish

---

## Repo layout

- `src/ui/*` — React views/components
- `src/domain/*` — types + pure helpers (no IO)
- `src/db-worker/*` — worker entry, SQLite init, migrations, queries/ops
- `src/rpc/*` — shared message types + RPC client wrapper
- `src/pwa/*` — service worker/caching (future)
