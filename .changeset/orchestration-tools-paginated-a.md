---
"@agentproto/runtime": minor
---

Migrate the first half of `orchestration-tools.ts`'s `pageParamsShape` list tools onto the `ToolTransformer` mechanism (`defineTool` + `implementTool` + `toMcpTool` + shared `paginated()`): `permissions_list`, `workflow_list`, `policy_list`, and `activities_list` now project COMPACT rows by default (real per-tool compact projections), return the full verbose records behind `full: true` / `compact: false`, honor `fields` on the page envelope, and keep the exact legacy default envelopes (`{permissions}`, bare arrays, `{activities, counts}`) and pagination cursor semantics. The same tools' handlers are wrapped in `catchErrors()` for one canonical error-result shape. Hand-rolled subtree-scoping logic is untouched.
