/**
 * Pure resolver for `~/.agentproto/config.json`'s `defaults` block —
 * computes the effective `skills` + `options` + `auth` for an `agent_start`
 * spawn before adapter-specific normalization. No fs, no adapter I/O, so
 * it's unit-testable in isolation from `session-spawn.ts` (which owns the
 * fs read + the adapter-manifest lookup).
 *
 * Precedence (lowest → highest): global `defaults` < `defaults.adapters.
 * <slug>` < the explicit `agent_start` call.
 *   - `options`: shallow-merged maps, later (higher-precedence) keys win.
 *   - `skills`: global ∪ per-adapter when the caller didn't pass `skills`
 *     at all; an explicit `skills` (even `[]`) REPLACES the union rather
 *     than merging into it — a deliberate exact set, mirroring how an
 *     explicit `mcpServers: []` opts out of the hermes default in
 *     `session-spawn.ts`.
 *   - `auth`: surfaces the RAW billing-auth material (requested mode, both
 *     candidate credentials, per-spawn provider pin, and the `explicit`
 *     signal) so the descriptor-aware resolver ({@link resolveAuthSpec},
 *     which also needs the adapter's provider/subscription descriptor +
 *     providers.json) can decide the final mode, env var, scrub set, and
 *     credential source. Credentials are named in config or the provider
 *     store — never read from the ambient shell env.
 */

import { getModelProvider } from "@agentproto/model-catalog/llm"
import type { CatalogProvider } from "@agentproto/model-catalog"
import { resolveCustomRoute } from "@agentproto/model-catalog/route-identity"
import { findAnthropicGatewayPreset } from "@agentproto/provider-presets"
import { providerEnvVar } from "./providers-store.js"

/**
 * Deterministic billing-auth config for one adapter slug (today, only
 * claude-code interprets it — see `AgentCliStartOptions.auth` in
 * `@agentproto/driver-agent-cli`). EXPLICIT credential selection, not
 * scrub-by-absence: `token`/`apiKey` are the actual secret values, named
 * here (or supplied per-spawn) rather than inherited from the launching
 * shell. Never logged; only a fingerprint (see {@link credentialFingerprint})
 * is ever surfaced back to a caller.
 */
export interface DefaultsAdapterAuthConfig {
  /** `"subscription"` or `"api-key"`. Omitted ⇒ the resolver picks by
   *  ordered preference (subscription first for adapters that support it —
   *  see {@link resolveAuthSpec}), never a hardcoded default. */
  mode?: "subscription" | "api-key"
  /** The subscription bearer token for `"subscription"` mode — minted via
   *  `claude setup-token` (bills the Max/Pro subscription, not API credits),
   *  SET to the adapter's `authSubscription.setEnv`. */
  token?: string
  /** Opt-in SELF-REFRESHING subscription source (Mode 3). When set to
   *  `"claude-code-oauth"` and no static `token` is supplied per-spawn, the
   *  subscription bearer is read FRESH on every spawn from the local Claude
   *  Code login (macOS Keychain `Claude Code-credentials` → jsonPath
   *  `claudeAiOauth.accessToken`, falling back to `~/.claude/.credentials.json`)
   *  via the `claude-code-oauth` provision recipe — because Claude Code keeps
   *  that item refreshed, agentproto gets a fresh token each spawn. Absent ⇒
   *  today's static-bearer behavior (Mode 2). Only `"claude-code-oauth"` is
   *  understood; any other value fails LOUD (never a silent fallthrough). See
   *  {@link resolveSubscriptionCredential} for the precedence with `token`. */
  source?: string
  /** Explicit API key for `"api-key"` mode, SET to `providerEnvVar(provider)`.
   *  Wins over the `providers.json` store key for the same provider. */
  apiKey?: string
  /** Per-spawn provider PIN — overrides the adapter's fixed provider and the
   *  model-derived provider (the sharp edge for by-model routers whose config
   *  routes a catalog-"anthropic" model elsewhere). A `CatalogProvider` id. */
  provider?: CatalogProvider
}

export interface DefaultsAdapterConfig {
  skills?: string[]
  options?: Record<string, boolean | number | string>
  auth?: DefaultsAdapterAuthConfig
}

