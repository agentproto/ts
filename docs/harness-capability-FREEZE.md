# Harness capability discovery — frozen interfaces & WP breakdown

Companion to [`harness-capability-auth-discovery.md`](./harness-capability-auth-discovery.md).
All anchors verified against source 2026-07-25. **Frozen** = executors build to
these signatures; changing one is a design change, not an implementation choice.

Repo root: `projects/agentproto/ts`. Ignore `.claude/worktrees/*` (stale).

---

## 0. Load-bearing facts (from scout, don't re-derive)

- `provider-kit` is real/built (v0.3.0), consumed widely. New module drops in.
  Src: `packages/provider-kit/src/{types,creds-store,ledger,list-resolve,mcp-tools,status,wizard,discover,index}.ts`.
- `AdapterHandle` base: `packages/provider-kit/src/types.ts:76-99`.
- `AgentCliHandle = Readonly<AgentCliDefinition>`: `packages/driver/agent-cli/src/types.ts:746`; the rich surface (`provider`, `routeSelection`, `models{env,allowed,deny,apply}`, `auth.state.env`, `modes`, `options`, `capabilities`) is on `AgentCliDefinition` (`types.ts:629-744`). **Not** a structural `AdapterHandle`.
- Runtime never parses `<NAME>.md`; handles come from `defineAgentCli({...})` in each adapter's `src/index.ts`. `.md` is an AIP sidecar.
- Adapter discovery: `collectAgentprotoNamespaceRoots` (`provider-kit/src/discover.ts:32`) → `listInstalledAdapters` (`cli/src/registry/resolve.ts:511`) → `resolveAdapter(slug)`.
- `adapter_list`/`catalog_models` tools: `packages/runtime/src/agent-tools.ts:1344/1441`; HTTP mirrors + lister types in `http-server.ts` (`AgentAdapterLister` etc.).
- **Two guards, money-safety** (do NOT weaken):
  - Guard A `checkModelWalletEligibility(model, walletRoute)` — `catalog-models.ts:720`; reads `@agentproto/model-catalog` via `serviceableModelRoutes` (`:622`); call-site `session-spawn.ts:1412` (unnamed-wallet only); restart `session-restart-core.ts:410`.
  - Guard B `eligibleProfiles(profiles, manifest, route)` — `auth/eligibility.ts:84`; manifest from `spawnEligibilityManifest` (`session-spawn.ts:172`); call-site `session-spawn.ts:1157`.
  - Wallet resolve: `session-spawn.ts:1278` (`resolvedProvider = pin ?? descriptor.provider ?? getModelProvider(model)`); `resolveAuthSpec` `spawn-defaults.ts:405`.
  - `base_url` reaches an adapter ONLY as an injected option (`session-spawn.ts:1459`), validated vs `resolved.declaredOptions`; hermes rejects it (no such option declared).
- Discovery scanner today: `packages/runtime/src/credential-discovery.ts` (fixed const lists `:51,176,187,194`; DI seam `CredentialDiscoveryDeps:76`; presence-only, never value, never throw). Import dispatcher `planCredentialImport:405`.
- Import tool + origin enum: `auth-profile-tools.ts:328` (`origin` zod enum `:342`). Profile store `packages/auth/src/profile-store.ts` (`~/.agentproto/auth-profiles.json`, 0600); masking `profile-provision.ts:222/247` (`AuthProfile.origin` is free `z.string()`, `profile-store.ts:51` — no schema change to add origins).

---

## 1. Phase 1 — FROZEN interfaces

### 1.1 New module `packages/provider-kit/src/capability.ts`

