
git procedure: 


## Prompt Counter: 3 (next +=) 


# Upcoming Features:

## Updating UI so it's function (modal windows that pop up) 
  - Make the CLI be a popup window on command + K 
  - Make the Create/Edit forum come in from the side. 

## Make Custom Keyboard Mappings Easy  

## Progress Tracking UI  
  Add a completed tasks bar (identical to github contributions) (this is iciing on the cake)
    - Would be fun to have achievement levels for time worked (actual vs estimate), efficiency achievements, total tasks achievements, etc. 


## Create the next views
 - Decisions: How to organize all of these views? How do I set the foundation so that i can start with just project based calendar, kanban, gantt, today, etc, and then build the functionality for calendars by user/team/org. 

    - Org Calendar 
      - User Calendar 
       - Project Calender Shows all tasks
   - Org Kanban
     - User Kanban
        - Project Kanban
    - Org Gantt
        - User Gantt 
             - Project Gantt 
    - Today
        - Project Today
            - User Today 
               - Org 

### LIST View
- 
    - by org
        - by user
            - by project
### 4.1 Project view (tree)
- project → milestones → tasks → subtasks
- show rollups (remaining time, overdue count, blocked count, due marker)
- filter by status/health/assignee/tag
    - by org
        - by user
            - by project

### 4.2 Kanban view
- Columns: backlog, ready, in_progress, blocked, review, done (canceled hidden by default)
- Swimlanes optional: by project, by assignee, by health
     - by org
        - by user
            - by project 

### 4.3 Calendar view
Shows:
- ScheduledBlocks as draggable/resizable bars
- Due markers as pins/flags at due_at (no duration)
Interactions:
- drag block → move start time
- resize block → change duration
- create block → click-drag on empty time (optional)
      - by org
        - by user
            - by project

### 4.4 Gantt view
- Bars reflect scheduled blocks:
  - Task bar: earliest block start → latest block end (optionally show gaps)
  - Project/milestone bar: rollup start/end from descendants
- Due markers render as vertical lines/pins
      - by org
        - by user
            - by project
### 4.5 “Today / This Week” execution view
- Primary: blocks scheduled in the time window (ordered by time)
- Secondary: ready & unblocked items without blocks (ordered by sequence_rank)
      - by org
        - by user
            - by project    
### 4.6 Blocked view
- Split into:
  - blocked by dependencies
  - blocked by blockers
- Show “scheduled but blocked” items as high-visibility warnings
      - by org
        - by user
            - by project    
### 4.7 Due/Overdue dashboards
- “Due soon” list
- “Overdue” list
- Per project: days until due / days overdue (based on project’s own due_at)
      - by org
        - by user
            - by project

### 4.8 By User / Team


Small ones: 

Make it so you can drag tasks between milestones. 
Missing fields in the list view (not showing up in the input component either): 
 - There is no scheduled for date! Just a duration. 
 - There are no tags field 
 - No depends on field 

 