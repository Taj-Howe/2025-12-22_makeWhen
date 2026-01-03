
git procedure: 


# Bug Fixes
- [ ] Fix the asignee menu not having enough space to click if its the last task in the list. 
- [ ] Highlight item that corresponds to scope. Make page titles more expressive. 


# Upcoming Features:

## Add custom UI Settings
- [ ] Copy minimal theme settings that allow you to change the CSS tokens 
  - [ ] Look up Minimal Theme Settings, it's an obsidian plugin, and use that model of being able to alter the CSS tokens through a UI. 
- [ ] Allow you to export the settings as JSON 
- [ ] Allow for custom CSS Snippets 
- [ ] Put this in the settings window 
- [ ] Make a few premade color themes
- [ ] Make slim, medium, and bold style
- [ ] Code, Minimal, and 
- [ ] I want three cohesive concepts for the themes. SO each color theme matches with a font style matches with a graphic weight (corners, lines, etc). They can each be controlled indvidgually. Use the Radix color pack as your sample selection. For the fonts, I will paste the embed links for the fonts that I want defualt. 
- [ ] Font one: looks good in bolder type faces, serif, traditional but still clean and minmal:
traditional font:  <link rel="stylesheet" href="https://use.typekit.net/pcv4nbv.css">
minimal font pack: <link rel="stylesheet" href="https://use.typekit.net/pcv4nbv.css">
code font pack: <link rel="stylesheet" href="https://use.typekit.net/pcv4nbv.css">

## Progress Tracking UI  
  - [ ] Add a completed tasks bar (identical to github contributions) (this is iciing on the cake)
  - [ ] Create a time tracking functionality that has a timer that fills in actual hours worked (vs estimate duration) 
  - [ ] 
  - [ ] Would be fun to have achievement levels for time worked (actual vs estimate), efficiency achievements, total tasks achievements, etc.
  - And then just go ahead and add a basic set of met


## Add Folder Support 
  - [ ] Add folders for projects

## Add Subtasks to tasks

## CLI 
- [ ] Add a switch command to switch between projects 

rics. Whatever is most common in PM world.  


## Create the next views

- [ ]  make the dahsboard stich between list view/kanban/cal/gantt for that user. When on project, it switches between the views. 


- [ ] I need project and user views to be able to be opened in tabs. RIght now the switch between list/calendar view needs to be somewhere else. I think how it works is you can select the level of the view, and type of view combination. Somehow this has to be simple in the ui. Maybe two horizontal selection bars at the top? 
 - [ ] Decisions: How to organize all of these views? How do I set the foundation so that i can start with just project based calendar, kanban, gantt, today, etc, and then build the functionality for calendars by user/team/org. 

   
    - Today
        - Project Today
            - User Today 
               - Org 

### LIST View
- 
    
        - by user
            - by project
### 4.1 Project view (tree)
- project → milestones → tasks → subtasks
- show rollups (remaining time, overdue count, blocked count, due marker)
- filter by status/health/assignee/tag
    - by org
        - by user
            - by project



            



### 4.5 “Today / This Week” execution view
- Just a super simple to do list widget that lists things in order of when they're scheduled for in the calendar. 
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

## Dashboard 
- [ ] A customizable view that users can add their favorite view tyupes to at a glance (by org, team, project, user basis). 


Small ones: 

Make it so you can drag tasks between milestones. 
Missing fields in the list view (not showing up in the input component either): 
 - There is no scheduled for date! Just a duration. 
 - There are no tags field 
 - No depends on field 

 
 
 
 ## **Completed:** 
________________________________________

### 4.3 Calendar view
Notes as of dec 30: 
  Right now the calendar view per project works. But I need to add a calendar view per user. This will default to the signed in user, but you can select other user's calendars to view them as well. This should show all scheduled tasks assigned to that user. 
  - [ ] Check what backend is necessary to add support for users. Do I need to set up Auth here? 
  - [ ] Think about a show available time for the user 
  - [ ] This will go in the right bar as well beneath projects in a bar titled Calendars, that will show a list of users names, on click it will show a calendar the same as the project view but with all tasks milestones and deadlines assigned to that person. 
  - [ ] While you're at it, go ahead and add a user icon and name at the top, with a settings button, and just a dashboard tab. The dashboard tab will be used for custom views where users can add widget like componenets of their most used views. But we'll work on that later. 
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
## Add AI Schedulers
  - [ ] make sure the architecture of the app is still set up to be able to communicate with an LLM who can view the database of tasks, understand it, and make changes. 
  - [ ] Create an AI that looks at deadline, priority, availability in your schedule, and time estimate, and adds scheduled for dates based on this information. If it goes long, it prompts to reschedule. 



## Changes to the UI 
  - [x] fix drop to end tags in the list.
  - [x] Be able to move tasks back into ungrouped 
  - [x] Get rid of the arrows (now that we have the drag) 
  - [x] get rid of all the task delete buttons (we have right click!)
  - [x] get rid of the New Task button in the top right 
  - [x] get rid of the type columns  

## Fixing Rollups
  - [x] manual rollups for milestones is not working. 
  

## Changing adding and fixing fields
- [x] Add the rest of Asana Fields in to the columns
  - [x] Completed On 
  - [x] Blocked By 
  - [x] Blocking (This should be computed by the dependency relationship, the dependency relationship should be stored in the DB still, because it will be used in Gantt, but I want to see what is blocking/blocked by in the columns)
  - [x] Timer (tool, is the same as actual duration).
  - Make sure the CLI is updated.  
- [x] Make the input for estimated duration work
- [x] Add dependency type logic
  - SF, FS, SS, FF
- [x] Add lag 
- [x] Add Slack 
  -[x] Don't sto re single dependons_on string field if you care about SS/FF
  -[x] Don't store blocked-by and blocking as separate source-of-truth fields. This creates contradictions. Pick one truth (the dependecy edges,) compute the rest. 
-[x] Scheduled for should shange to start date + duration to compute time block, keeping due date flag separate (but contained within the same task). 



### 4.4 Gantt view
Okay, so that app is working great. List view and calendar view seem to be in synch. The features are working correctly. it's usable. 

Next big task is Gantt view. Look back at this context to understand the design philosophy around the dependencies. I want Gantt to work even if the dependency logic hasn't been set up. Instead, it would just show a horizontal view of time, basically the order someone will do projects based on the order they are in the calendar. Then, when dependency logic is added, the lines will be drawn per usual gantt chart behavior. I would like dependency logic to be able to be added by interacting with the UI. 
- Bars reflect scheduled blocks:
  - Task bar: earliest block start → latest block end (optionally show gaps)
  - Project/milestone bar: rollup start/end from descendants
- Due markers render as vertical lines/pins
        