/** Shape of `config.json`'s top-level `defaults` block. */
export interface SpawnDefaultsConfig {
  skills?: string[]
  options?: Record<string, boolean | number | string>
  adapters?: Record<string, DefaultsAdapterConfig>
  /** Depth cutoff for the role-derived default (see `resolveRole` in
   *  `role.ts`) applied when an `agent_start` call omits `role`:
   *  `depth < cutoff` → supervisor, `depth >= cutoff` → executor.
   *  Default 1 (root spawns keep today's unrestricted behaviour; any
   *  spawn made THROUGH an orchestrator defaults to executor). Tune
   *  this up (e.g. to a large number) to restore the old permissive
   *  behaviour for existing deep spawns wholesale. */
  defaultRoleDepthCutoff?: number
  /** Trust-boundary cap on pack-carried roles (see `role-registry.ts`'s
   *  `loadRoleRegistry`): a role pack whose `toolPolicy.delegation` is
   *  `"allow"` at a level ABOVE this cap has it forced to `"deny"` —
   *  the pack can still declare the intent, the daemon just refuses to
   *  grant it. Lets an operator install third-party role packs without
   *  trusting every one of them to self-grant delegation. Undefined
   *  (default) ⇒ no cap, any pack-declared level may carry
   *  `delegation: "allow"` (back-compat: #214 had no such knob). */
  maxGrantableDelegation?: number
  /** Default per-session Langfuse tracing opt-in when an `agent_start` call
   *  omits `trace`. Default false — sessions trace only when they opt in or
   *  this is on. See `filterSessionObserver` / `SpawnAgentInput.trace`. */
  langfuseTracing?: boolean
  /** Redactor slug applied to traced session content before it's sent to
   *  Langfuse (see `@agentproto/redaction`'s registry). Default "secrets"
   *  (deny-list by key + value-scan for secret shapes). */
  traceRedactor?: string
}

export interface ResolveSpawnDefaultsInput {
  /** Explicit-call `skills`. Undefined ⇒ caller expressed no preference,
   *  fall through to the config union. Provided ⇒ replaces it outright. */
  skills?: string[]
  /** Explicit-call AIP-45 `options` map — wins per-key over both the
   *  global and per-adapter config defaults. */
  options?: Record<string, boolean | number | string>
  /** Explicit-call `agent_start.auth` override. `mode` wins over
   *  `defaults.adapters.<slug>.auth.mode`; the credential field matching the
   *  RESOLVED mode wins over the matching config field. Undefined ⇒ falls
   *  through entirely to the per-adapter config default. */
  auth?: DefaultsAdapterAuthConfig
}

export interface ResolvedSpawnDefaults {
  skills: string[]
  options: Record<string, boolean | number | string>
  /** RAW billing-auth material (config precedence applied) — fed to the
   *  descriptor-aware {@link resolveAuthSpec}, which owns the final mode /
   *  env / scrub / credential-source decision. Both candidate credentials
   *  are surfaced (NOT collapsed to one), since the ordered-mode selection
   *  needs to know which are available before it picks the mode. */
  auth: ResolvedSpawnAuthMaterial
}

export interface ResolvedSpawnAuthMaterial {
  /** Operator-requested mode (per-spawn > per-adapter config), or undefined
   *  ⇒ let the resolver pick by ordered preference. */
  requestedMode?: "subscription" | "api-key"
  /** True when the operator explicitly configured `auth` (per-spawn OR in
   *  `defaults.adapters.<slug>.auth`). The ONLY way to tell "set mode, no
   *  key" (fail-fast) from "set nothing" (ambient) — both give no credential.
   *  DECISION 5. */
  explicit: boolean
  /** Subscription bearer token (per-spawn > config), if configured. STATIC
   *  material only — the self-refreshing {@link subscriptionSource} is resolved
   *  separately (and impurely) by the caller. */
  subscriptionCredential?: string
  /** Opt-in self-refreshing subscription source (per-spawn > config), if
   *  configured — e.g. `"claude-code-oauth"`. Surfaced RAW; the impure caller
   *  resolves it to a fresh token via {@link resolveSubscriptionCredential}. */
  subscriptionSource?: string
  /** Explicit API key (per-spawn > config), if configured — distinct from the
   *  providers.json store key the resolver fetches separately. */
  apiKeyCredential?: string
  /** Per-spawn provider pin, if given. */
  provider?: CatalogProvider
}

