/**
 * Harness capability-discovery layer.
 *
 * A `HarnessCapabilities` record answers "what can this adapter actually
 * DO on this host right now" — where its credentials live, which billing
 * providers it can reach, how it discovers/reports models, whether it can
 * front an OpenAI/Anthropic-compatible endpoint, and how a model/posture
 * choice gets applied at spawn time. Two ways to produce one:
 *
 *   - `deriveDeclaredCapabilities` — a pure, manifest-only projection. Never
 *     touches disk/env/subprocess. Always succeeds. `source:"manifest-fallback"`.
 *   - `discoverCapabilities` — runs an adapter-supplied `CapabilityStrategy`
 *     (best-effort: parses the CLI's native config/creds store) and falls
 *     back to the declared projection on any failure. `source:"discovered"`
 *     on success.
 *
 * Security contract (mirrors `types.ts`'s Appendix B): nothing in this
 * module may ever surface a raw credential value — only presence,
 * fingerprints, and non-secret identity (last 4 chars). Callers building a
 * `CapabilityStrategy` must uphold the same contract; this module doesn't
 * deep-scan for it at runtime.
 */

/** Where an adapter's turn-time credentials live. */
export interface AuthStore {
  kind: "keychain" | "file" | "oauth-file" | "env" | "gateway"
  path?: string
  format?: "json" | "yaml" | "toml"
  providerKeyed: boolean
}

/** Where a credential comes from — never the credential itself. */
export type CredSource =
  | { kind: "env"; var: string }
  | { kind: "file"; path: string; pointer: string }
  | { kind: "keychain"; service: string }
  | { kind: "oauth-file"; path: string }

/** One billing provider this adapter can reach, and whether a credential
 *  for it is currently present (never the credential value). */
export interface ProviderCapability {
  id: string
  billingEndpoint: string
  cred: {
    present: boolean
    source: CredSource
    /** One-way fingerprint of the stored secret, if discovered. Never the
     *  secret itself — mirrors `@agentproto/auth`'s `fingerprintCredential`. */
    fingerprint?: string
    /** Trailing 4 chars of the stored secret, if discovered and long enough
     *  to reveal safely. Never the full secret. */
    last4?: string
  }
  baseUrl?: string
  apiMode?: "anthropic" | "chat_completions"
}

/** How this adapter discovers/reports its available models. */
export interface ModelDiscovery {
  mechanism: "command" | "file-cache" | "catalog" | "free-form"
  ref?: string
  ids?: string[]
  stale?: boolean
}

/** Whether this adapter can front an OpenAI/Anthropic-compatible endpoint,
 *  and how a caller would configure that. */
export interface EndpointCompat {
  openai?: { via: "env" | "config-block" | "per-spawn-option"; key: string }
  anthropic?: { via: "env" | "config-block" | "per-spawn-option"; key: string }
}

/** How a model/posture choice gets applied at spawn time, and whether this
 *  adapter's process is coupled to the host (in-process) vs a subprocess. */
export interface ApplicationContract {
  modelApply: "config" | "command" | "arg"
  postureApply: "arg" | "env" | "config" | "none"
  coupled: boolean
}

/** Full capability record for one adapter. */
export interface HarnessCapabilities {
  adapter: string
  /** "discovered" — a `CapabilityStrategy` ran successfully.
   *  "manifest-fallback" — no strategy, or the strategy threw. */
  source: "discovered" | "manifest-fallback"
  /** "live" — strategy probed live state (creds store, running process).
   *  "parse" — strategy parsed an on-disk config/cache file.
   *  "declared" — no strategy; everything came from the static manifest. */
  discoverable: "live" | "parse" | "declared"
  authStores: AuthStore[]
  providers: ProviderCapability[]
  models: ModelDiscovery
  endpointCompat: EndpointCompat
  application: ApplicationContract
}

/**
 * Structural subset of `AgentCliDefinition` (`@agentproto/driver-agent-cli`,
 * `packages/driver/agent-cli/src/types.ts:629`) that this module needs.
 * Defined locally rather than importing the real type so provider-kit stays
 * family-agnostic (it has no dependency on `@agentproto/driver-agent-cli`
 * today, and this module shouldn't be the one to introduce it) — an
 * `AgentCliDefinition` satisfies this shape structurally, so adapters can
 * pass their real handle straight through with no cast.
 */
