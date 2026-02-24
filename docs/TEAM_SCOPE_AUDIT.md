# TEAM_SCOPE_AUDIT

Branch: `codex/auth-team-foundation`  
File audited: `src/db-worker/worker.ts` (`handleMutate`, `handleRequest`)

Status legend:
- `PASS`: already enforced with team scoping.
- `FIXED`: missing/weak team scoping was patched in this branch.
- `TODO`: currently global/control-plane behavior; not team-scoped yet.

## Mutations (`handleMutate`)

| RPC name | kind | primary tables touched | required team scoping method | status |
|---|---|---|---|---|
| `create_item` | mutate | `items` | direct `team_id` on insert + parent team validation | PASS |
| `update_item_fields` | mutate | `items` | `ensureItemInTeam` + parent team check + `WHERE team_id = ?` | PASS |
| `set_status` | mutate | `items`, `blockers`, `dependencies` | `ensureItemInTeam` + team-scoped dependency join | FIXED |
| `scheduled_block.create` | mutate | `scheduled_blocks`, `items` | `ensureItemInTeam` before insert | PASS |
| `scheduled_block.update` | mutate | `scheduled_blocks`, `items` | resolve `item_id` then `ensureItemInTeam` | PASS |
| `scheduled_block.delete` | mutate | `scheduled_blocks`, `items` | resolve `item_id` then `ensureItemInTeam` | PASS |
| `create_block` | mutate | `scheduled_blocks`, `items` | `ensureItemInTeam` before insert | PASS |
| `move_block` | mutate | `scheduled_blocks`, `items` | resolve `item_id` then `ensureItemInTeam` | PASS |
| `resize_block` | mutate | `scheduled_blocks`, `items` | resolve `item_id` then `ensureItemInTeam` | PASS |
| `delete_block` | mutate | `scheduled_blocks`, `items` | resolve `item_id` then `ensureItemInTeam` | PASS |
| `item.archive` | mutate | `items` | subtree lookup via `getSubtreeIds` (current team) | PASS |
| `items.archive_many` | mutate | `items` | subtree lookup via `getSubtreeIds` (current team) | PASS |
| `item.restore` | mutate | `items` | subtree lookup via `getSubtreeIds` (current team) | PASS |
| `items.restore_many` | mutate | `items` | subtree lookup via `getSubtreeIds` (current team) | PASS |
| `delete_item` | mutate | `items`, `dependencies`, `blockers`, `scheduled_blocks`, `time_entries`, `running_timers`, `item_tags`, `item_assignees` | subtree lookup with explicit team + deletes scoped to subtree ids | PASS |
| `items.delete_many` | mutate | `items`, `dependencies`, `blockers`, `scheduled_blocks`, `time_entries`, `running_timers`, `item_tags`, `item_assignees` | subtree lookup with explicit team + deletes scoped to subtree ids | PASS |
| `reorder_item` | mutate | `items` | `ensureItemInTeam` + sibling queries filtered by `team_id` | PASS |
| `move_item` | mutate | `items` | `ensureItemInTeam` + parent/sibling checks in current team | PASS |
| `add_time_entry` | mutate | `time_entries`, `items` | `ensureItemInTeam` | PASS |
| `start_timer` | mutate | `running_timers`, `items` | `ensureItemInTeam` + running-timer count joined through `items.team_id` | FIXED |
| `stop_timer` | mutate | `running_timers`, `time_entries`, `items` | `ensureItemInTeam` | PASS |
| `set_setting` | mutate | `settings` | direct team filter would be required, but table is global | TODO |
| `export_data` | mutate | `items` graph + related tables | export queries joined/filtered by `items.team_id` | FIXED |
| `import_data` | mutate | `items` graph + related tables + `settings` | team-scoped delete/insert for item graph + inserted `items.team_id` set to current team | FIXED |
| `dependency.create` | mutate | `dependencies`, `items` | `ensureItemInTeam` for both ends (same team boundary) | PASS |
| `dependency.update` | mutate | `dependencies`, `items` | `ensureItemInTeam` for both ends | PASS |
| `dependency.delete` | mutate | `dependencies`, `items` | `ensureItemInTeam` for both ends | PASS |
| `add_dependency` | mutate | `dependencies`, `items` | `ensureItemInTeam` for both ends | PASS |
| `remove_dependency` | mutate | `dependencies`, `items` | `ensureItemInTeam` for both ends | PASS |
| `add_blocker` | mutate | `blockers`, `items` | `ensureItemInTeam` | PASS |
| `clear_blocker` | mutate | `blockers`, `items` | blocker -> `item_id` -> `ensureItemInTeam` | PASS |
| `set_item_tags` | mutate | `item_tags`, `items` | `ensureItemInTeam` | PASS |
| `user.create` | mutate | `users`, `team_members`, `settings` | direct team filter would be required, but operation is global user provisioning | TODO |
| `user.update` | mutate | `users`, `settings` | direct team filter would be required, but operation updates global user record | TODO |
| `auth.session.set` | mutate | `sessions`, `users`, `teams`, `team_members`, `settings` | activate exactly one session and derive team scope from active session | FIXED |
| `auth.logout` | mutate | `sessions` | deactivate active session by `session_id` | FIXED |
| `team.member.set_role` | mutate | `team_members` | direct `team_id = currentTeamId` writes | PASS |
| `team.member.add` | mutate | `team_members` | direct `team_id = currentTeamId` writes | PASS |
| `item.set_assignee` | mutate | `item_assignees`, `items` | `ensureItemInTeam` | PASS |
| `set_item_assignees` | mutate | `item_assignees`, `items` | `ensureItemInTeam` | PASS |