export function resolveSpawnDefaults(
  defaults: SpawnDefaultsConfig | undefined,
  adapterSlug: string,
  input: ResolveSpawnDefaultsInput,
): ResolvedSpawnDefaults {
  const adapterDefaults = defaults?.adapters?.[adapterSlug]

  const options: Record<string, boolean | number | string> = {
    ...defaults?.options,
    ...adapterDefaults?.options,
    ...input.options,
  }

  const skills =
    input.skills !== undefined
      ? input.skills
      : Array.from(
          new Set([...(defaults?.skills ?? []), ...(adapterDefaults?.skills ?? [])]),
        )

  const requestedMode = input.auth?.mode ?? adapterDefaults?.auth?.mode
  const explicit = input.auth !== undefined || adapterDefaults?.auth !== undefined
  const subscriptionCredential = input.auth?.token ?? adapterDefaults?.auth?.token
  const subscriptionSource = input.auth?.source ?? adapterDefaults?.auth?.source
  const apiKeyCredential = input.auth?.apiKey ?? adapterDefaults?.auth?.apiKey
  const authProvider = input.auth?.provider ?? adapterDefaults?.auth?.provider

  return {
    skills,
    options,
    auth: {
      explicit,
      ...(requestedMode ? { requestedMode } : {}),
      ...(subscriptionCredential !== undefined ? { subscriptionCredential } : {}),
      ...(subscriptionSource !== undefined ? { subscriptionSource } : {}),
      ...(apiKeyCredential !== undefined ? { apiKeyCredential } : {}),
      ...(authProvider ? { provider: authProvider } : {}),
    },
  }
}

/**
 * Public credential key-shape prefixes, longest / most-specific first (the
 * match is first-hit, so `sk-ant-oat` must precede `sk-ant-api`/`sk-ant-`,
 * `sk-or-v1-` precede `sk-or-`, and both precede the bare `sk-`). These are
 * PUBLIC key-shape knowledge — the visible leading bytes of each provider's
 * credential format — never secret; only these + the last 4 chars are ever
 * revealed. DECISION 6: the fingerprint is derived from the credential's own
 * shape, NOT from `mode`, so it stays honest across providers (a gateway
 * `sk-or-…` key run in api-key mode reads as `api-key · sk-or-…`).
 */
const CREDENTIAL_FINGERPRINT_PREFIXES: readonly string[] = [
  "sk-ant-oat",
  "sk-ant-api",
  "sk-ant-",
  "sk-or-v1-",
  "sk-or-",
  "sk-proj-",
  "sk-",
  "gsk_",
  "AIza",
]

/**
 * Derive a SAFE, non-secret fingerprint for a resolved auth credential —
 * NEVER the raw value — for recording on the session descriptor / surfacing
 * in `agentproto sessions --watch` and `agent_sessions_list` (the
 * "verifiability" requirement: answer "what was used" without exposing the
 * secret). Format: `<mode> · <shape-prefix>…<last4>` when the shape is known
 * (e.g. `subscription · sk-ant-oat…3f9c`), else `<mode> · …<last4>`.
 *
 * The shape marker is matched from a PUBLIC key-prefix table (longest-match),
 * not derived from `mode` — see {@link CREDENTIAL_FINGERPRINT_PREFIXES}. Only
 * the matched prefix + the last 4 characters are ever surfaced, never the
 * middle (mirrors GitHub's `ghp_…abcd` style).
 */
export function credentialFingerprint(
  mode: "subscription" | "api-key",
  credential: string,
): string {
  const prefix = CREDENTIAL_FINGERPRINT_PREFIXES.find(p => credential.startsWith(p))
  const last4 = credential.slice(-4)
  return prefix ? `${mode} · ${prefix}…${last4}` : `${mode} · …${last4}`
}

/**
 * The adapter's billing-auth capability, projected from its AIP-45 manifest
 * (`provider` / `authEnforce` / `authSubscription`) by the host resolver. The
 * runtime reads THIS, never the manifest directly — keeping the LLM-catalog
 * coupling in the runtime and the driver mechanical.
 */
