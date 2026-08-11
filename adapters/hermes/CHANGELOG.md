# @agentproto/adapter-hermes

## 0.4.5

### Patch Changes

- ec9efa3: **Hermes nativeTerminalResume gated on Node ≥22.5** — hermes TUI uses node:sqlite which is unavailable on older runtimes; the capability is now computed at import time so restart falls back to ACP agent-cli instead of crashing.

  **augmentWithFsResume backfills adapterSessionId** — when never captured (session killed before ACP handshake), backfill it from filesystem probe so agent restart can attempt ACP-level resume in addition to PTY-native restart.

  **restartAsTerminal opens transcript on fallback** — when restart falls back to agent-cli (no PTY available), open the conversation transcript view instead of the agent-mirror pseudo-terminal.

- Updated dependencies [415044d]
- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/model-catalog@0.8.3
  - @agentproto/driver-agent-cli@2.2.2

## 0.4.4

### Patch Changes

- 665019a: **adapters/hermes:** Replace hand-maintained model allowlist with dynamic catalog-based menu from the shared provider catalog, keeping it in sync with all available OpenRouter and OpenAI models.

  **adapters/mastracode:** Replace static model allowlist with dynamic catalog-based menu; add `modelDerivedApiKey: true` for correct billing-auth eligibility.

  **adapters/pi:** Replace static model allowlist with dynamic catalog-based menu; add `modelDerivedApiKey: true` fixing moonshot profile eligibility (profile was rejected because `methodsForDirect()` returned empty without this flag).

- 6e1fcf3: Remove tilde-prefixed OpenRouter aliases and use non-throwing route resolution in widening
- Updated dependencies [2b58616]
- Updated dependencies [6e1fcf3]
  - @agentproto/model-catalog@0.8.2

## 0.4.3

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 0.4.2

### Patch Changes

- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/driver-agent-cli@2.2.0

## 0.4.1

### Patch Changes

- Updated dependencies [c1399f3]
  - @agentproto/provider-kit@0.4.1

## 0.4.0

### Minor Changes

- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.
- f3b54ad: Implement harness capability discovery — a new layer that answers "what can this adapter actually DO on this host right now" by discovering credentials, providers, model-discovery mechanisms, endpoint compatibility, and application contracts at runtime. Each adapter optionally exports a `<camelSlug>Capabilities` strategy that parses its native config/creds stores (e.g., `~/.gemini/settings.json`, `~/.hermes/auth.json`) to report live state. Falls back gracefully to a pure manifest projection when no strategy is available or it throws. Never surfaces raw credential values — only presence, fingerprints, and last-4 chars. Exposed via the new `harness_capabilities` MCP tool and `@agentproto/cli`'s `listHarnessCapabilities` function.

### Patch Changes

- a88a78b: Fix model routing for multi-vendor gateways (OpenRouter/Requesty) by introducing route-identity suffixes. Add bare-product curation tolerance for existing allowlists on direct routes. Export a new `@agentproto/runtime/catalog-models` subpath for the vscode picker's unroutable-model warning.
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
- Updated dependencies [f3b54ad]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [4832ced]
  - @agentproto/driver-agent-cli@2.1.0
  - @agentproto/provider-kit@0.4.0

## 0.3.4

### Patch Changes

- Updated dependencies [cc00682]
  - @agentproto/driver-agent-cli@2.0.1

## 0.3.3

### Patch Changes

- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/driver-agent-cli@2.0.0

## 0.3.2

### Patch Changes

- Updated dependencies [dd3386d]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0

## 0.3.1

### Patch Changes

- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 0.3.0

### Minor Changes

- d425044: Add catalog-sourced billing-credential resolver for all adapters

### Patch Changes

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

## 0.2.0

### Minor Changes

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- 3a76562: Add models.deny to agent-CLI manifest; reserve Anthropic for claude-code

### Patch Changes

- 7142f1c: Add per-mode support status (active|noop|planned) to AIP-45 agent-CLI manifest
- 0ba77de: Add --pack fan-out install for skill CLI
- 2adc163: add shared Anthropic gateway presets and claude-code gateway modes
- Updated dependencies [6b8b023]
- Updated dependencies [7142f1c]
- Updated dependencies [6f867e1]
- Updated dependencies [6c83622]
- Updated dependencies [3a76562]
- Updated dependencies [b65ca15]
- Updated dependencies [a28bebc]
- Updated dependencies [7f8b45a]
  - @agentproto/driver-agent-cli@0.4.0

## 0.1.1

### Patch Changes

- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
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

- 5e908f8: add model/effort manifest options to hermes; fix researcher turn-end sequencing
- fc6fd0b: Add session cost/cap, wait:true one-shot, clean output, model echo, wait_for_any cursor

### Patch Changes

- 7542339: Fix hermes model selection (apply:"command") + wait_for_any fast-turn race
- Updated dependencies [04c9a5a]
- Updated dependencies [adf4583]
- Updated dependencies [c6a90e2]
- Updated dependencies [7542339]
- Updated dependencies [5c2063e]
- Updated dependencies [0022b2a]
- Updated dependencies [6587000]
- Updated dependencies [04c9a5a]
  - @agentproto/driver-agent-cli@0.2.0
