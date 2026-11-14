---
"@agentproto/runtime": patch
---

`agent_start` takes a `parent` argument: a caller without a session identity (Claude Code on a static MCP URL) declares its `cc:<session_id>` address and the child nests under it, so `message_parent` reaches that row. It is declared, not proven, and refused when the call already carries an identity. Under `mcp.noCallerIdentity: accept`, an identity-less spawn is recorded as `meta.anonymous: "claude-code"` with no extra privilege.
