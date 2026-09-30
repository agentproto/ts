---
"@agentproto/auth": patch
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Windows P1 onboarding fixes (recap D7/E9/B4): the auth key store grows a Windows backend (one DPAPI-protected file per slot under `~/.agentproto/keychain-dpapi/`, .NET `ProtectedData` at `CurrentUser` scope via PowerShell — zero npm deps); `agentproto setup`/doctor gains a "Connect machines" step that prints the exact pairing commands for the chosen direction (pilot vs be piloted), and `/health` now reports the daemon's start-time PATH so the doctor's agents step can diagnose "installed in your shell but not visible to the daemon" with a `agentproto daemon restart` hint; the "no host matched" device error carries a pairing-direction hint.
