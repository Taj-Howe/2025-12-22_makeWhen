# Legacy Product Spec (WASM + OPFS MVP)

This document captures **how the original legacy app behaved as a product** (origin/master).
It is a behavior spec, not an architecture spec. Use it as the target for rebuilding the MVP.

---

## 1) Core mental model

- **Everything is an Item** with a `type`:
  - `project`, `milestone`, `task`
  - **Subtask** is a task whose parent is another task (no separate DB type)
- **Hierarchy is parent_id**:
  - Projects are roots.
  - Milestones are children of projects.
  - Tasks can be children of projects, milestones, or tasks.
- **Scheduling is only Scheduled Blocks**:
  - `start_at + duration_minutes` is the only scheduling primitive.
  - End time is always derived: `end_at = start_at + duration_minutes`.
  - **Only one scheduled block per item**.
- **Dependencies are edges**:
  - "Blocked By / Blocking" are computed projections (never stored).
- **Blockers are explicit**:
  - User-entered blockers can block work regardless of dependencies.
- **Completion & Archive are explicit**:
  - `completed_at` is set only when status transitions to `done`.
  - `archived_at` hides items from active views until restored.

---

## 2) Items and hierarchy

### Types and rules
- **Project**
  - Root container.
  - Can have milestones and tasks as direct children.
- **Milestone**
  - Child of a project.
  - Can have tasks as children.
- **Task**
  - Child of a project, milestone, or task.
  - If parent is a task, the child task is a **subtask**.

### "Ungrouped" semantics
- There is a special logical project `"__ungrouped__"`:
  - **Global Ungrouped** shows tasks whose `parent_id IS NULL` (and their subtasks).
- In a specific project view:
  - **Ungrouped tasks** are tasks whose `parent_id = project_id`.
  - Milestones are `type = milestone` with `parent_id = project_id`.

---

## 3) Stored fields (Items)

> Timestamps are **milliseconds since epoch** (integer).

### Required at creation
- `type` (project | milestone | task)
- `title` (non-empty)
- `estimate_minutes` (integer >= 0)

### Stored fields
- `id` (uuid)
- `type`
- `title`
- `parent_id` (nullable)
- `status`
- `priority` (integer)
- `due_at` (nullable integer)
- `estimate_mode` (`manual` | `rollup`)
- `estimate_minutes` (integer >= 0)
- `health` (`on_track` | `at_risk` | `behind` | `ahead` | `unknown`)
- `health_mode` (`auto` | `manual`)
- `notes` (nullable)
- `sort_order` (integer for manual ordering)
- `completed_at` (nullable)
- `archived_at` (nullable)
- `created_at`, `updated_at` (integers)

### Defaults
- `estimate_mode`:
  - `task` -> `manual`
  - `project` / `milestone` -> `rollup`
- `status` -> `backlog`
- `priority` -> `0`
- `health` -> `unknown`
- `health_mode` -> `auto`
- `notes` -> `null`
- `completed_at` -> now if status = `done`, else null
- `archived_at` -> null
- `sort_order` -> append to end within parent (`max + 1`)

---

## 4) Scheduling (Scheduled Blocks)

### Storage
- `scheduled_blocks` table:
  - `block_id` (uuid)
  - `item_id`
  - `start_at` (int)
  - `duration_minutes` (int > 0)
  - `locked` (int, default 0)
  - `source` (string, default `"manual"`)

### Rules
- **Only one scheduled block per item** (enforced on create/update).
- End time is derived: `end_at = start_at + duration_minutes * 60000`.
- If `end_at` is supplied, duration is derived and must be > 0.

### Schedule summary (computed per item)
- `schedule_start_at` = earliest block start
- `schedule_end_at` = latest block end
- `scheduled_minutes_total` = sum of durations

### Slack (computed)
If both `due_at` and `schedule_end_at` exist:
```
slack_minutes = round((due_at - schedule_end_at) / 60000)
```
Else `slack_minutes = null`.

