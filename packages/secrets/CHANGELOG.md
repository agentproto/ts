# @agentproto/secrets

## 0.2.4

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

- Updated dependencies [7a96351]
- Updated dependencies [f0c51a7]
  - @agentproto/auth@1.0.1

## 0.2.3

### Patch Changes

- 76f2c78: Multi-surface external subscriptions — one adapter can now declare BOTH a Claude and a ChatGPT native OAuth login, so mastracode/opencode's subscription eligibility no longer forces an anthropic-or-openai choice. `authSubscription` accepts a single surface (unchanged) OR an array of surfaces, one per billing provider; two entries claiming the same provider scope (or two unscoped entries) are rejected at manifest-validation time rather than resolved arbitrarily at spawn time. The runtime's old `subscriptionAppliesTo` boolean predicate is replaced by `subscriptionSurfaceFor`, which resolves the MATCHING surface for a spawn's resolved provider — used by `resolveAuthSpec` and the three mirrored direct-methods projections (`session-spawn.ts`, `session-restart-core.ts`, `catalog-models.ts`) so they stay in lockstep. `verifyLocalLoginPresent` now takes an optional provision-recipe `methodId` (convention `<provider>-oauth`) so a multi-surface spawn verifies the RIGHT login file instead of always checking the recipe's default method. mastracode declares both `{external: true, provider: "anthropic"}` and `{external: true, provider: "openai"}` — its ChatGPT login (`openaiCodexOAuthProvider`) is stored in its own auth.json under the key `openai-codex`, verified live. opencode declares the same pair: its ChatGPT OAuth login was reverse-engineered from the shipped binary (no OSS source available for this build) and is keyed under the SAME `openai` provider id its API-key flow already uses — there is no separate "chatgpt" key, confirmed by tracing the binary's generic `Cli.providers.login` → `Auth.set(provider.id, …)` write path. Both adapters' provision recipes gained an `openai-oauth` method alongside the existing `anthropic-oauth` one.
- e3ad769: Claude subscription on pi/opencode/mastracode — each through the door that actually exists — and honest subscription eligibility everywhere. The runtime assumed "Anthropic OATs work as API keys" for every model-derived adapter and silently injected the subscription OAuth token into `ANTHROPIC_API_KEY`, where Anthropic's edge rejects it as an invalid key after the session is live (observed on opencode: "Internal error: API key is invalid"). Subscription support now requires an explicit, provider-matching `authSubscription` surface, shared across all four eligibility/resolution sites via one `subscriptionAppliesTo` predicate. pi declares its documented bearer env (`ANTHROPIC_OAUTH_TOKEN`, scoped `provider: "anthropic"`) so a Claude subscription profile runs pi's anthropic models natively. opencode and mastracode declare `external` anthropic-scoped subscriptions — each CLI's OWN Claude Pro/Max OAuth login (`opencode auth login`; mastracode's `/login`), backed by new `opencode`/`mastracode` provision recipes pointing at each CLI's auth store: the runtime verifies the login is present (fail-loud), injects nothing, and scrubs the api-key vars so a leftover key can't override it. Adapters/models with no matching surface fail fast at spawn with an actionable message instead of failing opaquely upstream, and the catalog stops advertising subscription profiles as runnable on them.

## 0.2.2

### Patch Changes

- Updated dependencies [8367648]
- Updated dependencies [6ff42b4]
- Updated dependencies [645279d]
- Updated dependencies [f3f5e82]
- Updated dependencies [655b4b6]
  - @agentproto/auth@1.0.0

## 0.2.1

### Patch Changes

- Updated dependencies [a0b94fd]
  - @agentproto/auth@0.2.0

## 0.2.0

### Minor Changes

- 6d4aa4b: Add E2E pairing: daemon identity, pair/v1 handshake, wrapE2E AEAD channel
- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- 8a4d5d5: Add opt-in E2E encryption for the serve --connect tunnel (tunnel-e2e/v1)
- 3639abd: Default pair offer to the hosted rendezvous broker when nothing is configured

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/auth@0.1.1
  - @agentproto/define-doctype@0.1.1

## 0.1.0

### Minor Changes

- fe13f4e: Add mcp-header SecretExposure variant and resolveMcpHeaderExposure
- e94757d: Add broker-resolved provision auth headers; export resolveProvisionHeaders and main

### Patch Changes

- 829a6c0: Document credential store, broker resolveHeaders, and mcp-header exposure
- Updated dependencies [c359894]
- Updated dependencies [829a6c0]
- Updated dependencies [547c796]
- Updated dependencies [83ce80f]
- Updated dependencies [c69d424]
- Updated dependencies [e94757d]
- Updated dependencies [d993560]
- Updated dependencies [9fe8586]
- Updated dependencies [da9f77a]
  - @agentproto/auth@0.1.0
