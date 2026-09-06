---
"@agentproto/runtime": minor
---

Migrate the second half of `orchestration-tools.ts`'s `pageParamsShape` list tools onto the `ToolTransformer` mechanism (`inbound_watcher_list`, `inbound_endpoint_list`, `cron_list`, `routine_list`): `defineTool` + `implementTool` + `toMcpTool` with the shared `paginated()` transformer (real per-tool compact projections, `full: true` escape hatch, `fields` allowlist, unchanged `limit`/`cursor` page semantics) and `catchErrors()` error normalization. Note: the non-paginated output of these four tools changes from a bare JSON array to a wrapped object (`watchers`/`endpoints`/`jobs`/`routines`).
