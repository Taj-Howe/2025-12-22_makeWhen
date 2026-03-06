#!/usr/bin/env bash
set -euo pipefail

default_branch="${DEFAULT_BRANCH:-master}"

ensure_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "error: this command must run inside a git repo" >&2
    exit 1
  fi
}

ensure_default_branch_exists() {
  if ! git show-ref --verify --quiet "refs/heads/${default_branch}"; then
    echo "error: default branch '${default_branch}' does not exist locally" >&2
    exit 1
  fi
}

require_clean_tree() {
  if [ -n "$(git status --porcelain)" ]; then
    echo "error: working tree is not clean. commit/stash first." >&2
    exit 1
  fi
}

print_counts_against_master() {
  local ref="$1"
  local behind ahead
  read -r behind ahead < <(git rev-list --left-right --count "${default_branch}...${ref}")
  printf "%s\tbehind:%s\tahead:%s\n" "${ref}" "${behind}" "${ahead}"
}

cmd_status() {
  ensure_default_branch_exists
  echo "Branch divergence vs ${default_branch}:"
  for b in $(git for-each-ref --format='%(refname:short)' refs/heads | sort); do
    print_counts_against_master "${b}"
  done

  echo
  echo "Local branches not merged into ${default_branch}:"
  git branch --no-merged "${default_branch}" || true
}

cmd_preflight() {
  ensure_default_branch_exists
  local current
  current="$(git rev-parse --abbrev-ref HEAD)"

  echo "Current branch: ${current}"
  if [ -n "$(git status --porcelain)" ]; then
    echo "Working tree: DIRTY"
  else
    echo "Working tree: CLEAN"
  fi

  echo
  echo "Divergence checks:"
  print_counts_against_master "${current}"

  local upstream
  upstream="$(git for-each-ref --format='%(upstream:short)' "refs/heads/${current}")"
  if [ -n "${upstream}" ]; then
    local behind ahead
    read -r behind ahead < <(git rev-list --left-right --count "${upstream}...${current}")
    printf "%s\tbehind:%s\tahead:%s\n" "${upstream}" "${behind}" "${ahead}"
  else
    echo "No upstream configured for ${current}"
  fi

  echo
  echo "Not merged into ${default_branch}:"
  git branch --no-merged "${default_branch}" || true
}

cmd_start() {
  ensure_default_branch_exists
  local new_branch="${1:-}"
  if [ -z "${new_branch}" ]; then
    echo "usage: scripts/git/branch-safety.sh start <new-branch-name>" >&2
    exit 1
  fi

  require_clean_tree
  git fetch --all --prune
  git switch "${default_branch}"
  git pull --ff-only
  git switch -c "${new_branch}"
  echo "Created ${new_branch} from ${default_branch}"
  echo "Next: git push -u origin ${new_branch}"
}

cmd_brief_non_master() {
  ensure_default_branch_exists
  local refs=()
  while IFS= read -r ref; do
    case "${ref}" in
      "${default_branch}"|"origin/${default_branch}"|"origin/HEAD"|"origin")
        continue
        ;;
    esac
    refs+=("${ref}")
  done < <(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/origin | sort -u)

  echo "Branches with commits not in ${default_branch}:"
  for ref in "${refs[@]}"; do
    local behind ahead
    read -r behind ahead < <(git rev-list --left-right --count "${default_branch}...${ref}")
    if [ "${ahead}" -gt 0 ]; then
      echo
      echo "## ${ref} (ahead ${ahead})"
      git log --oneline --no-merges "${default_branch}..${ref}"
    fi
  done
}

usage() {
  cat <<EOF
Usage:
  scripts/git/branch-safety.sh preflight
  scripts/git/branch-safety.sh status
  scripts/git/branch-safety.sh start <new-branch-name>
  scripts/git/branch-safety.sh brief-non-master

Environment:
  DEFAULT_BRANCH=<branch>  # default: master
EOF
}

main() {
  ensure_git_repo

  case "${1:-}" in
    preflight)
      cmd_preflight
      ;;
    status)
      cmd_status
      ;;
    start)
      shift
      cmd_start "${1:-}"
      ;;
    brief-non-master)
      cmd_brief_non_master
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
