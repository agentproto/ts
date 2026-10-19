#!/usr/bin/env bash
# Tests for scripts/bootstrap/install.sh's npm-global-prefix handling (#2056).
#
# Runs install.sh end to end in a sandbox HOME against fake npm/node/agentproto
# shims on PATH — no real npm, no network, no sudo, nothing outside the
# sandbox. Covers the three prefix cases the installer must distinguish:
#   1. root-owned / unwritable prefix outside $HOME → --prefix "$HOME/.local"
#   2. writable prefix (nvm, Homebrew, user prefix) → plain `npm i -g`
#   3. prefix already under $HOME                   → plain `npm i -g`
# plus the die() message on a failed plain install (names the prefix and the
# user-prefix command). Run: bash scripts/bootstrap/install.test.sh
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "SKIP: write-permission checks are meaningless as root; run as a normal user"
  exit 0
fi

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$TEST_DIR/install.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ap-install-test.XXXXXX")"
trap 'chmod -R u+rwX "$ROOT" 2>/dev/null || true; rm -rf "$ROOT"' EXIT

FAILURES=0
ok() { printf 'ok - %s\n' "$1"; }
not_ok() {
  printf 'not ok - %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

# --- fake toolchain -----------------------------------------------------------
FAKES="$ROOT/fakes"
mkdir -p "$FAKES"

cat >"$FAKES/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >>"${NPM_LOG:?}"
if [ "${1:-}" = "prefix" ]; then
  printf '%s\n' "${FAKE_GLOBAL_PREFIX:?}"
  exit 0
fi
if [ "${1:-}" = "i" ]; then
  if [ -n "${FAKE_NPM_FAIL:-}" ]; then
    echo "fake npm: simulated EACCES" >&2
    exit 1
  fi
  prefix="${FAKE_GLOBAL_PREFIX:?}"
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--prefix" ]; then prefix="$arg"; fi
    prev="$arg"
  done
  mkdir -p "$prefix/bin"
  cat >"$prefix/bin/agentproto" <<'SH'
#!/usr/bin/env bash
printf 'agentproto %s\n' "$*" >>"${AGENTPROTO_LOG:?}"
case "${1:-}" in
  doctor)
    case " $* " in
      *" --only daemon "*) echo "daemon: ok" ;;
      *) echo "doctor: ok" ;;
    esac
    ;;
  adapters) echo "opencode" ;;
  *) echo "0.0.0-fake" ;;
esac
exit 0
SH
  chmod +x "$prefix/bin/agentproto"
fi
exit 0
EOF

cat >"$FAKES/node" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-v" ]; then
  printf 'v%s\n' "${FAKE_NODE_VERSION:-22.0.0}"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKES/npm" "$FAKES/node"

# --- scenario plumbing --------------------------------------------------------
# run_install <scenario-dir> <global-prefix> [extra PATH dir] — runs the full
# installer with HOME sandboxed and the fake toolchain first on PATH.
run_install() {
  local scen="$1" prefix="$2"
  : >"$scen/npm.log"
  : >"$scen/agentproto.log"
  set +e
  env -i \
    HOME="$scen/home" \
    PATH="$FAKES:$prefix/bin:/usr/bin:/bin" \
    FAKE_GLOBAL_PREFIX="$prefix" \
    NPM_LOG="$scen/npm.log" \
    AGENTPROTO_LOG="$scen/agentproto.log" \
    FAKE_NPM_FAIL="${FAKE_NPM_FAIL:-}" \
    FAKE_NODE_VERSION="${FAKE_NODE_VERSION:-}" \
    bash "$INSTALL" >"$scen/out.log" 2>&1
  SCEN_STATUS=$?
  set -e
}

assert_exit() {
  if [ "$SCEN_STATUS" -eq "$1" ]; then ok "$2"
  else not_ok "$2 (exit $SCEN_STATUS, expected $1)"; sed 's/^/    /' "$SCEN/out.log"; fi
}
assert_in() { # <file> <fixed-string> <desc>
  if grep -Fq -- "$2" "$1"; then ok "$3"
  else not_ok "$3 (missing: $2)"; sed 's/^/    /' "$1"; fi
}
assert_not_in() { # <file> <fixed-string> <desc>
  if grep -Fq -- "$2" "$1"; then
    not_ok "$3 (unexpected: $2)"
    sed 's/^/    /' "$1"
  else ok "$3"; fi
}

new_scenario() {
  SCEN="$ROOT/$1"
  mkdir -p "$SCEN/home"
}