export interface AdapterAuthDescriptor {
  /** FIXED provider for a single-provider adapter; omitted for by-model
   *  routers (provider then derives from the requested model). */
  provider?: CatalogProvider
  /** Enforcement policy — `"always"` engages every spawn (claude-code's
   *  #312 fail-fast); `"when-configured"` (default) only when `explicit`. */
  authEnforce?: "always" | "when-configured"
  /** Subscription (OAuth/bearer) support. Presence ⇒ the adapter supports
   *  `"subscription"` mode. Mirrors the driver's `AgentCliAuthSubscription`.
   *  `external: true` (codex/gemini) ⇒ file-based: the CLI reads its own
   *  local-login file, so `setEnv` is absent and the runtime injects NO
   *  bearer — it only scrubs the conflicting api-key vars. */
  authSubscription?: {
    setEnv?: string
    external?: boolean
    conflictEnv?: string[]
    unsetEnvAdd?: string[]
  }
  /** True when the adapter's api-key auth is derived from the requested
   *  model rather than a fixed provider (e.g. `pi`, `opencode`). When set,
   *  the adapter supports `"api-key"` on the model-derived direct endpoint,
   *  and `spawnEligibilityManifest` includes it for direct routes. */
  modelDerivedApiKey?: boolean
}

/** The fully-resolved spec the driver applies mechanically. Structurally
 *  matches `@agentproto/driver-agent-cli`'s `ResolvedAuthSpec` (each package
 *  owns its own copy; the object flows across the boundary by shape). */
export interface ResolvedAuthSpec {
  mode: "subscription" | "api-key"
  credential?: string
  setEnv: string
  unsetEnv: string[]
  explicit: boolean
  enforce: "always" | "when-configured"
  /** True when NEITHER subscription nor api-key had any credential
   *  available and `mode` above is therefore an arbitrary fallback pick —
   *  never true when `mode` came from an explicit request or an actually-
   *  available credential. Optional (undefined ⇒ false) so existing
   *  callers/fixtures that predate this field keep working unchanged.
   *  Exists so a fail-fast message can enumerate BOTH auth paths instead of
   *  presenting the fallback mode as though the user configured it — the
   *  root cause of a zero-credential user being told to buy a subscription
   *  they never asked for. */
  neitherConfigured?: boolean
  /** File-based subscription (see `AdapterAuthDescriptor.authSubscription.
   *  external`): the CLI reads its OWN local-login file, so the driver injects
   *  NO credential — it only applies {@link unsetEnv} and does NOT fail-fast on
   *  a missing `credential`. Money-safe: no bearer ever reaches an env var. */
  externalCredential?: boolean
  /** Non-authenticating hint: true when `providers.json` HAS a key for the
   *  resolved provider that is currently being ignored because auth isn't
   *  explicitly configured (no `defaults.adapters.<slug>.auth` block — the
   *  `explicit` gate above, PR #321). NEVER used to authenticate — set by
   *  the caller (session-spawn.ts) as a read-only peek, purely so the
   *  fail-fast message can say "you already have a key, it's just not
   *  wired in" instead of staying silent about it. `resolveAuthSpec` itself
   *  never sets this (it does no I/O). */
  ignoredApiKeyInStore?: boolean
  /** When a gateway preset or custom route was matched, the `base_url` to
   *  inject into adapter options so the client hits the gateway endpoint. */
  baseUrl?: string
}

/** Where the resolved credential came from — the observable billing axis
 *  (DECISION 10②), never inferred. `"claude-code-oauth"` is the Mode-3
 *  self-refreshing source: the subscription bearer was read fresh from the
 *  local Claude Code login via the `claude-code-oauth` provision recipe.
 *  `"cli-local-login"` is the file-based (external) subscription: the CLI
 *  (codex/gemini) reads its OWN local-login file — the runtime injected no
 *  bearer, it only verified the login is present and scrubbed api-key vars. */
export type CredentialSource =
  | "explicit-config"
  | "providers-store"
  | "claude-code-oauth"
  | "cli-local-login"
  | "none"

/**
 * The OBSERVABLE echo (DECISION 9③ / 10②) — recorded on the session
 * descriptor so a verifier checks the RESOLUTION, never the model's
 * self-report. Never carries the raw credential (only its fingerprint).
 */
export interface AuthEcho {
  /** Billing endpoint / provider recorded for observability. Kept as `string`
   *  (not the catalog enum) so gateway preset ids (e.g. "moonshot",
   *  "openai-direct") that are not `CatalogProvider` values can still be
   *  echoed on the session descriptor. */
  provider: string
  authMode: "subscription" | "api-key"
  credentialSource: CredentialSource
  setEnv: string
  fingerprint?: string
}

