# @agentproto/adapter-opencode

## 1.2.0

### Minor Changes

- f75ef5d: Add token usage tracking for OpenCode adapter sessions via readOpenCodeUsage hook. OpenCode's live ACP usage_update event only carries cost (no token fields), so the new function reads token data from OpenCode's sqlite store and is wired into the registry's turn-end path to fill in missing tokensIn/tokensOut fields, mirroring the existing hermes adapter pattern.

### Patch Changes

- Updated dependencies [692d659]
- Updated dependencies [6bfb633]
  - @agentproto/model-catalog@0.9.2
  - @agentproto/driver-agent-cli@2.4.1

## 1.1.10

### Patch Changes

- Updated dependencies [139c198]
  - @agentproto/model-catalog@0.9.1

## 1.1.9

### Patch Changes

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

## 1.1.8

### Patch Changes

- 76f2c78: Multi-surface external subscriptions — one adapter can now declare BOTH a Claude and a ChatGPT native OAuth login, so mastracode/opencode's subscription eligibility no longer forces an anthropic-or-openai choice. `authSubscription` accepts a single surface (unchanged) OR an array of surfaces, one per billing provider; two entries claiming the same provider scope (or two unscoped entries) are rejected at manifest-validation time rather than resolved arbitrarily at spawn time. The runtime's old `subscriptionAppliesTo` boolean predicate is replaced by `subscriptionSurfaceFor`, which resolves the MATCHING surface for a spawn's resolved provider — used by `resolveAuthSpec` and the three mirrored direct-methods projections (`session-spawn.ts`, `session-restart-core.ts`, `catalog-models.ts`) so they stay in lockstep. `verifyLocalLoginPresent` now takes an optional provision-recipe `methodId` (convention `<provider>-oauth`) so a multi-surface spawn verifies the RIGHT login file instead of always checking the recipe's default method. mastracode declares both `{external: true, provider: "anthropic"}` and `{external: true, provider: "openai"}` — its ChatGPT login (`openaiCodexOAuthProvider`) is stored in its own auth.json under the key `openai-codex`, verified live. opencode declares the same pair: its ChatGPT OAuth login was reverse-engineered from the shipped binary (no OSS source available for this build) and is keyed under the SAME `openai` provider id its API-key flow already uses — there is no separate "chatgpt" key, confirmed by tracing the binary's generic `Cli.providers.login` → `Auth.set(provider.id, …)` write path. Both adapters' provision recipes gained an `openai-oauth` method alongside the existing `anthropic-oauth` one.
- 64088e0: Refuse to run a derived-from-model adapter on its default model when the requested model was not applied. Launching opencode with an id its server can't resolve (e.g. a claude-code-style `…@openrouter` suffix) used to warn on the daemon's stderr and silently run — and bill — the server's default `anthropic/claude-sonnet-4-5` instead; hermes had the same hole one strategy over (its spawn-time `/model <id>` control turn's result was ignored), and jcode a protocol over (its CLI silently falls back to its own default on an unknown `--model` id — observed live: `--model totally-bogus-xyz` → started on `gpt-5.6-sol`/OpenAI). Three guards now share one contract for `routeSelection:"derived-from-model"` adapters: the ACP client records a connect-time model rejection structurally (`AcpClientSession.modelApplyRejection`) and the driver refuses the spawn on a rejected `set_config_option` (opencode-style `apply:"config"`) or an unacknowledged/failed `/model` control turn (hermes-style `apply:"command"`); the print arm aborts a turn whose jcode-ndjson `start` line reports a model contradicting the requested one (basename compare, `@route`-suffix/`provider/`-prefix tolerant). Every refusal names the requested id and the concrete reason. Free/fixed-routing adapters keep the agentproto#186 warn-and-continue behavior unchanged; pi errors properly on its own (`Model not found`) and needs no guard.
- e3ad769: Claude subscription on pi/opencode/mastracode — each through the door that actually exists — and honest subscription eligibility everywhere. The runtime assumed "Anthropic OATs work as API keys" for every model-derived adapter and silently injected the subscription OAuth token into `ANTHROPIC_API_KEY`, where Anthropic's edge rejects it as an invalid key after the session is live (observed on opencode: "Internal error: API key is invalid"). Subscription support now requires an explicit, provider-matching `authSubscription` surface, shared across all four eligibility/resolution sites via one `subscriptionAppliesTo` predicate. pi declares its documented bearer env (`ANTHROPIC_OAUTH_TOKEN`, scoped `provider: "anthropic"`) so a Claude subscription profile runs pi's anthropic models natively. opencode and mastracode declare `external` anthropic-scoped subscriptions — each CLI's OWN Claude Pro/Max OAuth login (`opencode auth login`; mastracode's `/login`), backed by new `opencode`/`mastracode` provision recipes pointing at each CLI's auth store: the runtime verifies the login is present (fail-loud), injects nothing, and scrubs the api-key vars so a leftover key can't override it. Adapters/models with no matching surface fail fast at spawn with an actionable message instead of failing opaquely upstream, and the catalog stops advertising subscription profiles as runnable on them.
- Updated dependencies [95f7b5e]
- Updated dependencies [e826a4a]
- Updated dependencies [76f2c78]
- Updated dependencies [64088e0]
- Updated dependencies [e3ad769]
- Updated dependencies [1fd4a15]
  - @agentproto/model-catalog@0.8.5
  - @agentproto/driver-agent-cli@2.3.1

