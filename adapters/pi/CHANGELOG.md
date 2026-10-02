# @agentproto/adapter-pi

## 0.4.10

### Patch Changes

- Updated dependencies [58d5a41]
  - @agentproto/driver-agent-cli@2.7.2

## 0.4.9

### Patch Changes

- @agentproto/driver-agent-cli@2.7.1

## 0.4.8

### Patch Changes

- Updated dependencies [a878968]
  - @agentproto/driver-agent-cli@2.7.0

## 0.4.7

### Patch Changes

- 85051ab: Windows fixes for the pi stack from the WIN11 #1637 field test (agentproto 1.7.1):

  - driver-agent-cli proprietary arm: a dynamic `import()` of an ABSOLUTE filesystem path
    (the fully-resolved adapter produced by `withResolvedProprietaryAdapter`) failed on
    win32 with `ERR_UNSUPPORTED_ESM_URL_SCHEME` / `Received protocol 'c:'`. Absolute paths
    are now rewritten via `pathToFileURL()` before `import()`; bare npm specifiers import
    as before. POSIX behavior is unchanged.
  - adapter-pi: `spawn pi ENOENT` on win32 — the installed binary is a `.cmd` shim
    (`pi.cmd` on PATH, wrapper reapps of `%USERPROFILE%\.pi\agent\bin` or the npm global
    prefix) and Node's spawn without `shell` does no PATHEXT resolution. pi session spawns
    now resolve the binary through PATH; a `.cmd`/`.bat` shim is rewritten to its package
    entry JS (`node <…>/pi-coding-agent/dist/bundle/cli.js`) when a sibling exists, else
    spawned with `shell: true` (args are internal constants only).

- Updated dependencies [85051ab]
  - @agentproto/driver-agent-cli@2.6.4

## 0.4.6

### Patch Changes

- @agentproto/driver-agent-cli@2.6.3

## 0.4.5

### Patch Changes

- Updated dependencies [6bace2a]
  - @agentproto/driver-agent-cli@2.6.2

## 0.4.4

### Patch Changes

- Updated dependencies [3d9626a]
  - @agentproto/driver-agent-cli@2.6.1

## 0.4.3

### Patch Changes

