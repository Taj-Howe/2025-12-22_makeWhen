# Team + Sync Worklog

## Branch
- `codex/auth-team-foundation`

## Purpose
Single source of truth for:
- what team/auth/sync safety work has landed
- which invariants are being protected
- how to run deterministic verification
- what has already been audited (to avoid repeat audits)

## Migrations In Repo
- `0001_init.sql`
- `0002_blockers_kind_text.sql`
- `0003_running_timers.sql`
- `0004_sort_order.sql`
- `0005_due_at_nullable.sql`
- `0006_title_search.sql`
- `0007_dependencies_type_lag.sql`
- `0008_completed_at.sql`
- `0009_ui_snippets.sql`
- `0010_archived_at.sql`
- `0011_team_permissions_foundation.sql`

## Migrations Wired In Worker Init
- `0001_init.sql`
- `0002_blockers_kind_text.sql`
- `0003_running_timers.sql`
- `0004_sort_order.sql`
- `0005_due_at_nullable.sql`
- `0006_title_search.sql`
- `0007_dependencies_type_lag.sql`
- `0008_completed_at.sql`
- `0010_archived_at.sql`
- `0011_team_permissions_foundation.sql`

## Invariants Checklist
- [ ] Team boundary is enforced: items cannot be mutated/read across team scope.
- [ ] Parent/child links remain in-team (no cross-team parent references).
- [ ] One scheduled block per item is preserved by mutation flow (`enforceSingleScheduledBlock`).
- [ ] Dependencies are directed edges (`successor -> predecessor`) with edge id format `successor->predecessor`.
- [ ] Dependency cycle prevention remains active.
- [ ] Blockers are qualitative text entries tied to a specific item.
- [ ] Archived filtering behavior remains consistent with existing UI expectations.
- [ ] Existing local users bootstrap into default team membership without data loss.
- [ ] `users_list` and `team.current` align with current team context.

## Verification Command
```bash
pnpm -s typecheck && pnpm -s build
```

## Smoke Command
```bash
pnpm -s smoke
```

## Smoke Scope
- Applies all SQL migrations sequentially to a temporary sqlite database.
- Validates key schema expectations (`items.team_id`, team/user/member tables).
- Runs a minimal SQL round-trip insert/query path for core entities.
- Verifies core RPC seams exist in `src/db-worker/worker.ts`.

## Audit Ledger
| Date (UTC) | Prompt/Pass | Result | Notes |
|---|---|---|---|
| 2026-02-22 | Prompt 0 baseline safety rails | Complete | Added verify/smoke workflow, smoke harness, and deterministic worklog. |
