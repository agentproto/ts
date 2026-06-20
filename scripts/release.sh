#!/usr/bin/env bash
# One-shot release: changeset version → npm publish → tunnel server deploy.
#
# Usage:
#   scripts/release.sh                  # full release (npm + server)
#   scripts/release.sh --npm-only       # skip server deploy
#   scripts/release.sh --server-only    # skip npm (just redeploy server)
#   scripts/release.sh --dry-run        # print what would happen, publish nothing
#   scripts/release.sh --env test       # deploy tunnel to test instead of prod

set -euo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT="$(git -C . rev-parse --show-toplevel)"

NPM_ONLY=false
SERVER_ONLY=false
DRY_RUN=false
ENV="prod"

for arg in "$@"; do
  case "$arg" in
    --npm-only)    NPM_ONLY=true ;;
    --server-only) SERVER_ONLY=true ;;
    --dry-run)     DRY_RUN=true ;;
    --env=*)       ENV="${arg#--env=}" ;;
    --env)         shift; ENV="$1" ;;
    --help|-h)
      sed -n '2,10p' "$0" | sed 's|^# \?||'
      exit 0
      ;;
  esac
done

confirm() {
  local msg="$1"
  printf "\n%s [y/N] " "$msg"
  read -r reply </dev/tty
  [[ "$reply" =~ ^[Yy]$ ]]
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  @agentproto release"
echo "  npm-only=${NPM_ONLY}  server-only=${SERVER_ONLY}"
echo "  dry-run=${DRY_RUN}    server-env=${ENV}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Changeset version bump ─────────────────────────────────────────────────
if ! $SERVER_ONLY; then
  echo
  echo "━━ pending changesets"
  pnpm changeset status 2>&1 || true   # non-zero when nothing pending — that's fine

  if pnpm changeset status --verbose 2>&1 | grep -q "No changesets found"; then
    echo "No pending changesets — skipping version bump."
  else
    if confirm "Apply changeset version bumps?"; then
      $DRY_RUN && echo "(dry-run) skipping: pnpm changeset version" || pnpm changeset version
      echo "✓ versions bumped + CHANGELOG.md updated"
    else
      echo "Skipped version bump."
    fi
  fi

  # ── 2. npm publish ─────────────────────────────────────────────────────────
  echo
  echo "━━ npm publish"
  if confirm "Publish changed packages to npm?"; then
    if $DRY_RUN; then
      echo "(dry-run) skipping: pnpm build && changeset publish"
    else
      pnpm build
      pnpm changeset publish --no-git-tag
    fi
    echo "✓ npm publish done"
  else
    echo "Skipped npm publish."
  fi
fi

# ── 3. Server deploy ──────────────────────────────────────────────────────────
if ! $NPM_ONLY; then
  echo
  echo "━━ guilde-tunnel → ${ENV}"
  if confirm "Deploy guilde-tunnel to ${ENV}?"; then
    if $DRY_RUN; then
      echo "(dry-run) skipping: pnpm agentik deploy guilde-tunnel --env ${ENV} -y"
    else
      (cd "$REPO_ROOT" && pnpm agentik deploy guilde-tunnel --env "$ENV" -y)
    fi
    echo "✓ server deploy triggered"
  else
    echo "Skipped server deploy."
  fi
fi

echo
echo "━━━ done ━━━"
