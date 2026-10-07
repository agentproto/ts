---
"@agentproto/runtime": patch
---

Fix `POST /sessions/:id/restart` and the `session_restart` MCP verb minting a
new session id without carrying forward the prior session's `keepAlive` /
`notifyParentOnCrash` / `sentinelAutoWatch` / `restartPolicy` flags, without
re-stamping the daemon's self-mount `mcpServers` entry with the NEW session's
id (so spawns/commands the restarted session made kept attributing to the
dead OLD session), and without closing the OLD row when it was still alive —
leaving two live processes on the same conversation. The OLD row is now
closed with a deliberate `"restarted"` end reason after a successful restart
(never treated as a crash), except for a sandbox restart, where closing it
would tear down the box the new session just reconnected to.