- 88f2836: Weekly minor/patch dependency bumps across workspaces (@modelcontextprotocol/sdk 1.30.0 → 1.30.1, @anthropic-ai/claude-agent-sdk 0.3.282 → 0.3.283, turbo 2.10.12 → 2.11.5, @tauri-apps/* 2.12, @tanstack/react-query 5.104, e2b 2.51, @earendil-works/pi-tui 0.87, tsx 4.23.15, @types/vscode 1.138).
- Updated dependencies [6a1bedc]
  - @agentproto/driver-agent-cli@2.6.0

## 0.4.2

### Patch Changes

- Updated dependencies [d2df24b]
  - @agentproto/model-catalog@0.11.3

## 0.4.1

### Patch Changes

- Updated dependencies [d4ac86e]
- Updated dependencies [d000369]
- Updated dependencies [d4ac86e]
  - @agentproto/model-catalog@0.11.2

## 0.4.0

### Minor Changes

- 5402575: Advertise OpenRouter models in pi's menu and add an opt-in read-only `lean` mode

### Patch Changes

- Updated dependencies [fa1bfdd]
- Updated dependencies [68ffab8]
- Updated dependencies [b297612]
- Updated dependencies [9a5730d]
  - @agentproto/model-catalog@0.11.1
  - @agentproto/driver-agent-cli@2.5.1

## 0.3.20

### Patch Changes

- Updated dependencies [ab7970c]
- Updated dependencies [0179144]
- Updated dependencies [65777ee]
- Updated dependencies [8c74864]
- Updated dependencies [dc87d79]
- Updated dependencies [583ee19]
- Updated dependencies [c9e8318]
  - @agentproto/model-catalog@0.11.0
  - @agentproto/driver-agent-cli@2.5.0

## 0.3.19

### Patch Changes

- Updated dependencies [c5b9e2b]
  - @agentproto/model-catalog@0.10.3

## 0.3.18

### Patch Changes

- Updated dependencies [2aadecc]
- Updated dependencies [cbb8743]
  - @agentproto/model-catalog@0.10.2

## 0.3.17

### Patch Changes

- Updated dependencies [5aad102]
- Updated dependencies [e3054e1]
  - @agentproto/model-catalog@0.10.1

## 0.3.16

### Patch Changes

- Updated dependencies [9c31c86]
- Updated dependencies [4ade388]
- Updated dependencies [f89414a]
- Updated dependencies [ea6757f]
- Updated dependencies [c27f0b8]
- Updated dependencies [9c31c86]
  - @agentproto/model-catalog@0.10.0
  - @agentproto/driver-agent-cli@2.4.4

## 0.3.15

### Patch Changes

- @agentproto/driver-agent-cli@2.4.3

## 0.3.14

### Patch Changes

- 44eb515: Replace registry-query version checks (`npm view`) with local presence probes (`npm ls -g` / binary `--version`) so `install` no longer reports "already installed" on machines with nothing installed.
- 66e636b: Fix `version_check` to probe local presence (`npm ls -g` / binary `--version`) instead of the npm registry, so `install` no longer reports "already installed" on machines with nothing installed; add read-only freshness tooling: `agentproto adapters outdated` and `agentproto --version --check-updates` (new exported `registry/freshness` module).

## 0.3.13

### Patch Changes

- Updated dependencies [bb3342f]
  - @agentproto/model-catalog@0.9.4

## 0.3.12

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [b70149b]
- Updated dependencies [2f37e7b]
  - @agentproto/model-catalog@0.9.3
  - @agentproto/driver-agent-cli@2.4.2

## 0.3.11

### Patch Changes

- Updated dependencies [692d659]
- Updated dependencies [6bfb633]
  - @agentproto/model-catalog@0.9.2
  - @agentproto/driver-agent-cli@2.4.1

## 0.3.10

### Patch Changes

- Updated dependencies [139c198]
  - @agentproto/model-catalog@0.9.1

## 0.3.9

### Patch Changes

- ee7d285: Test fixture: replace stale kimi-k2.5 model with still-live kimi-k2.6 alternative (same 262144-token context window).
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

## 0.3.8

### Patch Changes

- e3ad769: Claude subscription on pi/opencode/mastracode — each through the door that actually exists — and honest subscription eligibility everywhere. The runtime assumed "Anthropic OATs work as API keys" for every model-derived adapter and silently injected the subscription OAuth token into `ANTHROPIC_API_KEY`, where Anthropic's edge rejects it as an invalid key after the session is live (observed on opencode: "Internal error: API key is invalid"). Subscription support now requires an explicit, provider-matching `authSubscription` surface, shared across all four eligibility/resolution sites via one `subscriptionAppliesTo` predicate. pi declares its documented bearer env (`ANTHROPIC_OAUTH_TOKEN`, scoped `provider: "anthropic"`) so a Claude subscription profile runs pi's anthropic models natively. opencode and mastracode declare `external` anthropic-scoped subscriptions — each CLI's OWN Claude Pro/Max OAuth login (`opencode auth login`; mastracode's `/login`), backed by new `opencode`/`mastracode` provision recipes pointing at each CLI's auth store: the runtime verifies the login is present (fail-loud), injects nothing, and scrubs the api-key vars so a leftover key can't override it. Adapters/models with no matching surface fail fast at spawn with an actionable message instead of failing opaquely upstream, and the catalog stops advertising subscription profiles as runnable on them.
- Updated dependencies [95f7b5e]
- Updated dependencies [e826a4a]
- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
- Updated dependencies [1fd4a15]
  - @agentproto/model-catalog@0.8.5
  - @agentproto/driver-agent-cli@2.3.1

## 0.3.7

### Patch Changes

- Updated dependencies [7b28edf]
- Updated dependencies [e8d39e8]
  - @agentproto/model-catalog@0.8.4

## 0.3.6

### Patch Changes

- 2120494: Report the pi adapter's real context window instead of the running token total, so context-continuity hard-stops trigger at the actual limit.
- Updated dependencies [27a22ca]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0

## 0.3.5

### Patch Changes

- Updated dependencies [415044d]
- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/model-catalog@0.8.3
  - @agentproto/driver-agent-cli@2.2.2

## 0.3.4

### Patch Changes

- 665019a: **adapters/hermes:** Replace hand-maintained model allowlist with dynamic catalog-based menu from the shared provider catalog, keeping it in sync with all available OpenRouter and OpenAI models.

  **adapters/mastracode:** Replace static model allowlist with dynamic catalog-based menu; add `modelDerivedApiKey: true` for correct billing-auth eligibility.

  **adapters/pi:** Replace static model allowlist with dynamic catalog-based menu; add `modelDerivedApiKey: true` fixing moonshot profile eligibility (profile was rejected because `methodsForDirect()` returned empty without this flag).

- Updated dependencies [2b58616]
- Updated dependencies [6e1fcf3]
  - @agentproto/model-catalog@0.8.2

## 0.3.3

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 0.3.2

### Patch Changes

- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0

## 0.3.1

### Patch Changes

- e7ab81a: Expose Kimi K3 model across adapters and llm-endpoint library. Adds direct moonshot routes and llm-endpoint proxy variants for unified model routing.
- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.

## 0.3.0

### Minor Changes

- c736c02: Dissociate auth profiles from routers/gateways and harness adapters. Session descriptors now carry explicit `harness`, `model`, `route`, and `accessProfile` identity. Runtime resolver derives api-key auth from the model and gateway route, injecting `base_url` + credential env without adapter hard-coding. Add native Moonshot support to `pi`, decouple `claude-sdk` from hard-coded gateway modes, and register a local `llm-endpoint` preset.
- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.

### Patch Changes

- 42f1217: Fix routing and credential injection for gateway-routed adapters (D1-D5)
  - D1: Base URL injection gate — skip gateway baseUrl for derived-from-model adapters (hermes); fail loud when adapter can neither accept baseUrl nor derive its route
  - D2: Wire model form — generalized stripFixedNativeVendor for fixed-provider adapters (codex/openai, codex/gpt-5 not openai/gpt-5)
  - D3: Model-derived provider precedence — adapter-declared modelProviders wins over global catalog routing (pi bills kimi via moonshot, not openrouter)
  - D4: Gateway credential injection — resolveAuthSpec honors adapter-declared gatewayAuth.setEnv instead of preset keyEnv (claude-sdk reads ANTHROPIC_AUTH_TOKEN, not OPENROUTER_API_KEY)
  - D5: LLM endpoint adoption — status report never contradicts (running:false, healthy:true); adopt external healthy endpoints as owner:external with probed model list

  New exports: LlmEndpointStatusReport, stripFixedNativeVendor, routeSelection in AgentAdapterResolver.

- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [3865de6]
- Updated dependencies [5643cb6]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [4832ced]
  - @agentproto/driver-agent-cli@2.1.0

## 0.2.4

### Patch Changes

- Updated dependencies [cc00682]
  - @agentproto/driver-agent-cli@2.0.1

## 0.2.3

### Patch Changes

- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/driver-agent-cli@2.0.0

## 0.2.2

### Patch Changes

- Updated dependencies [dd3386d]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0

## 0.2.1

### Patch Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 0.2.0

### Minor Changes

- bd57d69: Add @agentproto/adapter-pi: AIP-45 proprietary-arm adapter for earendil-works/pi
- 6f82e3a: Bridge injected MCP servers into pi via a generated pi extension

### Patch Changes

- b813c5a: Advertise sub_agents: true now MCP bridge proves pi can orchestrate
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
- Updated dependencies [049c2fe]
- Updated dependencies [0ea6fc1]
- Updated dependencies [386a573]
- Updated dependencies [c036f59]
- Updated dependencies [76747fc]
- Updated dependencies [d425044]
- Updated dependencies [2d94149]
  - @agentproto/driver-agent-cli@1.0.0
