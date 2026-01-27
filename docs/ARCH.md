# Architecture Map (Quick Inventory)

This is a fast index of the **server-authoritative** architecture: APIs, tables,
modules, and how data flows. Legacy worker code is listed at the end.

## Tech stack

- Next.js App Router (React 18 + TypeScript)
- Postgres (Neon) via Kysely
- Auth.js (Google OAuth)
- SSE invalidation (`/api/sse`)
- Radix UI Themes + Radix Colors
- pnpm

## Data flow (text diagram)

```
UI (React)
  -> src/data/api.ts
     -> POST /api/query  -> lib/views/* -> Postgres (Kysely)
     -> POST /api/ops    -> lib/domain/ops.ts -> Postgres (Kysely)
     -> GET  /api/sse    -> lib/server/pubsub.ts -> invalidation events
```

## Server API endpoints

- `POST /api/query`
  - Dispatches named queries and returns computed view models.
  - Active names in `app/api/query/route.ts`:
    - `list_view`, `list_view_complete`, `listItems`
    - `calendar_view`, `calendar_range`, `calendar_range_user`
    - `users_list`

- `POST /api/ops`
  - Ops-only mutation surface (validated + transactional).
  - Implemented in `lib/domain/ops.ts`.
  - Categories:
    - project: create/update
    - item: create/update/set_status/archive/restore/delete
    - scheduled blocks: create/move/resize/delete
    - dependencies: add/update/remove (type + lag)
    - blockers: add/clear
    - time entries: start/stop

- `GET /api/sse`
  - SSE stream for invalidation events.
  - Publishes `project:<id>` and `user:<id>` topics.

## Core server modules

- `lib/db/kysely.ts` - database connection
- `lib/db/schema.ts` - Kysely types
- `lib/auth/auth.ts` - Auth.js session + user provisioning
- `lib/domain/ops.ts` - op handlers + invariants
- `lib/domain/rollup.ts` - rollup computations
- `lib/domain/scheduleMath.ts` - schedule envelopes + dependency status
- `lib/views/listView.ts` - list view model builder
- `lib/views/calendarView.ts` - calendar view model builder
- `lib/server/pubsub.ts` - in-memory pubsub for SSE

## Database tables (migrations)

From `migrations/0001_init.sql`:
- `users`
- `projects`
- `project_members`
- `items`
- `scheduled_blocks`
- `dependencies`
- `blockers`
- `time_entries`
- `op_log`

Indexes in `migrations/0002_indexes.sql`.

## UI entry points (current)

Views (in `src/ui`):
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

## Scripts/tests

- `scripts/dbMigrate.mjs`
- `scripts/dbReset.mjs`
- `scripts/fixtures.mjs`
- `scripts/parity.mjs` (worker vs server view parity)
- `scripts/server.test.mjs`

## Legacy architecture (deprecated)

The old offline-first worker system still exists for reference only:
- `legacy/db-worker/*`
- `legacy/vite/*`

Do not build new features on the legacy worker path.
