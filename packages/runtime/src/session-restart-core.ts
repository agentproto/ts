/**
 * Shared agent-session restart core — the "agent" branch of
 * `decideRestartStrategy` (resume-strategies.ts), factored out so both
 * the `session_restart` MCP tool (session-tools.ts) and the cron
 * scheduler's `prompt-session` action (cron-scheduler.ts) resume a dead
 * session via the exact same path. PTY strategies stay inline in
 * session-tools.ts — cron `prompt-session` jobs only ever target
 * agent-cli sessions.
 *
 * Lives in its own module (not resume-strategies.ts) because
 * resume-strategies.ts is deliberately duck-typed against a minimal
 * shape to avoid a value-level import of sessions.ts (see its own
 * top-of-file comment). This module needs the real `SessionsRegistry`
 * / `AgentAdapterResolver` types, so it can't share that constraint.
 *
 * Billing-auth resolution (money bug fix): a restarted session used to
 * respawn with NO auth resolution at all, so a session pinned to
 * `subscription` billing silently came back on whatever the daemon's
 * ambient env happened to hold (e.g. a leaked `ANTHROPIC_API_KEY`) —
 * bills org credits under a Max/Pro-pinned session with no signal
 * anywhere. This module now re-runs the SAME resolver
 * `session-spawn.ts` uses (`resolveAuthSpec`, fed by
 * `resolveSpawnDefaults`), sourcing the requested MODE from the prior
 * descriptor's `auth.mode` (the secret itself is never persisted there,
 * by design — see `SessionDescriptor.auth`) and re-resolving the actual
 * credential from `~/.agentproto/config.json` / providers.json, same
 * merge order as a fresh spawn. The logic is duplicated rather than
 * shared with `session-spawn.ts` because that file is out of scope for
 * this fix (see its own callers) — both call sites must stay in sync by
 * inspection, same as they already do for `decideRestartStrategy`.
 *
 * Restart-with-override (SPEC §4.3, build step 6): the base path above copies
 * the prior descriptor's `auth.mode` and never switches wallets. This module
 * now also takes an `overrides` map (the decomposed `SessionConfig` axes) so a
 * restart can DELIBERATELY change an axis. The load-bearing one is `access`: a
 * restart requesting a different named auth profile resolves the route first
 * (access is downstream, SPEC §1c), validates the profile's eligibility against
 * the resolved `(adapter × route)` endpoint (rejecting Rx/Ry mismatches with a
 * `RestartOverrideError`/400 rather than ever falling back to another wallet —
 * the R1 money-bug guarantee), and feeds the profile's OWN credential through
 * the SAME `resolveAuthSpec` gate as the base path — no parallel auth path. The
 * remaining axes (`route`/`posture`/`contextProfile`/`model`/`effort`) overlay
 * the prior descriptor and round-trip onto the fresh one; a changed axis is
 * announced via `session:config-changed` (#490).
 */

import type {
  SessionDescriptor,
  SessionsRegistry,
  SessionAuthEcho,
  SessionAccessProfileEcho,
} from "./sessions.js"
import type { AgentAdapterResolver } from "./http-server.js"
import {
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
} from "./resume-strategies.js"
import {
  resolveSpawnDefaults,
  resolveAuthSpec,
  type SpawnDefaultsConfig,
  type DefaultsAdapterAuthConfig,
  type ResolvedAuthSpec,
  type AuthEcho,
  type AdapterAuthDescriptor,
} from "./spawn-defaults.js"
import { getProviderKey } from "./providers-store.js"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import {
  checkModelWalletEligibility,
  modelWalletIneligibleMessage,
} from "./catalog-models.js"
import type { CatalogProvider } from "@agentproto/model-catalog"
import { loadConfig } from "./config.js"
import type { SessionConfig, RouteSpec } from "./session-config.js"
import type { SessionConfigChangedEvent, SessionConfigAxis } from "./session-event-bus.js"
import {
  getAuthProfile,
  eligibleProfiles,
  KeychainStore,
  type AuthProfile,
  type AuthMethod,
  type AdapterAuthManifest,
} from "@agentproto/auth"

