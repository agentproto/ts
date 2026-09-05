---
"@agentproto/runtime": minor
---
Additive `limit`/`cursor` pagination (via `paginate` + `toolText`) to the orchestration list tools — `permissions_list`, `policy_list`, `workflow_list`, `activities_list`, `cron_list`, `routine_list`, `inbound_endpoint_list`, `inbound_watcher_list` — applied last, after all scoping and filters. Output is byte-identical to before when neither param is supplied.
