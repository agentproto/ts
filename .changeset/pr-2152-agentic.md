---
"@agentproto/runtime": minor
---

Add a generic lineage-handover mechanism: a successor session takes over a replaced session's position in the spawn tree by re-parenting its live children. New exported helpers (`handoverLineage`, `checkSuccessorDeclaration`, `checkAdoptAuthority`), `succeeds`/`succeededBy` descriptor fields, the `agent_start.succeeds` option, and the `session_adopt` MCP verb.