/**
 * Thrown when the operator requested a billing mode the adapter can't serve —
 * today only `"subscription"` on an adapter with no `authSubscription`. A
 * LOUD, distinct failure (DECISION 4②), never a silent downgrade to api-key.
 */
export class AuthResolutionError extends Error {
  readonly code = "unsupported_auth_mode"
  constructor(message: string) {
    super(message)
    this.name = "AuthResolutionError"
  }
}

export interface ResolveAuthSpecInput {
  descriptor: AdapterAuthDescriptor
  /** `input.model ?? adapter default model` — for model-derived provider. */
  model?: string
  /** Per-spawn provider pin (`input.auth.provider`). */
  requestedProvider?: CatalogProvider
  /** Operator-requested mode; undefined ⇒ ordered preference. */
  requestedMode?: "subscription" | "api-key"
  /** Operator explicitly configured `auth` (DECISION 5). */
  explicit: boolean
  /** Subscription bearer credential, if configured (or resolved fresh by the
   *  caller from a self-refreshing source). */
  subscriptionCredential?: string
  /** Observable ORIGIN label for `subscriptionCredential`, when it did not come
   *  from a plain static config token — today only `"claude-code-oauth"` (the
   *  caller resolved it fresh from the local Claude Code login). Purely a label
   *  for the echo; NEVER affects mode/credential selection. Omitted ⇒ the
   *  subscription credential (if any) is treated as `"explicit-config"`. */
  subscriptionCredentialSource?: CredentialSource
  /** File-based subscription only: the caller (impure) verified the CLI's OWN
   *  local-login file is present (e.g. `~/.codex/auth.json` has a subscription
   *  token) and fails LOUD before reaching here if not. Makes an `external`
   *  `authSubscription` count as an available subscription for ordered-mode
   *  selection — the login file IS the credential, even though the runtime
   *  injects no bearer. Ignored for a non-external (bearer) authSubscription. */
  externalSubscriptionVerified?: boolean
  /** Explicit api-key credential from config, if configured. */
  apiKeyConfigCredential?: string
  /** api-key credential from `providers.json` (fetched by the caller). */
  apiKeyStoreCredential?: string
  /** Explicit gateway route from `SessionConfig.route.gateway`. When this
   *  matches a `ProviderPreset` or a registered custom route, the route's
   *  `baseUrl`/`keyEnv`/`scrubEnv` drive resolution instead of the model-
   *  derived or fixed provider. */
  routeGateway?: string
}

/**
 * THE billing-auth resolver (DECISIONS 4, 6, 9, 10). Pure: given the adapter
 * descriptor + raw config material + (caller-fetched) store key, it decides
 * the provider, the mode (ordered — subscription over api-key when a
 * subscription credential is present; a requested-but-unsupported mode throws
 * `unsupported_auth_mode`), the env var to SET, the derived SCRUB set, and the
 * credential + its source. Returns the driver `spec` + the observable `echo`,
 * or `undefined` when no provider resolves (⇒ ambient, no injection — never
 * guess). NEVER falls back to a default provider/model. Fail-loud on a
 * configured-but-missing credential is deferred to the driver's mechanical
 * apply (it engages then throws `missing_auth_credential`), so the `explicit`
 * / `enforce` signals are carried through on the spec.
 */
