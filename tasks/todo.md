# Gantt Dependency + Direct Schedule Manipulation Slice

## Plan
- [x] Confirm current Gantt data flow and interaction constraints in `src/ui/GanttView.tsx`, `src/domain/ganttTypes.ts`, and `src/db-worker/worker.ts`.
- [x] Add backend mutation to shift descendant schedules when moving milestone/project rollups.
- [x] Implement drag-connect dependency creation with `Alt/Option`-only handles and default `FS` + `0` lag edge creation.
- [x] Implement inline edge popover editing (type, lag, delete) for existing and newly created edges.
- [x] Implement bar drag for all bars with snap-by-view granularity (`week` = 1h, `month` = 1d, `quarter` = 1w).
- [x] Implement resize handles for task bars only; exclude parent milestone/project rollups from resize.
- [x] Ensure rollup bar move shifts descendant scheduled blocks.
- [x] Validate acceptance checks through typecheck/build and direct behavior reasoning.

## Review
- [x] Can create/edit/delete dependencies directly in Gantt with minimal clicks.
- [x] Can drag task bars and resize task bars with correct snapping.
- [x] Can drag milestone/project rollups to shift descendants.
- [x] Parent rollups do not expose resize handles.
- [x] `pnpm -s typecheck` passes.
- [x] `pnpm -s build` passes.

### Verification Notes
- Behavior checks are implementation-verified in code paths (`GanttView` drag/connect handlers + `gantt.shift_subtree` mutation).
- Command-verified checks: `pnpm -s typecheck` and `pnpm -s build` both completed successfully.

# Branch Safety + Non-Master Brief

## Plan
- [x] Inspect current local/remote branch state and divergence from `master`.
- [x] Produce a concise brief of changes that exist outside `master`.
- [x] Add a safer, repeatable branch workflow with guardrails for future work.
- [x] Verify branch-audit command output and document results.

## Review
- [x] Brief created and checked against `git log`/`rev-list` output.
- [x] Safer flow documented with concrete commands/scripts.
- [x] Verification commands run and outcomes recorded.

### Verification Notes
- `bash scripts/git/branch-safety.sh preflight` runs and reports branch cleanliness + divergence.
- `bash scripts/git/branch-safety.sh status` lists local branch divergence vs `master`.
- `bash scripts/git/branch-safety.sh brief-non-master` prints all refs carrying commits outside `master`.

# Integrate Gantt Thread To Master

## Plan
- [x] Audit current working tree and old stash for integration candidates.
- [x] Verify current branch changes pass project checks.
- [x] Integrate safe changes (prefer current stable working tree; avoid stale stash conflicts).
- [ ] Commit integrated work and merge into `master`.
- [ ] Create a fresh generic branch from updated `master`.

## Review
- [ ] `master` contains integrated, verified changes.
- [ ] New generic branch created for continued work.
