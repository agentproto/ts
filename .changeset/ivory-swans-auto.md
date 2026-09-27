---
"@agentproto/runtime": minor
---

`branch_gc` background jobs are now visible to `branch_gc_status` from any MCP connection (the job registry was per server instance, so a job started on one connection was "not found" on the next). `branch_gc_status` also reads a finished job back from its result file, and a background `branch_gc` response now carries `resultPath` plus a `followUp` block (tool, args, poll interval) telling the caller how to follow up.
