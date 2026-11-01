# @agentproto/agent

## 0.6.0

### Minor Changes

- b67f58e: AGENT.md `tools` accepts the AIP-42 structured item `{ kind: mcp, server, allow?, deny? }` and refuses a malformed one (missing `server`, a `/` in a name, an extra key, an unknown `kind`); the item is part of the generated agent schema and exported as `McpToolRef` / `ToolRef`. The operator `tools` item is that same schema, taken from the agent package, and still accepts the deprecated scoped form `{ id, source?, scope? }`. `projectAgentToSpawn` maps each structured item to a per-server `allowTools` / `denyTools` (`servers` on the projection) instead of dropping it with a warning; a deny wins over an allow and over any other item admitting the same tool, and a bare string joins the `agentproto` server. The spec generator gains `--inline-ref <def>` and proves disjoint closed-object `oneOf` branches, so the agent package is now covered by `check:spec-drift`. The vendored specs are re-synced, which regenerates the memory frontmatter schema line; the bridge and `refKey` in the app package take the widened `ToolRef` (a server ref keys as `mcp:<server>`).

  Narrowing: a `server` in an operator or agent `tools` item must now match `^[A-Za-z0-9_.-]+$`, so a URL such as `https://mcp.local` is refused; use a host name such as `mcp-local`. The spawn still carries a single `allowTools` list for the daemon gateway, so a filter on any other server, or a `denyTools` with no allowlist, is exposed on `servers` and reported as a harness warning ("not applied") rather than enforced. The corpus validator and the corpus-cli bundle register the AIP-42 AGENT schema they now `$ref`.

- e47f3cd: AIP-42 `AgentEntry`, one AGENT.md renderer, and a configurable instructions composer.

  - `@agentproto/agent` exports `AgentEntry { agent, body? }` and `renderAgentMd(entry)`, the single AGENT.md renderer. `agentVerbs` (create and update) and the app emitter both go through it, so the same agent renders to the same bytes on either path. The body is trimmed on render, so an update no longer grows blank lines.
  - `defineAgent` refuses a missing or blank `model` with `model is required` (the generated schema types `model` as `any`, so a blank string used to pass).
  - `composeInstructions(handle, body, opts?)` takes `boundariesHeader` and `sectionOrder`. The default boundaries header is now `Hard rules (these MUST be followed):`, without the em dash.
  - `@agentproto/manifest`: `DoctypeSpec` gains an optional `render(handle, body)` hook that `create` and `update` use in place of the generic frontmatter renderer.
  - `@agentproto/skill` exports `SkillEntry { skill, body }`.
  - `@agentproto/app`: `renderAgentManifest` and `emitApp` delegate to `renderAgentMd`; ref comments cite AIP-54.

### Patch Changes

- 152ec6e: The daemon serves the AIP-72 memory store as MCP tools: `memory_search`, `memory_list`, `memory_read`, `memory_write` (default mode `propose`), `memory_supersede`, `memory_archive` and `memory_dismiss`. Anyone proposes; a commit, supersede, archive or dismiss needs the operator or a session spawned with the `supervisor` role, read from the role now recorded on every session's descriptor (`meta.role`); a session whose agent sets AIP-42 `memory.enabled: false` writes nothing. The default store lives at `~/.agentproto/memory` (new config key `memory.root`), and an agent's AIP-42 `memory.store` wins when it names a files root. An agent whose AGENT.md binds memory (`memory.enabled: true`, `store` or `anchors`) gets the AIP-72 section 9 digest of its in-force, in-scope items appended to its system prompt at spawn, bounded with an "items left out" line; an adapter declaring `capabilities.memory.inject: native-dir` gets none through this path. `@agentproto/cli` forwards the adapter's `capabilities.memory.inject` to the runtime. `@agentproto/agent` types the AIP-42 `memory` block's AIP-72 fields (`enabled`, `store`, `anchors`) on `MemoryConfig`.
- 152ec6e: AIP-72 daemon memory surface. `@agentproto/runtime` serves the memory store as seven `memory_*` MCP tools with a propose/commit write policy (commit, supersede, archive and dismiss require the operator or a `supervisor` session, read from `meta.role` on both the sync and async-worktree descriptors; `memory.enabled: false` sessions write nothing), resolves a per-agent `memory.store` for both the spawn digest and the tools, adds the `memory.root` config key, and appends a bounded AIP-72 section 9 digest to the system prompt at spawn. `@agentproto/agent` types the AIP-42 `memory` block's AIP-72 fields (`enabled`, `store`, `anchors`). `@agentproto/cli` forwards the adapter's `capabilities.memory.inject` to the runtime. `@agentproto/memory` documents the daemon tools and digest in its README.
- Updated dependencies [e47f3cd]
  - @agentproto/manifest@0.3.0

## 0.5.0

### Minor Changes

- d3dd524: Align `SPEC_NAME` with the canonical AIP-70 names registry, add the `defineAuth` alias for `defineAuthProvider`, and point the runtime approval request at the accepted AIP-7.

### Patch Changes

- 001368d: Fix loading an AGENT.md whose `on:` value is an array, the multi-action form AIP-42 documents. The generated schema typed an action ref as `z.any()`, so an array matched both branches of the `oneOf` and the load failed with "Should pass single schema. Passed 2". `on:` values are now validated as a string or object action ref, or an array of them, so a bare number is rejected where it used to load.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [5ab8114]
- Updated dependencies [f18edbc]
- Updated dependencies [5ab8114]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0
  - @agentproto/manifest@0.2.5

## 0.4.1

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4
  - @agentproto/manifest@0.2.4

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
