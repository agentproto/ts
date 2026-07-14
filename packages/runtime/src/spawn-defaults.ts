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
  /** Subscription bearer token (per-spawn > config), if configured. */
  subscriptionCredential?: string
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
  const apiKeyCredential = input.auth?.apiKey ?? adapterDefaults?.auth?.apiKey
  const authProvider = input.auth?.provider ?? adapterDefaults?.auth?.provider

  return {
    skills,
    options,
    auth: {
      explicit,
      ...(requestedMode ? { requestedMode } : {}),
      ...(subscriptionCredential !== undefined ? { subscriptionCredential } : {}),
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
   *  `"subscription"` mode. Mirrors the driver's `AgentCliAuthSubscription`. */
  authSubscription?: {
    setEnv: string
    conflictEnv?: string[]
    unsetEnvAdd?: string[]
  }
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
}

/** Where the resolved credential came from — the observable billing axis
 *  (DECISION 10②), never inferred. */
export type CredentialSource = "explicit-config" | "providers-store" | "none"

/**
 * The OBSERVABLE echo (DECISION 9③ / 10②) — recorded on the session
 * descriptor so a verifier checks the RESOLUTION, never the model's
 * self-report. Never carries the raw credential (only its fingerprint).
 */
export interface AuthEcho {
  provider: CatalogProvider
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
  /** Subscription bearer credential, if configured. */
  subscriptionCredential?: string
  /** Explicit api-key credential from config, if configured. */
  apiKeyConfigCredential?: string
  /** api-key credential from `providers.json` (fetched by the caller). */
  apiKeyStoreCredential?: string
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
  // 1. Provider: per-spawn pin → adapter-fixed → model-derived. None ⇒
  //    ambient (no injection); an unknown/free-form model id lands here too.
  const provider =
    input.requestedProvider ??
    input.descriptor.provider ??
    (input.model ? getModelProvider(input.model) : undefined)
  if (!provider) return undefined

  const sub = input.descriptor.authSubscription
  const supportsSub = sub !== undefined
  const enforce = input.descriptor.authEnforce ?? "when-configured"
  const apiKeyEnv = providerEnvVar(provider)

  const subCredAvailable = input.subscriptionCredential !== undefined
  const apiCredAvailable =
    input.apiKeyConfigCredential !== undefined || input.apiKeyStoreCredential !== undefined

  // 2/3. Mode: explicit request (validated) OR ordered preference (DECISION
  //      10 — subscription first when supported; never silently pick api-key
  //      while a subscription credential is present and preferred).
  let mode: "subscription" | "api-key"
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
    mode =
      preference.find(m => (m === "subscription" ? subCredAvailable : apiCredAvailable)) ??
      preference[0]!
  }

  // 4/5. setEnv + credential + source for the resolved mode.
  let setEnv: string
  let credential: string | undefined
  let credentialSource: CredentialSource
  if (mode === "subscription") {
    // Guaranteed present: the explicit path validated supportsSub, and the
    // ordered path only yields "subscription" when supportsSub.
    setEnv = sub!.setEnv
    credential = input.subscriptionCredential
    credentialSource = credential !== undefined ? "explicit-config" : "none"
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
  //    (the setEnv overwrite already prevents a leak).
  const credVars = new Set<string>([apiKeyEnv])
  if (sub) {
    credVars.add(sub.setEnv)
    for (const c of sub.conflictEnv ?? []) credVars.add(c)
  }
  credVars.delete(setEnv)
  const unsetEnv = [...credVars]
  if (mode === "subscription" && sub?.unsetEnvAdd) unsetEnv.push(...sub.unsetEnvAdd)

  const spec: ResolvedAuthSpec = {
    mode,
    ...(credential !== undefined ? { credential } : {}),
    setEnv,
    unsetEnv,
    explicit: input.explicit,
    enforce,
  }
  const echo: AuthEcho = {
    provider,
    authMode: mode,
    credentialSource,
    setEnv,
    ...(credential !== undefined
      ? { fingerprint: credentialFingerprint(mode, credential) }
      : {}),
  }
  return { spec, echo }
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
