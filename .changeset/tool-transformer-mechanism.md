---
"@agentproto/tool": minor
"@agentproto/mcp-server": minor
"@agentproto/runtime": patch
---

ToolTransformer composition mechanism on the AIP-14 contract layer, proven end-to-end on `session_list`:

- `@agentproto/tool`: new `ToolTransformer` type (optional `wrapShape`, required `wrapHandler`) + optional `transformers` field on `ToolDefinition`/`ToolHandle`; concrete `paginated({ project, keyOf?, maxLimit?, itemKey? })` and `catchErrors()` transformers; the shared pagination primitives (`paginate`, `pageParamsShape`, `toolText`, cursors) moved from `@agentproto/runtime`'s `tool-envelope.ts` to `@agentproto/tool` (runtime re-exports them verbatim) so the transformer reuses the exact cursor/limit semantics.
- `@agentproto/mcp-server`: `toMcpTool`/`buildMcpTool` apply `tool.transformers` (or a `transformers` option, which overrides) to the shape/handler at registration, composed left-to-right in declared order (first declared = outermost wrapper); transformers may terminate the pipeline with a pre-serialized MCP text result, which passes through verbatim.
- `@agentproto/runtime`: `session_list` migrated from raw `server.tool(...)` to `defineTool` + `implementTool` + `toMcpTool` with the `paginated()` transformer (reusing `compactSessionItem` as the required compact projection). Registration-mechanism change only — observable behavior (compact default, `full:true`/`compact:false` escape hatch, `fields` allowlist, pagination envelope, legacy `{sessions:[...]}` wrapper without limit/cursor) is unchanged; the existing PR-2/PR-10 parity tests pass untouched.
