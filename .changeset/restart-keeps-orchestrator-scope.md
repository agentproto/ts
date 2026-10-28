---
"@agentproto/runtime": patch
---

Restarting an orchestrator session no longer breaks its delegation or kills its children. A new-id restart hands the orchestrator scope (same token, role, depth, tools and limits) and the old row's live children to the restarted row before the old row is closed, through the same lineage handover `agent_start.succeeds` uses. A row that died for real gets its revoked scope back when it is restarted, in place or under a new id; children reaped by that death stay dead. A real exit of the restarted row still revokes the scope and reaps its children. The `mcpServers` override announcement no longer carries the scope token.
