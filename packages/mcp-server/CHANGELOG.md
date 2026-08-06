# @agentproto/mcp-server

## 0.2.5

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.

## 0.2.4

### Patch Changes

- 5becedc: Add `routine_reconcile` verb and HTTP route for on-demand re-scan of routine definitions. Tighten `schedule` schema from `z.any()` to validated discriminatedUnion with cron/interval/calendar/manual/event kinds, improving type safety and validation coverage.
- Updated dependencies [831d4f5]
- Updated dependencies [4d200a9]
- Updated dependencies [5becedc]
- Updated dependencies [1cbb910]
  - @agentproto/driver@0.2.0
  - @agentproto/routine@0.2.0

## 0.2.3

### Patch Changes

- e3bacf3: Add app-kit pick()/only, fix content-team tools, self_inspect discovers app-emitted agents

## 0.2.2

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- Updated dependencies [7b53b8c]
  - @agentproto/agent@0.2.1
  - @agentproto/define-doctype@0.1.1
  - @agentproto/driver@0.1.3
  - @agentproto/extension@0.1.2
  - @agentproto/manifest@0.2.1
  - @agentproto/routine@0.1.2
  - @agentproto/tool@0.2.1

## 0.2.1

### Patch Changes

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

- Updated dependencies [78ac79e]
- Updated dependencies [dc870cf]
- Updated dependencies [2186e9e]
  - @agentproto/tool@0.2.0
  - @agentproto/driver@0.1.2

## 0.2.0

### Minor Changes

- 1fc1750: Add loadAgent, updateManifestSet, self_inspect MCP tool, and extends-chain validation
- 1fc1750: Add loadAgent, validateExtendsChain, updateManifestSet, and self_inspect MCP tool

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/agent@0.2.0
  - @agentproto/manifest@0.2.0
  - @agentproto/driver@0.1.1
  - @agentproto/extension@0.1.1
  - @agentproto/routine@0.1.1
  - @agentproto/tool@0.1.1

## 0.1.0

### Minor Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/agent@0.1.0
  - @agentproto/driver@0.1.0
  - @agentproto/manifest@0.1.0
  - @agentproto/extension@0.1.0
  - @agentproto/routine@0.1.0
  - @agentproto/tool@0.1.0
