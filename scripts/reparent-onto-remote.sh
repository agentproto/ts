#!/usr/bin/env bash
# Re-parent HEAD's tree onto the current remote tip of a branch, so a same-day
# re-run of update-deps pushes a FAST-FORWARD instead of an unrelated commit.
#
# git-cas push --expect <sha> requires the local tip to descend from <sha>, and
# a fresh checkout of main has neither that commit nor a descendant of it: the
# 2026-11-20 re-run died with `not-descendant ... Not a valid commit name`.
# The new tree (main + this run's bump) is kept byte for byte; only the parent
# changes. Never rebases, never merges, never retries (the workflow contract).
#
# Usage: reparent-onto-remote.sh <remote> <branch> <expected-remote-sha> <message>
# Exit 0 on success (HEAD moved to the new commit), 3 if the branch moved since
# the expected sha was read (head_moved).
set -euo pipefail

REMOTE="$1"; BRANCH="$2"; EXPECTED="$3"; MESSAGE="$4"

git fetch --no-tags "$REMOTE" "refs/heads/$BRANCH"
TIP="$(git rev-parse FETCH_HEAD)"
if [ "$TIP" != "$EXPECTED" ]; then
  echo "head_moved: $BRANCH is at $TIP, expected $EXPECTED" >&2
  exit 3
fi
NEW="$(git commit-tree "HEAD^{tree}" -p "$EXPECTED" -m "$MESSAGE")"
git reset --hard "$NEW" >/dev/null
echo "re-parented onto $EXPECTED: $NEW"
