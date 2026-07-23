---
"@agentproto/runtime": minor
---

Unified tool-call logging for both proxy (command_execute) and in-agent (Bash, Read, Edit) paths via normalized ToolCallRecord interface. Adds tool_calls_list MCP tool to query records across sessions, joined with session-level provenance (harness, origin, callerSessionId) at read time.
