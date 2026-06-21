#!/usr/bin/env bash
#
# Configure the git committer identity for agentic CI commits.
#
# Uses the GitHub App bot identity (`<slug>[bot]` + the numeric-id noreply
# email GitHub requires for attribution) when an App token was minted —
# signalled by BOT_SLUG being set (the `app-slug` output of
# actions/create-github-app-token). Falls back to `github-actions[bot]`
# when no App is configured (e.g. forks, or BOT_APP_ID unset).
#
# Single source of truth so every commit site — CI changeset/auto-fix,
# agent-command commit-mode, and the local pre-push hooks — attributes
# commits identically. Run (not source) it before `git commit`:
#
#   env GH_TOKEN=… BOT_SLUG=… bash scripts/configure-bot-git.sh
#
# Requires GH_TOKEN in the environment for the slug→id lookup. The lookup
# is guarded: a failed/empty id degrades to a still-valid (if less precise)
# noreply email rather than producing a malformed `+<slug>[bot]@…` address.
set -euo pipefail

if [ -n "${BOT_SLUG:-}" ]; then
  BOT_USER="${BOT_SLUG}[bot]"
  BOT_ID="$(gh api "/users/${BOT_USER}" --jq .id 2>/dev/null || echo "")"
  git config user.name "$BOT_USER"
  if [ -n "$BOT_ID" ]; then
    git config user.email "${BOT_ID}+${BOT_USER}@users.noreply.github.com"
  else
    # Slug lookup failed (network blip / unknown slug). Keep the bot name
    # but use a safe email — git push still succeeds, just without the
    # numeric-id linkage.
    git config user.email "${BOT_USER}@users.noreply.github.com"
  fi
else
  git config user.name "github-actions[bot]"
  git config user.email "github-actions[bot]@users.noreply.github.com"
fi
