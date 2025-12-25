# CLI Command Grammar (v1)

This document defines a strict, deterministic CLI-style command grammar for creating items in makeWhen.

## Grammar (EBNF-ish)

```
command        := action WS item_type WS quoted_title (WS kv_pair)*
action         := "create" | "edit" | "archive"
item_type      := "project" | "milestone" | "task" | "subtask"
quoted_title   := '"' title_char* '"'
title_char     := (any char except '"' or "\" ) | escape
escape         := "\" "\" | "\" '"'"' | "\" '"'"'"'"' | "\" "n" | "\" "t"

kv_pair        := key ":" value
key            := "id" | "in" | "under" | "assignee" | "status" | "pri" | "due" |
                  "sched" | "est" | "tags" | "dep" | "notes" | "health"
value          := quoted_value | bare_value
quoted_value   := '"' value_char* '"'
value_char     := (any char except '"' or "\" ) | escape
bare_value     := token (no spaces)

WS             := one or more spaces
```

### Notes
- The **first token must be an action**.
- The **second token must be the item type**.
- The **third token must be a quoted title**.
- All remaining tokens must be key:value pairs with a **colon required**.
- Unknown keys are errors.
- Values with spaces must be quoted.
- Escaped quotes inside quoted strings are supported (`\"`).

## Supported Keys (v1)

- `id:` optional (string; if omitted, UUID is generated)
- `in:` project identifier (id or name)
- `under:` parent identifier (milestone/task id or name)
- `assignee:` single user id
- `status:` `backlog|ready|in_progress|blocked|review|done|canceled`
- `pri:` integer 0–5
- `due:` timestamp or date shorthand
- `sched:` scheduled block spec (start + duration)
- `est:` estimate minutes (integer; manual mode only)
- `tags:` comma-separated list
- `dep:` comma-separated item ids
- `notes:` quoted text
- `health:` `on_track|at_risk|behind|ahead|unknown`

## Shorthands (strict)

### due:
- `due:today`
- `due:tomorrow`
- `due:fri` (any weekday: mon/tue/wed/thu/fri/sat/sun)

### sched:
- Allowed **only if quoted** when spaces are present:
  - `sched:"tomorrow 9am/60"`
- Single-token form is allowed:
  - `sched:2025-12-24T09:00/60`

## Examples (valid)

1) `create project "Personal Dashboard" due:today pri:2`
2) `create milestone "MVP v1" in:proj_123 due:2025-01-15 est:0`
3) `create task "Draft onboarding copy" in:proj_123 under:ms_456 due:tomorrow est:90`
4) `create subtask "Write empty state" under:task_9 est:45`
5) `create task "Calendar polish" in:"Personal Dashboard" status:ready pri:3`
6) `create task "Schedule team sync" in:proj_123 sched:2025-12-24T09:00/60`
7) `create task "Fix CI flake" in:proj_123 sched:"tomorrow 9am/60" est:60`
8) `create task "Wire analytics" in:proj_123 tags:ops,backend,urgent`
9) `create task "Refactor tree" in:proj_123 dep:task_a,task_b`
10) `create milestone "Security pass" in:proj_123 notes:"Must include perf audit"`

## Examples (invalid) + errors

1) `create task Unquoted Title`
   - error: `title must be quoted`

2) `create task "Missing key colon" due today`
   - error: `expected key:value pair, got "due"`

3) `create task "Bad key" foo:bar`
   - error: `unknown key: foo`

4) `create task "Bad status" status:working`
   - error: `invalid status: working`

5) `create task "Bad priority" pri:9`
   - error: `priority must be 0-5`

6) `create task "Bad due" due:yesterdayish`
   - error: `invalid due value: yesterdayish`

7) `create task "Bad sched" sched:tomorrow 9am/60`
   - error: `sched value with spaces must be quoted`

8) `create task "Bad sched" sched:2025-13-01T09:00/60`
   - error: `invalid sched datetime: 2025-13-01T09:00`

9) `create task "Bad dep list" dep:""`
   - error: `dep list must contain at least one id`

10) `create task "Ambiguous parent" under:"Design"`
    - error: `ambiguous name: Design (matches 3 items)`

## Canonical JSON Output Shape

```
{
  "action": "create|edit|archive",
  "type": "project|milestone|task|subtask",
  "title": "string",
  "id?": "string",
  "parent_id?": "string",
  "project_id?": "string",
  "assignees?": ["string"],
  "status": "backlog|ready|in_progress|blocked|review|done|canceled",
  "priority": 0,
  "due_at": "ISO-8601 timestamp",
  "scheduled_for?": "ISO-8601 timestamp",
  "scheduled_duration_minutes?": 60,
  "estimate_mode": "manual",
  "estimate_minutes": 0,
  "tags": ["string"],
  "depends_on": ["string"],
  "notes?": "string",
  "health": "on_track|at_risk|behind|ahead|unknown",
  "health_mode": "auto|manual"
}
```

Defaults if omitted:
- `status`: `backlog`
- `priority`: `0`
- `estimate_mode`: `manual`
- `estimate_minutes`: `0`
- `health`: `unknown`
- `health_mode`: `auto`
- `tags`: `[]`
- `depends_on`: `[]`

## Name Resolution Rules

1) **Prefer IDs**: if `in:` or `under:` looks like a known id, use it directly.
2) **Exact title match** within current project scope.
3) **Error on multiple matches** with a clear list/count.
4) If `in:` is missing for non-project items, resolve project from `under:` parent. If both missing, error.

## Timezone Handling

- Parse relative dates (`today`, `tomorrow`, `fri`) using the **local timezone**.
- Store final values as ISO timestamps (UTC-agnostic storage; keep ms epoch internally).
