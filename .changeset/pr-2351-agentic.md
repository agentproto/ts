---
"@agentproto/runtime": patch
---

Restarting an orchestrator session now preserves its delegation surface: the `/mcp/orchestrator` scope token and its role/depth/tools/limits move to the successor row (or are reinstated for an in-place revival), and the old row's live children are re-parented to the successor through the lineage hand-over so drive rights, `message_parent`, `session_tree` and subtree kills keep working. The `mcpServers` override announcement now redacts the orchestrator scope token.
