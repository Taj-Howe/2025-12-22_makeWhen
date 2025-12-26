# 1) update main and create a new branch
git switch main
git pull --ff-only
git switch -c feat/my-change

# 2) stage + commit your work
git add -A
git commit -m "Describe the change"

# 3) push branch to origin
git push -u origin HEAD

# 4) open a PR for review (pick ONE option)

# Option A (GitHub CLI):
gh pr create --base main --head HEAD --title "Describe the change" --body "What changed + how to test"

# Option B (no CLI):
# Open GitHub/GitLab in the browser → “Compare & pull request” / “New merge request”

# 5) after review is approved + checks pass, merge (pick ONE option)

# Option A (GitHub CLI):
gh pr merge --merge --delete-branch

# Option B (browser):
# Click “Merge” / “Squash and merge” / “Rebase and merge”

# 6) sync local main and clean up
git switch main
git pull --ff-only
git branch -d feat/my-change