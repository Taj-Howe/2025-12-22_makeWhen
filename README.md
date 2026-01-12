# MakeWhen — Offline-First Personal PM (SQLite-WASM + OPFS)

MakeWhen is an **offline-first** personal project management app built as a fast
React SPA with a local SQLite database running in a Web Worker. All reads/writes
go through a typed RPC layer so the UI never touches SQL.

If you need the architectural rules or invariants, start with `docs/SPEC.md`.

---

## Tech stack (current)

- Vite + React 18 + TypeScript
- SQLite-WASM in a Web Worker (OPFS + opfs-sahpool VFS)
- Radix UI Themes + Radix primitives + Radix Colors
- pnpm

---

## Quick start

```sh
pnpm install
pnpm dev
```

Open the dev server URL printed by Vite (usually `http://localhost:5173`).

---

## How it works

- **UI → Worker RPC**: UI calls `query(name,args)` for reads and `mutate(op,args)`
  for writes. No SQL runs in the UI.
- **Worker owns truth**: SQLite-WASM runs in `src/db-worker/worker.ts`. Migrations
  live in `src/db-worker/migrations`.
- **Derived logic is server-like**: rollups, scheduling envelopes, dependency
  projections, and slack are computed in the worker (`src/db-worker/rollup.ts`,
  `src/db-worker/scheduleMath.js`).

---

## Core model (current behavior)

- **Items**: `project | milestone | task` (a subtask is a task whose parent is a task)
- **Due date**: `due_at` is optional for all items
- **Estimate**: required at creation (`estimate_mode` + `estimate_minutes`)
- **Scheduling**: `scheduled_blocks` with `{ start_at, duration_minutes }`
  - end time is always derived
  - items can have zero or many blocks
- **Dependencies**: edges with `type` + `lag_minutes`
  - `blocked_by` / `blocking` are projections only (computed)
- **Blockers**: rows in `blockers` (active = `cleared_at IS NULL`)
- **Completion**: `completed_at` set when status becomes `done`
- **Archiving**: `archived_at` hides items from active views
- **Assignments**: single assignee per item (stored in `item_assignees`)

---

## Views / functionality

- **List view**: spreadsheet-style table, grouping by milestones and ungrouped
  tasks, inline editing, multi-select, archive section, drag/drop reordering
- **Calendar view**: week + month views, drag to create blocks, move/resize blocks,
  due flags
- **Gantt view**: bars from scheduled blocks + rollups + due markers
- **Kanban view**: status columns (tasks/subtasks only), swimlanes, drag to change status
- **Dashboard**: execution window, blocked view, due/overdue, contributions heatmap
- **Command palette (CLI)**: Cmd/Ctrl+K for fast create/update (see docs)
- **Right-side editor**: drawer for item edit/create

---

## Docs (start here)

- `docs/SPEC.md` — invariants, stored vs computed, worker rules
- `docs/ARCH.md` — queries, ops, tables, UI entry points
- `docs/CLI_LANGUAGE.md` — command palette language
- `docs/CONTEXT.md` — condensed rules/checklists

---

## Dev commands

```sh
pnpm lint
pnpm typecheck
```