## Queries (`handleRequest`)

| RPC name | kind | primary tables touched | required team scoping method | status |
|---|---|---|---|---|
| `getItemDetails` | query | `items`, `dependencies`, `blockers`, `time_entries`, `scheduled_blocks`, `running_timers`, `item_assignees` | direct item `team_id` filter + team-scoped dependency/tree joins | FIXED |
| `get_running_timer` | query | `running_timers`, `items` | join through `items.team_id` | PASS |
| `getProjectTree` | query | `items`, `time_entries`, `scheduled_blocks` | recursive tree filtered by `team_id` | PASS |
| `listKanban` | query | `items`, `blockers`, `dependencies`, `scheduled_blocks` | base `items.team_id` filter + dependency join constrained to same team | FIXED |
| `listItems` | query | `items` + related maps (`scheduled_blocks`, `dependencies`, `blockers`, `time_entries`, `item_tags`, `item_assignees`) | direct/recursive `team_id` filters | PASS |
| `list_view_complete` | query | `items` + related maps | direct/recursive `team_id` filters | PASS |
| `list_view_scope` | query | `items` + related maps | direct/recursive `team_id` filters | PASS |
| `execution_window` | query | `items`, `scheduled_blocks`, `dependencies`, `blockers`, `item_assignees` | scope ids from `getScopeItemIds` (team-filtered) | PASS |
| `blocked_view` | query | `items`, `dependencies`, `blockers`, `scheduled_blocks`, `item_assignees` | scope ids from `getScopeItemIds` (team-filtered) | PASS |
| `due_overdue` | query | `items`, `scheduled_blocks`, `item_assignees` | scope ids from `getScopeItemIds` (team-filtered) | PASS |
| `contributions_range` | query | `items` | scope ids from `getScopeItemIds` (team-filtered) | PASS |
| `kanban_view` | query | `items`, `item_assignees`, `scheduled_blocks` | direct/recursive `team_id` filters | PASS |
| `searchItems` | query | `items` | direct `team_id` filters for prefix/substring/hierarchy queries | FIXED |
| `listGantt` | query | `items`, `scheduled_blocks`, `dependencies`, `time_entries`, `blockers` | direct/recursive `team_id` filters | FIXED |
| `listExecution` | query | `items`, `scheduled_blocks`, `dependencies`, `blockers`, `time_entries`, `item_tags`, `item_assignees` | direct/recursive `team_id` filters | FIXED |
| `listBlocked` | query | `items`, `dependencies`, `blockers`, `scheduled_blocks`, `time_entries`, `item_tags`, `item_assignees` | direct/recursive `team_id` filters | FIXED |
| `listByUser` | query | `items`, `dependencies`, `blockers`, `scheduled_blocks`, `time_entries`, `item_tags`, `item_assignees` | direct/recursive `team_id` filters | FIXED |
| `listOverdue` | query | `items` | direct `team_id` filter | FIXED |
| `listDueSoon` | query | `items` | direct `team_id` filter | FIXED |
| `getSettings` | query | `settings` | direct team filter would be required, but table is global | TODO |
| `listCalendarBlocks` | query | `scheduled_blocks`, `items` | join through `items.team_id` | PASS |
| `calendar_range` | query | `items`, `scheduled_blocks`, `item_assignees` | direct `team_id` filters + scoped project tree | PASS |
| `gantt_range` | query | `items`, `scheduled_blocks`, `dependencies`, `item_assignees` | direct/recursive `team_id` filters | PASS |
| `calendar_range_user` | query | `items`, `scheduled_blocks`, `item_assignees` | join through `items.team_id` | PASS |
| `calendar_range_users` | query | `items`, `scheduled_blocks`, `item_assignees` | join through `items.team_id` | PASS |
| `auth.session.current` | query | `sessions`, `users`, `teams`, `team_members` | read active session then resolve user/team/role from that session | FIXED |
| `team.current` | query | `teams`, `team_members`, `users` | direct lookup by `currentTeamId` | PASS |
| `users_list` | query | `team_members`, `users`, `item_assignees`, `items` | team members + assignee discovery joined through `items.team_id` | FIXED |
| `debug.verify_integrity` | query | `items` graph + related tables | direct team filter would be required, but check is global diagnostics | TODO |
