# MakeWhen - Server-Authoritative Personal PM

MakeWhen is a personal project management app with a **server-authoritative** data model.
The Postgres database is the source of truth, and all UI reads/writes go through
server APIs that return computed view models (no SQL in the client).

If you need architectural rules and invariants, start with `docs/SPEC.md`.

---

## Tech stack (current)

- Next.js App Router (React 18 + TypeScript)
- Postgres (Neon) via Kysely
- Auth.js (Google OAuth)
- SSE invalidation (`/api/sse`)
- Radix UI Themes + Radix Colors
- pnpm

---

## Quick start (server mode)

1) Install deps

```sh
pnpm install
```

2) Configure environment

- `DATABASE_URL` (Neon Postgres connection string)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `AUTH_SECRET`
- `NEXT_PUBLIC_DATA_SOURCE=server`

3) Run migrations

```sh
pnpm db:migrate
```

4) Start the Next.js dev server

```sh
pnpm dev:server
```

---

## How it works

- **Reads**: UI calls `POST /api/query` with a query name + args. The server returns
  a computed view model (list, calendar, gantt, kanban, dashboard).
- **Writes**: UI calls `POST /api/ops` with validated ops. Ops enforce permissions,
  invariants, and write an op log. No direct DB writes from UI.
- **Realtime**: `/api/sse` sends invalidation events; the client refetches view models.
- **Derived logic**: rollups, slack, dependency projections, schedule envelopes all
  live server-side (see `lib/domain/*` and `lib/views/*`).

---

## Core model (current behavior)

- **Items**: `project | milestone | task | subtask` (subtask is a task whose parent is a task)
- **Due date**: `items.due_at` is optional
- **Estimate**: `estimate_mode` + `estimate_minutes`
- **Scheduling**: `scheduled_blocks` with `{ start_at, duration_minutes }`
  - end time is always derived
- **Dependencies**: edges with `type` + `lag_minutes`
  - `blocked_by` / `blocking` are projections only (computed)
- **Blockers**: rows in `blockers` (active = `cleared_at IS NULL`)
- **Completion**: `completed_at` set when status becomes `done`
- **Archiving**: `archived_at` hides items from active views
- **Assignments**: single assignee per item

---

## Views / functionality

- **List**: spreadsheet-style table, milestones + ungrouped, inline edits, multi-select
- **Calendar**: week + month, drag to create blocks, move/resize blocks, due flags
- **Gantt**: bars from scheduled blocks + rollups + due markers
- **Kanban**: status columns (tasks/subtasks), swimlanes, drag to change status
- **Dashboard**: execution window, blocked view, due/overdue, contributions heatmap
- **Command palette**: Cmd/Ctrl+K for fast create/update
- **Editor drawer**: right-side item editor

---

## Docs (start here)

- `docs/SPEC.md` - invariants, stored vs computed, ops/query rules
- `docs/ARCH.md` - API inventory, tables, modules, data flow diagram
- `docs/CLI_LANGUAGE.md` - command palette language
- `docs/VIEW_MODELS.md` - view model contracts

---

## Legacy architecture (deprecated)

The old offline-first SQLite/Web Worker code still exists for reference, but it is
**not** the active system. See `legacy/db-worker/` and `legacy/vite/` for legacy
artifacts. Do not build new features on the legacy worker path.

---

## Dev commands

```sh
pnpm lint
pnpm typecheck
pnpm test:parity
pnpm test:server
```
