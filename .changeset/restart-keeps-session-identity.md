---
"@agentproto/runtime": patch
---

Fix `POST /sessions/:id/restart`, the `session_restart` MCP verb, the
sentinel/inbound restart hooks, and the cron scheduler's `prompt-session`
auto-resume minting a new session id without carrying forward the prior
session's `keepAlive` / `notifyParentOnCrash` / `sentinelAutoWatch` /
`restartPolicy` flags, without re-stamping the daemon's self-mount
`mcpServers` entry with the NEW session's id (so spawns/commands the
restarted session made kept attributing to the dead OLD session), and
without closing the OLD row when it was still alive — leaving two live
processes on the same conversation. The OLD row is now closed with a
deliberate `"restarted"` end reason after a successful restart (never
treated as a crash), except for a sandbox restart, where closing it would
tear down the box the new session just reconnected to. Every production
restart path now threads the daemon's own `/mcp` URL through so the
`mcpServers` re-stamp can actually happen; a path that still doesn't wire it
falls back to carrying `mcpServers` through untouched (keeping the prior
identity) rather than stripping it to no identity at all.
