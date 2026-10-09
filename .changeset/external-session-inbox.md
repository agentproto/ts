---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Let Claude Desktop / `claude` CLI sessions the daemon did not spawn own an AIP-46 inbox. An authenticated `/mcp` request whose `callerSessionId` is unknown and which carries `?host=<label>` now registers an `external` session (no process; alive for `daemon.externalSessionLivenessMs`, default 30 min, after its last MCP request or inbox poll), so `sentinel_watch`, `session_follow` and workflow notifications can deliver to it. `workflow_start` / `workflow_run_file` record the calling session and post one inbox item on run succeeded, run failed and approval/input suspension. New `agentproto hook inbox` Claude Code hook injects unread inbox items as untrusted `additionalContext` and acks them.
