# @agentproto/adapter-claude-sdk

## 0.5.10

### Patch Changes

- Updated dependencies [139c198]
  - @agentproto/model-catalog@0.9.1

## 0.5.9

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

- 001a2a0: Refactor model catalog to derive existence from live-synced sources, not hand-typed pricing rows.

  **Model existence inversion**: `LlmModelId` union now derives from `CONTEXT_WINDOWS` + `OPENROUTER_ROUTES` keys, with pricing overlaid on top. Hand-written pricing is now bounded to the `PRICING_OVERRIDES` map (rare edge cases only).

  **Native model lists**: Both Anthropic adapters now use `listNativeModelIds("anthropic")` with an empty denylist, eliminating the hand-maintained list. Google native ids extracted to `google-native-model-ids.mjs` for reuse across sync scripts.

  **Sync scripts**: Added generators for Anthropic, xAI, Google, OpenAI, MiniMax. Fallback strategy: Anthropic uses `CONTEXT_WINDOWS` when API key unavailable.

  **Pricing optionality**: `ResolvedModel.pricing?: LLMPricing` signals "known but unpriced" models. Consumers updated (enrichment, registry, cost dispatcher).

  **Data quality**: Generated prices replace stale hand-typed entries. No pricing regressions; Anthropic, Mistral, Moonshot, Groq all carry live sync-derived values or documented placeholders.

- Updated dependencies [4b924c9]
- Updated dependencies [008a483]
- Updated dependencies [3496977]
- Updated dependencies [008a483]
- Updated dependencies [dfda0b1]
- Updated dependencies [f0c51a7]
- Updated dependencies [12bb9e8]
- Updated dependencies [001a2a0]
- Updated dependencies [5dcc733]
  - @agentproto/model-catalog@0.9.0
  - @agentproto/driver-agent-cli@2.4.0

## 0.5.8

### Patch Changes

- bcdff87: Fix: Fail fast on unrouted vendor/product model IDs to prevent silent billing issues.

  When a gateway model (e.g., `deepseek/deepseek-v4-flash-0731`) reaches `buildQueryOptions()` without a `base_url` to route it through, it would previously be sent directly to the real Anthropic API — resulting in one of three silent failures: an empty turn still billed, a 400 error, or worst, a silent fallback to a real Claude model billed to Anthropic. The guard now throws `UnroutedGatewayModelError` before any request is made, with a clear error message naming the model and suggesting the fix (set a `base_url` or request a native `claude-*` model instead).

  Exports the new `UnroutedGatewayModelError` class for pattern-matching if hosts wish to distinguish this failure mode.

- e2314b3: Weekly dependency update: minor/patch-range bumps across the workspace.
  - @mastra/core 1.57.0 → 1.59.0
  - @mastra/memory 1.26.0 → 1.26.2
  - @mastra/libsql 1.19.0 → 1.20.0
  - turbo 2.10.9 → 2.10.10
  - unpdf 1.8.0 → 1.8.1
  - e2b 2.38.2 → 2.39.0
  - @anthropic-ai/claude-agent-sdk 0.3.226/0.3.232 → 0.3.233
  - @earendil-works/pi-tui 0.84.1 → 0.84.2
  - mastracode 0.32.6 → 0.33.1

- b95e23b: Weekly dependency update: bump external dependencies to latest minor/patch versions.
  - @anthropic-ai/claude-agent-sdk 0.3.233 → 0.3.241
  - @ast-grep/napi 0.45.1 → 0.45.2
  - @mastra/core 1.59.0 → 1.61.0
  - @mastra/libsql 1.20.0 → 1.21.1
  - @mastra/memory 1.26.2 → 1.27.0
  - @tanstack/react-query 5.66.0 → 5.102.2
  - @types/react-dom 19.2.4 → 19.2.5
  - @types/vscode 1.90.0 → 1.134.0
  - e2b 2.39.0 → 2.45.0
  - mastracode 0.33.1 → 0.35.0
  - turbo 2.10.10 → 2.10.11

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
  - @agentproto/driver-agent-cli@2.3.1

## 0.5.7

### Patch Changes

- a02a5ea: Bump @anthropic-ai/claude-agent-sdk from 0.3.226 to 0.3.232 to align with Claude Code 2.1.232.
- Updated dependencies [132ffe5]
  - @agentproto/provider-presets@0.6.1

## 0.5.6

### Patch Changes

- Updated dependencies [27a22ca]
- Updated dependencies [0bdd564]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0
  - @agentproto/provider-presets@0.6.0

## 0.5.5

### Patch Changes

- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/driver-agent-cli@2.2.2

## 0.5.4

### Patch Changes

- e68c999: Weekly minor/patch dependency bump (w33). Fixes `TUI` class → `TuiMainScreen` rename from `@earendil-works/pi-tui` 0.84.1.

## 0.5.3

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 0.5.2

### Patch Changes

- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0

## 0.5.1

### Patch Changes

- e7ab81a: Expose Kimi K3 model across adapters and llm-endpoint library. Adds direct moonshot routes and llm-endpoint proxy variants for unified model routing.
- 980276e: Router-aware LLM model enumeration for Requesty and HuggingFace.

  Introduces `listRouterLlmRoutes` to systematically enumerate all models a router serves, and enhances `getModelsByProvider` to fold these router tables into provider queries while deduplicating against OpenRouter's existing bare-id surface. Requesty and HuggingFace models now enumerate from their generated route tables as `vendor/product@router` ids. Claude SDK adapter adds Requesty model curation to its allowed list.

