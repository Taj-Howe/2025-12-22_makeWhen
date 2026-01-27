# View Model Contracts

These are the worker query contracts used by the UI. The client should treat
these as read-only, already-sorted view models and avoid recomputing domain
logic.

## list_view_complete

Purpose: canonical list view payload (project tree + rollups + scheduling +
dependency projections).

Input (args):
- `scopeProjectId?: string` — project root to scope the tree.
- `scopeUserId?: string` — assignee filter (no parent inference).
- `scopeParentId?: string` — subtree root.
- `includeUngrouped?: boolean` — include ungrouped tasks.
- `includeCompleted?: boolean` — include done/canceled items (default true).
- `archiveFilter?: "active" | "archived" | "all"` — archived inclusion.

Output: `ItemRow[]`

Each item includes (subset):
- `id`, `title`, `item_type`, `parent_id`, `status`, `completed_on`, `due_at`
- `estimate_mode`, `estimate_minutes`, `actual_minutes`
- `scheduled_blocks[]` with `{ block_id, item_id, start_at, duration_minutes, end_at_derived }`
- `slack_minutes` (null if no due_at or no scheduled blocks)
- `dependencies_in[]`, `dependencies_out[]` (edges with type+lag)
- `blocked_by[]`, `blocking[]` projections with dependency status
- rollups: `rollup_estimate_minutes`, `rollup_actual_minutes`, `rollup_remaining_minutes`,
  `rollup_start_at`, `rollup_end_at`, `rollup_blocked_count`, `rollup_overdue_count`
- `assignee_id`, `assignee_name`

Sorting:
- Project scope: `sort_order ASC`, then `due_at NULLS LAST`, then `due_at ASC`, `title ASC`
- User scope (list_view_scope): `planned_start_at NULLS LAST`, then `due_at`, then `title`

## calendar_range

Purpose: calendar view payload for scheduled blocks + due markers.

Input (args):
- `time_min: number` (epoch ms)
- `time_max: number` (epoch ms)
- `scopeProjectId?: string` — optional project subtree filter

Output:
```
{
  blocks: [
    { block_id, item_id, start_at, duration_minutes }
  ],
  items: [
    { id, title, status, due_at, parent_id, item_type, priority, assignee_id, assignee_name }
  ]
}
```

Rules:
- Blocks intersect `[time_min, time_max)`.
- Items include due markers within `[time_min, time_max)`.
- Archived items are excluded.

Sorting:
- Blocks ordered by `start_at ASC`.
- Items ordered by `due_at ASC`.
