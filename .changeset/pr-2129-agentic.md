---
"@agentproto/sandbox": patch
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
---

Run `sandbox_exec` against an existing computer box without consuming a session slot or disturbing the in-box daemon: adds an optional `SandboxProvider.connectForExec` exec-only attach path and has `sandbox_exec` prefer it, falling back to `connect()` for providers that don't implement it. Note: the PR already carries an equivalent changeset (`.changeset/sandbox-exec-no-session-slot.md`); this file is only a reviewer handoff and may be dropped if the existing one is kept.