export interface HarnessManifestView {
  id: string
  provider?: string
  routeSelection?: string
  models?: {
    env?: Record<string, string>
    allowed?: unknown[]
    default?: string
    apply?: string
  }
  auth?: { state?: { env?: string[] } }
  options?: unknown[]
  modes?: unknown[]
}

/** Context a `CapabilityStrategy` reads from — never a raw credential
 *  value, only presence/read access. `runCommand`/`keychainLookup` are
 *  optional: a strategy that only parses on-disk files doesn't need them. */
export interface DiscoverCtx {
  homeDir: string
  env: Record<string, string | undefined>
  readFile(path: string): Promise<string | null>
  runCommand?(cmd: string, args: string[], opts?: { ttlMs?: number }): Promise<string | null>
  keychainLookup?(service: string): Promise<boolean>
  warn(msg: string): void
}

/** Adapter-supplied discovery logic — reads the CLI's native config/creds
 *  store via `ctx` and returns a live `HarnessCapabilities`. MUST be
 *  best-effort: `discoverCapabilities` catches a throw and falls back to
 *  `deriveDeclaredCapabilities`, but a well-behaved strategy should still
 *  degrade gracefully on its own (missing file ⇒ empty, not throw) where
 *  practical. */
export type CapabilityStrategy = (
  def: HarnessManifestView,
  ctx: DiscoverCtx,
) => Promise<HarnessCapabilities>

/** Narrows a `models.allowed` element to its id, matching the bare-string /
 *  `{id, ...}` shape `AgentCliModelEntry` allows (see `resolve.ts`'s
 *  `toModelDetails` for the sibling projection). */
function allowedEntryId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string") {
    return (entry as { id: string }).id
  }
  return undefined
}

/**
 * Pure, manifest-only projection — never touches disk/env/subprocess, never
 * throws. The fallback `discoverCapabilities` reaches for when no strategy
 * is wired or the strategy fails.
 *
 *   - `providers` — one per `models.env` entry (endpoint key ⇒ billing
 *     endpoint of the same name; credential presence is never checked here,
 *     always `false`).
 *   - `models` — always `"free-form"` (the manifest alone can't say the CLI
 *     has a live model-listing mechanism); `ids` carries `models.allowed`
 *     when the manifest declares one.
 *   - `authStores` — one `{kind:"env", providerKeyed:false}` entry per
 *     `auth.state.env` var name.
 *   - `application` — `modelApply` mirrors `models.apply` (default
 *     `"config"`, matching the driver's own default); posture has no
 *     manifest-level declaration, so `"none"`/`coupled:false`.
 */
export function deriveDeclaredCapabilities(def: HarnessManifestView): HarnessCapabilities {
  const providers: ProviderCapability[] = Object.entries(def.models?.env ?? {}).map(
    ([id, varName]) => ({
      id,
      billingEndpoint: id,
      cred: { present: false, source: { kind: "env", var: varName } },
    }),
  )

  const ids = Array.isArray(def.models?.allowed)
    ? def.models!.allowed!.map(allowedEntryId).filter((id): id is string => id !== undefined)
    : undefined

  const authStores: AuthStore[] = (def.auth?.state?.env ?? []).map(() => ({
    kind: "env" as const,
    providerKeyed: false,
  }))

  const modelApply = def.models?.apply
  return {
    adapter: def.id,
    source: "manifest-fallback",
    discoverable: "declared",
    authStores,
    providers,
    models: {
      mechanism: "free-form",
      ...(ids && ids.length > 0 ? { ids } : {}),
    },
    endpointCompat: {},
    application: {
      modelApply: modelApply === "command" || modelApply === "arg" ? modelApply : "config",
      postureApply: "none",
      coupled: false,
    },
  }
}

/**
 * Best-effort capability discovery: run `strategy` when given one, falling
 * back to `deriveDeclaredCapabilities` when there is no strategy or it
 * throws. Never throws itself — a broken/absent strategy degrades to the
 * declared projection rather than failing the caller (e.g. the
 * `harness_capabilities` MCP tool listing every adapter).
 */
export async function discoverCapabilities(
  def: HarnessManifestView,
  strategy: CapabilityStrategy | undefined,
  ctx: DiscoverCtx,
): Promise<HarnessCapabilities> {
  if (!strategy) return deriveDeclaredCapabilities(def)
  try {
    return await strategy(def, ctx)
  } catch (err) {
    ctx.warn(
      `capability discovery failed for '${def.id}', falling back to manifest: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return deriveDeclaredCapabilities(def)
  }
}