export function resolveAuthSpec(
  input: ResolveAuthSpecInput,
): { spec: ResolvedAuthSpec; echo: AuthEcho } | undefined {
  // 0. Gateway route: a preset or custom route wins over model-derived/fixed
  //    provider because the operator explicitly chose a billing rail. It drives
  //    base_url, the API-key env var, and the scrub set.
  const gatewayPreset = input.routeGateway
    ? findAnthropicGatewayPreset(input.routeGateway)
    : undefined
  const customRoute =
    input.routeGateway && !gatewayPreset
      ? resolveCustomRoute(input.routeGateway)
      : undefined
  const gatewayRoute = gatewayPreset ?? customRoute

  // 1. Provider: per-spawn pin → adapter-fixed → model-derived. None ⇒
  //    ambient (no injection); an unknown/free-form model id lands here too.
  //    A matched gateway route overrides all three — the route IS the provider.
  let provider: string | undefined
  let baseUrl: string | undefined
  let apiKeyEnv: string
  let gatewayScrub: string[] = []
  if (gatewayRoute) {
    provider = input.routeGateway
    baseUrl = gatewayPreset?.baseUrl ?? customRoute?.baseUrl
    apiKeyEnv =
      gatewayPreset?.keyEnv ??
      customRoute?.authEnv ??
      (provider ? providerEnvVar(provider) : "")
    gatewayScrub = gatewayPreset ? [...gatewayPreset.scrubEnv] : []
  } else {
    provider =
      input.requestedProvider ??
      input.descriptor.provider ??
      (input.model ? getModelProvider(input.model) : undefined)
    if (!provider) return undefined
    apiKeyEnv = providerEnvVar(provider)
  }
  if (!provider) return undefined

  const sub = input.descriptor.authSubscription
  // Gateway routes are API-key only; subscription mode is only supported on
  // direct routes where the adapter declares authSubscription.
  const supportsSub = sub !== undefined && gatewayRoute === undefined
  const enforce = input.descriptor.authEnforce ?? "when-configured"

  // File-based (external) subscription (codex/gemini): the CLI reads its OWN
  // local-login file, so there is no bearer to inject. The login file IS the
  // credential — availability comes from the caller's fail-loud presence check
  // (`externalSubscriptionVerified`), NOT from an injected token.
  const external = supportsSub && sub?.external === true
  const subCredAvailable =
    input.subscriptionCredential !== undefined ||
    (external && input.externalSubscriptionVerified === true)
  const apiCredAvailable =
    input.apiKeyConfigCredential !== undefined || input.apiKeyStoreCredential !== undefined

  // 2/3. Mode: explicit request (validated) OR ordered preference (DECISION
  //      10 — subscription first when supported; never silently pick api-key
  //      while a subscription credential is present and preferred). When
  //      NEITHER credential is available, `mode` still needs a value (it
  //      drives `setEnv`/scrub below) but is an ARBITRARY pick, not a real
  //      signal — this used to silently fall back to `preference[0]`
  //      ("subscription" for any adapter that supports it), which is exactly
  //      how a zero-credential, api-key-only user got told to buy a
  //      subscription. `neitherConfigured` flags that case so callers never
  //      present the fallback mode as though it meant something.
  let mode: "subscription" | "api-key"
  let neitherConfigured = false
  if (input.requestedMode) {
    if (input.requestedMode === "subscription" && !supportsSub) {
      throw new AuthResolutionError(
        `auth mode "subscription" is not supported for provider "${provider}" ` +
          `(this adapter declares no authSubscription) — use api-key instead.`,
      )
    }
    mode = input.requestedMode
  } else {
    const preference: Array<"subscription" | "api-key"> = supportsSub
      ? ["subscription", "api-key"]
      : ["api-key"]
    const available = preference.find(m =>
      m === "subscription" ? subCredAvailable : apiCredAvailable,
    )
    mode = available ?? preference[0]!
    neitherConfigured = available === undefined
  }

  // 4/5. setEnv + credential + source for the resolved mode.
  let setEnv: string
  let credential: string | undefined
  let credentialSource: CredentialSource
  let externalCredential = false
  if (mode === "subscription" && external) {
    // File-based: inject NOTHING (setEnv empty). The credential lives in the
    // CLI's own login file; the source label records that for the echo. The
    // scrub below still removes the api-key vars so a leftover key can't flip
    // billing. Money-safe by construction — no bearer is ever set. When the
    // login was NOT verified (the unconfigured ordered-preference fallback,
    // which the driver never engages because it isn't explicit), the echo
    // stays honest as "none" rather than claiming a local login was used.
    setEnv = ""
    credential = undefined
    credentialSource = subCredAvailable ? "cli-local-login" : "none"
    externalCredential = true
  } else if (mode === "subscription") {
    // Guaranteed present: the explicit path validated supportsSub, and the
    // ordered path only yields "subscription" when supportsSub. A bearer
    // (non-external) authSubscription always declares setEnv (schema-enforced).
    setEnv = sub!.setEnv!
    credential = input.subscriptionCredential
    credentialSource =
      credential !== undefined
        ? (input.subscriptionCredentialSource ?? "explicit-config")
        : "none"
  } else {
    setEnv = apiKeyEnv
    if (input.apiKeyConfigCredential !== undefined) {
      credential = input.apiKeyConfigCredential
      credentialSource = "explicit-config"
    } else if (input.apiKeyStoreCredential !== undefined) {
      credential = input.apiKeyStoreCredential
      credentialSource = "providers-store"
    } else {
      credential = undefined
      credentialSource = "none"
    }
  }

  // 4. Derived scrub: every conflicting billing-credential var EXCEPT the one
  //    being set, plus (native/subscription mode only) the adapter's gateway
  //    hygiene. Single-credential provider (no authSubscription) → empty scrub
  //    (the setEnv overwrite already prevents a leak). Gateway routes also
  //    apply the preset's scrubEnv (e.g. ANTHROPIC_API_KEY when fronting
  //    Moonshot) so native credentials don't leak to third-party hosts.
  const unsetEnvSet = new Set<string>()
  if (mode === "subscription" && sub?.unsetEnvAdd) {
    for (const e of sub.unsetEnvAdd) unsetEnvSet.add(e)
  }
  for (const e of gatewayScrub) unsetEnvSet.add(e)

  const credVars = new Set<string>([apiKeyEnv])
  if (sub) {
    if (sub.setEnv) credVars.add(sub.setEnv)
    for (const c of sub.conflictEnv ?? []) credVars.add(c)
  }
  credVars.delete(setEnv)
  for (const c of credVars) unsetEnvSet.add(c)
  const unsetEnv = [...unsetEnvSet]

  const spec: ResolvedAuthSpec = {
    mode,
    ...(credential !== undefined ? { credential } : {}),
    setEnv,
    unsetEnv,
    explicit: input.explicit,
    enforce,
    ...(externalCredential ? { externalCredential: true } : {}),
    ...(neitherConfigured ? { neitherConfigured } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  }
  const echo: AuthEcho = {
    provider,
    authMode: mode,
    credentialSource,
    setEnv,
    // A verified file-based login has no injected credential to fingerprint, so
    // carry a NON-SECRET marker (`subscription · local-login`) instead — it lets
    // the descriptor echo record the spawn for verifiability (same guard as a
    // real fingerprint) without inventing a fake secret shape.
    ...(credential !== undefined
      ? { fingerprint: credentialFingerprint(mode, credential) }
      : credentialSource === "cli-local-login"
        ? { fingerprint: `${mode} · local-login` }
        : {}),
  }
  return { spec, echo }
}

/** The only `auth.source` value understood today (Mode 3): read the
 *  subscription bearer fresh from the local Claude Code login via the
 *  `claude-code-oauth` provision recipe. */
export const CLAUDE_CODE_OAUTH_SOURCE = "claude-code-oauth"

/**
 * Raised when `auth.source` is configured but cannot yield a credential — an
 * unknown source value (`unsupported_auth_source`) or the recipe resolving to
 * nothing / not-logged-in (`auth_source_unresolved`). A LOUD, actionable
 * failure surfaced as a spawn error, NEVER a silent fallthrough to a static or
 * ambient credential (mirrors {@link AuthResolutionError}'s discipline).
 */
export class SubscriptionSourceError extends Error {
  readonly code: "unsupported_auth_source" | "auth_source_unresolved"
  constructor(
    code: "unsupported_auth_source" | "auth_source_unresolved",
    message: string,
  ) {
    super(message)
    this.name = "SubscriptionSourceError"
    this.code = code
  }
}

export interface ResolveSubscriptionCredentialInput {
  /** Per-spawn explicit static token (`input.auth.token`) — wins over source. */
  explicitToken?: string
  /** Effective opt-in source (`input.auth.source ?? config auth.source`). */
  source?: string
  /** Config static token (`defaults.adapters.<slug>.auth.token`) — the
   *  lowest-precedence fallback, used only when NEITHER an explicit per-spawn
   *  token nor a source applies. */
  fallbackStaticToken?: string
}

export interface SubscriptionCredentialResolution {
  /** Resolved subscription bearer, or undefined ⇒ nothing configured (the
   *  driver's fail-fast `missing_auth_credential` still owns that case). */
  credential?: string
  /** Observable origin of {@link credential} for the echo. */
  source?: CredentialSource
}

/**
 * Resolve the subscription (oauth-bearer) credential + its observable origin,
 * placing the self-refreshing `source` (Mode 3) BETWEEN the two static tokens
 * (SPEC §2):
 *   a. explicit per-spawn `input.auth.token` (static) — wins over everything.
 *   b. else `source: "claude-code-oauth"` → resolve FRESH via the injected
 *      recipe resolver (Keychain / credentials file) ⇒ origin
 *      `"claude-code-oauth"`.
 *   c. else config.json static `auth.token` ⇒ origin `"explicit-config"`.
 *   d. else nothing (⇒ driver fail-fast `missing_auth_credential`, unchanged).
 *
 * The recipe I/O is INJECTED (`resolveSourceToken`) so this stays pure and
 * unit-testable without touching the real Keychain — the impure resolver lives
 * in `claude-code-oauth-source.ts`. Fails LOUD ({@link SubscriptionSourceError})
 * on an unknown source or an empty recipe; never a silent fallthrough. Only
 * touches the subscription path — api-key mode never reaches here.
 */
export async function resolveSubscriptionCredential(
  input: ResolveSubscriptionCredentialInput,
  resolveSourceToken: (source: string) => Promise<string>,
): Promise<SubscriptionCredentialResolution> {
  // (a) An explicit per-spawn token is a deliberate one-off override — it wins
  //     even over a persisted `source`.
  if (input.explicitToken !== undefined) {
    return { credential: input.explicitToken, source: "explicit-config" }
  }
  // (b) Opt-in self-refreshing source.
  if (input.source !== undefined) {
    if (input.source !== CLAUDE_CODE_OAUTH_SOURCE) {
      throw new SubscriptionSourceError(
        "unsupported_auth_source",
        `auth.source: "${input.source}" is not supported — the only supported ` +
          `value is "${CLAUDE_CODE_OAUTH_SOURCE}".`,
      )
    }
    let token: string
    try {
      token = await resolveSourceToken(input.source)
    } catch (err) {
      throw new SubscriptionSourceError(
        "auth_source_unresolved",
        `auth.source: "${CLAUDE_CODE_OAUTH_SOURCE}" but no Claude Code login ` +
          `found — run \`claude\` and /login (or \`claude setup-token\`) first ` +
          `(${err instanceof Error ? err.message : String(err)}).`,
      )
    }
    if (!token) {
      throw new SubscriptionSourceError(
        "auth_source_unresolved",
        `auth.source: "${CLAUDE_CODE_OAUTH_SOURCE}" but no Claude Code login ` +
          `found — run \`claude\` and /login (or \`claude setup-token\`) first.`,
      )
    }
    return { credential: token, source: CLAUDE_CODE_OAUTH_SOURCE }
  }
  // (c) Config-level static token.
  if (input.fallbackStaticToken !== undefined) {
    return { credential: input.fallbackStaticToken, source: "explicit-config" }
  }
  // (d) Nothing configured.
  return {}
}

/** Manifest-declared AIP-45 option id + type, the minimum an adapter
 *  resolver needs to expose for `normalizeSkillsOption` below. Mirrors
 *  `AgentCliOption`'s `id`/`type` fields without importing
 *  `@agentproto/driver-agent-cli` into the runtime package. */
export interface DeclaredAdapterOption {
  id: string
  type: "boolean" | "integer" | "string" | "enum"
}

/**
 * Fold the resolved `skills` list into `options.skills` using whatever
 * shape the adapter's manifest declares for that option id (today, only
 * `type: "string"` exists for a skills-shaped option — e.g. hermes'
 * comma-joined `--skills a,b`). Adapters with no declared `skills` option
 * (e.g. claude-code, which auto-discovers from `~/.claude/skills`) are a
 * documented no-op — the effective skills list has nowhere to go, so it's
 * dropped rather than guessing a flag the manifest didn't declare.
 *
 * An `options.skills` already present (from config defaults or the
 * explicit call) is respected as-is and never overwritten here.
 */
export function normalizeSkillsOption(
  skills: string[],
  options: Record<string, boolean | number | string>,
  declaredOptions: readonly DeclaredAdapterOption[] | undefined,
): Record<string, boolean | number | string> {
  if (skills.length === 0 || "skills" in options) return options
  const skillsOption = declaredOptions?.find(o => o.id === "skills")
  if (!skillsOption || skillsOption.type !== "string") return options
  return { ...options, skills: skills.join(",") }
}