/**
 * Axis overrides a restart-with-override applies (SPEC §4.3, build step 6).
 * The decomposed `SessionConfig` axes plus a back-compat legacy `mode` string:
 * only `access` is fully re-resolved end-to-end here (it drives billing, the R1
 * money bug), while `route`/`posture`/`contextProfile` land on the fresh
 * descriptor so they round-trip (SPEC §3.8) — their spawn-time env application
 * rides the driver's mode-decomposition (build step 2), out of scope for this
 * step. `model`/`effort` are forwarded to the driver's own spawn inputs.
 */
export type RestartOverrides = Partial<SessionConfig> & {
  /** Legacy AIP-45 mode id, forwarded verbatim to the driver's `startSession`
   *  (back-compat — the pre-decomposition apply-path). */
  mode?: string
}

/**
 * Resolve an `access` override's `profileRef` to the named profile's metadata
 * (endpoint/method/label) + its actual secret. Injected onto
 * {@link RestartAgentSessionOptions} so tests inject a deterministic stub and
 * the money-safety path stays provable; the default
 * ({@link resolveAccessProfileFromStore}) reads `@agentproto/auth`'s profile
 * store + keychain. Returns `undefined` when the ref names no profile — the
 * caller turns that into a `400` rather than silently spawning unbilled.
 */
export type AccessProfileResolver = (
  profileRef: string,
) => Promise<{ profile: AuthProfile; credential?: string } | undefined>

/**
 * Thrown when a restart override is invalid — an unknown access profile, or a
 * profile that isn't eligible for the resolved `(adapter, route)` endpoint
 * (SPEC risks Rx/Ry). Carries `status: 400` so the MCP/HTTP surfaces reject the
 * restart with a clear reason instead of ever spawning with the wrong wallet.
 */
export class RestartOverrideError extends Error {
  readonly code = "restart_override_invalid"
  readonly status = 400
  constructor(message: string) {
    super(message)
    this.name = "RestartOverrideError"
  }
}

/**
 * Default {@link AccessProfileResolver}: profile metadata from
 * `@agentproto/auth`'s profile store, secret from the keychain at the profile's
 * `credentialRef` slot. Only invoked when an `access` override is actually
 * passed (never by cron or the existing no-override restart), so its keychain
 * I/O never runs in the auth-resolution unit tests, which inject a stub.
 */
export async function resolveAccessProfileFromStore(
  profileRef: string,
): Promise<{ profile: AuthProfile; credential?: string } | undefined> {
  const profile = await getAuthProfile(profileRef)
  if (!profile) return undefined
  const stored = await new KeychainStore().read({ path: profile.credentialRef })
  return { profile, ...(stored?.value !== undefined ? { credential: stored.value } : {}) }
}

/** The auth `method` facet ↔ the billing `mode` the resolver speaks:
 *  `oauth-bearer` (an OAuth/subscription bearer) → `"subscription"`, `api-key`
 *  → `"api-key"` (SPEC §1c/§3.1 — mirrors `@agentproto/auth`'s `tokenKind`
 *  mapping). */
function methodToMode(method: AuthMethod): "subscription" | "api-key" {
  return method === "oauth-bearer" ? "subscription" : "api-key"
}

/** Which auth methods `descriptor` can present on its DIRECT route, derived
 *  from the same projection `resolveAuthSpec` reads (`authSubscription` ⇒
 *  oauth-bearer, `provider` ⇒ api-key) — the method-side of the eligibility
 *  predicate (SPEC §3.4). Mirrors `catalog-models.ts`'s `methodsForDirect`. */
function directMethods(descriptor: AdapterAuthDescriptor | undefined): AuthMethod[] {
  const methods: AuthMethod[] = []
  if (descriptor?.authSubscription) methods.push("oauth-bearer")
  if (descriptor?.provider || descriptor?.modelDerivedApiKey) methods.push("api-key")
  return methods
}

/**
 * Project the resolved adapter + effective route into the single-route
 * {@link AdapterAuthManifest} the #470 eligibility predicate needs, mirroring
 * `catalog-models.ts`'s `billedVendor`/`methodsForDirect` split: a DIRECT route
 * (no gateway override, or a gateway equal to the model's own vendor) bills the
 * model's vendor and presents whatever the descriptor declares; a gateway route
 * bills the gateway's own id and is always api-key only (SPEC §1c — "a moonshot
 * profile, not the Claude sub"). Returns `undefined` when no vendor resolves at
 * all (an adapter with no provider + a free-form model) — the caller treats
 * that as "cannot confirm eligibility" and rejects, never guessing a wallet.
 */
