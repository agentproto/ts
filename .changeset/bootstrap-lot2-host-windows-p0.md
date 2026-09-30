---
"@agentproto/cli": patch
"@agentproto/driver-agent-cli": patch
---

Windows P0 fixes from the WIN11 onboarding test.

- `agentproto setup <slug>` now auto-installs the adapter package (`npm i -g`, the package manager that owns the CLI) before failing on a missing `@agentproto/adapter-<slug>`, shared with `agentproto install`'s existing bootstrap; dry-run prints what would run and npm failures keep the original clear error.
- Adapter launches (ACP + print arms) are win32-aware: npm `.cmd` shims are rewritten to their real `node …-cli.js` entry (staying `shell:false`), and any remaining `.cmd`/`.bat` bin spawns with `shell: true` — Node ≥ 18.20.2 refuses direct batch-file spawning with `spawn EINVAL` (CVE-2024-27980), which is what killed device-sandbox spawns onto joined Windows hosts.
- `npm` invocations in the install verb go through cmd.exe on Windows (a shell-less npm spawn is ENOENT there — libuv resolves only `.exe` and npm global bins are `.cmd` shims).
- `scripts/bootstrap/install.ps1` sets ExecutionPolicy (CurrentUser only) from Restricted to RemoteSigned, prints the exact command and its undo, and always invokes npm via `npm.cmd` so the script works even when group policy refuses the change.
