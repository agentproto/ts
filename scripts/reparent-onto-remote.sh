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
# The branch is owned by the workflow (chore/update-deps-<date>, created by the
# bot): this run's tree supersedes whatever the earlier run pushed, so a manual
# commit on it would be replaced. The dropped diff is printed (stat) so it is
# visible in the job log and recoverable from history.
#
# Usage: reparent-onto-remote.sh <remote> <branch> <expected-remote-sha> <message>
# Exit 0 on success (HEAD moved to the new commit), 3 if the branch moved since
# the expected sha was read (head_moved).
set -euo pipefail

REMOTE="$1"; BRANCH="$2"; EXPECTED="$3"; MESSAGE="$4"

if ! git fetch --no-tags "$REMOTE" "refs/heads/$BRANCH"; then
  # Branch deleted between job start and now: nothing to fast-forward onto.
  echo "head_moved: $BRANCH no longer exists on $REMOTE (was $EXPECTED)" >&2
  exit 3
fi
TIP="$(git rev-parse FETCH_HEAD)"
if [ "$TIP" != "$EXPECTED" ]; then
  echo "head_moved: $BRANCH is at $TIP, expected $EXPECTED" >&2
  exit 3
fi
if [ "$(git rev-parse "$EXPECTED^{tree}")" = "$(git rev-parse 'HEAD^{tree}')" ]; then
  # Same tree as the branch already carries: no empty commit, no CI churn.
  # HEAD becomes the remote tip, so the CAS push is a no-op.
  git reset --hard "$EXPECTED" >/dev/null
  echo "tree identical to $EXPECTED: nothing to push"
  exit 0
fi
echo "superseding the earlier tip $EXPECTED (changes vs this run's tree):"
git diff --stat "$EXPECTED" HEAD | tail -5
NEW="$(git commit-tree "HEAD^{tree}" -p "$EXPECTED" -m "$MESSAGE")"
git reset --hard "$NEW" >/dev/null
echo "re-parented onto $EXPECTED: $NEW"
