# agentproto one-line bootstrap for Windows 10/11 (PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/agentproto/ts/main/scripts/bootstrap/install.ps1 | iex
#
# Safe to run twice: every step is idempotent and an existing valid Node is
# never reinstalled or downgraded. Every failure prints why + the manual
# command to run, never a bare exit.

$ErrorActionPreference = "Stop"

$MinNodeMajor = 20
$MinNodeMinor = 9
$LtsMajor = 22

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Die($why, $fix) {
  Warn $why
  Write-Host ""
  Write-Host "Fix it by hand, then re-run this script:" -ForegroundColor Yellow
  Write-Host "  $fix" -ForegroundColor Yellow
  exit 1
}

# --- 1. Windows 10/11 check ---------------------------------------------------
$caption = (Get-CimInstance Win32_OperatingSystem).Caption
if ($caption -notmatch "Windows 1[01]") {
  Die "Unsupported OS: $caption (this script targets Windows 10/11)." "Install Node 22 LTS from https://nodejs.org/ and then: npm i -g @agentproto/cli"
}
Info "Windows detected: $caption"

# --- 2. Node ------------------------------------------------------------------
function NodeVersion {
  try { return (node -v 2>$null) } catch { return $null }
}

function NodeVersionOk {
  $v = NodeVersion
  if (-not $v) { return $false }
  $v = $v.TrimStart("v")
  $parts = $v.Split(".")
  if ([int]$parts[0] -gt $MinNodeMajor) { return $true }
  if ([int]$parts[0] -lt $MinNodeMajor) { return $false }
  return [int]$parts[1] -ge $MinNodeMinor
}

function InstallLtsNode {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Info "Installing Node $LtsMajor LTS via winget"
    winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) {
      Die "winget failed to install OpenJS.NodeJS.LTS (exit $LASTEXITCODE)." "Download Node 22 LTS from https://nodejs.org/, install it, open a NEW PowerShell window, then re-run this script."
    }
  }
  else {
    Die "Node >= $MinNodeMajor.$MinNodeMinor is required but not installed, and winget is not available." "Download Node 22 LTS from https://nodejs.org/, install it, open a NEW PowerShell window, then re-run this script."
  }
  # winget installs machine-wide; the current session's PATH may not have it yet
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node.js install did not put node on PATH." "Open a NEW PowerShell window (PATH refresh), then re-run this script."
  }
}


if (NodeVersionOk) {
  Info "Node $(NodeVersion) already installed - keeping it (nothing to do)"
}
elseif (NodeVersion) {
  Info "Node $(NodeVersion) is too old (need >= $MinNodeMajor.$MinNodeMinor) - installing Node $LtsMajor LTS"
  InstallLtsNode
}
else {
  Info "Node not found - installing Node $LtsMajor LTS"
  InstallLtsNode
}

Info "Node $(NodeVersion) ready"

# --- 3. CLI -------------------------------------------------------------------
Info "Installing @agentproto/cli globally"
npm i -g @agentproto/cli
if ($LASTEXITCODE -ne 0) {
  Die "npm i -g @agentproto/cli failed (exit $LASTEXITCODE)." "Run it by hand to see the full npm error: npm i -g @agentproto/cli"
}
if (-not (Get-Command agentproto -ErrorAction SilentlyContinue)) {
  Die "The agentproto binary is not on PATH after install." "Open a NEW PowerShell window, or check your npm global bin dir (npm config get prefix), then re-run this script."
}
agentproto --version
if ($LASTEXITCODE -ne 0) {
  Die "agentproto --version failed after install." "Reinstall by hand: npm i -g @agentproto/cli"
}

# --- 4. pnpm native builds ----------------------------------------------------
Info "Note: if you later develop in the agentproto monorepo itself, the first pnpm install asks to approve native builds (node-pty). Approve when prompted - this only affects repo development, not the CLI you just installed."

# --- 5. Adapters --------------------------------------------------------------
Info "Available agent harnesses/adapters - none are auto-installed; pick your own:"
try {
  $null = (agentproto adapters list 2>&1 | Out-String)
  agentproto adapters list
}
catch {
  Write-Host "    (could not list adapters - see: agentproto adapters list)"
}
Write-Host "    Example: agentproto install opencode   # installs the agentproto adapter for opencode"
Write-Host "    The opencode CLI itself is separate: npm i -g opencode-ai"
Write-Host "    Install adapters from THIS SAME PowerShell window the daemon is about to inherit (the daemon PATH is captured at launch)."

# --- 6. Daemon ----------------------------------------------------------------
# No service support on Windows yet: the daemon must run in a window that stays open.
try {
  $doctor = @(agentproto doctor --only daemon 2>&1) -join "`n"
}
catch {
  $doctor = ""
}
$daemonOk = ($LASTEXITCODE -eq 0) -and ($doctor -match "(?i)\bok\b")
if ($daemonOk) {
  Info "Daemon already healthy"
}
else {
  Info "Starting the daemon in a new minimized PowerShell window"
  Info "(no Windows service support yet - that window must stay open; closing it stops the daemon)"
  Start-Process powershell -ArgumentList '-NoExit', '-Command', 'agentproto serve' -WindowStyle Minimized
  Start-Sleep -Seconds 3
}

# --- 7. Doctor ----------------------------------------------------------------
Write-Host ""
Write-Host "Doctor summary" -ForegroundColor White
& {
  $ErrorActionPreference = "Continue"
  agentproto doctor
}

# --- 8. Next step -------------------------------------------------------------
Write-Host ""
Write-Host "Done. Next step:" -ForegroundColor White
Write-Host "  agentproto onboard" -ForegroundColor White