## 1.1.7

### Patch Changes

- Updated dependencies [7b28edf]
- Updated dependencies [e8d39e8]
  - @agentproto/model-catalog@0.8.4

## 1.1.6

### Patch Changes

- Updated dependencies [27a22ca]
- Updated dependencies [ce7cbb7]
- Updated dependencies [cbe11c2]
  - @agentproto/driver-agent-cli@2.3.0

## 1.1.5

### Patch Changes

- Updated dependencies [415044d]
- Updated dependencies [bf3407e]
- Updated dependencies [82ca9e6]
  - @agentproto/model-catalog@0.8.3
  - @agentproto/driver-agent-cli@2.2.2

## 1.1.4

### Patch Changes

- Updated dependencies [2b58616]
- Updated dependencies [6e1fcf3]
  - @agentproto/model-catalog@0.8.2

## 1.1.3

### Patch Changes

- Updated dependencies [08bcd4a]
  - @agentproto/driver-agent-cli@2.2.1

## 1.1.2

### Patch Changes

- Updated dependencies [4b6bbe6]
- Updated dependencies [3e187e5]
- Updated dependencies [492240c]
  - @agentproto/model-catalog@0.8.1
  - @agentproto/driver-agent-cli@2.2.0

## 1.1.1

### Patch Changes

- Updated dependencies [c825a12]
- Updated dependencies [980276e]
  - @agentproto/model-catalog@0.8.0

## 1.1.0

### Minor Changes

- 831d4f5: Implement route-selection axis for AIP-45 launch-menu drill-down (WP1): add declarative `routeSelection` field to adapter manifests (distinguishes "free" vs. "derived-from-model"), project it through resolve/runtime layers, enrich catalog with per-route `multiModel` flags and flat routes index for tier-pinning logic.

### Patch Changes

- 29042ca: Generate OpenCode model menu from shared provider catalog; add model-derived API key auth support and router-prefixed model ID handling across runtime and VS Code configuration UI.
- Updated dependencies [c736c02]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [c506d87]
- Updated dependencies [392021a]
- Updated dependencies [3865de6]
- Updated dependencies [5643cb6]
- Updated dependencies [358af0e]
- Updated dependencies [f1484a4]
- Updated dependencies [0f10338]
- Updated dependencies [ec5f64f]
- Updated dependencies [1ea7682]
- Updated dependencies [42f1217]
- Updated dependencies [4542ca3]
- Updated dependencies [c064bc7]
- Updated dependencies [4832ced]
  - @agentproto/driver-agent-cli@2.1.0
  - @agentproto/model-catalog@0.7.0

## 1.0.1

### Patch Changes

- Updated dependencies [cc00682]
  - @agentproto/driver-agent-cli@2.0.1

## 1.0.0

### Major Changes

- 92c1c51: Narrow AgentCliMode.kind to "context"; drop posture/route modes from claude-code, codex, opencode

### Patch Changes

- b16bb83: Add SessionConfig axes type + decomposeMode/composeMode shim (SPEC §3.1)
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [48c55d5]
  - @agentproto/driver-agent-cli@2.0.0

## 0.1.5

### Patch Changes

- Updated dependencies [dd3386d]
- Updated dependencies [2f8ba2d]
- Updated dependencies [68d3093]
  - @agentproto/driver-agent-cli@1.2.0

## 0.1.4

### Patch Changes

- 9cec8c5: Add structured models.allowed entries to fix gateway model mode binding in VS Code picker
- Updated dependencies [9cec8c5]
- Updated dependencies [8d73291]
  - @agentproto/driver-agent-cli@1.1.0

## 0.1.3

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

## 0.1.2

### Patch Changes

- 4c88fe1: Stop advertising Anthropic models in adapter model menus
- b65ca15: Fix opencode adapter crash when mode/model set via ACP config, not CLI flags
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
