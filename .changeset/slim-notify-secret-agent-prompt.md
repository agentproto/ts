---
"@agentproto/runtime": patch
---

Bring the always-on MCP `tools/list` back under its 60 KB budget: `agent_start`'s `notifySecret` field is now a one-line description pointing at `tool_help {name:"agent_start", topic:"notifySecret"}` (full text moved to the help doc), and `agent_prompt`'s description is tightened without changing its contract.