- Updated dependencies [832870d]
  - @agentproto/provider-presets@0.5.1

## 0.5.0

### Minor Changes

- c736c02: Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.
- f883915: Add extended idle timeout for tool execution in Claude SDK adapter. Prevents generation watchdog from aborting healthy long-running tool calls that legitimately go silent between `tool_use` and `tool_result` messages. Introduces `toolIdleTimeoutMs` config option (default 10 minutes) and `CLAUDE_SDK_TOOL_IDLE_TIMEOUT_MS` environment variable.

### Patch Changes

- a88a78b: Fix model routing for multi-vendor gateways (OpenRouter/Requesty) by introducing route-identity suffixes. Add bare-product curation tolerance for existing allowlists on direct routes. Export a new `@agentproto/runtime/catalog-models` subpath for the vscode picker's unroutable-model warning.
- 0f10338: Add built-in custom route for local llm-endpoint Anthropic-compatible proxy. The runtime now registers the llm-endpoint route at daemon boot, allowing curated model references (e.g., moonshot/kimi-k2.7-code@llm-endpoint) to transparently route through the local proxy. Configuration is derived from the gateway preset to ensure single source of truth.
- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

- 4542ca3: Curate OpenAI gpt-5.6 series (luna, sol) into claude-code and claude-sdk with `@openrouter` suffix, allowing Anthropic-native adapters to spawn these models via OpenRouter gateway. Refine auth-engagement logic to detect resolver-coupled gateway routes via `baseUrl` field in `ResolvedAuthSpec`, ensuring credentials are injected for runtime-resolved routes while protecting against native-credential leaks on manually-configured base_urls. Add comprehensive P0 test validating credential injection, base_url preservation, and scrubbing of conflicting provider vars.
- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [3865de6]
- Updated dependencies [5643cb6]
- Updated dependencies [f1484a4]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [68ef7fb]
- Updated dependencies [4832ced]
  - @agentproto/provider-presets@0.5.0
  - @agentproto/driver-agent-cli@2.1.0

## 0.4.2

### Patch Changes

- Updated dependencies [cc00682]
  - @agentproto/driver-agent-cli@2.0.1

## 0.4.1

### Patch Changes

- 5c99163: Sync docs (README/manifests) with already-shipped requesty preset, catalog-sync, and permissions watch
- Updated dependencies [5c99163]
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/provider-presets@0.4.1
  - @agentproto/driver-agent-cli@2.0.0

## 0.4.0

### Minor Changes

- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug

### Patch Changes

- Updated dependencies [dd3386d]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0
  - @agentproto/provider-presets@0.4.0

## 0.3.1

### Patch Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 0.3.0

### Minor Changes

- d425044: Add catalog-sourced billing-credential resolver for all adapters

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [1b282ab]
- Updated dependencies [1bdc055]
- Updated dependencies [7b53b8c]
- Updated dependencies [049c2fe]
- Updated dependencies [0ea6fc1]
- Updated dependencies [386a573]
- Updated dependencies [c036f59]
- Updated dependencies [76747fc]
- Updated dependencies [d425044]
- Updated dependencies [2d94149]
- Updated dependencies [c430b9f]
- Updated dependencies [94a7e90]
  - @agentproto/provider-presets@0.3.0
  - @agentproto/driver-agent-cli@1.0.0

## 0.2.0

### Minor Changes

- 81e0292: Add first-party claude-sdk adapter (headless query() over ACP, model + base_url)
- e31c322: Add auth_token option, gateway model-tier pinning, and thinking flag to claude-sdk adapter
- 556b97e: Add Moonshot and OpenRouter gateway presets as AIP-45 modes on claude-sdk
- abb49cf: add DeepSeek gateway preset to provider-presets and adapters

### Patch Changes

- 2532d33: Scrub ambient Anthropic key under gateway base_url; provider-driven bearer auth
- 167b61f: Fix stalled gateway turn hanging forever with idle watchdog in #drive
- 10d1386: Tighten SDK-child stall watchdog default to 90s; correct root-cause docs
- a925b0b: Scrub leaked CLAUDE_CODE_USE_BEDROCK/\_VERTEX (etc.) toggles in gateway mode
- fad8300: Fix claude-sdk idle watchdog false-abort and frozen ring on long thinking turns
- 25358ad: Cast moonshot SDK test fakes at the boundary to fix BetaUsage drift
- 34cfcb5: Document DeepSeek gateway mode across claude-code/claude-sdk adapters
- 2adc163: add shared Anthropic gateway presets and claude-code gateway modes
- Updated dependencies [6b8b023]
- Updated dependencies [7142f1c]
- Updated dependencies [6f867e1]
- Updated dependencies [6c83622]
- Updated dependencies [3a76562]
- Updated dependencies [b65ca15]
- Updated dependencies [a28bebc]
- Updated dependencies [7f8b45a]
- Updated dependencies [abb49cf]
- Updated dependencies [34cfcb5]
- Updated dependencies [2adc163]
  - @agentproto/driver-agent-cli@0.4.0
  - @agentproto/provider-presets@0.2.0
