# Context (condensed)

## Non-negotiables
- Offline-first: SQLite-WASM in a Web Worker
- Storage: OPFS + opfs-sahpool VFS (default)
- Writes only via validated operations (no UI SQL)
- Creating any Item requires due_at + estimate
- Scheduling is via blocks (zero or many ScheduledBlocks)

## Operation list (v1 minimum)
- create_item
- update_item_fields
- set_status
- add_dependency / remove_dependency
- add_blocker / clear_blocker
- create_block / move_block / resize_block / delete_block
- add_time_entry
- set_health_mode / set_health
- archive_item

## Table list
- items
- item_assignees
- item_tags
- dependencies
- blockers
- scheduled_blocks
- time_entries
- audit_log
- settings

## Smoke test list
1) create project + task (due + estimate required)
2) create two scheduled blocks on different days
3) refresh page → data still present
4) add dependency + blocker → blocked state reflected
5) move/resize a block → persists after refresh
6) audit log shows operations

## Dev note: dependencies + projections
- Dependencies are edges in `dependencies` only. Do not add blocked_by/blocking fields to `items`.
- "Blocked By" and "Blocking" are projections computed in worker queries from edges.
- Autocomplete must reuse the worker query (searchItems) so UI never scans or infers data.
- This structure lets future AI scheduling read edges, compute projections, and write only ops.
