#!/usr/bin/env bash
# agentproto one-line bootstrap: takes a machine from zero to a working agentproto.
#
#   curl -fsSL https://raw.githubusercontent.com/agentproto/ts/main/scripts/bootstrap/install.sh | bash
#
# Safe to run twice: every step is idempotent and an existing valid Node is
# never reinstalled or downgraded. Every failure prints why + the manual
# command to run, never a bare exit.
set -euo pipefail

MIN_NODE="20.9.0"
LTS_LINE="22" # Node 22 LTS
# Minimum kept at major.minor granularity — `node_major_minor` returns e.g.
# "20.9", so the constant must be normalized or `sort -V` ranks "20.9.0"
# above it and the exact minimum looks below the floor.
MIN_MM="20.9"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '==> %s\n' "$1"; }
warn() { printf '!!  %s\n' "$1"; }
die() {
  warn "$1"
  printf '\nFix it by hand, then re-run this script:\n  %s\n' "$2" >&2
  exit 1
}
command_exists() { command -v "$1" >/dev/null 2>&1; }

# --- 1. OS + arch -------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) OS_ID="macos" ;;
  Linux) OS_ID="linux" ;;
  *)
    die "Unsupported OS: $OS (this script handles macOS and linux)." \
      "On Windows, use install.ps1: irm https://raw.githubusercontent.com/agentproto/ts/main/scripts/bootstrap/install.ps1 | iex"
    ;;
esac
case "$ARCH" in
  x86_64 | arm64 | aarch64) ;;
  *) die "Unsupported architecture: $ARCH." "agentproto runs on x64 and arm64 mac/linux machines." ;;
esac
bold "agentproto bootstrap — $OS_ID / $ARCH"

# --- 2. Node ------------------------------------------------------------------
node_major_minor() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1,2; }

node_version_ok() {
  command_exists node || return 1
  # version compare on major.minor strings: have >= floor iff floor sorts
  # first (or equal). Do NOT compare the minor field with `[ ... -ge ... ]`:
  # the minimum carried a patch field (".0"), which bash rejects
  # ("integer expression expected"), so any Node 20.10.x … 20.99.x — and the
  # exact minimum 20.9.0 — was read as "too old" and reinstalled (#2057).
  local have="$1"
  local lower
  lower="$(printf '%s\n' "$have" "$MIN_MM" | sort -V | head -1)"
  [ "$lower" = "$MIN_MM" ]
}

install_lts_node() {
  if [ "$OS_ID" = "macos" ]; then
    if command_exists brew; then
      info "Installing Node $LTS_LINE via Homebrew"
      brew install "node@$LTS_LINE" || die "Homebrew failed to install node@$LTS_LINE." \
        "Run: brew install node@$LTS_LINE — or download Node 22 LTS from https://nodejs.org/"
      brew link --overwrite "node@$LTS_LINE" 2>/dev/null || true
    else
      die "Node >= $MIN_NODE is required but not installed, and Homebrew is not present." \
        "Install Homebrew (https://brew.sh) then run: brew install node@$LTS_LINE — or download Node 22 LTS from https://nodejs.org/"
    fi
  else
    if command_exists apt-get; then
      info "Installing Node $LTS_LINE via NodeSource (apt)"
      curl -fsSL "https://deb.nodesource.com/setup_${LTS_LINE}.x" | sudo -E bash - \
        || die "NodeSource setup failed." "Run: curl -fsSL https://deb.nodesource.com/setup_${LTS_LINE}.x | sudo -E bash - && sudo apt-get install -y nodejs"
      sudo apt-get install -y nodejs || die "apt failed to install nodejs." "Run: sudo apt-get install -y nodejs"
    elif command_exists dnf; then
      info "Installing Node $LTS_LINE via NodeSource (dnf)"
      curl -fsSL "https://rpm.nodesource.com/setup_${LTS_LINE}.x" | sudo bash - \
        || die "NodeSource setup failed." "Run: curl -fsSL https://rpm.nodesource.com/setup_${LTS_LINE}.x | sudo bash - && sudo dnf install -y nodejs"
      sudo dnf install -y nodejs || die "dnf failed to install nodejs." "Run: sudo dnf install -y nodejs"
    else
      die "Node >= $MIN_NODE is required but not installed, and no supported package manager (apt/dnf) was found." \
        "Install Node 22 LTS from https://nodejs.org/ (tarball or package), then re-run this script."
    fi
  fi
  command_exists node || die "Node.js install did not put node on PATH." \
    "Open a new terminal (PATH refresh) or install Node 22 LTS from https://nodejs.org/, then re-run this script."
}

HAVE_MM="$(node_major_minor || true)"
if [ -n "$HAVE_MM" ] && node_version_ok "$HAVE_MM"; then
  info "Node $(node -v) already installed — keeping it (nothing to do)"
elif command_exists node; then
  info "Node $(node -v) is too old (need >= $MIN_NODE) — installing Node $LTS_LINE LTS"
  install_lts_node
else
  info "Node not found — installing Node $LTS_LINE LTS"
  install_lts_node
fi

{
  command_exists node
} || die "Node.js was not installed." "Install Node 22 LTS from https://nodejs.org/, then re-run this script."
info "Node $(node -v) ready"


