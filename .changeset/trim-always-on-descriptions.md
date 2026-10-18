---
"@agentproto/runtime": patch
---

fix(runtime): trim always-on tool descriptions under the schema budget

The deferred always-on `tools/list` payload had drifted to the 63 000-byte
budget line (`agent_start` alone ≈ 28.2 KB), leaving almost no headroom and
flaking across environments. Shortened `agent_start`'s field descriptions
(inference, cloud, auth, sandbox, commandSandbox, worktree, wait, sentinel,
…) plus `agent_prompt` and `session_list`, keeping the field semantics intact
— the long-form detail now lives in `tool_help` topics, with new
`## inference`, `## daemonMount`, `## deviceBridge` and `## resumeSessionId`
sections in `docs/mcp-tools/agent_start.md`. Always-on set: 62 992 → 61 490
bytes measured.