### Calendar defaults
Dragging to create a block:
- Creates a **new task** titled `"New task"`.
- Sets:
  - `estimate_mode = manual`
  - `estimate_minutes = max(15, selection_duration)`
  - `status = ready`
  - `priority = 0`
- Creates a scheduled block for the selection.

### "Scheduled For" input (edit form)
- UI exposes a "Start time" field.
- **Duration is not separately entered**:
  - Duration uses current `estimate_minutes`.
- Changing start time updates/creates the single block.

---

## 5) Dependencies

### Storage
- `dependencies`:
  - `item_id` (successor)
  - `depends_on_id` (predecessor)
  - `type` (`FS | SS | FF | SF`)
  - `lag_minutes` (integer >= 0)

### Rules
- No self-dependency.
- No duplicate edges.
- Cycle detection rejects edges that create cycles.
- Defaults: `type = FS`, `lag_minutes = 0`.

### Status evaluation (computed)
Using schedule envelope (`start/end` from blocks):
- **FS**: successor.start >= predecessor.end + lag
- **SS**: successor.start >= predecessor.start + lag
- **FF**: successor.end >= predecessor.end + lag
- **SF**: successor.end >= predecessor.start + lag
- Missing times -> `unknown`.

### Projections (computed)
- **Blocked By** = incoming edges (predecessors).
- **Blocking** = outgoing edges (successors).
- Each projection includes: predecessor/successor title, type, lag, status.

---

## 6) Blockers

### Storage
- `blockers`:
  - `blocker_id`
  - `item_id`
  - `kind` (default `"general"`)
  - `text`
  - `created_at`
  - `cleared_at` (nullable)

### Behavior
- An item is **blocked** if:
  - status is `blocked`, **or**
  - has uncleared blockers, **or**
  - has unmet dependencies.
- Blockers are shown in item editor and in "Blocked" widgets.

---

## 7) Status, completion, and archive

### Status values

  backlog, ready, in_progress, blocked, review, done, (optional) canceled

### Status transitions
- Setting done:
  - completed_at = now if not already set.
  - If ui.auto_archive_on_complete = true, archive the item and all descendants.
- Setting in_progress:
  - If item is blocked, operation is rejected unless override = true.

### Archive
- Archive sets archived_at = now.
- Archive applies to entire subtree (item + descendants).
- Restore sets archived_at = null (also applied to subtree).
- Archived items are hidden from active lists by default.

---

## 8) Assignments and users (legacy local)

### Assignment
- Stored in item_assignees.
- Single assignee enforced:
  - If multiple rows exist, UI uses the first.

### User registry
- Users are stored locally in settings under a users list.
- Display name is resolved from registry; fallback is User <idprefix>.
- Current user is stored in settings.

### User scope
When scope = user:
- Lists and calendars show only items assigned to that user.
- No parent inference: parents do not appear unless assigned themselves.

---

## 9) Tags

- Stored in item_tags as strings.
- UI provides:
  - Tag chips
  - Suggestions from existing tags
  - Filter by tag

---

## 10) Time tracking / Actuals

### Storage
- time_entries:
  - entry_id
  - item_id
  - start_at
  - end_at
  - duration_minutes
  - note
  - source
- running_timers:
  - item_id (unique)
  - start_at
  - note

### Behavior
- Start timer creates a running timer.
- Stop timer writes a time entry with computed duration.
- Actual minutes = sum of time_entries per item.

---

## 11) Rollups (computed)

Rollups apply to any item with children (projects, milestones, and parent tasks):

- Estimate rollup
  - If parent estimate_mode = rollup: sum children total estimates.
  - If parent estimate_mode = manual: parent estimate stays as-is.
- Actual rollup: always sums children actual minutes.
- Schedule rollup:
  - rollup_start_at = min descendant schedule start
  - rollup_end_at = max descendant schedule end
