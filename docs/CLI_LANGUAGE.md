# CLI Language (Command Palette)

This describes the command language used by the Command Palette (Cmd/Ctrl+K).
All commands are parsed strictly; unknown keys are errors.

## Command shape (v1)

```
[verb] <type> <title?> <key:value>...

verb  := create | edit | delete
type  := project | milestone | task | subtask
title := "Quoted Title" | title:"Quoted Title"
```

Notes:
- If the verb is omitted, it defaults to `create`.
- For `edit` and `delete`, the target must be:
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

## Date/time formats

- ISO or browser‑parseable date/time strings are accepted:
  - `2026-01-03 17:00`
  - `2026-01-03T17:00`
- Month/day without year uses the current year:
  - `1/15 09:00`
- Use 24h time for clarity.

## Scheduling rules

- Scheduling creates a `ScheduledBlock` using `{ start_at, duration_minutes }`.
- If `start` is provided without `dur`, the CLI falls back to
  `estimate_minutes`. If no estimate is available, it errors.
- There is no end‑time input; end is derived as `start + duration`.
- Dependency type defaults to `FS` when not specified.

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

Dependencies:
- `edit task 01H... dep:01A...,01B... dep_type:FS lag:30m`

Delete:
- `delete task 01H...`
- `delete task "Old task" in:"Sample Project"`

## Error behavior (summary)

- Unknown keys or missing values produce errors.
- Subtasks require `parent:` or `under:`.
- Invalid dates or durations produce errors.
- Dependency type must be one of FS/SS/FF/SF.
