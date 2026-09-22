# @agentproto/providers-store

## 0.3.15

### Patch Changes

- Updated dependencies [5aad102]
- Updated dependencies [e3054e1]
  - @agentproto/model-catalog@0.10.1

## 0.3.14

### Patch Changes

- ea6757f: Add OpenCode's two hosted endpoints as first-class billing providers: `opencode-go` (OpenCode Go, the flat subscription, 36 models) and `opencode` (OpenCode Zen, pay-as-you-go, 102 models). Two new catalog-sync generators (`llm:opencode-go`, `llm:opencode-zen`) source both from models.dev and emit `OPENCODE_GO_ROUTES` / `OPENCODE_ZEN_ROUTES`, each with a pruned per-provider snapshot rather than the 4.6 MB whole-ecosystem payload. Prices are used verbatim (models.dev already publishes USD per 1M tokens); zero-priced `-free` variants are kept, and cache multipliers are omitted where the base input price is 0.

  Route tables are keyed `<provider>/<bare-id>` (`opencode-go/glm-5.3`) — opencode's own config spelling, and the same string the runtime derives the billing endpoint from — so `resolveLlmModelRoute` resolves the OpenCode branch ahead of the direct-vendor branch. Neither table is spread into `LLM_PRICING_CATALOG`, so a bare `claude-sonnet-5` keeps meaning direct Anthropic rather than Zen pricing.

  Two Anthropic gateway presets (`opencode-go`, `opencode`) put each endpoint's Anthropic-surface models behind claude-code / claude-sdk — Zen's subset is the whole Claude family. Preset ids deliberately match the catalog route ids, since `resolveAuthSpec` resolves a spawn's base URL by route id. The opencode adapter now offers both endpoints in full in its generated model menu.

  Fixes two spillovers found along the way: `serviceableModelRoutes` no longer reports a spurious direct-vendor route for a self-routed id (`opencode/claude-sonnet-4-6` had picked up `anthropic` via `resolvePricing`'s substring fallback, loosening the money-safety guard and mis-routing the Configuration Lab), and `injectProviderKeysIntoEnv` now visits providers in sorted order so two providers sharing one env name (both OpenCode endpoints read `OPENCODE_API_KEY`) resolve deterministically instead of by `providers.json` write order.

- Updated dependencies [9c31c86]
- Updated dependencies [4ade388]
- Updated dependencies [f89414a]
- Updated dependencies [ea6757f]
- Updated dependencies [c27f0b8]
- Updated dependencies [9c31c86]
  - @agentproto/model-catalog@0.10.0

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

## 0.3.11

### Patch Changes

- Updated dependencies [692d659]
- Updated dependencies [6bfb633]
  - @agentproto/model-catalog@0.9.2

## 0.3.10

### Patch Changes

- Updated dependencies [139c198]
  - @agentproto/model-catalog@0.9.1

## 0.3.9

### Patch Changes

- Updated dependencies [4b924c9]
- Updated dependencies [008a483]
- Updated dependencies [3496977]
- Updated dependencies [008a483]
- Updated dependencies [f0c51a7]
- Updated dependencies [001a2a0]
- Updated dependencies [5dcc733]
  - @agentproto/model-catalog@0.9.0

## 0.3.8

### Patch Changes

- Updated dependencies [95f7b5e]
- Updated dependencies [e826a4a]
- Updated dependencies [1fd4a15]
  - @agentproto/model-catalog@0.8.5

## 0.3.7

### Patch Changes

- Updated dependencies [7b28edf]
- Updated dependencies [e8d39e8]
  - @agentproto/model-catalog@0.8.4

## 0.3.6

### Patch Changes

- Updated dependencies [415044d]
  - @agentproto/model-catalog@0.8.3

## 0.3.5

### Patch Changes

- Updated dependencies [2b58616]
- Updated dependencies [6e1fcf3]
  - @agentproto/model-catalog@0.8.2

## 0.3.4

### Patch Changes

- Updated dependencies [4b6bbe6]
  - @agentproto/model-catalog@0.8.1

## 0.3.3

### Patch Changes

- Updated dependencies [c825a12]
- Updated dependencies [980276e]
  - @agentproto/model-catalog@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [358af0e]
- Updated dependencies [f1484a4]
- Updated dependencies [0f10338]
- Updated dependencies [ec5f64f]
- Updated dependencies [1ea7682]
- Updated dependencies [42f1217]
  - @agentproto/model-catalog@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [9e30ad2]
  - @agentproto/model-catalog@0.6.0

## 0.3.0

### Minor Changes

- 719771e: Inject provider-key env aliases (google → GOOGLE_API_KEY) at serve boot

### Patch Changes

- Updated dependencies [719771e]
- Updated dependencies [9c2cec0]
  - @agentproto/model-catalog@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [b531fd1]
  - @agentproto/model-catalog@0.4.0

## 0.2.0

### Minor Changes

- 8e7353a: Extract providers-store into a leaf package; fix llm-endpoint boot to inject stored provider keys

### Patch Changes

- Updated dependencies [1bdc055]
- Updated dependencies [afbf5c4]
- Updated dependencies [7b53b8c]
- Updated dependencies [d425044]
- Updated dependencies [d924e95]
  - @agentproto/model-catalog@0.3.0
