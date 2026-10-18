---
"@agentproto/runtime": patch
---

fix(runtime): trim always-on tool descriptions under the schema budget

Shortened the always-on `tools/list` field descriptions for `agent_start`,
`agent_prompt`, and `session_list` that had drifted to the 63 000-byte
budget line, moving the long-form detail into `tool_help` topics (including
new `## inference`, `## daemonMount`, `## deviceBridge`, and
`## resumeSessionId` sections in `docs/mcp-tools/agent_start.md`).
Descriptions and docs only — no runtime behavior change.
