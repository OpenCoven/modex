#!/usr/bin/env bash
# Modex worktree convention: every session (human or agent) works in its own worktree under
# .worktrees/<name> on branch <name>, cut from origin/main. The primary checkout stays on main
# and is never edited directly. main is protected (signed commits + green CI), so work lands
# through a PR.
#
#   scripts/worktree.sh new <name>      create .worktrees/<name> on branch <name> from origin/main and print its path
#   scripts/worktree.sh list            list worktrees
#   scripts/worktree.sh remove <name>   remove the worktree (refuses if it has uncommitted changes) and its local branch if merged
#   scripts/worktree.sh check           exit 1 with a hint when run from the primary checkout (agents call this first)
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
# Resolve the primary checkout even when invoked from inside a worktree.
common="$(git rev-parse --git-common-dir)"
primary="$(cd "$(dirname "$common")" && pwd -P)"
[ "$(basename "$common")" = ".git" ] || primary="$(cd "$common/.." && pwd -P)"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

case "${1:-}" in
  new)
    name="${2:-}"; [ -n "$name" ] || { echo "usage: scripts/worktree.sh new <name>" >&2; exit 2; }
    case "$name" in */*|*..*|.*|"") echo "name must be a simple slug (letters, digits, - _)" >&2; exit 2;; esac
    dest="$primary/.worktrees/$name"
    [ ! -e "$dest" ] || { echo "$dest already exists" >&2; exit 1; }
    git -C "$primary" fetch -q origin main
    mkdir -p "$primary/.worktrees"
    if git -C "$primary" show-ref -q --verify "refs/heads/$name"; then
      git -C "$primary" worktree add -q "$dest" "$name"
    else
      git -C "$primary" worktree add -q -b "$name" "$dest" origin/main
    fi
    # A fresh worktree has no built @modex/core, which the desktop tests import; build it so
    # `npm test` works immediately.
    ( cd "$dest" && npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1 && npm run build -w @modex/core >/dev/null 2>&1 ) \
      || echo "note: npm install/build failed; run \`npm install && npm run build\` inside the worktree" >&2
    echo "$dest"
    ;;
  list)
    git -C "$primary" worktree list
    ;;
  remove)
    name="${2:-}"; [ -n "$name" ] || { echo "usage: scripts/worktree.sh remove <name>" >&2; exit 2; }
    dest="$primary/.worktrees/$name"
    [ -d "$dest" ] || { echo "no worktree at $dest" >&2; exit 1; }
    if [ -n "$(git -C "$dest" status --porcelain)" ]; then
      echo "refusing: $dest has uncommitted changes (commit, stash, or discard them first)" >&2; exit 1
    fi
    git -C "$primary" worktree remove "$dest"
    git -C "$primary" fetch -q origin main
    # main is squash-merged, so a landed branch is never an ancestor of origin/main. Treat the
    # branch as merged when it is an ancestor OR its tree is identical to origin/main's (squash
    # landed and nothing else has since) OR GitHub reports a merged PR for it.
    merged=no
    if git -C "$primary" merge-base --is-ancestor "$name" origin/main 2>/dev/null; then merged=yes
    elif git -C "$primary" diff --quiet "origin/main" "$name" 2>/dev/null; then merged=yes
    elif command -v gh >/dev/null 2>&1 && [ "$(git -C "$primary" -c core.quotepath=false ls-remote --heads origin "$name" | wc -l | tr -d ' ')" = "0" ] \
         && [ -n "$(gh pr list --state merged --head "$name" --json number --jq '.[0].number' 2>/dev/null)" ]; then merged=yes
    fi
    if [ "$merged" = yes ]; then
      git -C "$primary" branch -q -D "$name" && echo "removed worktree and merged branch $name"
    else
      echo "removed worktree; branch $name kept (not merged into origin/main)"
    fi
    ;;
  check)
    if [ "$(pwd -P)" = "$primary" ] || [[ "$(pwd -P)" != "$primary/.worktrees/"* ]]; then
      echo "You are in the primary checkout ($primary). Work in a worktree instead:" >&2
      echo "  scripts/worktree.sh new <name>   # then cd into the printed path" >&2
      exit 1
    fi
    echo "ok: $(pwd -P) on $(git branch --show-current)"
    ;;
  -h|--help|help|"") usage 0 ;;
  *) usage 2 ;;
esac
