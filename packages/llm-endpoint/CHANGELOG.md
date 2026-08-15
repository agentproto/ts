# @agentproto/llm-endpoint

## 0.5.6

### Patch Changes

- @agentproto/providers-store@0.3.7

## 0.5.5

### Patch Changes

- cbe05f9: Fix credential shape detection for Anthropic OAuth Access Tokens (OATs). When resolving env-key credentials without a mapped auth profile, the resolver now classifies tokens by shape — Anthropic OATs (`sk-ant-oat*`) get method:"oauth-bearer" instead of the hardcoded "api-key" — so `buildUpstreamAuthHeaders` emits `Authorization: Bearer` instead of `x-api-key`. Anthropic hard-rejects OATs sent as x-api-key ("invalid x-api-key"), and the runtime's billing-auth resolver injects subscription OATs into ANTHROPIC_API_KEY for certain adapters (e.g. pi) with no authSubscription override.

## 0.5.4

### Patch Changes

- @agentproto/providers-store@0.3.6

## 0.5.3

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.
  - @agentproto/providers-store@0.3.5

## 0.5.2

### Patch Changes

- @agentproto/providers-store@0.3.4

## 0.5.1

### Patch Changes

- e7ab81a: Expose Kimi K3 model across adapters and llm-endpoint library. Adds direct moonshot routes and llm-endpoint proxy variants for unified model routing.
- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
  - @agentproto/providers-store@0.3.3

## 0.5.0

### Minor Changes

- 852dfd4: Add Anthropic-style format feature and curated coding pack. Enables any pack to be relabeled on-the-fly with opaque `claude-<family>-<sha>` IDs for Anthropic-only clients without impersonating real Claude models. Introduces codingPack with production-grade models via OpenRouter (GPT-5.5, Claude Opus 4.8, Deepseek v4, Claude Sonnet 5, GLM 5.2, Minimax m3). Feature is opt-in via `X-Proxy-Format: anthropic` header or `?format=anthropic` query param.
- 6c1c6e3: Add hot-reload functionality for local model packs (packs.local.json). The llm-endpoint proxy now validates pack configurations and exposes a POST /v1/packs/reload endpoint for live reloading without a restart. The VS Code extension gains a "Reload Local Router Packs" command with tree-view integration and field-scoped error feedback.
- 924cbf6: Add upstream credential linking and live testing:
  - **@agentproto/llm-endpoint**: New API for per-upstream credential status (describeUpstreamStatus, collectUpstreamStatuses, testUpstream) and HTTP routes (GET /v1/upstreams, POST /v1/upstreams/:provider/test).
  - **@agentproto/runtime**: New llm-endpoint-links-store for persisting upstream→profile links to ~/.agentproto/llm-endpoint-links.json, and new MCP tools (llm_endpoint_set_upstream_link, llm_endpoint_list_links).
  - **agentproto-vscode**: New "Upstreams" tree grouping with inline test and link actions, profile picker QuickPick, and pending-restart annotations when persisted links haven't been applied yet.

  Users can now map LLM provider upstreams to named auth-profiles (instead of bare env keys), manage those links via MCP, and test them live to verify credentials resolve correctly.

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [8367648]
- Updated dependencies [6ff42b4]
- Updated dependencies [645279d]
- Updated dependencies [f3f5e82]
- Updated dependencies [655b4b6]
  - @agentproto/auth@1.0.0
  - @agentproto/providers-store@0.3.2

## 0.4.0

### Minor Changes

- a7599f4: Add inbound + edge/WAF access gates and fix /v1 pack-path normalization

### Patch Changes

- @agentproto/providers-store@0.3.1

## 0.3.0

### Minor Changes

- d4187ca: Route requesty through the llm-endpoint proxy with a committed transparent pack
- e4a5527: Replay a turn once when a stripped-thinking provider returns an empty turn

### Patch Changes

- Updated dependencies [719771e]
  - @agentproto/providers-store@0.3.0

## 0.2.1

### Patch Changes

- @agentproto/providers-store@0.2.1

## 0.2.0

### Minor Changes

- e72a250: Add pack-based model registry, tool-control headers, and local config support
- 4fce66e: Add pack registry, tool-header wildcard filtering, and vscode VSIX packaging script
- f869759: Add Responses API facade, transparent chat/completions surface, and direct OpenAI provider

### Patch Changes

- dc24713: Export trimTools and ToolTrimOptions from index for testability
- Updated dependencies [8e7353a]
  - @agentproto/providers-store@0.2.0

## 0.1.0

### Minor Changes

- 363c944: Add @agentproto/llm-endpoint as a proper workspace package with exportable start()/server
