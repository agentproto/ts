# @agentproto/tool

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
