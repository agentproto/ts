---
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-claude-code": patch
---

Fix claude-code's `plan` (and `accept-edits`/`bypass-permissions`) modes,
which were silently non-functional — the ACP wrapper never reads
`--permission-mode` from argv. `createAgentCliRuntime.start()` now points a
per-session `CLAUDE_CONFIG_DIR` at a throwaway settings.json carrying the
resolved `permissions.defaultMode` instead, which the wrapper's
`resolveSettings` merge actually honors. Empirically verified live: a
`mode:"plan"` session now refuses to write files until the user approves
exiting plan mode. Known limitation, also empirically confirmed: a target
repo that commits its own escalated `.claude/settings.json`
`permissions.defaultMode` defeats the requested mode (falls back to
"default", not a silent bypass).
