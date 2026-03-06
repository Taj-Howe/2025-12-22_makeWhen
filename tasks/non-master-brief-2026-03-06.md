# Brief: Changes Outside `master`

Date: 2026-03-06  
Repo snapshot: after local safe cleanup pass

## Baseline
- `master` at `8596778`
- Current branch `codex/fix-assignee-menu-last-row` is aligned with `master` (`0 behind / 0 ahead`)

## Local branches with commits not in `master`

### 1) Radix/UI chain (overlapping lineage, not separate work streams)
- `feat/backend-dev-for-project-` (ahead 1):
  - `c481ca3` added scope for views.
- `feat/adding-radix-ui-and-color-for-styling-setting-up-backend-for-custom-themes` (ahead 2):
  - `6b3f11c` Installed Radix UI + Radix Colors + Semantic token layer
  - `c481ca3` added scope for views.
- `feat/add-cli-for-tasks` (ahead 3):
  - `c4919ef` Added Radix UI and CLI feature
  - `6b3f11c` Installed Radix UI + Radix Colors + Semantic token layer
  - `c481ca3` added scope for views.

Interpretation: these three are stacked/overlapping, not three independent feature sets.

### 2) Rebuild branch (independent line)
- `feat/rebuild-radix-ui` (ahead 4):
  - `1e54d11` trying to get things back to the main
  - `7e54077` fix(ui): restore constants module used by App
  - `adb7bf2` Add missing Radix theme CSS files
  - `bc2a94e` Resolve App.tsx conflict and restore create flows

### 3) Sync/auth experiment line (independent line)
- `feat/add-sync` local (ahead 3):
  - `acc4a19` this isn't working
  - `cf260aa` working on auth
  - `e6b3063` First commit on new branch
- `origin/feat/add-sync` remote (ahead 2):
  - `cf260aa` working on auth
  - `e6b3063` First commit on new branch

Interpretation: local `feat/add-sync` has one extra commit not pushed (`acc4a19`).

## Remote-only branches still carrying non-master commits
- `origin/debug/v1.0.0` (ahead 3):
  - `5d5069f` Changed to server, SSE sync for collab
  - `33930f0` Refactored the backend to take live. See spec for details.
  - `c0143c8` fixed gantt

## Remote branches with no unique commits vs `master`
- `origin/core/storage-system-refactor` (ahead 0)
- `origin/feat/radix-themed-componenets-refactor` (ahead 0)
- `origin/feat/updating-ui-with-modals` (ahead 0)

## Bottom line
- The only active working baseline is `master`/`codex/fix-assignee-menu-last-row`.
- Non-master changes are concentrated into:
  - one overlapping Radix/UI chain (3 commits total),
  - one rebuild line (4 commits),
  - one sync/auth line (3 local commits),
  - one remote-only debug line (3 commits).