# --- 1. unwritable (root-owned-style) prefix outside $HOME → user prefix ------
new_scenario "unwritable"
PREFIX_1="$ROOT/unwritable/global"
mkdir -p "$PREFIX_1"
chmod 555 "$PREFIX_1"
run_install "$SCEN" "$PREFIX_1"
assert_exit 0 "unwritable prefix: install.sh exits 0"
assert_in "$SCEN/npm.log" "npm i -g --prefix $SCEN/home/.local @agentproto/cli" \
  "unwritable prefix: npm install uses --prefix \$HOME/.local"
assert_not_in "$SCEN/npm.log" "npm i -g @agentproto/cli" \
  "unwritable prefix: no plain npm i -g"
assert_in "$SCEN/out.log" 'export PATH="$HOME/.local/bin:$PATH"' \
  "unwritable prefix: prints the exact shell-profile line"
assert_in "$SCEN/agentproto.log" "--version" \
  "unwritable prefix: agentproto found via the PATH prepend"
assert_exit 0 "unwritable prefix: full run stays green"

# --- 2. writable prefix outside $HOME → unchanged plain install ---------------
new_scenario "writable"
PREFIX_2="$ROOT/writable/global"
mkdir -p "$PREFIX_2"
run_install "$SCEN" "$PREFIX_2"
assert_exit 0 "writable prefix: install.sh exits 0"
assert_in "$SCEN/npm.log" "npm i -g @agentproto/cli" \
  "writable prefix: plain npm i -g"
assert_not_in "$SCEN/npm.log" "--prefix" \
  "writable prefix: --prefix is never passed"
assert_not_in "$SCEN/out.log" 'export PATH="$HOME/.local/bin:$PATH"' \
  "writable prefix: no shell-profile hint"
assert_in "$SCEN/agentproto.log" "--version" \
  "writable prefix: agentproto found on the existing PATH"

# --- 3. prefix already under $HOME → unchanged plain install ------------------
new_scenario "under-home"
PREFIX_3="$SCEN/home/.nvm/versions/node/v22.0.0"
mkdir -p "$PREFIX_3"
run_install "$SCEN" "$PREFIX_3"
assert_exit 0 "prefix under \$HOME: install.sh exits 0"
assert_in "$SCEN/npm.log" "npm i -g @agentproto/cli" \
  "prefix under \$HOME: plain npm i -g"
assert_not_in "$SCEN/npm.log" "--prefix" \
  "prefix under \$HOME: --prefix is never passed"
assert_not_in "$SCEN/out.log" 'export PATH="$HOME/.local/bin:$PATH"' \
  "prefix under \$HOME: no shell-profile hint"

# --- 3.1 an existing Node >= the minimum is kept, never reinstalled ------------
# #2057: `node_version_ok` compared the minor field against "${MIN_NODE#*.}"
# ("9.0" — non-integer), so bash's `[ -ge` rejected it and any Node 20.10+
# (and exactly 20.9.x) was declared too old. Red: the installer rushes into
# install_lts_node and dies "no supported package manager" in a bare sandbox.
for v in 20.10.0 20.9.0; do
  new_scenario "keep-node-$v"
  PREFIX_K="$SCEN/home/.nvm/x"
  FAKE_NODE_VERSION="$v" run_install "$SCEN" "$PREFIX_K" 2>/dev/null || true
  unset FAKE_NODE_VERSION
  assert_exit 0 "existing Node v$v satisfies >= 20.9.0 and is kept (exit 0)"
  assert_in "$SCEN/out.log" "already installed — keeping it" \
    "existing Node v$v: prints the keep message instead of installing LTS"
  assert_not_in "$SCEN/out.log" "too old" \
    "existing Node v$v: never says Node is too old"
done

# --- 4. failed plain install → die names the prefix + user-prefix command -----
new_scenario "die-message"
PREFIX_4="$ROOT/die-message/global"
mkdir -p "$PREFIX_4"
FAKE_NPM_FAIL=1 run_install "$SCEN" "$PREFIX_4"
unset FAKE_NPM_FAIL
if [ "$SCEN_STATUS" -ne 0 ]; then ok "failed plain install: install.sh exits non-zero"
else not_ok "failed plain install: expected non-zero exit"; fi
assert_in "$SCEN/out.log" "npm global prefix: $PREFIX_4" \
  "failed plain install: die message names the prefix"
assert_in "$SCEN/out.log" 'npm i -g --prefix "$HOME/.local" @agentproto/cli' \
  "failed plain install: die message gives the user-prefix command"

# --- summary ------------------------------------------------------------------
echo
if [ "$FAILURES" -gt 0 ]; then
  echo "FAILED: $FAILURES assertion(s)"
  exit 1
fi
echo "All bootstrap install.sh prefix tests passed"
