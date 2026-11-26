---
"@agentproto/runtime": minor
---

Offer the MCP `io.modelcontextprotocol/tasks` extension on the modern `/mcp` gateway: a session turn started by `agent_start` (first prompt) or `agent_prompt` is projected as a task for clients that declare the extension, with `tasks/get`, `tasks/update` and `tasks/cancel`. The task id is a random 128-bit handle resolved through a small on-disk ledger (`~/.agentproto/mcp-tasks`), the session stays the real handle and keeps running after the turn, and the work board is untouched. A parked permission or question turns the task `input_required` through the existing elicitation gate, and `tasks/update` goes through the same resolvers. Turn mapping: completed, cancelled (interrupted turn), failed (abnormal session end or daemon restart). Disable with `mcp.tasks: false` (the extension is then no longer announced and the tools answer as before).
