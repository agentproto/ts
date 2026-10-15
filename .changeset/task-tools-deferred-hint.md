---
"@agentproto/runtime": patch
---

`task_list` (and the three task_* write tools) now say how to recover when a mount lists `task_list` but not `task_create`/`task_claim`/`task_update`: a custom `deferredTools.alwaysOn` set defers them (reach them with `tool_search` `select:task_create,task_claim,task_update`), an `allowTools` scope leaves them out. Every default mount still lists all four.
