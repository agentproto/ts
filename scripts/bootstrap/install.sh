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
  # compare "20.9" >= "20.9" numerically, field by field
  local have="$1"
  [ "$(printf '%s\n%s\n' "${have%%.*}" "$MIN_NODE" | head -1)" -gt "${MIN_NODE%%.*}" ] && return 0
  [ "$(printf '%s\n%s\n' "${have%%.*}" "$MIN_NODE" | head -1)" -lt "${MIN_NODE%%.*}" ] && return 1
  [ "${have#*.}" -ge "${MIN_NODE#*.}" ] 2>/dev/null
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
info "Installing @agentproto/cli globally"
npm i -g @agentproto/cli || die "npm i -g @agentproto/cli failed." \
  "Run it by hand to see the full npm error: npm i -g @agentproto/cli"
command_exists agentproto || die "The agentproto binary is not on PATH after install." \
  "Open a new terminal, or check your npm global bin dir (npm bin -g), then re-run this script."
agentproto --version || die "agentproto --version failed after install." \
  "Reinstall by hand: npm i -g @agentproto/cli"

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
  if agentproto doctor --only daemon >/dev/null 2>&1 && agentproto doctor --only daemon 2>/dev/null | grep -qiE 'ok|pass'; then
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
