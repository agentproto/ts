# @agentproto/tool

## 0.3.0

### Minor Changes

- 20ef731: ToolTransformer composition mechanism on the AIP-14 contract layer, proven end-to-end on `session_list`:
  - `@agentproto/tool`: new `ToolTransformer` type (optional `wrapShape`, required `wrapHandler`) + optional `transformers` field on `ToolDefinition`/`ToolHandle`; concrete `paginated({ project, keyOf?, maxLimit?, itemKey? })` and `catchErrors()` transformers; the shared pagination primitives (`paginate`, `pageParamsShape`, `toolText`, cursors) moved from `@agentproto/runtime`'s `tool-envelope.ts` to `@agentproto/tool` (runtime re-exports them verbatim) so the transformer reuses the exact cursor/limit semantics.
  - `@agentproto/mcp-server`: `toMcpTool`/`buildMcpTool` apply `tool.transformers` (or a `transformers` option, which overrides) to the shape/handler at registration, composed left-to-right in declared order (first declared = outermost wrapper); transformers may terminate the pipeline with a pre-serialized MCP text result, which passes through verbatim.
  - `@agentproto/runtime`: `session_list` migrated from raw `server.tool(...)` to `defineTool` + `implementTool` + `toMcpTool` with the `paginated()` transformer (reusing `compactSessionItem` as the required compact projection). Registration-mechanism change only — observable behavior (compact default, `full:true`/`compact:false` escape hatch, `fields` allowlist, pagination envelope, legacy `{sessions:[...]}` wrapper without limit/cursor) is unchanged; the existing PR-2/PR-10 parity tests pass untouched.

## 0.2.2

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.2.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
  - @agentproto/manifest@0.2.1

## 0.2.0

### Minor Changes

- dc870cf: tool: toolFromManifestOnly + optional inputSchema/outputSchema; runtime: session lifecycle events on bus + completion-policy supervisor MVP
- 2186e9e: tool: carry & validate AIP-16 `inputs`/`outputs` JSON Schema from manifests

  A manifest-only `TOOL.md` (authored in YAML, no TS zod module — e.g. by an agent
  self-constructing a tool) now keeps its declared IO contract: `inputs`/`outputs`
  (JSON Schema, AIP-16) are modelled on the frontmatter schema and `ToolHandle`,
  and carried through `parse` / `define` / `toolFromManifest` instead of being
  silently dropped. `validateInput`/`validateOutput` validate against that JSON
  Schema via `ajv` when no zod schema is present (zod stays the v0.1 path);
  compiled validators are cached per schema in a `WeakMap`. Also fixes snake_case
  meta surfacing on load (`risk_level`/`cost_class`/`timeout_ms` were lost to
  defaults).

  mcp-server: `buildMcpTool` tolerates a tool whose `inputSchema` is absent at
  runtime (manifest-only) — it yields an empty MCP input shape instead of throwing.

### Patch Changes

- 78ac79e: fix(tool): convert camelCase ToolDefinition params to snake_case before YAML serialization

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/manifest@0.2.0

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/manifest@0.1.0
