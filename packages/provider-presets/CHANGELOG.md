# @agentproto/provider-presets

## 0.5.1

### Patch Changes

- 832870d: Documentation sync: daemon restart command, sessions gc garbage collection, install --allow-unverified flag, Gemini adapter shipped, pi adapter support, xai-anthropic and llm-endpoint provider presets, and launchd crash-only KeepAlive behavior.

## 0.5.0

### Minor Changes

- c736c02: Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
- 68ef7fb: Add operator-configurable custom routes via `~/.agentproto/routes.json` and a new `xai-anthropic` gateway preset.

  **Breaking change (`@agentproto/runtime`):** `registerBuiltinRoutes()` is now `async` (`() => Promise<void>`, previously `() => void`), because it now also loads and validates operator routes from `~/.agentproto/routes.json` before returning. Any external caller must add `await`:

  ```diff
  -registerBuiltinRoutes()
  +await registerBuiltinRoutes()
  ```

  Callers that do not await the returned promise will silently skip operator-route loading (built-in routes still register synchronously before the first `await` point, but overrides from `routes.json` will not be applied and no rejection will surface). All internal call sites in this repo have been updated.

  `@agentproto/provider-presets` gains the `xai-anthropic` preset: an Anthropic-schema-compatible gateway pointed directly at xAI, for hosts that want to address Grok through the Anthropic wire format.

### Patch Changes

- f1484a4: Add `stripRouteSuffix()` utility to strip catalog @route suffix before passing model IDs to upstream providers, and fix llm-endpoint keyEnv from LLM_ENDPOINT_API_KEY to LLM_ENDPOINT_ACCESS_TOKENS.
- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

## 0.4.1

### Patch Changes

- 5c99163: Sync docs (README/manifests) with already-shipped requesty preset, catalog-sync, and permissions watch

## 0.4.0

### Minor Changes

- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug

## 0.3.0

### Minor Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)

### Patch Changes

- 1b282ab: Loosen preset tests for xai openai-flavored proxy preset
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- c430b9f: Harden SSE reconnect sleep cancellation, poll-loop disposal guards, and webview hydration
- 94a7e90: Fix xAI preset: replace private codenames with real upstream model ids

## 0.2.0

### Minor Changes

- abb49cf: add DeepSeek gateway preset to provider-presets and adapters
- 2adc163: add shared Anthropic gateway presets and claude-code gateway modes

### Patch Changes

- 34cfcb5: Document DeepSeek gateway mode across claude-code/claude-sdk adapters
