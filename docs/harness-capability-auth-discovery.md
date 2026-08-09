# Harness capability & auth discovery — design

**Status:** design / RFC · **Amends:** [`provider-kit.md`](./provider-kit.md),
[`file-based-subscription-login.md`](./file-based-subscription-login.md) ·
**Supersedes the fixed scan in:** `auth_discover_credentials`

> One-line thesis: each agent CLI already knows — in its *own* config/credential
> store — which providers, models, and custom endpoints it can reach. agentproto
> hand-encodes a lossy 1-provider projection of that in each adapter manifest.
> This design makes the CLI's native surface **discoverable**: a read-only,
> money-safe per-adapter contract that enumerates providers/credentials/models/
> endpoint-compat and feeds the auth-profile store + the billing guard.

---

## 1. Problem (grounded)

The adapter manifest is a hand-authored, static, lossy summary of a CLI's real
capability. Three failure modes, all observed on this host (2026-07-25):

1. **Stranded credentials.** `hermes` keeps a first-class multi-provider
   credential store at `~/.hermes/auth.json` (`credential_pool`) — on this host
   it holds `nous, copilot, openrouter, custom:moonshot, minimax, openai-api,
   gemini`. agentproto's hermes adapter wires **two** env vars
   (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`) and is blind to the rest. When the
   OpenRouter wallet hit 0 credits, hermes was fully dead **despite** having a
   live Moonshot key in its own pool.
2. **Single-wallet fragility & mis-routing.** Because the manifest bills hermes
   only through OpenRouter, the daemon's billing guard rejected a Moonshot spawn
   (`route "openrouter" … profile not eligible`), and `route.gateway=moonshot`
   failed because the hermes manifest declares no `base_url` option — even though
   hermes natively supports `providers.<name>.{base_url,key_env,api_mode}`.
3. **Drift.** For hermes, three layers each know less than the one below:
   manifest `models.env` (2 providers) ⊂ `SECRETS.md` slots (5) ⊂ hermes's own
   native providers (~16 + custom). Modes drift too (`HERMES.md` documents a
   `mode: moonshot` the runtime doesn't expose).

The narrow fix (add Moonshot to the hermes manifest) treats one symptom. The
systemic fix is to stop hand-maintaining the projection and **derive it from
each CLI's own source of truth.**

---

## 2. Ground truth — the fleet as-is

Sourced from each CLI's native config + adapter `src/index.ts` (2026-07-25).
"Wired" = what the agentproto adapter currently bills/routes. "Native" = what
the CLI itself supports.

| Adapter | Native auth store | Native providers | Native model discovery | Custom endpoint (native) | agentproto wires | Discoverable? |
|---|---|---|---|---|---|---|
| **hermes** | `~/.hermes/auth.json` `credential_pool` (per-provider, fingerprinted) + `config.yaml` `providers:` + `.env` | ~16: openrouter, nous(-api), anthropic, openai(-codex), gemini, zai/GLM, kimi-coding(-cn), minimax(-cn), bedrock, copilot, azure-foundry, lmstudio, moa, **custom** | `hermes model --refresh` (live `/v1/models`) + `provider_models_cache.json` | ✅ `providers.<n>.{base_url,key_env,api_mode,extra_headers}` | openrouter, openai | ✅ **live** (all 4 fields) |
| **opencode** | `~/.local/share/opencode/auth.json` `{provider:{type,key}}` + `opencode.jsonc` provider blocks | anthropic, openai, openrouter, groq, opencode-hosted, google, deepseek, xai, … (models.dev) | `opencode models` (command) | ✅ per-provider `options.baseURL` in `opencode.jsonc` | opencode, anthropic, openai, openrouter, groq | ✅ **parse+cmd** |
| **codex** | `~/.codex/{config.toml, auth.json}` (auth.json = api-key **and** ChatGPT OAuth, `auth_mode` selects) | OpenAI + ChatGPT-sub; `[model_providers.<id>]` custom | `models_cache.json` (cache); list-cmd unconfirmed | ✅ `[model_providers.<id>].{base_url,env_key,wire_api}` | openai, codex (+ ext ChatGPT sub) | 🟡 **mostly** |
| **claude-code** | macOS Keychain `Claude Code-credentials` + `~/.claude.json` + env | anthropic + any **Anthropic-wire** endpoint via `ANTHROPIC_BASE_URL` (Bedrock/Vertex/Foundry/gateways) | none (server entitlements cached in `~/.claude.json`) | ✅ `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN` (per-spawn option wired) | anthropic (+ OAuth sub) | 🟡 env yes, models no |
| **claude-sdk** | spawn env (`ANTHROPIC_API_KEY`/`_AUTH_TOKEN` + cloud toggles) | same as claude-code (Anthropic-wire) | none (SDK `options.model` free-form) | ✅ `--base-url`/`--auth-token`/`--thinking` | anthropic (+ sub) | 🟡 best env legibility, models no |
| **gemini** | `~/.gemini/{settings.json, oauth_creds.json, google_accounts.json}` | Google only (auth *modes*: OAuth personal / Gemini API key / Vertex) | none (adapter sources models from `@agstudio/model-catalog`) | 🟡 Vertex switch only, no arbitrary base_url | google, gemini (+ OAuth sub) | 🟡 auth yes, models docs-only |
| **openclaw** | `~/.openclaw/openclaw.json` (Gateway token) — provider keys **inside** OpenClaw (`auth.profiles`) | brokered by Gateway (opaque to adapter) | config `agents.defaults.models`; no adapter list | ❌ (internal to Gateway) | Gateway URL/token only — **no provider/model layer** | ⚠️ opaque broker |
| **pi** | spawn env (`~/.pi/agent/auth.json` empty) | anthropic, openai, google, moonshot | `--model provider/id` prefix; no list cmd | UNKNOWN / not exposed | anthropic, openai, google, moonshot | 🟡 run-cmd; auth=env |
| **mastracode** (print + inprocess) | env + native OAuth (Claude Max/ChatGPT) in Mastra Code's own store (headless arms use env) | anthropic, openai, openrouter, google | none (headless flags only) | ❌ not exposed (OpenRouter ≈ gateway) | anthropic, openai, openrouter, google | 🟡 run-cmd; OAuth store opaque |
| **mastra-agent** | spawn env via Mastra models.dev gateway (`model-resolver.ts` `PROVIDER_ENV` map) | openrouter, openai (+ resolver knows anthropic/google/groq/xai/mistral/deepseek) | validated pass-through to gateway; no enum | 🟡 via models.dev gateway routing only | openrouter, anthropic, openai | 🟡 code-legible env map |

### 2.1 Two hygiene bugs found in passing (pre-existing, fix alongside)
- **Plaintext key at rest:** `~/.config/opencode/opencode.jsonc`
  `provider.openrouter.api` holds an OpenRouter key in cleartext → rotate + move
  to `auth.json`/env.
- **Dangling `auth.ref`:** `adapters/claude-code` and `adapters/opencode`
  manifests point `auth.ref: "./SECRETS.md"` at a non-existent file (real docs
  are `CLAUDE-CODE.md` / `OPENCODE.md`).

---

## 3. Discovery archetypes

The payoff: you do **not** write 11 bespoke discoverers. The fleet collapses to
**five strategies**; each adapter picks one (+ a static-declared fallback).

- **A. Credential-pool + live model refresh** — `hermes`. Parse `auth.json`
  `credential_pool` → candidate profiles; `providers:` map → endpoint-compat;
  `hermes model --refresh`/cache → models. *Richest; fully live.*
- **B. Provider-keyed auth file + `models` command** — `opencode` (and `codex`
  as a degenerate 1-provider variant). Parse `auth.json` map + run the CLI's
  model-list command; provider blocks → endpoint-compat.
- **C. Single-endpoint gateway (env contract)** — `claude-code`, `claude-sdk`.
  No provider *enumeration*; discovery yields one Anthropic-wire endpoint + the
  `base_url`/`auth_token` contract. Models stay free-form.
- **D. Single-vendor auth-mode** — `gemini`. Discover the active auth *mode*
  from `settings.json`/`oauth_creds.json`; models come from the agentproto
  catalog (no native list). This is exactly the `file-based-subscription-login`
  case, generalized.
- **E. Env-slot passthrough, prefix-routed** — `pi`, `mastracode`,
  `mastra-agent`. Provider = model-id prefix; creds = declared env slots; the
  adapter's `PROVIDER_ENV`/`models.env` map *is* the machine-readable source.
- **(F. Opaque broker)** — `openclaw`. Provider layer lives inside the Gateway;
  discovery reports `{ broker: true }` and stops. Optional later: read
  `~/.openclaw/openclaw.json` `auth.profiles` if we choose to see through it.

### 3.1 mastracode — a reference case for the *application* axis

mastracode's **discovery** is plain archetype E (env-slot providers: anthropic,
openai, openrouter, google). It earns a dedicated reference implementation
because its **model/mode application** is unlike any other adapter and is
currently a hack that this design should retire:

- **print arm** (ephemeral): mode → `--mode <x>` argv, model → `--model <id>`
  argv. Both re-applied on every spawn, so posture and model compose cleanly.
- **in-process arm** (live, resumable): there is **no argv and no ACP
  `set_config_option`** for the mode. Mode is smuggled via the
  `AGENTPROTO_MASTRACODE_MODE` env var, which `client.ts` reads off the composed
  env and applies to the **live session's mode before `send()`**. Model/effort
  ride the generic `config.options` passthrough.

Consequence: on a live in-process session, **model and mode(=posture) are
coupled**. Applying a model mid-session MUST re-apply it *under the current
posture* (plan/accept-edits/build/fast → mastracode mode), not reset the mode —
and today that coupling exists only as the env-patch-before-`send()` hack, not a
first-class channel. The capability layer should therefore carry, alongside the
provider/model descriptor, an **application contract**: `{ modelApply,
postureApply, coupled: boolean }`. For mastracode `coupled: true` — a model set
resolves against the session's current posture. See OQ-6.

---

## 4. Design

### 4.1 The normalized descriptor

```ts
// packages/provider-kit (new module: capability.ts)
interface HarnessCapabilities {
  adapter: string
  source: "discovered" | "manifest-fallback"   // provenance, always stamped
  discoverable: "live" | "parse" | "declared"

  authStores: AuthStore[]
  providers: ProviderCapability[]
  models: ModelDiscovery
  endpointCompat: EndpointCompat            // openai? / anthropic?
}

interface AuthStore {
  kind: "keychain" | "file" | "oauth-file" | "env" | "gateway"
  path?: string                              // never a secret value
  format?: "json" | "yaml" | "toml"
  providerKeyed: boolean                     // does one store hold N providers?
}

interface ProviderCapability {
  id: string                                 // hermes: "custom:moonshot", opencode: "zai"
  billingEndpoint: string                    // normalized: "moonshot" | "openrouter" | ...
  cred: { present: boolean; source: CredSource; fingerprint?: string; last4?: string }
  baseUrl?: string                           // if the CLI pins one (never the key)
  apiMode?: "anthropic" | "chat_completions"
}
type CredSource =
  | { kind: "env"; var: string }
  | { kind: "file"; path: string; pointer: string }   // e.g. auth.json#/credential_pool/moonshot
  | { kind: "keychain"; service: string }
  | { kind: "oauth-file"; path: string }

interface ModelDiscovery {
  mechanism: "command" | "file-cache" | "catalog" | "free-form"
  ref?: string                               // "hermes model --refresh" | "~/.hermes/provider_models_cache.json"
  ids?: string[]                             // when enumerable
  stale?: boolean
}
```

**Non-negotiable:** the descriptor carries **fingerprints/refs/last4 only, never
a secret value** — mirrors `auth_profile_list`. Discovery is a *read model*.

### 4.2 The contract (extends provider-kit's `AdapterHandle`)

`provider-kit.md` already defines `AdapterHandle.check(): Promise<boolean>`. Add
an optional discovery method on the **agent-CLI** family handle
(`AgentCliHandle`), so browser/tunnel families are unaffected:

```ts
interface AgentCliHandle extends AdapterHandle {
  // ...existing (commands, models, protocol, streaming, setup[])
  /** Read-only. Best-effort. MUST NOT throw, spend, or mutate CLI state.
   *  Returns manifest-derived defaults when the native store is absent. */
  discoverCapabilities?(ctx: DiscoverCtx): Promise<HarnessCapabilities>
}
```

Shared strategy helpers live in provider-kit so adapters stay ~10 lines each:

```ts
parseCredentialPool(path)              // archetype A (hermes)
parseProviderKeyedAuthFile(path, map)  // archetype B (opencode, codex)
runModelListCommand(cmd, { cacheFile, ttl })   // A/B model discovery
declaredFromManifest(handle)           // archetype E + universal fallback
probeKeychain(service)                 // archetype C (claude-code) — GATED, opt-in
```

### 4.3 Precedence & merge (additive, never silent re-bill)

`effective = merge(discovered, manifestDeclared)` where:
- discovery may **widen** the provider set and **annotate** credential presence;
- discovery may **never** remove a manifest provider or change a billing
  endpoint silently — a discovered provider is *offered*, activation is explicit;
- `source` is always stamped so callers can distinguish derived vs hand-declared.

### 4.4 Where it plugs in

1. **`auth_discover_credentials` → adapter-delegating.** Today it scans a fixed
   file/env list. New behaviour: for each resolved adapter handle, call
   `discoverCapabilities()` and union the results. Hermes's `credential_pool`
   and opencode's `auth.json` become visible without touching the tool's caller
   contract.
2. **Auth-profile store (`auth_profile_import`).** Extend the `origin` enum to
   be **adapter-scoped** (`origin: "hermes-pool" | "opencode-authjson" | …`) so a
   discovered `ProviderCapability.cred` can be materialised into an agentproto
   profile with the correct `billingEndpoint`. This is the direct fix for "fetch
   the auth profile for a provider from hermes" — the pool entry *is* the
   profile.
3. **Billing guard / route resolver** — *revised after reading the guard source
   (`catalog-models.ts:720`, `auth/eligibility.ts:84`, `session-spawn.ts:1157,
   1412,1459`).* There are **two** guards, neither reading `models.env`:
   - **Guard A** — `checkModelWalletEligibility(model, walletRoute)`: money-safety
     over `@agentproto/model-catalog` route tables. Unknown model ⇒ passes;
     rejects only a model serviceable on some route but not the *resolved wallet*
     (`resolvedProvider = descriptor.provider ?? getModelProvider(model)`).
     Disabled when `route.gateway` is set.
   - **Guard B** — `eligibleProfiles(profiles, manifest, route)`: matches a passed
     `access.profileRef` against the route's endpoint, from the
     `AdapterAuthDescriptor` projection (`spawnEligibilityManifest`).

   Discovery does **not** rewrite these (money-safety stays put). Its role is
   twofold: **(i)** *enrich the rejection* — when Guard A/B reject, cross-ref
   `verdict.suggestedRoutes` against discovered creds / existing profiles and
   tell the operator "hermes has an importable `moonshot` credential in its pool;
   import it + re-spawn `route.gateway=moonshot`" (the scout's own integration
   note); **(ii)** *supply the profile + the adapter route surface* — discovery
   materialises the hermes-pool moonshot cred into an eligible profile (satisfies
   Guard B) and surfaces `providers.moonshot.base_url` so the hermes adapter can
   declare the moonshot route/gateway option (so `route.gateway=moonshot` no
   longer injects an undeclared `base_url`). "hermes bills moonshot" becomes true
   via profile + declared-route, **not** by flipping a catalog check.
4. **`catalog_models` / `adapter_list`.** Model lists come from
   `ModelDiscovery` (live/cache) where the archetype supports it, falling back
   to the static catalog for gemini/claude-shaped adapters.

### 4.5 New/changed MCP surface

- `harness_capabilities({ adapter? })` — returns the normalized descriptor(s);
  pure read model, no secrets.
- `auth_discover_credentials` — same signature, now adapter-delegating.
- `auth_profile_import` — `origin` widened to adapter-scoped discovery sources.

---

## 5. Money-safety invariant (inherited from `file-based-subscription-login`)

Discovery is **read-only and never spends or switches wallets.** It surfaces
"hermes has a moonshot key in its pool" and *offers* to register it; billing
attribution stays explicit. Concretely:
- never write a discovered secret into an env channel of a *different* billing
  kind (the OAuth-into-api-key failure the login surface exists to prevent);
- the billing guard keeps its "only rejects, never switches for you" stance —
  discovery just gives it a truer eligibility set to check against;
- keychain probing (`claude-code`) is **opt-in and consent-gated** — never
  auto-`security find-generic-password` on a plain list call.

---

## 6. Rollout (non-breaking)

- **Phase 1 — descriptor + contract + three reference archetypes.** Ship
  `HarnessCapabilities` + `AgentCliHandle.discoverCapabilities?` + helpers, and
  implement the **richest** (hermes, archetype A), the **poorest** (gemini,
  archetype D), and **mastracode** (archetype E for discovery, but the reference
  case for the *application contract* / posture-coupled model-set — §3.1, OQ-6)
  to prove both the discovery range *and* the application axis. Manifests stay
  authoritative; discovery is additive and unused by default.
- **Phase 2 — adapter-delegate `auth_discover_credentials`, enrich the guards,
  declare the hermes moonshot route.** Three coordinated moves: (a) replace the
  fixed scan lists in `credential-discovery.ts` with adapter-delegated probes
  (add `hermes-pool` reading `~/.hermes/auth.json` `credential_pool`,
  `opencode-authjson`); (b) `auth_profile_import` gains those adapter-scoped
  `origin`s (6 touch points, §7 of scout) so a pool entry materialises into a
  Guard-B-eligible profile; (c) enrich the Guard-A/B rejection to name the
  importable cred, and give the hermes adapter a declared moonshot route
  (base_url option / preset) so `route.gateway=moonshot` stops injecting an
  undeclared option. This is the phase that unblocks hermes-on-Moonshot and kills
  single-wallet fragility.
- **Phase 3 — remaining archetypes** (opencode/codex B, claude-* C, pi/mastra E)
  + fix the two hygiene bugs (§2.1). Begin treating `models.env` as a *fallback*
  under the discovered∪declared merge.
- **Phase 4 — `harness_capabilities` MCP + adapter-scoped `auth_profile_import`
  origins.** Full read model + one-click "import this CLI's providers as
  agentproto profiles".

---

## 7. Risks / open questions

- **OQ-1 (cache the live refresh).** `hermes model --refresh` and
  `opencode models` hit provider APIs / spawn the binary. Discovery must read
  the on-disk cache by default and refresh only on explicit demand (TTL), or a
  `list` call fans out N slow probes. Mirror provider-kit OQ-2: keep the list
  path cheap; probes are opt-in.
- **OQ-2 (env-var splits are load-bearing).** Preserve, don't normalise:
  `mastracode-print` reads `GOOGLE_API_KEY` while `-inprocess`/pi read
  `GOOGLE_GENERATIVE_AI_API_KEY`; hermes moonshot is `KIMI_API_KEY`
  (`kimi-coding`) not `MOONSHOT_API_KEY`. The descriptor's `CredSource.var` must
  carry the *exact* var each code path reads.
- **OQ-3 (opaque brokers).** For `openclaw`, do we see through the Gateway
  (`~/.openclaw/openclaw.json` `auth.profiles`) or treat it as a black box?
  Recommend black box for v0 (`{ broker: true }`); the Gateway owns its own
  provider governance.
- **OQ-4 (secrets discipline).** Discovery reads credential *stores*. It must
  emit only fingerprints/refs/last4 and be audited to never log a value — same
  bar as `auth_profile_list`. The opencode plaintext-key finding shows how easy
  an incidental leak is.
- **OQ-5 (provenance vs trust).** A discovered provider is a *claim* from the
  CLI's config, not proof the key works. `cred.present` means "a credential
  exists", not "it has balance". Keep the guard's job (eligibility) separate from
  liveness (the 402 we hit is a runtime truth discovery can't predict).
- **OQ-6 (application axis — the mastracode posture-coupled model-set).** The
  capability layer is *discovery*, but mastracode forces an adjacent question:
  how is a model/posture *applied* to a live session? mastracode-inprocess has
  no ACP config channel, so mode rides `AGENTPROTO_MASTRACODE_MODE` +
  patch-before-`send()`, and a mid-session model-set must resolve **under the
  current posture** (`coupled: true`). Options: **(A, recommended)** add an
  `applicationContract: { modelApply, postureApply, coupled }` to the capability
  descriptor and give mastracode a real "set model under current posture"
  channel (mastracode SDK `runMC` option or a proper `set_config_option`),
  retiring the env hack. **(B)** leave application in the adapter and only
  *describe* the coupling in the descriptor (doc-only). Recommend A — it's the
  reason mastracode is a Phase-1 reference; the hack is exactly what "properly"
  should replace.

---

## 8. What this unblocks (tie-back)

The thread that started this: *does hermes pick up the injected orchestration
gateway, and why couldn't we test it?* The gateway **is** injected (confirmed).
The test was blocked by three plumbing walls, now precisely located:
1. **Guard A** rejected `moonshot/kimi-k2.7-code` because the resolved wallet was
   `openrouter` (`getModelProvider` off the hermes descriptor) and the model
   isn't serviceable there (`catalog-models.ts:720`, call-site
   `session-spawn.ts:1412`).
2. `route.gateway=moonshot` then injected a `base_url` adapter option hermes
   doesn't declare (`session-spawn.ts:1459`) → downstream reject.
3. profile-only tripped **Guard B** — hermes's route projects to `openrouter`,
   so a `moonshot`-endpoint profile is ineligible (`session-spawn.ts:1157`,
   `auth/eligibility.ts:84`).

Under this design, Phase 2 (a) materialises the Moonshot cred from hermes's
`credential_pool` into a Guard-B-eligible `moonshot` profile, and (b) gives the
hermes adapter a declared moonshot route so `route.gateway=moonshot` is honoured
without an undeclared-option reject (Guard A is already off once a gateway is
named). hermes then runs on its own configured Moonshot provider and the
orchestration behaviour test completes with **no OpenRouter top-up and no
wrong-slot import** — discovery supplies the profile + route surface, it does not
weaken either guard.