- Blocked rollup: count of blocked descendants.
- Overdue rollup: count of overdue descendants.

---

## 12) Health (auto/manual)

### Auto health calculation
Inputs:
- is_overdue
- remaining_minutes (estimate - actual)
- days_until_due
- capacity_minutes_per_day (setting)

Rules:
- Overdue -> behind
- No capacity or remaining <= 0 -> on_track
- Required/day > capacity -> behind
- Required/day >= 0.8 * capacity -> at_risk
- Else -> on_track

### Manual health
If health_mode = manual, the stored health value is used.

---

## 13) List View (primary grid)

### Structure
- Grouped by milestone, with an Ungrouped section at top.
- Ungrouped can be collapsed.
- Milestones can be collapsed.
- Tasks with children show a chevron to expand subtasks.

### Sorting
- Base order is sort_order within a parent.
- Secondary sorts: due date (nulls last), then title.

### Columns (major ones)
- Title (with status checkbox)
- Assignee
- Status
- Priority
- Due
- Completed On
- Slack
- Start Time (scheduled start)
- Scheduled Blocks summary
- Estimate Mode
- Est. Duration
- Actual
- Dependencies (editable)
- Blocked By (read-only)
- Blocking (read-only)
- Blockers (count)
- Tags
- Notes
- Health
- ID

### Editing
- Inline editors for most fields.
- Clicking a row selects it (single or multi).
- Double click or explicit controls open edit panel (depending on UI state).

### Selection and bulk actions
- Shift-click range, Cmd/Ctrl-click toggle.
- Bulk action bar appears when selection exists:
  - Archive selected
  - Delete permanently
  - Clear selection

### Drag and drop
- Tasks can be dragged within a group or between groups.
- Multiple selected tasks can be dragged together.
- Dragging a task onto another task makes it a subtask (if no cycle).
- Dragging to Ungrouped moves to project root (or global ungrouped in that view).
- Sort order recalculated based on drop position.

### Archive section
- Collapsible Archive (N) section at bottom of project list.
- Archived rows can be restored or deleted permanently.
- Archived items are still draggable (to restore/move).

---

## 14) Add / Edit Item Form

### Create mode
- Required: title, estimate_minutes
- For tasks: must have a project selected (or Ungrouped)
- Parent selection:
  - For tasks: parent can be milestone or task
  - For milestones: parent is the selected project
- Fields exposed:
  - Title
  - Type
  - Parent
  - Due date
  - Estimate mode
  - Estimate minutes
  - Status
  - Priority
  - Health + Health mode
  - Notes
  - Tags
  - Assignee
  - Dependencies (autocomplete)
  - Scheduled For (start time) -> creates/updates block using estimate minutes

### Edit mode
All create fields plus:
- Blockers list (add/clear)
- Archive / Delete actions
- Status set (blocked checks apply)

---

## 15) Calendar View

### Modes
- Week (time grid)
  - Hours shown from 6:00 to 20:00.
  - 15-minute snap for dragging.
- Month (day grid)

### Display
- Scheduled blocks rendered as rectangles.
- Due dates rendered as flags/badges.
- Titles shown in blocks; overdue is visually distinct.

### Interactions
- Drag on empty grid -> create a task + scheduled block.
- Drag a block -> moves it (updates start_at).
- Resize block -> updates duration_minutes.
- Right-click on block:
  - Edit
  - Duplicate
  - Delete
- Left-click block opens the edit drawer.

### User scope behavior
If scope = user:
- Only assigned items appear.
- Drag-create assigns the new task to the selected user.

---

## 16) Gantt View

### Data model
- Task bar = earliest scheduled start -> latest scheduled end.
- Project/milestone rollup bars = min/max of descendants.
- Due markers shown as vertical pins.

### Ordering
- Primary: planned/rollup start ascending (nulls last)
- Secondary: due date
- Tertiary: title

