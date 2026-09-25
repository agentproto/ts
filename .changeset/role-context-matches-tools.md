---
"@agentproto/runtime": minor
---

Role text now matches the delegation tools a session can actually reach. A spawn with no daemon/orchestrator mount, or whose mount strips `agent_start` (`denyTools`), gets the executor disposition and no "Roles you may spawn" line instead of a supervisor promise of a tool it doesn't have — and a depth-0 spawn with no `role` defaults to executor in that case. The supervisor text now names `agent_start`/`agent_prompt` as MCP tools on the `agentproto` server, points at `tool_search` when that mount is deferred, and gives the `agentproto sessions start`/`prompt` CLI equivalents. `agent_start`/`agent_prompt` are always-on under deferred tools even with a custom `alwaysOn` set (a deny-role mount still strips them).
