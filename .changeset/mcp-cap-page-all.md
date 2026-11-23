---
"@agentproto/app-client": minor
"@agentproto/apps": patch
"@agentproto/runtime": patch
---

List readers that called a daemon list tool unpaged now read every row through one shared helper, `pageAll` (`@agentproto/app-client`, also the `./page-all` subpath): it walks `nextCursor`, halves a page that hits the MCP result cap, and throws instead of resolving an empty list. Used by the config app (Models catalog, wallet model curation, imported MCP tools), the Store, the work board, the ops panel and session viewer (`session_list` pages), the mail-triage run history, the panel bridge's `callToolPaged`, and the runner selector (`adapter_list`, `harness_preset_list`). The session steward reads installed app ids with a bounded, projected `app_list`. `task_list` pages now carry `boardId` like the unpaged body.