function eligibilityManifest(
  adapterSlug: string,
  descriptor: AdapterAuthDescriptor | undefined,
  route: RouteSpec | undefined,
  model: string | undefined,
): { manifest: AdapterAuthManifest; routeId: string } | undefined {
  const baseVendor =
    descriptor?.provider ?? (model ? getModelProvider(model) : undefined)
  const gateway = route?.gateway
  const routeId = gateway ?? baseVendor
  if (routeId === undefined) return undefined
  // A gateway that differs from the model's own vendor is a redirection —
  // billed against the gateway id, api-key only (no third-party gateway has an
  // oauth-bearer path). Otherwise it's the direct route.
  const isDirect = baseVendor !== undefined && routeId === baseVendor
  const billedVendor = isDirect ? baseVendor : routeId
  const methods: readonly AuthMethod[] = isDirect ? directMethods(descriptor) : ["api-key"]
  return {
    manifest: {
      id: adapterSlug,
      endpointByRoute: { [routeId]: billedVendor },
      methodsByRoute: { [routeId]: methods },
    },
    routeId,
  }
}

export interface RestartAgentSessionResult {
  desc: SessionDescriptor
  resumedFrom: string
  resumeVia: string
  resumeFallback?: boolean
}

export interface RestartAgentSessionOptions {
  /**
   * Skip `decideRestartStrategy`'s PTY-native preference (e.g. claude-code's
   * `claude --resume <id>`, chosen whenever a native resume id is found —
   * see resume-strategies.ts) and always resume at the ACP level via
   * `prev.adapterSessionId` instead. A PTY-resumed session is a raw
   * terminal — it has no `sendPrompt`, only `writeTerminalInput` — so
   * any caller that needs to keep sending structured prompts to the
   * resumed session (the cron scheduler's `prompt-session` action) MUST
   * set this; there's nothing "less correct" about ACP resume for
   * claude-code specifically, it's simply the strategy that yields an
   * agent-cli session instead of a PTY one.
   */
  forceAgentResume?: boolean
  /** Loads config.json's `defaults` block — same seam as
   *  `SpawnAgentSessionDeps.loadDefaultsConfig` in session-spawn.ts.
   *  Defaults to reading the real `~/.agentproto/config.json` via
   *  `loadConfig` when omitted; tests inject a stub to avoid touching
   *  the real file. */
  loadDefaultsConfig?: () => Promise<SpawnDefaultsConfig | undefined>
  /**
   * Axis overrides applied to this restart (SPEC §4.3, build step 6). Overlaid
   * onto the prior descriptor's axes: an axis present here wins, an axis omitted
   * is carried forward from `prev` so a single-axis restart never silently drops
   * the others (SPEC §3.8 round-trip). The `access` override re-resolves billing
   * against a NEW named profile (the R1 money-bug fix — see the header comment);
   * `route`/`posture`/`contextProfile`/`model`/`effort` update the fresh
   * descriptor and, where the driver supports it, the spawn inputs. Omitted ⇒ a
   * pure resume, byte-identical to the pre-step-6 path.
   */
  overrides?: RestartOverrides
  /** Resolve an `access` override's `profileRef` → profile metadata + secret.
   *  Defaults to {@link resolveAccessProfileFromStore}; tests inject a stub.
   *  Only consulted when `overrides.access.profileRef` is set. */
  resolveAccessProfile?: AccessProfileResolver
}

/**
 * Resume an agent-cli session's conversation via provider-native or
 * ACP-level resume (never PTY — throws for `pty-native`/`pty-plain`/
 * `unsupported` strategies, unless `forceAgentResume` is set). Falls
 * back to a fresh spawn (no continuity) if the adapter rejects the
 * resume id with a "not found" error — same behaviour `session_restart`
 * has always had for a prior session that died before its first turn.
 */
