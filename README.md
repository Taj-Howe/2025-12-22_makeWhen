# README — Offline-First Personal PM (SQLite-WASM + OPFS) — MVP v1

This repo builds a **fast, offline-first** personal project management app with an **AI-safe** write surface.

If Codex (or any agent) loses context, **this README is the source of truth** for architecture, invariants, and implementation rules.

---

## Product summary (what this app is)

- Everything is an **Item**: `project | milestone | task`
- Every Item has:
  - `due_at` (a **marker**, no duration)
  - `estimate` (effort; required at creation)
- Actual “work scheduling” happens via **ScheduledBlocks**:
  - time spans that are draggable/resizable on a calendar
- Projects/milestones “span multiple days” via **rollups** over their descendant blocks and tasks

---

## Non-negotiable requirements (must not drift)

### 1) Offline-first + speed
- Local persistence is **SQLite-WASM in a Web Worker**
- Storage uses **OPFS + opfs-sahpool VFS** (default)
- UI never blocks on DB work; the DB lives in the worker; UI talks via RPC

### 2) AI-safe writes
- **No direct SQL from UI**
- All writes go through a small set of **validated operations**
- Each operation:
  - validates inputs
  - checks invariants (like no dependency cycles)
  - runs in a transaction
  - writes to an append-only **audit log**

### 3) Due date + estimate linked at creation
- Creating any Item requires both `due_at` and `estimate`:
  - tasks default to manual estimate
  - projects/milestones default to rollup estimate mode

### 4) Scheduling is blocks, not a single “scheduled_for” field
- Items can have zero or many ScheduledBlocks
- Multi-day work = multiple blocks

---

## Architecture (layers)

### Main thread (UI)
- React SPA
- Sends RPC messages to the DB worker:
  - operations (writes)
  - named queries (reads)
- Maintains view state, not business truth

### DB worker (data + domain gateway)
- Owns:
  - SQLite instance
  - migrations
  - query registry
  - operation executor + validation
  - audit log
- Exposes:
  - `query(name, args)` and `mutate(operationEnvelope)`

---

## Data model (canonical objects)

### Item
Writable fields (stored):
- `id`, `type`, `title`, `parent_id`
- `status`: `backlog | ready | in_progress | blocked | review | done | canceled`
- `priority` (0–5)
- `due_at` (required)
- `estimate_mode`: `manual | rollup` (required)
- `estimate_minutes` (required; may be 0)
- `health`: `on_track | at_risk | behind | ahead | unknown`
- `health_mode`: `auto | manual`
- `notes` (text for v1)
- tags + assignees (tables)

Computed (derived on read or via rollup table later):
- `is_blocked` (deps unmet OR active blockers)
- `days_until_due`, `days_overdue`, `is_overdue`
- rollups (for parents): estimate/actual/remaining, rollup start/end, overdue count, blocked count
- `sequence_rank` (deterministic ordering)

### ScheduledBlock
- `block_id`, `item_id`
- `start_at`, `duration_minutes`, `locked`, `source`
- optional external calendar mapping fields (v1 can omit integration)

### TimeEntry
- `entry_id`, `item_id`
- `start_at`, `end_at`, `duration_minutes`, `note`, `source`

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
- `audit_log`
- `settings` (e.g., `capacity_minutes_per_day`, theme tokens, user css)

Indexes:
- `items(parent_id)`, `items(status)`, `items(due_at)`
- `scheduled_blocks(start_at)`, `scheduled_blocks(item_id)`
- `dependencies(item_id)`, `dependencies(depends_on_id)`
- `blockers(item_id, cleared_at)`
- `time_entries(item_id)`

---

## Operation contract (writes)

All writes happen via these operations (v1 minimum):
- `create_item`
- `update_item_fields`
- `set_status`
- `add_dependency` / `remove_dependency` (must prevent cycles)
- `add_blocker` / `clear_blocker`
- `create_block` / `move_block` / `resize_block` / `delete_block`
- `add_time_entry`
- `set_health_mode` / `set_health` (manual override)
- `archive_item` (preferred over delete)

Additional operations implemented (current):
- `set_setting` (writes to `settings`)
- `export_data` / `import_data` (JSON backup/restore, audited)

Operation envelope (RPC):
- `op_id`, `op_name`, `actor` (`user|ai|system`), `ts`, `args`

Operation results:
- `ok`, `data`, `warnings`, `invalidate` (list of query keys to refetch)

Audit log:
- append-only row per operation with payload + result

---

## Named queries (reads)

v1 minimum:
- `getItemDetails({itemId})`
- `getProjectTree({projectId})`
- `listKanban({projectId?, assigneeId?, tag?, status?, health?})`
- `listCalendarBlocks({startAt, endAt, assigneeId?})`
- `listOverdue()`
- `listDueSoon({days})`
- `searchItems({text})`

UI must not contain raw SQL.

Additional queries implemented (current):
- `getSettings()`

---

## Multi-tab policy (v1)
Because OPFS + SQLite has concurrency realities:
- **Single active tab policy for v1**
- Elect leader via BroadcastChannel
- Non-leader tabs show read-only banner and “Take over” control

---

## Theming / user CSS (v1)
- Theme API = CSS variables applied on `.app-root`
- Safe mode: tokens only
- Advanced: user CSS scoped under `.app-root` with a reset button
- Theme config stored in `settings`

---

## Dev checks (every chunk must pass)
- App loads
- Worker initializes
- DB persists after refresh
- Smoke test (manual):
  1) create project + task (due + estimate required)
  2) create two scheduled blocks on different days
  3) refresh page → data still present
  4) add dependency + blocker → blocked state reflected
  5) move/resize a block → persists after refresh
  6) audit log shows operations

---

## Current implementation status (Prompt 11)

Implemented:
- Vite + React + TypeScript SPA with a dedicated DB worker
- Typed RPC with `ping`, `dbInfo`, `listTables`, `listAudit`, `mutate`, `query`
- SQLite-WASM initialized in worker with OPFS SAH pool, migration runner, and schema versioning
- Core tables and indexes from schema
- Operations: item create/update/status, blockers, dependencies with cycle detection, scheduled block CRUD, time entries, settings
- Audit log for every mutation
- Queries: kanban list, calendar blocks, item details, project tree rollups, due/overdue lists, settings
- UI: kanban board, weekly calendar grid with drag/resize blocks, due pins, item details panel, project dashboard rollups, settings panel
- Theming: CSS variables on `.app-root`, scoped user CSS injection with reset
- Backup: export/import full JSON dataset (wipe-and-restore, transactional)

Partially implemented (missing filters/features):
- `listKanban` currently supports `projectId` only (no assignee/tag/status/health filters yet)
- `listCalendarBlocks` currently supports date range only (no assignee filter yet)

Not implemented yet:
- `set_health_mode` / `set_health`
- `archive_item`
- `searchItems`
- Multi-tab leader election/read-only policy

---

## Repo layout (suggested)
- `src/ui/*`         React views/components
- `src/domain/*`     types + pure logic helpers (no IO)
- `src/db-worker/*`  worker entry, sqlite init, migrations, query+op handlers
- `src/rpc/*`        shared message types + rpc client wrapper
- `src/pwa/*`        service worker / caching config (later)

---
