# CLI Language (Command Palette)

This describes the command language used by the Command Palette (Cmd/Ctrl+K).
All commands are parsed strictly; unknown keys are errors.

## Command shape (v1)

```
[verb] <type> <title?> <key:value>...

verb  := create | edit | delete | schedule | archive | restore | open
type  := project | milestone | task | subtask
title := "Quoted Title" | title:"Quoted Title"
```

Notes:
- If the verb is omitted, it defaults to `create`.
- `open` switches view/project scope and does not accept key:value tokens.
- For `edit`, `delete`, `schedule`, `archive`, and `restore`, the target must be:
  - an id token (first bare token after type), OR
  - `id:<value>`, OR
  - a quoted title (exact match).
- `subtask` is an alias for `create task` with a required parent.

## Keys (all optional unless noted)

Item placement:
- `parent:` or `under:` parent id (required for subtask)
- `in:` project name or id (scopes name resolution)

Dates / scheduling:
- `due:` or `due_at:` due date/time (optional)
- `start:` or `start_at:` scheduled block start time
- `dur:` or `duration:` or `duration_minutes:` scheduled block duration
  - accepts `90`, `90m`, `1.5h`, or `1:30`
- `scheduled_for:` is accepted as a legacy alias for `start:`

Status / priority / estimate:
- `status:` backlog | ready | in_progress | blocked | review | done | canceled
- `pri:` or `priority:` integer 0–5
- `estimate_mode:` manual | rollup
- `estimate_minutes:` accepts `30`, `30m`, `2h`, `2:15`

Dependencies:
- `dep:` or `depends_on:` comma list of ids or titles
- `dep_type:` FS | SS | FF | SF (applies to deps added in this command, default FS)
- `dep_lag:` or `lag:` minutes (applies to deps added in this command)

Other:
- `tags:` comma list
- `assignee:` or `assignees:` comma list (single-assignee enforced; first wins)
- `notes:` quoted text
- `health:` on_track | at_risk | behind | ahead | unknown
- `health_mode:` auto | manual
- `blocker:` single blocker text (adds a blocker)
- `blockers:` comma list of blocker texts
- `blocker_kind:` optional kind for added blockers (default `general`)

## ListView field coverage (current)

This CLI supports most *writable* fields shown in the ListView. Some columns are
computed/read‑only or require separate UI actions.

Writable via CLI:
- `title` (create/edit)
- `status` (edit)
- `priority` (create/edit)
- `due_at` (create/edit)
- `estimate_mode`, `estimate_minutes` (create/edit)
- `tags` (create/edit via `set_item_tags`)
- `assignee` (create/edit, single‑assignee)
- `notes` (create/edit)
- `health`, `health_mode` (create/edit)
- `dependencies` (create/edit via `dep:` list)
- `blockers` (create/edit via `blocker:` / `blockers:`)
- `schedule` (create/edit via `start:` + `dur:`; creates a ScheduledBlock)

Read‑only / computed in ListView (not writable via CLI):
- `completed_on` (derived from status transitions)
- `slack` (derived from due_at vs scheduled blocks)
- `blocked_by` / `blocking` (computed projections from dependency edges)
- `actual_minutes` (from time entries)

Not supported in CLI (yet):
- Scheduled block edits (move/resize/delete blocks beyond primary block)
- Multiple block creation in a single command

## Date/time formats

- ISO or browser‑parseable date/time strings are accepted:
  - `2026-01-03 17:00`
  - `2026-01-03T17:00`
- Month/day without year uses the current year:
  - `1/15 09:00`
- Use 24h time for clarity.

## Scheduling rules

- Scheduling creates a `ScheduledBlock` using `{ start_at, duration_minutes }`.
- Each item can have **only one** scheduled block; scheduling replaces the previous block.
- If `start` is provided without `dur`, the CLI falls back to
  `estimate_minutes` **only for create/edit**. The `schedule` verb requires both.
- There is no end‑time input; end is derived as `start + duration`.
- Dependency type defaults to `FS` when not specified.

Schedule verb behavior:
- `schedule` updates the *primary* scheduled block if one exists, otherwise creates one.
- Requires both `start` and `dur`.

## Open command

Use `open` to switch views and/or projects:
- `open "calendar"` switches to the Calendar view for the current scope.
- `open "Sample Project"` switches to that project and opens the List view.
- `open "Sample Project" "kanban"` switches project + view.
- Supported views: list, calendar, kanban, gantt, dashboard.

## Examples

Create:
- `create task "Write outline" due:"2026-01-03 17:00" pri:3`
- `task "Plan sprint" start:"2026-01-03 09:00" dur:"90m"`
- `milestone "Phase 1" in:"Sample Project"`
- `subtask "Write tests" under:01H...`

Edit:
- `edit task 01H... title:"New title" status:in_progress`
- `edit task "Weekly sync" in:"Sample Project" priority:2`
- `edit milestone 01H... due:"2026-01-03 17:00"`

Schedule:
- `schedule task 01H... start:"2026-01-03 09:00" dur:"45m"`
- `schedule task "Fix bug" in:"Sample Project" start:"2026-01-03 09:00" dur:"45m"`

Dependencies:
- `edit task 01H... dep:01A...,01B... dep_type:FS lag:30m`

Delete:
- `delete task 01H...`
- `delete task "Old task" in:"Sample Project"`

Archive / restore:
- `archive task 01H...`
- `restore task 01H...`

Open:
- `open "Sample Project"`
- `open "calendar"`
- `open "Sample Project" "kanban"`

## Error behavior (summary)

- Unknown keys or missing values produce errors.
- Subtasks require `parent:` or `under:`.
- Invalid dates or durations produce errors.
- Dependency type must be one of FS/SS/FF/SF.
