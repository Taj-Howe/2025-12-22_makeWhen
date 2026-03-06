# Safe Branch Flow (uses `master` in this repo)

## 0) Preflight before coding

```sh
bash scripts/git/branch-safety.sh preflight
```

Checks current branch cleanliness and divergence against `master` and upstream.

## 1) Start a new branch from up-to-date `master`

```sh
bash scripts/git/branch-safety.sh start feat/my-change
```

Equivalent guarded sequence:

```sh
git fetch --all --prune
git switch master
git pull --ff-only
git switch -c feat/my-change
```

## 2) Commit and push

```sh
git add -A
git commit -m "Describe the change"
git push -u origin feat/my-change
```

## 3) Open PR to `master`

```sh
gh pr create --base master --head feat/my-change --title "Describe the change" --body "What changed + how to test"
```

## 4) Before merge, run checks and re-sync

```sh
bash scripts/git/branch-safety.sh preflight
pnpm -s verify
git fetch --all --prune
git rebase origin/master
```

## 5) Merge + cleanup

```sh
gh pr merge --merge --delete-branch
git switch master
git pull --ff-only
git branch -d feat/my-change
```

## 6) Weekly hygiene

```sh
bash scripts/git/branch-safety.sh status
bash scripts/git/branch-safety.sh brief-non-master
```
