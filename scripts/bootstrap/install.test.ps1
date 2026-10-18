# Tests for install.ps1 on a real Windows PowerShell 5.1 (CI: windows-latest).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap/install.test.ps1
#
# install.ps1 is run the way users run it (`irm ... | iex`, i.e. read as text
# and piped to Invoke-Expression, which works under any policy) in a child
# PowerShell with a Process-scope ExecutionPolicy of Restricted. npm.cmd and
# agentproto.cmd are fakes in a sandbox dir at the front of PATH; the fake
# agentproto.ps1 / npm.ps1 beside them drop a marker file if they ever run -
# under Restricted PowerShell refuses them, so the installer must only reach
# the .cmd shims. No network, no real npm install.

$ErrorActionPreference = "Continue"
$Installer = Join-Path $PSScriptRoot "install.ps1"
$Sandbox = Join-Path ([IO.Path]::GetTempPath()) ("agentproto-install-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Sandbox | Out-Null
$Log = Join-Path $Sandbox "calls.log"
$Marker = Join-Path $Sandbox "ps1-shim-ran"
$env:FAKE_LOG = $Log
$env:FAKE_MARKER = $Marker
$env:PATH = "$Sandbox;$env:PATH"

# `>>"%FAKE_LOG%" echo ...` keeps the redirection before the text so a trailing
# digit in the args can never be parsed as a file-descriptor redirect.
Set-Content -Path (Join-Path $Sandbox "npm.cmd") -Encoding ASCII -Value @'
@echo off
>>"%FAKE_LOG%" echo npm %*
exit /b 0
'@
Set-Content -Path (Join-Path $Sandbox "agentproto.cmd") -Encoding ASCII -Value @'
@echo off
>>"%FAKE_LOG%" echo agentproto %*
if "%1"=="--version" echo 0.0.0-fake
if "%1"=="doctor" echo ok
exit /b 0
'@
foreach ($name in "npm", "agentproto") {
  Set-Content -Path (Join-Path $Sandbox "$name.ps1") -Encoding ASCII -Value 'Set-Content -Path $env:FAKE_MARKER -Value ran'
}

function Run-Installer($policy) {
  Remove-Item $Log, $Marker -ErrorAction SilentlyContinue
  $cmd = "Get-Content -Raw -LiteralPath '$Installer' | Invoke-Expression"
  $out = & powershell.exe -NoProfile -ExecutionPolicy $policy -Command $cmd 2>&1 | Out-String
  return @{ Out = $out; Code = $LASTEXITCODE }
}

$script:n = 0
$script:failed = 0
function Check($ok, $name, $detail) {
  $script:n++
  if ($ok) { Write-Host "ok $($script:n) - $name" }
  else {
    $script:failed++
    Write-Host "not ok $($script:n) - $name"
    if ($detail) { Write-Host ($detail -replace "(?m)^", "    # ") }
  }
}

try {
  $r = Run-Installer "Restricted"
  $calls = if (Test-Path $Log) { Get-Content $Log -Raw } else { "" }
  Check ($r.Code -eq 0) "Restricted: installer exits 0" $r.Out
  Check ($calls -match "(?m)^npm i -g --allow-scripts=node-pty @agentproto/cli") "Restricted: npm install allow-lists node-pty" $calls
  Check ($calls -match "(?m)^agentproto --version") "Restricted: agentproto invoked via agentproto.cmd" $calls
  Check (-not (Test-Path $Marker)) "Restricted: no .ps1 shim was executed" $r.Out
  Check ($r.Out -match "ExecutionPolicy is Restricted") "Restricted: warns about the effective policy" $r.Out
  Check ($r.Out -match "agentproto\.cmd onboard") "Restricted: next step uses agentproto.cmd" $r.Out
  Check ($r.Out -match "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned") "Restricted: suggests the RemoteSigned fix" $r.Out

  $r = Run-Installer "Bypass"
  Check ($r.Code -eq 0) "Bypass: installer exits 0" $r.Out
  Check ($r.Out -notmatch "ExecutionPolicy is") "Bypass: no policy warning" $r.Out
  Check ($r.Out -match "agentproto onboard" -and $r.Out -notmatch "agentproto\.cmd onboard") "Bypass: next step is plain agentproto onboard" $r.Out
}
finally {
  Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
}

Write-Host "1..$($script:n)"
if ($script:failed -gt 0) { exit 1 }
exit 0