# --- 3. CLI -------------------------------------------------------------------
# A system Node (apt/NodeSource/dnf — what this script itself installs on
# Linux) leaves a root-owned npm global prefix, so a plain `npm i -g` dies
# with EACCES (#2056). When `npm prefix -g` is not writable by the current
# user — and is not already under $HOME (nvm, Homebrew, user prefixes) —
# install into a user-owned prefix for THIS install only: `--prefix` on the
# command line, never a rewrite of the user's npmrc, and never sudo for the
# CLI itself. Same fix docs/cli/guides/no-admin-install.md documents by hand.
npm_prefix_g="$(npm prefix -g 2>/dev/null || true)"
user_prefix=""
reinstall_cmd="npm i -g @agentproto/cli"
if [ -n "$npm_prefix_g" ]; then
  case "$npm_prefix_g" in
    "$HOME" | "$HOME"/*) : ;; # already user-owned — today's behaviour
    *)
      if [ ! -w "$npm_prefix_g" ]; then
        user_prefix="$HOME/.local"
        reinstall_cmd='npm i -g --prefix "$HOME/.local" @agentproto/cli'
        info "npm global prefix $npm_prefix_g is not writable — installing @agentproto/cli into $user_prefix for this install only (no sudo, npmrc untouched)"
        PATH="$user_prefix/bin:$PATH"
        export PATH
      fi
      ;;
  esac
fi

if [ -n "$user_prefix" ]; then
  npm i -g --prefix "$user_prefix" @agentproto/cli || die \
    "npm i -g --prefix $user_prefix @agentproto/cli failed." \
    "Run it by hand to see the full npm error: npm i -g --prefix \"\$HOME/.local\" @agentproto/cli"
else
  npm i -g @agentproto/cli || die \
    "npm i -g @agentproto/cli failed (npm global prefix: ${npm_prefix_g:-unknown})." \
    "npm i -g --prefix \"\$HOME/.local\" @agentproto/cli   # user-owned prefix, no sudo needed"
fi
command_exists agentproto || die "The agentproto binary is not on PATH after install." \
  "Open a new terminal, or check your npm global bin dir (npm prefix -g), then re-run this script."
agentproto --version || die "agentproto --version failed after install." \
  "Reinstall by hand: $reinstall_cmd"
if [ -n "$user_prefix" ]; then
  printf 'Add this line to your shell profile (~/.bashrc, ~/.zshrc, ...) so agentproto stays on PATH:\n  export PATH="$HOME/.local/bin:$PATH"\n'
fi

# --- 4. pnpm native builds ----------------------------------------------------
info "Note: if you later develop in the agentproto monorepo itself, the first pnpm install asks to approve native builds (node-pty). Approve when prompted — this only affects repo development, not the CLI you just installed."

# --- 5. Adapters --------------------------------------------------------------
info "Available agent harnesses/adapters — none are auto-installed; pick your own:"
if agentproto adapters list >/tmp/ap-adapters.txt 2>&1; then
  sed 's/^/    /' /tmp/ap-adapters.txt
else
  printf '    (could not list adapters — see: agentproto adapters list)\n'
fi
printf '    Example: %s\n' "agentproto install opencode   # installs the agentproto adapter for opencode"
printf '    The opencode CLI itself is separate: %s\n' "npm i -g opencode-ai"
printf '    Install adapters later from the SAME shell that launched the daemon (the daemon PATH is captured at launch).\n'

# --- 6. Daemon ----------------------------------------------------------------
ensure_daemon() {
  # The doctor human summary always prints "N ok · N warn …" — a bare grep
  # for 'ok|pass' matched that line even with the daemon down, so a fresh
  # machine was told "Daemon already healthy" with nothing running. Look at
  # the machine-readable output instead: healthy iff exit 0 AND some daemon
  # check has status "ok" (a warn-only step reports no ok status; warn/broken
  # detail text can never inject one).
  # Healthy iff `--json` exits 0 AND some daemon check reports
  # `"status": "ok"`. Do NOT grep the human output for 'ok|pass': the doctor
  # summary always prints "N ok · N warn …", which matches even when NO
  # check is ok — so a warn-only daemon step (or any status drift in
  # doctor's check text) printed "Daemon already healthy" with nothing
  # running. The machine-readable status is the contract.
  if agentproto doctor --only daemon --json >/dev/null 2>&1 &&
    agentproto doctor --only daemon --json 2>/dev/null | grep -q '"status": "ok"'; then
    info "Daemon already healthy"
    return 0
  fi
  if [ "$OS_ID" = "macos" ]; then
    info "Installing + starting the daemon as a launchd service"
    agentproto daemon install || die "agentproto daemon install failed." "Run it by hand: agentproto daemon install && agentproto daemon start"
    agentproto daemon start || die "agentproto daemon start failed." "Run: agentproto daemon start — or start the daemon in a terminal: agentproto serve"
    :
  else
    info "Starting the daemon detached (nohup, logs to ~/.agentproto/serve.log)"
    mkdir -p "$HOME/.agentproto"
    nohup agentproto serve >>"$HOME/.agentproto/serve.log" 2>&1 &
    disown || true
    sleep 2
  fi
}
ensure_daemon

# --- 7. Doctor ----------------------------------------------------------------
bold "Doctor summary"
agentproto doctor || true

# --- 8. Next step -------------------------------------------------------------
bold ""
bold "Done. Next step:"
bold "  agentproto onboard"