```ts
// ——— normalized descriptor (read-model; NEVER carries a secret value) ———
export interface HarnessCapabilities {
  adapter: string
  source: "discovered" | "manifest-fallback"
  discoverable: "live" | "parse" | "declared"
  authStores: AuthStore[]
  providers: ProviderCapability[]
  models: ModelDiscovery
  endpointCompat: EndpointCompat
  application: ApplicationContract      // §3.1 of design (mastracode)
}

export interface AuthStore {
  kind: "keychain" | "file" | "oauth-file" | "env" | "gateway"
  path?: string                         // never a value
  format?: "json" | "yaml" | "toml"
  providerKeyed: boolean
}

export interface ProviderCapability {
  id: string                            // native id, e.g. "custom:moonshot", "zai"
  billingEndpoint: string               // normalized: "moonshot" | "openrouter" | ...
  cred: {
    present: boolean
    source: CredSource
    fingerprint?: string                // sha256(secret).slice(0,12) — mirror profile-provision.ts:222
    last4?: string                      // only when secret length >= 8
  }
  baseUrl?: string                      // if the CLI pins one; never the key
  apiMode?: "anthropic" | "chat_completions"
}

export type CredSource =
  | { kind: "env"; var: string }
  | { kind: "file"; path: string; pointer: string }
  | { kind: "keychain"; service: string }
  | { kind: "oauth-file"; path: string }

export interface ModelDiscovery {
  mechanism: "command" | "file-cache" | "catalog" | "free-form"
  ref?: string
  ids?: string[]
  stale?: boolean
}

export interface EndpointCompat {
  openai?: { via: "env" | "config-block" | "per-spawn-option"; key: string }
  anthropic?: { via: "env" | "config-block" | "per-spawn-option"; key: string }
}

export interface ApplicationContract {
  modelApply: "config" | "command" | "arg"     // mirrors AgentCliModels.apply
  postureApply: "arg" | "env" | "config" | "none"
  coupled: boolean                              // mastracode-inprocess = true
}

// ——— strategy contract (adapter-owned native readers) ———
export interface DiscoverCtx {
  homeDir: string
  env: Record<string, string | undefined>
  readFile(path: string): Promise<string | null>   // returns null on ENOENT; never throws
  runCommand?(cmd: string, args: string[], opts?: { ttlMs?: number }): Promise<string | null>
  keychainLookup?(service: string): Promise<boolean>
  warn(msg: string): void
}
export type CapabilityStrategy = (
  def: Readonly<AgentCliDefinition>,
  ctx: DiscoverCtx,
) => Promise<HarnessCapabilities>

// ——— universal fallback: derives from manifest data alone (archetype E + default) ———
export function deriveDeclaredCapabilities(
  def: Readonly<AgentCliDefinition>,
): HarnessCapabilities   // source:"manifest-fallback", discoverable:"declared"

// ——— resolve: strategy(slug) ?? fallback ———
export function discoverCapabilities(
  def: Readonly<AgentCliDefinition>,
  strategy: CapabilityStrategy | undefined,
  ctx: DiscoverCtx,
): Promise<HarnessCapabilities>   // best-effort; catches strategy throw → fallback
```

Barrel: add re-exports to `provider-kit/src/index.ts` type block (`:11-20`). Deep
subpath optional — add `"./capability"` to `package.json` exports (`:27`) +
`tsup.config.ts` entry only if a consumer deep-imports; the `.` barrel suffices
for types.

Import `AgentCliDefinition` type-only from `@agentproto/driver-agent-cli`
(provider-kit already depends on the agent-CLI family at the `cli` seam; if a
cycle appears, define capability.ts to take a **structural** subset interface
`{ id, provider?, routeSelection?, models?, auth?, options?, modes? }` instead of
the concrete type — PREFERRED to avoid a provider-kit→driver dep).

### 1.2 Adapter-owned strategies (three reference archetypes)

Each adapter package exports an optional strategy alongside its handle:
`adapters/hermes/src/index.ts` → `export const hermesCapabilities: CapabilityStrategy`.
Collected by slug the same way handles are (extend `resolveAdapter` to also read
`mod[camel+"Capabilities"]`, `cli/src/registry/resolve.ts:470`).

- **hermes (archetype A):** parse `~/.hermes/auth.json` `credential_pool` →
  `providers[]` (id, billingEndpoint, cred.present+fingerprint, baseUrl from
  `providers.<n>.base_url`); models from `~/.hermes/provider_models_cache.json`
  (`mechanism:"file-cache"`, ref = `hermes model --refresh`, stale if old);
  endpointCompat from `providers.<n>.{base_url,api_mode}`. `discoverable:"live"`.
- **gemini (archetype D):** read `~/.gemini/settings.json`
  `security.auth.selectedType` + `oauth_creds.json` presence → single google
  provider + auth-mode; `models: { mechanism:"catalog" }` (no native list).
  `discoverable:"parse"` for auth, catalog for models.
- **mastracode (archetype E + application):** providers from the declared
  `models.env` map (`deriveDeclaredCapabilities` covers discovery); the reference
  value is `application: { modelApply:"command"|"arg", postureApply:"arg"(print)|"env"(inprocess), coupled: <inprocess?true:false> }`.

### 1.3 `harness_capabilities` MCP tool

