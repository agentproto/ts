#!/usr/bin/env bash
# Publish @agentproto/* packages to npm.
#
# Two auth modes, picked automatically:
#
#   1. NPM_TOKEN in env → granular access token with "Bypass 2FA"
#      enabled. The script sets it and pnpm publish runs unattended.
#      Add it to agentik-studio/envs/.env.local (script auto-sources)
#      or export it manually. Generate at:
#      https://www.npmjs.com/settings/agentiknet/tokens
#
#   2. No NPM_TOKEN → falls back to interactive TOTP prompts (one
#      fresh OTP per package, since codes are valid ~30s).
#
# Order matters: runtime-profile-standard before cli (cli depends on
# it as a runtime dep, so pnpm needs the version on the registry to
# resolve workspace:* at pack time).
#
# Usage:
#   scripts/publish-packages.sh                 # auto: token if set, otherwise OTP
#   scripts/publish-packages.sh 123456          # force OTP mode with this code
#   scripts/publish-packages.sh --dry-run       # don't actually publish

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=""
OTP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --help|-h)
      sed -n '2,22p' "$0" | sed 's|^# \?||'
      exit 0
      ;;
    *) OTP="$arg" ;;
  esac
done

# Pull NPM_TOKEN from the agentik-studio monorepo env files if not
# already in env. Targeted grep instead of `source` — some env files
# have multi-line values bash can't parse, and we only care about
# this one var anyway.
ENV_BASE="../../../envs"
if [ -z "${NPM_TOKEN:-}" ]; then
  for envfile in "$ENV_BASE/.env.local" "$ENV_BASE/.env"; do
    [ -f "$envfile" ] || continue
    # `|| true` because grep exits 1 when the line isn't found, which
    # would trip pipefail; we want absence to be a normal case.
    VAL=$( (grep -m1 "^NPM_TOKEN=" "$envfile" 2>/dev/null || true) \
      | sed -e 's/^NPM_TOKEN=//' -e 's/^["'\'']//' -e 's/["'\'']$//')
    if [ -n "$VAL" ]; then
      export NPM_TOKEN="$VAL"
      break
    fi
  done
fi

# Packages to publish, in dependency order.
PACKAGES=(
  "@agentproto/runtime-profile-standard|runtime-profile-standard"
  "@agentproto/cli|cli"
)

prompt_otp() {
  local label="$1"
  if [ -n "$OTP" ]; then
    local code="$OTP"
    OTP=""
    echo "$code"
    return
  fi
  read -r -p "npm OTP for ${label} (6 digits): " code </dev/tty
  echo "$code"
}

publish_one() {
  local filter="$1"
  local label="$2"

  echo
  echo "━━━ ${label} ━━━"

  pnpm --filter "$filter" publish --access public --no-git-checks --dry-run 2>&1 \
    | grep -E "^npm notice (name|version|filename|package size|total files):" \
    || true

  if [ -n "$DRY_RUN" ]; then
    echo "(dry-run) skipping actual publish"
    return 0
  fi

  # Token mode — no OTP needed (token has bypass 2FA).
  if [ -n "${NPM_TOKEN:-}" ]; then
    if pnpm --filter "$filter" publish \
        --access public --no-git-checks; then
      echo "✓ ${label} published (via NPM_TOKEN)"
      return 0
    fi
    echo "✗ ${label} publish failed despite NPM_TOKEN — check token scope + expiry."
    return 1
  fi

  # OTP fallback — three attempts, fresh code each time.
  local attempt=0
  while [ $attempt -lt 3 ]; do
    attempt=$((attempt + 1))
    local code
    code=$(prompt_otp "$label")
    if [ -z "$code" ]; then
      echo "Empty OTP — aborting."
      return 1
    fi

    if pnpm --filter "$filter" publish \
        --access public --no-git-checks --otp="$code"; then
      echo "✓ ${label} published"
      return 0
    fi

    echo "Publish failed (often: OTP expired or wrong). Attempt ${attempt}/3."
  done

  echo "✗ Gave up on ${label} after 3 attempts."
  return 1
}

echo "Publishing as $(npm whoami 2>/dev/null || echo "(not logged in)")"
echo "Workspace: $(pwd)"
if [ -n "${NPM_TOKEN:-}" ]; then
  echo "Auth: NPM_TOKEN (token mode)"
else
  echo "Auth: interactive OTP"
fi

for entry in "${PACKAGES[@]}"; do
  filter="${entry%%|*}"
  label="${entry##*|}"
  publish_one "$filter" "$label"
done

echo
echo "━━━ done ━━━"
echo "Verify on npm:"
for entry in "${PACKAGES[@]}"; do
  filter="${entry%%|*}"
  echo "  https://www.npmjs.com/package/${filter}"
done
