# Gantt Notes (Invariant Contract)

This app models scheduling via **ScheduledBlocks** only. Do not invent new fields.

## Invariants
- Scheduling is represented as `scheduled_blocks` rows with `{ start_at, duration_minutes }`.
- `end_at` is **always derived** as `start_at + duration_minutes`.
- Gantt bars are computed from blocks:
  - task bar: min(block.start_at) to max(block.end_at_derived)
  - milestone/project bar: rollups over descendant task bars
- Dependency arrows are computed from dependency edges:
  - `dependencies` holds `{ item_id (successor), depends_on_id (predecessor), type, lag_minutes }`
  - edge type ∈ `FS | SS | FF | SF`
- Slack is computed from `due_at` vs `planned_end` (latest derived block end):
  - `slack_minutes = due_at - planned_end`
  - if no blocks or no due_at, slack is null
- "Blocked By" / "Blocking" are computed projections from dependency edges.
  - They are **not stored** on items.

## Quick rules for contributors
- Do not add "scheduled_for" or "end_at" columns to items.
- Never persist derived fields (blocked_by/blocking, slack).
- Keep UI reads via named queries; UI never runs SQL.