Register in `packages/runtime/src/agent-tools.ts` beside `adapter_list`
(`:1344`). New injected lister option next to `listAgentAdapters` (`:143`); HTTP
type beside `AgentAdapterLister` in `http-server.ts:351`. Params
`{ adapter?: string }`; returns `{ capabilities: HarnessCapabilities[] }`. Lister
impl in `cli` next to `listInstalledAdapters` (`resolve.ts:511`): for each
resolved adapter, call `discoverCapabilities(def, strategy, ctx)`.

**Invariant:** the tool output is a read-model — assert (test) it never contains
a secret value; only fingerprints/last4/refs. Mirror `credential-discovery.ts:13-19`.

---

## 2. Phase 2 — FROZEN integration points

1. **Adapter-delegate `auth_discover_credentials`** (`credential-discovery.ts`):
   keep the DI seam + presence-only + never-throw invariants. Add probes:
   `hermes-pool` (read `~/.hermes/auth.json` `credential_pool`, emit one
   `DiscoveredCredential` per pooled provider), `opencode-authjson`
   (`~/.local/share/opencode/auth.json` provider map). Prefer sourcing recipes
   from the capability strategies (Phase 1) over new const arrays. Tests:
   `credential-discovery.test.ts`.
2. **`auth_profile_import` new origins** — 6 touch points (scout §4):
   `CredentialOrigin` union (`credential-discovery.ts:51`), zod enum
   (`auth-profile-tools.ts:342`), a probe/scan entry, a `planCredentialImport`
   branch (`:405` — decides `method`; hermes-pool = `api-key` copy from the
   pooled env/source, endpoint = the pooled provider's billingEndpoint),
   `resolveCopyValue` if a new `via` (`:446`), tests. No profile-schema change
   (`AuthProfile.origin` is free string).
3. **Guard enrichment (money-safety UNCHANGED)** — at Guard A `!ok`
   (`session-spawn.ts:1412`) and Guard B ineligible (`:1157`), append to the
   message: which discovered cred / existing profile satisfies
   `verdict.suggestedRoutes` (call `discoverCredentials`/`listAuthProfiles`,
   read-only). Do **not** alter the verdict. Tests:
   `spawn-model-eligibility.test.ts`, `eligibility.test.ts`.
4. **hermes moonshot route** — give `adapters/hermes` a declared way to accept
   `route.gateway=moonshot` without the undeclared-`base_url` reject
   (`session-spawn.ts:1459`). Option: declare a `base_url` option (mirror
   `adapters/claude-sdk` option) OR a moonshot preset/mode. Add `moonshot` to
   hermes `models.env` so the eligible endpoint resolves. Keep Anthropic denied.
5. **End-to-end**: import hermes-pool moonshot → profile; spawn hermes
   `route.gateway=moonshot access.profileRef=<that>` → runs → confirm the
   orchestration-gateway behaviour test (spawns a background sub-session).

---

## 3. WP breakdown (disjoint, for parallel executors)

- **WP1 (kit core):** `capability.ts` types + `deriveDeclaredCapabilities` +
  `discoverCapabilities` + barrel export + unit tests. No adapter/runtime deps.
- **WP2 (strategies):** hermes/gemini/mastracode strategy exports + native-store
  readers + tests. Depends on WP1 types only.
- **WP3 (runtime tool):** `harness_capabilities` tool + lister + HTTP type +
  `resolveAdapter` capability pickup. Depends on WP1.
- **WP4 (Phase 2 discovery+import):** adapter-delegated `credential-discovery` +
  new import origins + tests. Depends on WP1/WP2.
- **WP5 (Phase 2 guard+hermes-route):** guard enrichment + hermes moonshot route
  declaration + e2e. Depends on WP4. **Single-writer, supervised** (touches
  money-safety files — no parallel edits here).

Order: WP1 → {WP2, WP3} parallel → WP4 → WP5. WP5 last and alone.

---

## 4. Non-negotiable invariants

- Discovery READS; never spends, never switches wallets, never writes a secret
  into a different-billing-kind channel.
- Descriptors/logs carry fingerprint/last4/ref only — never a secret value.
  Add an explicit test asserting this per new surface.
- Guards A/B verdicts are unchanged; discovery only enriches messages + supplies
  profiles/route surface.
- Manifests stay authoritative in Phase 1 (`source:"manifest-fallback"` default);
  discovery is additive.
- Preserve exact env-var identities (google split, hermes `KIMI_API_KEY`).
