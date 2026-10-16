# @agentproto/agent

## 0.4.0

### Minor Changes

- 3a02a3b: New `create_tool` / `delete_tool` daemon verbs author an AIP-14/AIP-30
  TOOL.md + DRIVER.md pair into the workspace bundle
  (`.agentproto/tools/<id>/`, `.agentproto/drivers/<id>/`). Gated by the
  caller's AIP-42 `actions.granted` (default-denied — an agent must grant
  `create_tool` in its own manifest). The grant subject is the daemon-resolved
  caller session identity — never a caller-supplied tool argument — and an
  unresolvable caller fails closed. Bounded by a minimum lifetime, an authoring
  marker that protects operator/`emitApp`-authored tools from `force`, a
  per-agent/day delete limit and a reclaimable authoring lock; created tools
  default to `approval: "always"`. `@agentproto/agent` now exports its
  `AGENT_ID_PATTERN` so callers validate AIP-42 ids before resolving them to
  paths. `isSelfSchedulingTool` now also refuses `create_*`/`delete_*` authoring
  verbs (including `create_tool`) as cron `tool` actions.

## 0.3.0

### Minor Changes

- fe3c879: An AIP-42 AGENT.md now reaches every harness, not just mastra-agent. `app_run` and workflow agent refs share one projection (`projectAgentToSpawn`): body, persona, boundaries and traits become the first prompt's prefix, declared tools scope a daemon gateway mount (`allowTools`) for any adapter, declared skills reach the spawn's `skills`, and each gap the harness can't honour raises a `session:harness-warning`. `composeInstructions` moves to `@agentproto/agent`. `app_run` spawns now get the daemon `/mcp` URL, workflow host spawns deliver session skills, and the AGENT.md path goes only to adapters whose manifest declares `metadata.agentManifestOption` (mastra-agent), so antigravity's `agent` option (an `agy` agent name) is no longer handed a path.

## 0.2.5

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3
  - @agentproto/manifest@0.2.3

## 0.2.4

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.2.3

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2
  - @agentproto/manifest@0.2.2

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

- 1fc1750: Add loadAgent, updateManifestSet, self_inspect MCP tool, and extends-chain validation
- 1fc1750: Add loadAgent, validateExtendsChain, updateManifestSet, and self_inspect MCP tool

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/manifest@0.2.0

## 0.1.0

### Minor Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/manifest@0.1.0
