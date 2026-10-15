---
"@agentproto/runtime": patch
---

`task_list`'s description now names the write verbs and how to reach them when a mount lists `task_list` but not `task_create`/`task_claim`/`task_update` (a custom `deferredTools.alwaysOn` set defers them: `tool_search` `select:task_create,task_claim,task_update`). Every default mount still lists all four.