### Modes and zoom
- View modes: Week / Month / Quarter.
- Zoom: Ctrl/Cmd + mouse wheel adjusts day width.

### Dependency mode
- Toggle Dependency Mode:
  - Click one bar, then another -> creates edge (default FS, lag 0).
  - Inline editor allows type/lag changes.
  - Lines are drawn according to edge type.

---

## 17) Kanban View

### Columns (order)

  backlog -> ready -> in_progress -> blocked -> review -> done

Optional: canceled (toggleable).

### Swimlanes
Optional grouping by:
- None
- Assignee
- Project
- Health

### Cards
Tasks (and subtasks) only.
Cards show:
- Title
- Due date
- Priority
- Optional assignee/health badges

### Interactions
- Drag card between columns -> updates status.
- Clicking a card opens the edit drawer.
- Add task in column creates new task with that status.

---

## 18) Dashboard View

### Widgets
1) Execution Window
   - Scheduled (now/next)
   - Available now (ready and unblocked)
   - Back pocket (unscheduled ready)
2) Blocked
   - Blocked by dependencies
   - Blocked by blockers
   - Scheduled but blocked
3) Due / Overdue
   - Due soon
   - Overdue
   - Project deadlines
4) Contributions Heatmap
   - Completed items per day (uses completed_at)

### Behavior
- Clicking an item opens its edit drawer.
- Checkbox to mark done is available in lists.

---

## 19) Command Palette / CLI (legacy)

### Verbs

  create, edit, delete, schedule, archive, restore, open

### Types

  project, milestone, task, subtask

### Selection
- For edit/delete/schedule/archive/restore:
  - Use id:<value> or first bare token as target
  - Title can be quoted when supported

### Common fields
- title:\"...\", parent:<id>, in:\"Project Name\"
- due:\"...\", start:\"...\", duration:\"...\"
- priority:#, status:...
- tags:\"a,b\" or tags:[a,b]
- depends_on:\"id1,id2\"
- dep_type:FS|SS|FF|SF, dep_lag:#
- assignees:\"u1,u2\" (legacy UI enforces single)
- notes:\"...\"
- estimate_mode:manual|rollup, estimate_minutes:#
- health:..., health_mode:auto|manual
- blocker:\"text\" / blockers:\"a,b\", blocker_kind:\"...\"

### Special open command

  open \"Project Name\"
  open calendar
  open \"Project Name\" calendar
  open kanban | gantt | dashboard

### Scheduling from CLI
- schedule task <id> start:\"...\" duration:\"...\"
- Duration strings accept:
  - 30 min, 2 hours, 2:30

### Archive/Restore from CLI
- archive task <id>
- restore task <id>

---

## 20) Legacy settings

Stored in settings:
- ui.auto_archive_on_complete (boolean)
- capacity_minutes_per_day (number)
- users (local registry list)
- current_user_id

---

## 21) Export / Import

The legacy worker supported:
- export_data -> full JSON dump of items, dependencies, blockers, blocks, time_entries, tags, assignees, settings.
- import_data -> wipes and replaces with provided dataset.

---

## 22) What blocked means (summary)

An item is blocked if any of these are true:
- status == blocked
- there is at least one uncleared blocker
- there is at least one unmet dependency
  - unmet = depends_on item missing or not done

---

## 23) What done means (summary)

- Setting status to done sets completed_at once.
- If auto-archive is on, item and descendants are archived immediately.
- Completed items can still have scheduled blocks or dependencies (but are usually hidden by filters).

---

## 24) Canonical invariants (legacy MVP)

- Scheduled block is the only schedule source of truth.
- Dependencies are edges; blocked_by/blocking are projections.
- One scheduled block per item.
- Subtask = task with parent task.
- Archive hides by default but does not delete data.
- Estimate vs rollup:
  - manual = user-entered
  - rollup = sum of children

---

This is the behavioral baseline for rebuilding the MVP. If anything in the new architecture deviates, that deviation should be explicit and intentional.
