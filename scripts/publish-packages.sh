#!/usr/bin/env bash
# Publish @agentproto/* packages to npm with 2FA OTP.
#
# Usage:
#   scripts/publish-packages.sh                 # prompts for OTP
#   scripts/publish-packages.sh 123456          # OTP as arg
#   scripts/publish-packages.sh --dry-run       # don't actually publish
#
# Order matters: runtime-profile-standard before cli (cli depends on it
# as a runtime dep, so pnpm needs the version on the registry to
# resolve workspace:* at pack time).
#
# Each publish gets its own --otp prompt because a single TOTP code
# is valid for ~30s and the second publish often misses the window
# when the first one takes more than that.

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=""
OTP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's|^# \?||'
      exit 0
      ;;
    *) OTP="$arg" ;;
  esac
done

# Packages to publish, in dependency order. Each line:
#   <pnpm-filter-name>   <human label>
PACKAGES=(
  "@agentproto/runtime-profile-standard|runtime-profile-standard"
  "@agentproto/cli|cli"
)

prompt_otp() {
  local label="$1"
  if [ -n "$OTP" ]; then
    # Use the previously-supplied OTP; clear so the next publish
    # re-prompts (TOTP codes expire fast).
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

  # Show what would publish — useful for the user before they enter OTP.
  pnpm --filter "$filter" publish --access public --no-git-checks --dry-run 2>&1 \
    | grep -E "^npm notice (name|version|filename|package size|total files):" \
    || true

  if [ -n "$DRY_RUN" ]; then
    echo "(dry-run) skipping actual publish"
    return 0
  fi

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
