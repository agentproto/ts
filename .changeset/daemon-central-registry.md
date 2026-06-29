---
"@agentproto/runtime": patch
"@agentproto/cli": minor
---

daemon discovery: publish a central, workspace-independent registry so the CLI finds a daemon launched from any cwd

`agentproto serve` wrote its `runtime.json` (with the bearer token) under
`<workspace>/.agentproto/`, where the workspace defaults to the launch cwd. But
`discoverDaemon()` only walks **registered** workspaces (`workspaces.json`) — so a
daemon started from an arbitrary directory (a repo checkout, or tunnel mode) was
invisible to `agentproto chat` / `sessions`, which reported "no daemon found"
despite a live, token-bearing daemon.

serve now also mirrors the snapshot to a central registry at
`~/.agentproto/daemons/<port>.json` (mode 0600), and discovery consults it first
(newest-first, dead-PID entries skipped + swept at boot, removed on graceful
shutdown). Keyed by port so multiple daemons coexist. The per-workspace
`runtime.json` is unchanged.
