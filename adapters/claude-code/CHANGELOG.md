# @agentproto/adapter-claude-code

## 2.1.9

### Patch Changes

- Updated dependencies [139c198]
  - @agentproto/model-catalog@0.9.1

## 2.1.8

### Patch Changes

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

## 2.1.7

### Patch Changes

- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
  - @agentproto/driver-agent-cli@2.3.1

## 2.1.6

### Patch Changes

- 9473480: Bump @agentclientprotocol/claude-agent-acp from 0.59.0 to 0.67.0 to track Claude Code 2.1.x. Includes fixes for denied-tool resolution and ExitPlanMode single-tool representation, improving plan-mode rendering reliability. Changes are backward compatible; new session capabilities (fork/list/resume/delete) are additive.
- Updated dependencies [132ffe5]
  - @agentproto/provider-presets@0.6.1

## 2.1.5

### Patch Changes

- Updated dependencies [27a22ca]
- Updated dependencies [0bdd564]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0
  - @agentproto/provider-presets@0.6.0

## 2.1.4

### Patch Changes

- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/driver-agent-cli@2.2.2

## 2.1.3

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 2.1.2

### Patch Changes

- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0

## 2.1.1

### Patch Changes

- e7ab81a: Expose Kimi K3 model across adapters and llm-endpoint library. Adds direct moonshot routes and llm-endpoint proxy variants for unified model routing.
- Updated dependencies [832870d]
  - @agentproto/provider-presets@0.5.1

## 2.1.0

### Minor Changes

- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.

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
- 4832ced: Terminal restart fidelity: route-aware launch config, native terminal resume capability, and resume honesty.
  - Extracts `buildRouteAwareLaunchConfig` so fresh spawn and restart inject `base_url` identically; derived-from-model adapters (e.g. hermes) no longer receive an unsupported `options.base_url`.
  - Adds `capabilities.nativeTerminalResume` to the agent-cli manifest schema and stamps it on session descriptors; `pty-native` restart is now an explicit capability, not implied by ACP resumability.
  - Preserves auth profile, route, model, posture, effort, and effective environment across restarts; wire model strips catalog `@route` suffixes and fixed-provider native vendor prefixes.
  - Resume-honesty fix: adapters declaring `resumable: false` degrade to a flagged fresh spawn instead of a phantom ACP resume.

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

## 2.0.1

### Patch Changes

- Updated dependencies [cc00682]
  - @agentproto/driver-agent-cli@2.0.1

## 2.0.0

### Major Changes

- 92c1c51: Narrow AgentCliMode.kind to "context"; drop posture/route modes from claude-code, codex, opencode

### Patch Changes

- 5c99163: Sync docs (README/manifests) with already-shipped requesty preset, catalog-sync, and permissions watch
- b16bb83: Add SessionConfig axes type + decomposeMode/composeMode shim (SPEC §3.1)
- Updated dependencies [5c99163]
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/provider-presets@0.4.1
  - @agentproto/driver-agent-cli@2.0.0

## 1.1.0

### Minor Changes

- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug

### Patch Changes

- cae6a45: Pin @agentclientprotocol/claude-agent-acp spawn to 0.59.0 for reproducibility
- Updated dependencies [dd3386d]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0
  - @agentproto/provider-presets@0.4.0

## 1.0.1

### Patch Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 1.0.0

### Major Changes

- c036f59: Explicit credential selection + verifiable auth mode for claude-code spawns

### Minor Changes

- 386a573: Add deterministic auth spawn mode (subscription vs api-key) for claude-code
- d425044: Add catalog-sourced billing-credential resolver for all adapters

### Patch Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 76747fc: fix(claude-code): subscription auth injects CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_AUTH_TOKEN
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

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- abb49cf: add DeepSeek gateway preset to provider-presets and adapters
- 2adc163: add shared Anthropic gateway presets and claude-code gateway modes

### Patch Changes

- 6a5c41c: Make model set_config_option non-fatal; fix claude-code stale model list
- 0ba77de: Add --pack fan-out install for skill CLI
- 34cfcb5: Document DeepSeek gateway mode across claude-code/claude-sdk adapters
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

## 0.1.1

### Patch Changes

- 16d52cd: Add WorkflowRunner primitive, deferred tool gateway, structured awaiting-input, and agent_start mode wiring
- 1bf295b: Fix claude-code plan/accept-edits/bypass-permissions modes via CLAUDE_CONFIG_DIR override
- Updated dependencies [06132bc]
- Updated dependencies [2d1434a]
- Updated dependencies [1bf295b]
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [78d09e6]
- Updated dependencies [559cff3]
- Updated dependencies [06132bc]
- Updated dependencies [c2b6779]
- Updated dependencies [e27fc94]
- Updated dependencies [837967a]
  - @agentproto/driver-agent-cli@0.3.0

## 0.1.0

### Minor Changes

- 6587000: Honor model and add effort to start_agent_session for claude-code adapter

### Patch Changes

- Updated dependencies [04c9a5a]
- Updated dependencies [adf4583]
- Updated dependencies [c6a90e2]
- Updated dependencies [7542339]
- Updated dependencies [5c2063e]
- Updated dependencies [0022b2a]
- Updated dependencies [6587000]
- Updated dependencies [04c9a5a]
  - @agentproto/driver-agent-cli@0.2.0