export async function restartAgentSession(
  registry: SessionsRegistry,
  resolveAgentAdapter: AgentAdapterResolver,
  prev: SessionDescriptor,
  opts: RestartAgentSessionOptions = {},
): Promise<RestartAgentSessionResult> {
  // `forceAgentResume` never consults `augmented` (see the `resumeVia`
  // comment below) — skip the FS probe entirely rather than pay for I/O
  // whose result is discarded.
  const augmented = opts.forceAgentResume ? prev : await augmentWithFsResume(prev)
  const strategy = opts.forceAgentResume
    ? ({ kind: "agent", resumeSessionId: prev.adapterSessionId } as const)
    : decideRestartStrategy(augmented)

  if (strategy.kind !== "agent") {
    throw new Error(
      `restartAgentSession: session '${prev.id}' resolved to a '${strategy.kind}' ` +
        "restart strategy — only agent-adapter sessions are resumable this way.",
    )
  }

  const adapterSlug = prev.adapterSlug
  if (!adapterSlug) {
    throw new Error(
      "restartAgentSession: internal error — agent resume strategy without adapterSlug",
    )
  }

  const resolved = await resolveAgentAdapter(adapterSlug)
  if (!resolved) {
    throw new Error(`restartAgentSession: adapter '${adapterSlug}' not found.`)
  }

  let cwd = prev.cwd
  if (!cwd) console.warn(`[restartAgentSession] no cwd on prior descriptor ${prev.id} — falling back to daemon's cwd ${process.cwd()}`)
  cwd ??= process.cwd()

  // ── Effective config axes (SPEC §4.3 overlay) ────────────────────
  // `effective = { ...prev axes, ...overrides }`: an axis present in the
  // override wins, an axis omitted is carried forward from `prev` so a
  // single-axis restart never silently drops the rest (SPEC §3.8 round-trip).
  // Only `access` re-resolves billing end-to-end below (the R1 money bug);
  // `route`/`posture`/`contextProfile` land on the fresh descriptor to
  // round-trip, and `model`/`effort`/legacy `mode` forward to the driver's own
  // spawn inputs.
  const overrides = opts.overrides ?? {}
  const effModel = overrides.model ?? prev.model
  const effEffort = overrides.effort ?? prev.effort
  const effRoute = overrides.route ?? prev.route
  const effPosture = overrides.posture ?? prev.posture
  const effContextProfile = overrides.contextProfile ?? prev.contextProfile
  const effHarness = overrides.harness ?? prev.harness ?? prev.adapterSlug
  const effMode = overrides.mode ?? prev.mode
  // An `access` override is present iff a `profileRef` was explicitly requested.
  const accessOverrideRef = overrides.access?.profileRef

  // ── Billing-auth re-resolution ───────────────────────────────────
  // Mirrors session-spawn.ts's resolution exactly (same resolver, same
  // config precedence), except the requested MODE comes from the prior
  // descriptor's echo rather than a fresh `agent_start.auth` call — the
  // credential itself is never on the descriptor (only the fingerprint
  // is), so it's re-resolved from config/providers.json here, not
  // copied. No prior `auth` echo (adapter with no `authDescriptor`, or
  // a session that never got one) ⇒ `explicitAuthInput` stays
  // undefined, which resolves exactly like a fresh spawn with no
  // explicit `auth` — falls through to `defaults.adapters.<slug>.auth`,
  // never inventing a mode. `resolveAuthSpec` throws
  // `AuthResolutionError` (unsupported mode) and the driver's
  // `startSession` throws `missing_auth_credential` (engaged mode, no
  // credential) — both propagate uncaught, exactly the fail-loud
  // contract `agent_start` already has. Never logged/echoed here beyond
  // the fingerprint already carried on `AuthEcho`.
  let authSpec: ResolvedAuthSpec | undefined
  let authEcho: AuthEcho | undefined
  let accessProfileEcho: SessionAccessProfileEcho | undefined = prev.accessProfile
  if (accessOverrideRef !== undefined) {
    // ── access override: switch billing to a NAMED profile (R1 money bug) ──
    // This is the whole point of the money-safety fix: a restart requesting a
    // DIFFERENT auth profile must actually bill/authenticate as THAT profile —
    // never the prior descriptor's wallet, never an ambient fallback. Order
    // matters (SPEC §1c): resolve `route` first (access is downstream of it),
    // validate the requested profile's eligibility against the resolved
    // endpoint, THEN feed the profile's own credential through the SAME
    // `resolveAuthSpec` gate every spawn uses — no parallel auth path.
    const resolveProfile = opts.resolveAccessProfile ?? resolveAccessProfileFromStore
    const found = await resolveProfile(accessOverrideRef)
    if (!found) {
      throw new RestartOverrideError(
        `restart access override: no auth profile "${accessOverrideRef}" found.`,
      )
    }
    const { profile, credential } = found
    if (!resolved.authDescriptor) {
      throw new RestartOverrideError(
        `restart access override: adapter "${adapterSlug}" presents no billing-auth, ` +
          `so profile "${profile.id}" cannot be attached.`,
      )
    }
    const projected = eligibilityManifest(
      adapterSlug,
      resolved.authDescriptor,
      effRoute,
      effModel ?? resolved.defaultModel,
    )
    if (!projected) {
      throw new RestartOverrideError(
        `restart access override: cannot resolve a billing vendor for adapter ` +
          `"${adapterSlug}" (no fixed provider, no model) — profile "${profile.id}" ` +
          `eligibility is unverifiable, refusing to spawn.`,
      )
    }
    const { manifest, routeId } = projected
    // The step-0 eligibility predicate (Rx/Ry): a profile whose vendor doesn't
    // match the route's billed endpoint, or whose method the adapter can't
    // present on that route, is REJECTED (400) — never silently swapped for a
    // wallet that happens to fit.
    if (eligibleProfiles([profile], manifest, routeId).length === 0) {
      const billed = manifest.endpointByRoute[routeId]
      const methods = manifest.methodsByRoute[routeId] ?? []
      throw new RestartOverrideError(
        `restart access override: profile "${profile.id}" (${profile.endpoint}/${profile.method}) ` +
          `is not eligible for adapter "${adapterSlug}" on route "${routeId}" — that endpoint ` +
          `bills "${billed}" via [${methods.join(", ") || "no presentable methods"}]. ` +
          `Attach a profile whose endpoint + method match the route.`,
      )
    }
    const mode = methodToMode(profile.method)
    const result = resolveAuthSpec({
      descriptor: resolved.authDescriptor,
      ...(effModel ? { model: effModel } : {}),
      ...(effRoute?.gateway ? { routeGateway: effRoute.gateway } : {}),
      ...(!effRoute?.gateway ? { requestedProvider: profile.endpoint as CatalogProvider } : {}),
      requestedMode: mode,
      // Attaching a named profile is always an EXPLICIT billing choice — so a
      // missing credential fails loud (driver `missing_auth_credential`) rather
      // than falling back to ambient env or the prior credential.
      explicit: true,
      ...(mode === "subscription" && credential !== undefined
        ? { subscriptionCredential: credential }
        : {}),
      ...(mode === "api-key" && credential !== undefined
        ? { apiKeyConfigCredential: credential }
        : {}),
    })
    if (result) {
      authSpec = result.spec
      authEcho = result.echo
    }
    accessProfileEcho = {
      profileRef: profile.id,
      ...(profile.label !== undefined ? { label: profile.label } : {}),
      endpoint: profile.endpoint,
      method: profile.method,
    }
  } else if (resolved.authDescriptor) {
    const configDefaults = opts.loadDefaultsConfig
      ? await opts.loadDefaultsConfig()
      : (await loadConfig()).defaults
    const explicitAuthInput: DefaultsAdapterAuthConfig | undefined = prev.auth
      ? { mode: prev.auth.mode }
      : undefined
    const spawnDefaults = resolveSpawnDefaults(configDefaults, adapterSlug, {
      auth: explicitAuthInput,
    })
    const authModel = effModel ?? resolved.defaultModel
    const pinnedProvider = spawnDefaults.auth.provider
    const resolvedProvider =
      pinnedProvider ??
      resolved.authDescriptor.provider ??
      (authModel ? getModelProvider(authModel) : undefined)
    // When an explicit gateway route is set, the provider-store key is looked
    // up under the gateway id (e.g. "moonshot") rather than the model-derived
    // vendor, because the gateway preset/custom route defines the credential
    // env var and the billing endpoint.
    const apiKeyStoreProvider = effRoute?.gateway ?? resolvedProvider
    // Same money-safety gate as session-spawn.ts: the providers.json store
    // is only consulted when the resolved auth is EXPLICIT (never for an
    // unconfigured `always`-enforcing adapter, which must fail-fast instead
    // of silently picking up a leftover store key).
    const apiKeyStoreCredential =
      apiKeyStoreProvider &&
      spawnDefaults.auth.explicit &&
      spawnDefaults.auth.apiKeyCredential === undefined
        ? await getProviderKey(apiKeyStoreProvider)
        : undefined
    const result = resolveAuthSpec({
      descriptor: resolved.authDescriptor,
      ...(authModel ? { model: authModel } : {}),
      ...(effRoute?.gateway ? { routeGateway: effRoute.gateway } : {}),
      ...(pinnedProvider ? { requestedProvider: pinnedProvider } : {}),
      ...(spawnDefaults.auth.requestedMode
        ? { requestedMode: spawnDefaults.auth.requestedMode }
        : {}),
      explicit: spawnDefaults.auth.explicit,
      ...(spawnDefaults.auth.subscriptionCredential !== undefined
        ? { subscriptionCredential: spawnDefaults.auth.subscriptionCredential }
        : {}),
      ...(spawnDefaults.auth.apiKeyCredential !== undefined
        ? { apiKeyConfigCredential: spawnDefaults.auth.apiKeyCredential }
        : {}),
      ...(apiKeyStoreCredential !== undefined ? { apiKeyStoreCredential } : {}),
    })
    if (result) {
      authSpec = result.spec
      authEcho = result.echo
    }
    // Same money-safety spawn guard as session-spawn.ts (SPEC §1c), mirrored
    // here so a restart-with-override can't reopen the hole the base path
    // closes: the auth-MODE path validates only provider→mode support, never
    // that the resolved wallet can bill THIS model. A gateway/router model
    // (e.g. `deepseek/deepseek-v4-pro`, billing `openrouter`) restarted onto
    // claude-code's FIXED `anthropic` wallet with NO `route.gateway` would 404
    // upstream. Scoped to the UNNAMED-wallet case (an explicit `route.gateway`
    // is a deliberate operator wallet choice — see session-spawn.ts for the
    // full rationale). FAIL LOUD (RestartOverrideError ⇒ 400); NEVER swap in an
    // eligible wallet the operator didn't name.
    if (
      effRoute?.gateway === undefined &&
      authModel !== undefined &&
      resolvedProvider !== undefined
    ) {
      const verdict = checkModelWalletEligibility(authModel, resolvedProvider)
      if (!verdict.ok) {
        throw new RestartOverrideError(
          modelWalletIneligibleMessage({
            prefix: "restart",
            adapter: adapterSlug,
            model: authModel,
            walletRoute: resolvedProvider,
            ...(authSpec?.mode ? { walletMode: authSpec.mode } : {}),
            suggestedRoutes: verdict.suggestedRoutes,
          }),
        )
      }
    }
    // Same non-authenticating hint as session-spawn.ts (kept in sync by
    // inspection, per this module's own doc comment above): only checked
    // when about to hard-fail (enforce "always", no credential) and auth
    // wasn't explicit, i.e. the store was never consulted for real above.
    if (
      authSpec &&
      authSpec.enforce === "always" &&
      authSpec.credential === undefined &&
      !spawnDefaults.auth.explicit &&
      apiKeyStoreProvider !== undefined
    ) {
      const ignored = await getProviderKey(apiKeyStoreProvider)
      if (ignored !== undefined) {
        authSpec = { ...authSpec, ignoredApiKeyInStore: true }
      }
    }
  }

  const spawnWithResume = async (
    resumeSessionId?: string,
  ): Promise<SessionDescriptor> => {
    let liveSessionId: string | undefined
    const resolvedBaseUrl = authSpec?.baseUrl ?? effRoute?.baseUrl
    const agentSession = await resolved.startSession({
      cwd,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(effModel ? { model: effModel } : {}),
      ...(effEffort ? { effort: effEffort } : {}),
      ...(effPosture !== undefined ? { posture: effPosture } : {}),
      ...(effContextProfile ? { contextProfile: effContextProfile } : {}),
      // Legacy AIP-45 mode remains a back-compat override only.
      ...(overrides.mode ? { mode: overrides.mode } : {}),
      ...(prev.mcpServers ? { mcpServers: prev.mcpServers } : {}),
      ...(authSpec ? { auth: authSpec } : {}),
      ...(typeof resolvedBaseUrl === "string" && resolvedBaseUrl.length > 0
        ? { options: { base_url: resolvedBaseUrl } }
        : {}),
      onActivity: () => {
        if (liveSessionId) registry.pulseActivity(liveSessionId)
      },
    })
    // Same "which path was used" logic the RESULT computes below (see the
    // `resumeVia` comment near the return statement) — computed here, per
    // call, off the `resumeSessionId` this specific attempt used, so the
    // fields land on the STORED descriptor rather than only being grafted
    // onto the caller's response object (the bug this module's persistence
    // fix addresses; see `SessionDescriptor.resumedFrom`'s doc).
    const resumeVia = !resumeSessionId
      ? ""
      : opts.forceAgentResume
        ? "resumed via ACP"
        : describeResumePath(augmented)
    const desc = registry.spawnAgent({
      workspaceSlug: prev.workspaceSlug,
      cwd,
      agentSession,
      adapterSlug,
      harness: effHarness,
      ...(prev.label ? { label: prev.label } : {}),
      ...(prev.mcpServers ? { mcpServers: prev.mcpServers } : {}),
      ...(effModel ? { model: effModel } : {}),
      // Decomposed config-axis echoes (SPEC §3.7) — carried forward from `prev`
      // and overlaid with any override so every axis round-trips onto the fresh
      // descriptor and the picker re-opens on it (SPEC §3.8), even the axes
      // whose spawn-env apply-path isn't wired here yet (route/posture/context).
      ...(effEffort ? { effort: effEffort } : {}),
      ...(effPosture !== undefined ? { posture: effPosture } : {}),
      ...(effRoute ? { route: effRoute } : {}),
      ...(effContextProfile ? { contextProfile: effContextProfile } : {}),
      ...(accessProfileEcho ? { accessProfile: accessProfileEcho } : {}),
      ...(effMode ? { mode: effMode } : {}),
      ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
      // Verifiability echo (never the credential) — see the auth
      // resolution block above. Absent when no credential resolved,
      // same as session-spawn.ts.
      ...(authEcho?.fingerprint
        ? {
            auth: {
              mode: authEcho.authMode,
              fingerprint: authEcho.fingerprint,
              provider: authEcho.provider,
              credentialSource: authEcho.credentialSource,
              setEnv: authEcho.setEnv,
            } satisfies SessionAuthEcho,
          }
        : {}),
      resumedFrom: prev.id,
      resumeVia,
    })
    liveSessionId = desc.id
    return desc
  }

  let desc: SessionDescriptor
  let resumeFallback = false
  try {
    desc = await spawnWithResume(strategy.resumeSessionId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (strategy.resumeSessionId && /not found|Resource not found/i.test(msg)) {
      desc = await spawnWithResume(undefined)
      resumeFallback = true
    } else {
      throw err
    }
  }

  // ── Announce the changed axes (SPEC §4.3) ────────────────────────
  // One `session:config-changed` event per axis the operator overrode (from
  // #490, the axis-generic successor to `session:model-changed`), carried on
  // the NEW session id so a client that followed the restart via `resumedFrom`
  // sees which axes moved. Emitted only after a successful spawn — an override
  // that failed eligibility (400) or missing-credential (fail-loud) never gets
  // here, so no phantom "changed" is announced for a restart that didn't happen.
  const ts = new Date().toISOString()
  const emit = (axis: SessionConfigAxis, value: NonNullable<SessionConfig[SessionConfigAxis]>) => {
    registry.emitConfigChanged({
      type: "session:config-changed",
      sessionId: desc.id,
      axis,
      value,
      ...(desc.label ? { label: desc.label } : {}),
      ts,
    } as SessionConfigChangedEvent)
  }
  if (overrides.model !== undefined) emit("model", overrides.model)
  if (overrides.effort !== undefined) emit("effort", overrides.effort)
  if (accessOverrideRef !== undefined) emit("access", { profileRef: accessOverrideRef })
  if (overrides.route !== undefined) emit("route", overrides.route)
  if (overrides.posture !== undefined) emit("posture", overrides.posture)
  if (overrides.contextProfile !== undefined) emit("contextProfile", overrides.contextProfile)
  if (overrides.harness !== undefined) emit("harness", overrides.harness)

  return {
    desc,
    resumedFrom: prev.id,
    // `spawnWithResume` already computed + persisted this onto `desc` (the
    // fix this module carries — see `SessionDescriptor.resumedFrom`'s doc);
    // reading it back here rather than recomputing keeps the RESULT and the
    // STORED descriptor from ever being able to diverge. Never actually
    // undefined — every `spawnWithResume` call sets it, `?? ""` is just
    // satisfying the optional field's type.
    resumeVia: desc.resumeVia ?? "",
    ...(resumeFallback ? { resumeFallback: true } : {}),
  }
}
