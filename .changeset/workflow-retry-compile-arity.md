---
"@agentproto/runtime": patch
---

Fix the `@agentproto/runtime` build on main: `run.retry` now passes the WORKFLOW.md path to `compileWorkflow`, whose signature gained that second argument in a concurrently merged change.
