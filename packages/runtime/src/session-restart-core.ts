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

import { boundaryFromMeta, boundaryMeta, boundaryRestartOptions } from "./app-boundary.js"
import {
  adapterConfigDirFor,
  mintSessionId,
  SESSION_ID_ENV,
  WORKSPACE_SLUG_ENV,
  isResumable,
  canResume,
  SessionRetiredError,
  type AgentSessionLike,
  type SessionDescriptor,
  type SessionsRegistry,
  type SessionAuthEcho,
  type SessionAccessProfileEcho,
} from "./sessions.js"
import { isRetired } from "./session-retirement.js"
import type { AgentAdapterResolver, CatalogModelsLister } from "./http-server.js"
import {
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
  RESUME_ID_REJECTED_RE,
  RESUME_CONNECTION_LOST_RE,
  type RestartStrategy,
} from "./resume-strategies.js"
import {
  resolveSpawnDefaults,
  resolveAuthSpec,
  SubscriptionSourceError,
  modelIdPrefixProvider,
  boxLoginDeclFor,
  forwardedSubaccountAuthInputs,
  type SpawnDefaultsConfig,
  type DefaultsAdapterAuthConfig,
  type ResolvedAuthSpec,
  type AuthEcho,
  type AdapterAuthDescriptor,
} from "./spawn-defaults.js"
import { readRecipeLoginJson } from "@agentproto/secrets/provision/recipe"
import { bootSandboxAgentSession, stampDaemonCallerSessionId, uploadBoxLoginCopy } from "./session-spawn.js"
import { createBoxLoginRefresher, type BoxLoginRefreshOutcome } from "./box-login-bridge.js"
import { findWorkspace, loadWorkspacesConfig } from "./workspaces-config.js"
import { SANDBOX_BRANCH_PREFIX } from "./sandbox-workspace-remote.js"
import { stripOwnCallerStamp } from "./session-continue-fresh.js"
import {
  buildRouteAwareLaunchConfig,
  type RouteAwareLaunchConfig,
} from "./launch-config.js"
import { buildResumeContextDigest } from "./resume-context-digest.js"
import {
  buildBoxRestartHandoff,
  buildLocalRestartHandoff,
  writeBoxPriorTranscripts,
  type RestartHandoff,
} from "./restart-handoff.js"
import { eligibleProfilesForRoute, spawnEligibilityManifest } from "./eligibility-manifest.js"
import { resolveProfileSubaccount, type ResolvedProfileSubaccount } from "./subaccount-resolution.js"
import { getProviderKey } from "./providers-store.js"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import {
  checkModelAdapterEligibility,
  checkModelWalletEligibility,
  modelAdapterIncompatibleMessage,
  modelWalletIneligibleMessage,
  reconcileModelRoute,
} from "./catalog-models.js"
import type { CatalogProvider } from "@agentproto/model-catalog"
import { loadConfig } from "./config.js"
import type { SessionConfig, RouteSpec } from "./session-config.js"
import type { SessionConfigChangedEvent, SessionConfigAxis } from "./session-event-bus.js"
import {
  getAuthProfile,
  KeychainStore,
  type AuthProfile,
  type AuthMethod,
} from "@agentproto/auth"
import {
  createSandboxAgentSessionHost,
  isSandboxBoxGoneError,
  resolveLifecyclePolicy,
  SandboxHostBootFailedError,
  type SandboxAgentSessionHost,
  type SandboxSpec,
} from "@agentproto/sandbox"
import { createSandboxAgentSessionProxy } from "./sandbox-agent-session-proxy.js"
import {
  formatDeliveryNotice,
  trackedSandboxDeliveryOpts,
  resolveSandboxCheckpointConfig,
  type SandboxDeliveryTarget,
} from "./sandbox-delivery.js"
import { sessionTranscriptDir } from "./transcript-writer.js"
import { resolveSandboxWorkspaceSource } from "./sandbox-workspace-derive-remote.js"
import {
  adoptTarCheckpoint,
  readTarTarget,
  savedTarArchive,
  tarCheckpointProxyOpts,
} from "./sandbox-tar-checkpoint.js"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type { AcpMcpServer } from "@agentproto/acp"

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
) => Promise<{ profile: AuthProfile; credential?: string; subaccount?: ResolvedProfileSubaccount } | undefined>

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
): Promise<
  { profile: AuthProfile; credential?: string; subaccount?: ResolvedProfileSubaccount } | undefined
> {
  const profile = await getAuthProfile(profileRef)
  if (!profile) return undefined
  if (profile.subaccount !== undefined) {
    try {
      const stored =
        profile.credentialRef !== undefined
          ? (await new KeychainStore().read({ path: profile.credentialRef }))?.value
          : undefined
      const subaccount = await resolveProfileSubaccount(
        profile,
        stored !== undefined ? { credential: stored } : {},
      )
      return {
        profile,
        ...(subaccount?.credential !== undefined ? { credential: subaccount.credential } : {}),
        ...(subaccount ? { subaccount } : {}),
      }
    } catch (err) {
      if (err instanceof SubscriptionSourceError) throw new RestartOverrideError(err.message)
      throw err
    }
  }
  if (profile.credentialRef === undefined) {
    // A source-backed profile (`profile.source`) has no stored secret to read
    // here. Self-refreshing restart is out of scope today — only spawn
    // (`session-spawn.ts`) resolves `source` — so this fails LOUD rather than
    // restarting with no credential.
    throw new RestartOverrideError(
      `restart access override: profile "${profile.id}" is source-backed ` +
        `("${profile.source}") — restart does not yet support self-refreshing ` +
        `profiles, only spawn does. Use a credential-backed profile instead.`,
    )
  }
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

/** Resolved billing-auth for a resume — the pair {@link resolveResumeAuth}
 *  produces and both call-sites thread into `startSession({ auth })` and its
 *  `base_url` option. Both fields absent ⇒ ambient (adapter with no
 *  `authDescriptor`, or a resolver that produced no spec), same as a fresh
 *  spawn with no configured credential. */
export interface ResumeAuthResolution {
  authSpec?: ResolvedAuthSpec
  authEcho?: AuthEcho
}

export interface ResolveResumeAuthOptions {
  /** Adapter slug of the session being resumed. */
  adapterSlug: string
  /** Effective model — override-overlaid for `restartAgentSession`'s base
   *  branch, `prev.model` for the lazy in-place resume hook. Feeds the
   *  provider derivation + model↔wallet eligibility gate. */
  model?: string
  /** Effective route — drives the gateway/base_url + api-key store provider. */
  route?: RouteSpec
  /** The pinned named auth profile to re-resolve, if any (from
   *  `prev.accessProfile.profileRef` on the lazy path). Undefined ⇒ base mode
   *  path only, which is exactly what `restartAgentSession` passes so its
   *  behaviour is byte-identical to before the extraction (its own `access`
   *  OVERRIDE stays inline — this is only the pinned-profile re-bind the lazy
   *  resume needs). A source-backed profile (spawn-only, `credentialRef`
   *  absent) falls back to the base mode path. */
  accessProfileRef?: string
  /** Prefix for the model↔wallet ineligibility message ("restart" for the
   *  restart base branch — preserving its exact wording — "resume" otherwise). */
  prefix?: string
  /** config.json `defaults` loader — same seam as
   *  {@link RestartAgentSessionOptions.loadDefaultsConfig}. Defaults to
   *  `loadConfig()`; tests inject a stub. */
  loadDefaultsConfig?: () => Promise<SpawnDefaultsConfig | undefined>
  /** Resolve `accessProfileRef` → profile metadata + secret. Defaults to
   *  {@link resolveAccessProfileFromStore}; tests inject a stub. */
  resolveAccessProfile?: AccessProfileResolver
  /** Same seam as `SpawnAgentSessionDeps.listCatalogModels` in
   *  session-spawn.ts — feeds the adapter-capability guard
   *  (`checkModelAdapterEligibility`). Omitted ⇒ the guard is skipped. */
  listCatalogModels?: CatalogModelsLister
}

/**
 * Re-resolve billing-auth for a resume of `prev`, using the SAME resolver chain
 * a fresh spawn / `session_restart` uses — the MODE comes from the prior
 * descriptor's `auth.mode` echo (or a pinned named profile), the CREDENTIAL is
 * re-resolved fresh from config / providers.json / the keychain, NEVER copied
 * (it was never persisted, by design — `SessionDescriptor.auth`) and NEVER
 * inherited from the daemon's ambient env. This is the shared core of the
 * "money bug" fix: extracted out of `restartAgentSession`'s base branch so the
 * registry's lazy in-place `resumeAgent` hook (which used to call
 * `startSession` with NO `auth` at all — index.ts) re-bills correctly instead
 * of on whatever `ANTHROPIC_API_KEY` the daemon happened to hold.
 *
 * Fail-loud contract (identical to spawn/restart): an unsupported mode throws
 * `AuthResolutionError`; a pinned profile that can't be verified eligible or
 * doesn't match its route throws `RestartOverrideError`; a model↔wallet
 * mismatch throws `RestartOverrideError`; and an engaged mode with no resolved
 * credential is caught downstream by the driver's `missing_auth_credential`.
 * The caller NEVER silently starts a session on ambient env when a pinned mode
 * fails to resolve.
 *
 * Returns `{}` when the adapter presents no `authDescriptor` (ambient — e.g.
 * hermes), unchanged from before this existed.
 */
export async function resolveResumeAuth(
  prev: SessionDescriptor,
  resolved: { authDescriptor?: AdapterAuthDescriptor; defaultModel?: string },
  opts: ResolveResumeAuthOptions,
): Promise<ResumeAuthResolution> {
  const { adapterSlug } = opts
  const effModel = opts.model
  const effRoute = opts.route
  const prefix = opts.prefix ?? "resume"

  // ── Pinned named-profile re-resolution ───────────────────────────
  // A session pinned to a named `accessProfile` re-binds to THAT profile's own
  // credential (keychain) + re-validates its eligibility against the resolved
  // `(adapter × route)` endpoint — the same Rx/Ry gate `restartAgentSession`'s
  // access-OVERRIDE branch and `session-spawn.ts` apply, so a resume can't
  // silently swap in a wallet the operator never named. Source-backed profiles
  // are spawn-only today (documented limitation, `resolveAccessProfileFromStore`
  // throws for them) → fall back to the base mode path below, fail-loud if
  // nothing resolves there.
  if (opts.accessProfileRef !== undefined && resolved.authDescriptor) {
    const resolveProfile = opts.resolveAccessProfile ?? resolveAccessProfileFromStore
    let found:
      | { profile: AuthProfile; credential?: string; subaccount?: ResolvedProfileSubaccount }
      | undefined
    try {
      found = await resolveProfile(opts.accessProfileRef)
    } catch (err) {
      // The default resolver throws `RestartOverrideError` only for a
      // source-backed profile — treat that as "not credential-backed here" and
      // fall through to the base mode path. Any other error is real; propagate.
      if (!(err instanceof RestartOverrideError)) throw err
      found = undefined
    }
    if (found) {
      const { profile, credential, subaccount } = found
      const projected = spawnEligibilityManifest(
        adapterSlug,
        resolved.authDescriptor,
        effRoute,
        effModel ?? resolved.defaultModel,
      )
      if (!projected) {
        throw new RestartOverrideError(
          `${prefix} access profile: cannot resolve a billing vendor for adapter ` +
            `"${adapterSlug}" (no fixed provider, no model) — profile "${profile.id}" ` +
            `eligibility is unverifiable, refusing to resume.`,
        )
      }
      const { manifest, routeId } = projected
      if (eligibleProfilesForRoute([profile], manifest, routeId, effModel ?? resolved.defaultModel).length === 0) {
        const billed = manifest.endpointByRoute[routeId]
        const methods = manifest.methodsByRoute[routeId] ?? []
        throw new RestartOverrideError(
          `${prefix} access profile: profile "${profile.id}" (${profile.endpoint}/${profile.method}) ` +
            `is not eligible for adapter "${adapterSlug}" on route "${routeId}" — that endpoint ` +
            `bills "${billed}" via [${methods.join(", ") || "no presentable methods"}].`,
        )
      }
      const mode = methodToMode(profile.method)
      const result = resolveAuthSpec({
        descriptor: resolved.authDescriptor,
        ...(effModel ? { model: effModel } : {}),
        ...(effRoute?.gateway ? { routeGateway: effRoute.gateway } : {}),
        ...(!effRoute?.gateway
          ? { requestedProvider: (manifest.endpointByRoute[routeId] ?? profile.endpoint) as CatalogProvider }
          : {}),
        requestedMode: mode,
        // A named profile is an EXPLICIT billing choice — a missing credential
        // fails loud (driver `missing_auth_credential`), never ambient.
        explicit: true,
        ...(mode === "subscription" && credential !== undefined
          ? { subscriptionCredential: credential }
          : {}),
        ...(mode === "api-key" && credential !== undefined
          ? { apiKeyConfigCredential: credential }
          : {}),
        ...(subaccount ? subaccount.authInputs : {}),
      })
      return { authSpec: result?.spec, authEcho: result?.echo }
    }
    // found === undefined → profile gone / source-backed → base mode path.
  }

  // ── Base mode path (extracted verbatim from restartAgentSession) ──
  // Mode from the prior descriptor's `auth.mode` echo; credential re-resolved
  // from config/providers.json in the same merge order as a fresh spawn. No
  // prior echo ⇒ `explicitAuthInput` undefined ⇒ resolves like a fresh spawn
  // with no explicit `auth`, never inventing a mode.
  if (!resolved.authDescriptor) return {}
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
    (authModel && resolved.authDescriptor.modelDerivedApiKey
      ? modelIdPrefixProvider(authModel)
      : undefined) ??
    (authModel ? getModelProvider(authModel) : undefined)
  // With an explicit gateway route the provider-store key is looked up under
  // the gateway id (e.g. "moonshot") rather than the model-derived vendor.
  const apiKeyStoreProvider = effRoute?.gateway ?? resolvedProvider
  // Same money-safety gate as session-spawn.ts: the providers.json store is
  // only consulted when the resolved auth is EXPLICIT (never for an
  // unconfigured `always`-enforcing adapter, which must fail-fast).
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
    ...forwardedSubaccountAuthInputs(spawnDefaults.auth),
    ...(spawnDefaults.auth.loginFile === true ? { loginFile: true } : {}),
  })
  let authSpec = result?.spec
  const authEcho = result?.echo
  // Money-safety spawn guard (SPEC §1c): the auth-MODE path validates only
  // provider→mode support, never that the resolved wallet can bill THIS model.
  // Scoped to the UNNAMED-wallet case; FAIL LOUD, never swap in an eligible
  // wallet the operator didn't name.
  if (
    effRoute?.gateway === undefined &&
    authModel !== undefined &&
    resolvedProvider !== undefined
  ) {
    const verdict = checkModelWalletEligibility(authModel, resolvedProvider)
    if (!verdict.ok) {
      throw new RestartOverrideError(
        modelWalletIneligibleMessage({
          prefix,
          adapter: adapterSlug,
          model: authModel,
          walletRoute: resolvedProvider,
          ...(authSpec?.mode ? { walletMode: authSpec.mode } : {}),
          suggestedRoutes: verdict.suggestedRoutes,
        }),
      )
    }
  }
  // Adapter-capability guard — same rationale/scope as session-spawn.ts's
  // mirror: the wallet guard above proves the ROUTE can bill this model, not
  // that THIS adapter's manifest can reach it there. Optional dep; skipped
  // (no protection, same as before this guard existed) when unwired.
  if (
    effRoute?.gateway === undefined &&
    authModel !== undefined &&
    resolvedProvider !== undefined &&
    opts.listCatalogModels
  ) {
    const catalog = await opts.listCatalogModels({})
    const verdict = checkModelAdapterEligibility(catalog, adapterSlug, authModel, resolvedProvider)
    if (!verdict.ok) {
      throw new RestartOverrideError(
        modelAdapterIncompatibleMessage({
          prefix,
          adapter: adapterSlug,
          model: authModel,
          route: resolvedProvider,
          compatibleAdapters: verdict.compatibleAdapters,
        }),
      )
    }
  }
  // Same non-authenticating hint as session-spawn.ts: only when about to
  // hard-fail (enforce "always", no credential) and auth wasn't explicit.
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
  return { authSpec, authEcho }
}

export interface RestartAgentSessionResult {
  desc: SessionDescriptor
  resumedFrom: string
  resumeVia: string
  resumeFallback?: boolean
  /** True when a fallback occurred AND the daemon transcript contained
   *  actual conversation content that was injected as a digest. False
   *  when no digest was available (daemon transcript empty/missing) or
   *  when no fallback occurred (successful native/ACP resume). This
   *  lets callers distinguish "fresh with zero context" from "fresh
   *  with partial digest injected" for the restart banner. */
  digestRecovered?: boolean
  /** Structured handoff the restart injected instead of the old digest:
   *  the full transcript file's path, the checkpoint id, and how much
   *  conversation was recovered — so CLI/VS Code/session-chat can say
   *  "conversation restored from transcript (N messages)". Absent when
   *  no handoff could be built (the digest fallback ran, or nothing). */
  handoff?: RestartHandoff
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
  /** Same seam as `SpawnAgentSessionDeps.listCatalogModels` in
   *  session-spawn.ts — feeds the adapter-capability guard
   *  (`checkModelAdapterEligibility`) via `resolveResumeAuth`. Omitted ⇒ the
   *  guard is skipped. */
  listCatalogModels?: CatalogModelsLister
  /** Required to restart a sandbox session (`prev.remote === true` carrying a
   *  `sandboxId`): resolves the box's provider so the EXISTING sandbox can be
   *  re-connected and the adapter re-spawned inside it. Never consulted for a
   *  local session. Omitted for a sandbox session ⇒ a loud error — never a
   *  local spawn of a box path (`/home/user` etc.). */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Daemon's own `/mcp` base URL — same seam as
   *  `RegisterAgentToolsOptions.daemonMcpUrl` / `SpawnAgentSessionDeps`'s own
   *  threading. Lets the carried-forward `mcpServers` be re-stamped with the
   *  FRESH session's id (see `stampDaemonCallerSessionId`) instead of staying
   *  pinned to the OLD (now-dead) session's id. Every production restart path
   *  should wire this (`POST /sessions/:id/restart`, `session_restart`,
   *  `makeRestartForRouting`'s sentinel/inbound hooks, the cron scheduler's
   *  `prompt-session` action — all in index.ts, mirroring `daemonMcpUrl`'s own
   *  construction there). Omitted ⇒ `mcpServers` is carried forward UNTOUCHED
   *  (neither stripped nor re-stamped) — an absent URL means this restart
   *  can't safely re-identify the mount, so it deliberately falls back to the
   *  pre-fix behaviour (stale-but-present identity) rather than stripping to
   *  no identity at all, and logs loudly so a caller that forgot to wire it
   *  shows up in the daemon's own log. */
  daemonMcpUrl?: string
}

// ── In-place restart (same-id revival) ─────────────────────────────────
//
// Restarting an ended-but-resumable agent-cli session used to ALWAYS mint a
// new row (continuedFrom/continuedTo chain), even though the registry can
// revive the dead row IN PLACE — same id — via the lazy resume-on-prompt
// primitive (`maybeResumeAgent`, sessions.ts). Users saw a "new
// conversation" every time. These helpers are the ONE shared decision all
// restart paths go through:
//
//   - `session_restart` (explicit operator action) — tries the in-place
//     revival first when the row is ended + resumable + carries no override
//     axes; on success returns the SAME id with `sameId: true`.
//   - INBOUND (watcher + push router — a HUMAN writing to the session) —
//     same helper with `allowDeliberateEnd: true`: explicit human intent,
//     so even a deliberate end may be revived in place.
//   - the SENTINEL (AUTOMATIC) — same helper with
//     `allowDeliberateEnd: false`: a deliberate end
//     (`operator-completed`/`operator-stopped`/`steward-completed`/
//     `steward-abandoned`, `DELIBERATE_END_REASONS`) is never revived in
//     place; it falls back to today's new-id restart unchanged. (The
//     sentinel additionally never reaches the helper for a deliberate end —
//     its own `sessionInfo` guard routes those to the parent / parking.)
//
// On any failure (triggerResume returns false / throws / ResumeDisabledError
// / the row isn't eligible) the caller falls back to `restartAgentSession`'s
// new-id path — byte-identical to the pre-change behaviour.

export interface RestartPreferInPlaceOptions extends RestartAgentSessionOptions {
  /** Whether a deliberate end (see `DELIBERATE_END_REASONS`) may still be
   *  restarted. Default false — the AUTOMATIC path (sentinel) never
   *  revives a deliberate end. The human-intent paths pass true:
   *  `session_restart` (explicit operator action) and the inbound
   *  watcher/push router (a human writing to the session) both revive a
   *  deliberate end in place when the row is resumable. */
  allowDeliberateEnd?: boolean
}

export interface RestartPreferInPlaceResult {
  /** The live descriptor — the SAME row when `sameId` is true. */
  desc: SessionDescriptor
  /** True when the restart revived the existing row in place (no new id,
   *  no `continuedFrom`/`continuedTo` chain). */
  sameId: boolean
  /** The id this restart continued from — `prev.id` in both branches (equal
   *  to `desc.id` when `sameId` is true). */
  resumedFrom: string
  /** Which path was used — `"in-place"` for the in-place revival. */
  resumeVia: string
  resumeFallback?: boolean
  digestRecovered?: boolean
  /** Present when the new-id fallback built a structured handoff (see
   *  `RestartAgentSessionResult.handoff`); absent for an in-place revival
   *  or a fallback with no recoverable transcript. */
  handoff?: RestartHandoff
}

/** The shared in-place eligibility decision: the row must be ENDED (not
 *  running/starting — a live row keeps today's new-id restart), carry no
 *  override axes (a config change needs a fresh descriptor), not be a
 *  deliberate end unless the caller is an explicit operator action, and
 *  pass the registry's own resume gates (`isResumable` — agent-cli with
 *  adapterSlug/adapterSessionId/cwd, not archived — and `canResume` —
 *  under `MAX_RESUME_ATTEMPTS`). */
export function restartInPlaceEligible(
  desc: SessionDescriptor,
  opts: { overrides?: RestartOverrides; allowDeliberateEnd?: boolean } = {},
): boolean {
  const hasOverrides = Object.keys(opts.overrides ?? {}).length > 0
  const ended = desc.status !== "running" && desc.status !== "starting"
  return (
    ended &&
    !hasOverrides &&
    (opts.allowDeliberateEnd === true || !isRetired(desc)) &&
    isResumable(desc) &&
    canResume(desc)
  )
}

/** Try the in-place revival of an ended row via the registry's own
 *  `triggerResume` (the primitive lazy resume-on-prompt uses — wraps
 *  `maybeResumeAgent(rt, "restarted")`, returns whether the row is bound
 *  again). Returns the revived SAME-id descriptor, or `undefined` when the
 *  row isn't eligible or the resume didn't take — the caller then falls
 *  back to the new-id restart. */
export async function tryRestartInPlace(
  registry: SessionsRegistry,
  desc: SessionDescriptor,
  opts: { overrides?: RestartOverrides; allowDeliberateEnd?: boolean } = {},
): Promise<SessionDescriptor | undefined> {
  if (!restartInPlaceEligible(desc, opts)) return undefined
  let resumed = false
  try {
    resumed = await registry.triggerResume(desc.id, {
      force: opts.allowDeliberateEnd === true,
    })
  } catch {
    resumed = false
  }
  if (!resumed) return undefined
  const live = registry.get(desc.id)
  // `triggerResume` answers "is a binding present" — which is also true for
  // the STALE binding `kill()` leaves behind (it closes the session but keeps
  // the reference, so a killed row is deliberately NOT lazy-resumable in
  // the same daemon lifetime). A real revival flips the row back to
  // running (`maybeResumeAgent` clears the terminal fields), so require
  // exactly that: a still-terminal row means the resume didn't take, and
  // the caller falls back to the new-id restart.
  if (!live || (live.status !== "running" && live.status !== "starting")) return undefined
  return live
}

/** The full shared restart decision for the routing paths (sentinel +
 *  inbound): in-place revival when eligible, else today's new-id
 *  `restartAgentSession` unchanged. Callers pass `forceAgentResume: true`
 *  and their own `allowDeliberateEnd` — false for the sentinel
 *  (automatic), true for inbound (human intent). */
export async function restartPreferInPlace(
  registry: SessionsRegistry,
  resolveAgentAdapter: AgentAdapterResolver,
  prev: SessionDescriptor,
  opts: RestartPreferInPlaceOptions = {},
): Promise<RestartPreferInPlaceResult> {
  // A retired row must not fall through to the new-id restart either: that
  // is the same revival, just under a fresh id (the "zombie brain" shape).
  if (opts.allowDeliberateEnd !== true && isRetired(prev)) {
    throw new SessionRetiredError(prev.id, prev.status, "restartPreferInPlace", prev.continuedTo)
  }
  const inPlace = await tryRestartInPlace(registry, prev, opts)
  if (inPlace) {
    return {
      desc: inPlace,
      sameId: true,
      resumedFrom: prev.id,
      resumeVia: "in-place",
    }
  }
  const restarted = await restartAgentSession(registry, resolveAgentAdapter, prev, opts)
  return {
    desc: restarted.desc,
    sameId: false,
    resumedFrom: restarted.resumedFrom,
    resumeVia: restarted.resumeVia,
    ...(restarted.resumeFallback ? { resumeFallback: true } : {}),
    ...(restarted.digestRecovered ? { digestRecovered: true } : {}),
    ...(restarted.handoff ? { handoff: restarted.handoff } : {}),
  }
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
  // Sandbox gate — BEFORE any local strategy decision: a sandbox descriptor's
  // `cwd` is a path INSIDE the box (`/home/user`, …), so the local branches
  // below (adapter resolution → `startSession` with `cwd = prev.cwd` on the
  // HOST) would spawn `npx opencode-ai` locally against a nonexistent host
  // directory. A sandbox restart re-attaches the box and re-spawns the
  // adapter inside it instead (see `spawnInSandbox`).
  const sandboxId =
    prev.remote === true && prev.sandboxId !== undefined ? prev.sandboxId : undefined
  // Sandbox restart only — the same `defaults.sandbox.checkpoint` →
  // per-spawn resolution a fresh spawn runs; the spawn's own override rides
  // the descriptor (`sandboxCheckpointOverride`).
  const checkpointConfig =
    sandboxId !== undefined
      ? resolveSandboxCheckpointConfig(
          (opts.loadDefaultsConfig ? await opts.loadDefaultsConfig() : (await loadConfig()).defaults)?.sandbox
            ?.checkpoint,
          prev.sandboxCheckpointOverride,
        )
      : undefined
  // `forceAgentResume` never consults `augmented` (see the `resumeVia`
  // comment below) — skip the FS probe entirely rather than pay for I/O
  // whose result is discarded. A sandbox session skips it too: its `cwd`
  // is a box path, meaningless on the host FS.
  const augmented =
    sandboxId !== undefined || opts.forceAgentResume ? prev : await augmentWithFsResume(prev)
  const strategy: RestartStrategy =
    sandboxId !== undefined
      ? // The box daemon's own `agent_start` now takes a resume target (its
        // prior in-box session id) and rehydrates that adapter conversation
        // with the same ACP-level resume a local restart uses — see
        // `spawnInSandbox`. A row with no recorded in-box id, or an adapter
        // declaring `resumable: false`, keeps the flagged fallback so the
        // digest below still runs.
        {
          kind: "agent",
          ...(prev.adapterSessionId && prev.resumable !== false
            ? { resumeSessionId: prev.adapterSessionId }
            : { resumeFallback: true }),
        }
      : opts.forceAgentResume
        ? { kind: "agent", resumeSessionId: prev.adapterSessionId }
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
  if (!resolved && sandboxId === undefined) {
    throw new Error(`restartAgentSession: adapter '${adapterSlug}' not found.`)
  }

  let cwd = prev.cwd
  if (!cwd) console.warn(`[restartAgentSession] no cwd on prior descriptor ${prev.id} — falling back to daemon's cwd ${process.cwd()}`)
  cwd ??= process.cwd()

  // ── Effective config axes (SPEC §4.3 overlay) ────────────────────
  // `effective = { ...prev axes, ...overrides }`: an axis present in the
  // override wins, an axis omitted is carried forward from `prev` so a
  // single-axis restart never silently drops the rest (SPEC §3.8 round-trip).
  // `model` and `route` are reconciled first so they can never describe two
  // different billing endpoints: an explicit `@route` on the model wins, a
  // route-only override rewrites a parseable model string, and a model-only
  // override synthesizes the route field when it conflicts with the prior one.
  const overrides = opts.overrides ?? {}
  const reconciled = reconcileModelRoute({
    prevModel: prev.model,
    prevRoute: prev.route,
    model: overrides.model,
    route: overrides.route,
  })
  const effModel = reconciled.model ?? prev.model
  const effEffort = overrides.effort ?? prev.effort
  const effRoute = reconciled.route ?? prev.route
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
    const { profile, credential, subaccount } = found
    if (!resolved) {
      throw new RestartOverrideError(
        `restart access override: adapter "${adapterSlug}" is not installed on the host — ` +
          `profile "${profile.id}" eligibility cannot be verified, refusing to spawn.`,
      )
    }
    if (!resolved.authDescriptor) {
      throw new RestartOverrideError(
        `restart access override: adapter "${adapterSlug}" presents no billing-auth, ` +
          `so profile "${profile.id}" cannot be attached.`,
      )
    }
    const projected = spawnEligibilityManifest(
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
    if (eligibleProfilesForRoute([profile], manifest, routeId, effModel ?? resolved.defaultModel).length === 0) {
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
      ...(!effRoute?.gateway
          ? { requestedProvider: (manifest.endpointByRoute[routeId] ?? profile.endpoint) as CatalogProvider }
          : {}),
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
      ...(subaccount ? subaccount.authInputs : {}),
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
      ...(subaccount ? { subaccount: subaccount.pin } : {}),
    }
  } else if (resolved?.authDescriptor) {
    // Base mode path (no explicit `access` override): re-resolve billing-auth.
    // When the prior session was pinned to a named profile, pass its profileRef
    // so `resolveResumeAuth` re-reads the CURRENT credential from the keychain
    // rather than falling through to the stale mode-based path.
    const resumeAuth = await resolveResumeAuth(prev, resolved, {
      adapterSlug,
      ...(effModel ? { model: effModel } : {}),
      ...(effRoute ? { route: effRoute } : {}),
      ...(prev.accessProfile?.profileRef
        ? { accessProfileRef: prev.accessProfile.profileRef }
        : {}),
      prefix: "restart",
      ...(opts.loadDefaultsConfig ? { loadDefaultsConfig: opts.loadDefaultsConfig } : {}),
      ...(opts.listCatalogModels ? { listCatalogModels: opts.listCatalogModels } : {}),
    })
    authSpec = resumeAuth.authSpec
    authEcho = resumeAuth.authEcho
  }

  // BOX-LOGIN BRIDGE declaration for THIS restart — see `spawn-defaults.ts`'s
  // `boxLoginDeclFor`. Undefined for bearer/api-key sessions and for adapters
  // that declare no `boxLogin`, which leaves both restart paths below exactly
  // as they are today. Computed once here so the re-attach path and the
  // fresh-box path bridge the SAME declaration.
  const boxLogin = boxLoginDeclFor(resolved?.authDescriptor, authSpec, authEcho?.provider)

  // Copying `prev.mcpServers` verbatim would carry the OLD session's own
  // `callerSessionId` stamp (baked in at ITS spawn time) onto the fresh
  // restart — every spawn/`command_execute` the restarted session makes
  // through that mount would misattribute to the dead id (wrong auto-parent,
  // `message_parent` reaching the wrong session, `session_follow` defaulting
  // to the wrong follower). Strip the stale stamp (`stripOwnCallerStamp`,
  // same helper `continueAgentSessionFresh` uses) and re-stamp with THIS
  // restart's own fresh id (`stampDaemonCallerSessionId`, shared with
  // `spawnAgentSession`'s identity-stamp block).
  //
  // Both steps need the daemon's OWN `/mcp` URL — stripping alone (no
  // restamp) would leave the entry with NO identity at all, which is WORSE
  // than the stale stamp: every caller of this function is expected to
  // thread `daemonMcpUrl` through (HTTP route, MCP verb, `makeRestartForRouting`
  // (index.ts) for the sentinel/inbound paths, and the cron scheduler's
  // `prompt-session` action), but a caller that forgets must never silently
  // erase the only identity the mount had — the stale-but-present id at
  // least resolves to a real (if dead) session, same as before this fix
  // existed. So an absent `daemonMcpUrl` is a no-op here: `prev.mcpServers`
  // rides through completely untouched, and the gap is logged loudly so a
  // caller that forgot to wire `daemonMcpUrl` shows up in the daemon's own
  // log rather than silently degrading identity.
  const buildRestartMcpServers = (newSessionId: string): SessionDescriptor["mcpServers"] => {
    if (!opts.daemonMcpUrl) {
      if (prev.mcpServers && prev.mcpServers.length > 0) {
        console.warn(
          `[restartAgentSession] no daemonMcpUrl wired for restart of ${prev.id} — ` +
            `carrying mcpServers forward WITHOUT re-stamping callerSessionId (the ` +
            `restarted session ${newSessionId} will keep speaking to the daemon under ` +
            `the OLD session's identity).`,
        )
      }
      return prev.mcpServers
    }
    const stripped = stripOwnCallerStamp(prev.mcpServers, prev.id)
    return stampDaemonCallerSessionId(stripped, {
      daemonMcpUrl: opts.daemonMcpUrl,
      callerSessionId: newSessionId,
    })
  }

  const spawnWithResume = async (
    resumeSessionId?: string,
  ): Promise<SessionDescriptor> => {
    let liveSessionId: string | undefined
    // Minted BEFORE `startSession` — same reason as session-spawn.ts's
    // `mintedSessionId`: a restart/resume gets a FRESH id (see
    // `spawnAgent`'s `resumedFrom: prev.id` lineage below, not an in-place
    // id reuse), and that fresh id has to be known before the adapter
    // process ever exec's so it can be injected as AGENTPROTO_SESSION_ID —
    // never the id being restarted FROM.
    const restartedSessionId = mintSessionId()
    const restartMcpServers = buildRestartMcpServers(restartedSessionId)
    if (sandboxId !== undefined) {
      return spawnInSandbox(sandboxId, restartedSessionId, resumeSessionId)
    }
    if (!resolved) {
      throw new Error(`restartAgentSession: adapter '${adapterSlug}' not found.`)
    }
    let launchConfig: RouteAwareLaunchConfig
    try {
      launchConfig = buildRouteAwareLaunchConfig({
        adapter: adapterSlug,
        model: effModel,
        route: effRoute,
        authSpec,
        declaredOptions: resolved.declaredOptions,
        routeSelection: resolved.routeSelection,
        adapterProvider: resolved.authDescriptor?.provider,
        modelDerivedApiKey: resolved.authDescriptor?.modelDerivedApiKey,
        prefix: "restart",
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(message)
    }
    // Carry the prior session's persistent isolated-config dir forward —
    // the provider's conversation store lives inside it, so reusing the
    // SAME dir is what lets `resumeSessionId` restore full context (a
    // fresh dir here is exactly the old always-degrade-to-digest bug).
    // A legacy row with no recorded dir gets one keyed by the NEW id, so
    // the lineage is resumable from here on even if THIS restart lands as
    // a digest fallback.
    const restartConfigDir = prev.adapterConfigDir ?? adapterConfigDirFor(restartedSessionId)
    // App boundary survives a restart: same fs zones + host-context isolation.
    const prevBoundary = boundaryFromMeta(prev.meta)
    const boundaryStart = prevBoundary
      ? boundaryRestartOptions(prevBoundary, {
          supportsFsZones: resolved.supportsFsZones === true,
          supportsHostContextIsolation: resolved.supportsHostContextIsolation === true,
          ...(prev.commandSandbox === "off" ? { commandSandbox: "off" as const } : {}),
        })
      : {}
    const agentSession = await resolved.startSession({
      cwd,
      ...boundaryStart,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      configDir: restartConfigDir,
      ...(launchConfig.wireModel ? { model: launchConfig.wireModel } : {}),
      ...(effEffort ? { effort: effEffort } : {}),
      ...(effPosture !== undefined ? { posture: effPosture } : {}),
      ...(effContextProfile ? { contextProfile: effContextProfile } : {}),
      // Legacy AIP-45 mode: prefer an explicit override; otherwise carry the
      // prior descriptor's mode forward so a plain restart preserves it.
      ...(effMode ? { mode: effMode } : {}),
      ...(restartMcpServers ? { mcpServers: restartMcpServers } : {}),
      ...(prev.sessionSkills ? { sessionSkills: prev.sessionSkills } : {}),
      // Re-apply the AGENT.md system-prompt text on the SAME declared channel
      // (the original spawn already warned + prefixed when the adapter had
      // none — a channel-less lineage has nothing left to re-apply here).
      ...(prev.appendSystemPrompt && resolved.supportsSystemPrompt === true
        ? { appendSystemPrompt: prev.appendSystemPrompt }
        : {}),
      ...(authSpec ? { auth: authSpec } : {}),
      ...(launchConfig.options ? { options: launchConfig.options } : {}),
      // Spawn-time guarantees survive a restart: the adapter runs under the
      // same OS confinement it had (the EFFECTIVE mode `session-spawn.ts`
      // recorded, re-applied explicitly so a since-edited workspace config
      // can't silently loosen a running session's lineage), and a session
      // spawned in permission-hold keeps routing its permission requests to
      // the human inbox instead of auto-answering them.
      ...(prev.commandSandbox ? { commandSandbox: prev.commandSandbox } : {}),
      ...(prev.permissionHold ? { permissionHold: true } : {}),
      env: {
        [SESSION_ID_ENV]: restartedSessionId,
        [WORKSPACE_SLUG_ENV]: prev.workspaceSlug,
      },
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
    //
    // `strategy.resumeFallback` (agent-honesty fix) marks a DELIBERATE
    // capability-based downgrade — `decideRestartStrategy` never even
    // attempted `resumeSessionId` because the adapter declared
    // `resumable: false` — so this attempt's honest label comes from
    // `describeResumePath` even though `resumeSessionId` itself is
    // undefined; a plain "" stays reserved for "nothing to resume" (no id)
    // and for the not-found retry attempt below.
    const resumeVia = !resumeSessionId
      ? strategy.kind === "agent" && strategy.resumeFallback
        ? describeResumePath(augmented)
        : ""
      : opts.forceAgentResume
        ? "resumed via ACP"
        : describeResumePath(augmented)
    const desc = registry.spawnAgent({
      id: restartedSessionId,
      workspaceSlug: prev.workspaceSlug,
      cwd,
      agentSession,
      adapterSlug,
      adapterConfigDir: restartConfigDir,
      ...(resolved.resumable !== undefined ? { resumable: resolved.resumable } : {}),
      ...(resolved.nativeTerminalResume !== undefined
        ? { nativeTerminalResume: resolved.nativeTerminalResume }
        : {}),
      harness: effHarness,
      ...(resolved.routeSelection !== undefined
        ? { routeSelection: resolved.routeSelection }
        : {}),
      ...(resolved.authDescriptor?.provider !== undefined
        ? { adapterProvider: resolved.authDescriptor.provider }
        : {}),
      ...(resolved.authDescriptor?.modelDerivedApiKey !== undefined
        ? { modelDerivedApiKey: resolved.authDescriptor.modelDerivedApiKey }
        : {}),
      ...(prev.label ? { label: prev.label } : {}),
      ...(restartMcpServers ? { mcpServers: restartMcpServers } : {}),
      // Re-deliver the SAME imported skill set on restart (skill imports) —
      // `prev.sessionSkills` names stable copies under the registry root, so
      // they carry forward verbatim like `mcpServers` (see the field's doc).
      ...(prev.sessionSkills ? { sessionSkills: prev.sessionSkills } : {}),
      // Echoed forward like `sessionSkills`, so the NEXT restart still knows
      // the lineage's AGENT.md text (the channel pass above re-applies it).
      ...(prev.appendSystemPrompt
        ? { appendSystemPrompt: prev.appendSystemPrompt }
        : {}),
      ...(prevBoundary ? { meta: boundaryMeta(prevBoundary) } : {}),
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
      // Echoed so the NEXT restart (and every reader) still sees them.
      ...(prev.commandSandbox ? { commandSandbox: prev.commandSandbox } : {}),
      ...(prev.permissionHold ? { permissionHold: true } : {}),
      // Lineage carry-forward (#session-visibility). A restart is a NEW
      // descriptor, but it is the same logical session continued — so its
      // origin (which channel spawned it: cowork/vscode/codex/cron) and its
      // parent/depth must survive, exactly as continue-fresh already carries
      // them (session-continue-fresh.ts). Dropping them here is what left a
      // restarted session a bare top-level root with no source trace.
      ...(prev.origin ? { origin: prev.origin } : {}),
      ...(prev.parentSessionId ? { parentSessionId: prev.parentSessionId } : {}),
      ...(prev.depth !== undefined ? { depth: prev.depth } : {}),
      // Immutable spawn-time flags survive a restart exactly like
      // `continueAgentSessionFresh` carries `keepAlive`/`notifyParentOnCrash`
      // forward (session-continue-fresh.ts) — these are never axes a restart
      // overrides, only inherited, so dropping them here is what let a
      // persistent supervisor's restart silently become idle-reapable and
      // lose its crash-detect opt-ins.
      ...(prev.keepAlive ? { keepAlive: true } : {}),
      ...(prev.notifyParentOnCrash ? { notifyParentOnCrash: true } : {}),
      ...(prev.sentinelAutoWatch === false ? { sentinelAutoWatch: false } : {}),
      ...(prev.restartPolicy ? { restartPolicy: prev.restartPolicy } : {}),
      ...(prev.turnRetry ? { turnRetry: prev.turnRetry } : {}),
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

  // ── Sandbox branch: re-attach the box, re-spawn the adapter inside it ──
  // Mirrors session-spawn.ts's `bootSandboxAgentSession` reuse path
  // (`agent_start.sandbox.reuse`): resolve the provider, `connect()` (never
  // boot) the EXISTING `sandboxId` — `Sandbox.connect` re-arms its timeout —
  // then start the adapter on the BOX's own `agent_start` with the prior
  // descriptor's adapter/cwd/model/posture and the restart's overrides.
  // The helpers it needs (`toMcpServerMounts`, `sandboxAuthFromResolved`,
  // `resolveSandboxSecret`) are module-private in session-spawn.ts, so
  // byte-equivalent copies live at the bottom of this file — keep in sync
  // by inspection, same as the auth-resolution block above.
  //
  // In-box paths of the prior session's full transcript file(s) written
  // during this restart (restart-handoff.ts) — both the re-attach and the
  // fresh-box paths fill it in; the handoff assembly below consumes it once
  // `desc` exists. Declared above the closures that assign it so the
  // dependency is visible at a glance.
  let boxPriorTranscriptPaths: string[] = []
  const spawnInSandbox = async (
    boxSandboxId: string,
    restartedSessionId: string,
    resumeSessionId?: string,
  ): Promise<SessionDescriptor> => {
    if (!opts.resolveSandboxProvider) {
      throw new Error(
        `restartAgentSession: session '${prev.id}' runs in a sandbox but the daemon has ` +
          "no sandbox provider resolver wired — cannot re-attach its box.",
      )
    }
    const providerSlug = parseSandboxProviderSlug(prev.command)
    if (!providerSlug) {
      throw new Error(
        `restartAgentSession: session '${prev.id}' records no sandbox provider ` +
          "(no `sandbox:<provider>` command preview) — cannot re-attach its box.",
      )
    }
    const handle = await opts.resolveSandboxProvider(providerSlug)
    if (!handle) {
      throw new Error(
        `restartAgentSession: sandbox provider "${providerSlug}" not found — cannot ` +
          `re-attach sandbox "${boxSandboxId}".`,
      )
    }
    const sandboxMcpServers = buildRestartMcpServers(restartedSessionId)
    const spec: SandboxSpec = { provider: providerSlug, config: {} }
    const lifecyclePolicy = resolveLifecyclePolicy(spec, true)
    let host: SandboxAgentSessionHost
    try {
      host = await createSandboxAgentSessionHost({
        provider: handle.provider,
        spec,
        sandboxId: boxSandboxId,
        secrets: { slugs: [], resolver: resolveSandboxSecretFromBroker },
      })
    } catch (err) {
      // The box is GONE (provider not-found), or it came back without a
      // healthy daemon and the provider reclaimed it: either way there is no
      // box left to re-attach. A session whose work lives on a workspace
      // remote can still go on — boot a NEW box, re-clone, and check the
      // work branch out again (pushed commits + the last checkpoint snapshot,
      // see `sandbox-delivery.ts`).
      const boxGone = isSandboxBoxGoneError(err) || err instanceof SandboxHostBootFailedError
      let freshBlocker: string | undefined
      if (boxGone) {
        const fresh = await spawnOnFreshBox(providerSlug, restartedSessionId, sandboxMcpServers)
        if (fresh.ok) {
          // A new box has no adapter store to resume: the restart is a
          // blank fallback even when the strategy carried a resume id, so
          // the handoff/digest below must still run.
          resumeFallback = true
          return fresh.desc
        }
        freshBlocker = fresh.blocker
      }
      throw new Error(
        `restartAgentSession: sandbox "${boxSandboxId}" expired or is unreachable ` +
          `(provider "${providerSlug}")${freshBlocker ? ` and it cannot be restarted on a fresh box: ${freshBlocker}` : " — spawn a fresh session."} ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // The box is alive, so the PRIOR session's adapter may still be running
    // in it — a row that ended on a host-side error (lost event stream, box
    // daemon briefly unreachable) never got its box session killed, and that
    // process keeps editing the same checkout next to the new one. Stop it
    // through the box's own daemon BEFORE starting the replacement. Detach
    // prev's proxy first so its timers can't read the kill as a crash, and
    // so closing prev below never tears down the box.
    // The persisted ids cover a prev whose proxy is already gone (closed on
    // a failed teardown, or a daemon restart since); rows from before
    // `sandboxRemoteSessionId` existed fall back to the reattach record.
    const releasedRemoteSessionId = registry.releaseSandboxSession(prev.id)
    priorProxyReleased = releasedRemoteSessionId !== undefined
    const priorRemoteSessionId =
      releasedRemoteSessionId ??
      prev.sandboxRemoteSessionId ??
      prev.sandboxReattach?.remoteSessionId ??
      prev.hostSessionId
    if (priorRemoteSessionId !== undefined) {
      try {
        // `agent_kill` on an id the box daemon no longer knows is a no-op
        // (`ok: false`), not an error — only a transport failure throws.
        await host.kill(priorRemoteSessionId)
      } catch (err) {
        await host.close().catch(() => undefined)
        throw new Error(
          `restartAgentSession: could not stop the prior session "${priorRemoteSessionId}" ` +
            `inside sandbox "${host.sandboxId}" — refusing to start a second adapter next to ` +
            `it. ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    // Re-attach the adapter conversation the box itself still holds: the
    // stop above killed the PROCESS, but the box daemon keeps its registry
    // row (status-only `kill`), whose `adapterSessionId` + isolated config
    // dir are exactly what its `agent_start({ resumeSessionId })` resolves.
    // The killed row's id is preferred (`priorRemoteSessionId` survives
    // proxy-less restarts); a legacy row without one degrades to the host's
    // recorded id, and a row the box no longer knows degrades to a blank
    // spawn the `resumeVia` check below flags.
    const boxResumeId =
      resumeSessionId === undefined || prev.resumable === false
        ? undefined
        : (priorRemoteSessionId ?? resumeSessionId)
    let boxResumed = false
    // Best-effort: write the prior session's full transcript into the
    // re-attached box (outside the repo checkout, so the delivery hook never
    // commits it) — the handoff below points the fresh adapter at it. A
    // failure is not fatal; the handoff falls back to the old digest.
    const priorTranscripts = await writeBoxPriorTranscripts(host, prev, registry).catch(
      err => {
        console.warn(
          `restartAgentSession: writing the prior transcript of ${prev.id} into box ` +
            `${host.sandboxId} failed — ${err instanceof Error ? err.message : String(err)} ` +
            "(the handoff will fall back to the digest)",
        )
        return undefined
      },
    )
    boxPriorTranscriptPaths = priorTranscripts?.paths ?? []
    if (priorTranscripts && !priorTranscripts.ok) {
      console.warn(
        `restartAgentSession: prior transcript of ${prev.id} could not be written into ` +
          `box ${host.sandboxId} — the handoff will fall back to the digest`,
      )
    }

    // BOX-LOGIN BRIDGE — same upload the fresh boot does: a re-attach can land
    // on a box booted BEFORE this bridge existed (or by a host whose copy
    // never took), and `host.start`'s own fail-loud login verify runs inside
    // this call. Degrades exactly like `session-spawn.ts`'s: no copy → no
    // `loginFile` stamp → today's behavior, never a box spawned without the
    // file it was told to expect. A device box can't reach this path at all
    // (`parseSandboxProviderSlug` matches `sandbox:<provider>` only), so no
    // device guard is needed here.
    let boxLoginUpload: { boxPath: string; digest: string } | undefined
    let refreshBoxLogin: (() => Promise<BoxLoginRefreshOutcome>) | undefined
    if (
      boxLogin &&
      authSpec?.mode === "subscription" &&
      authSpec.externalCredential === true &&
      handle.defaultCwd &&
      host.writeFile
    ) {
      const decl = boxLogin
      const writeFile = host.writeFile
      const uploaded = await uploadBoxLoginCopy({ decl, homeDir: handle.defaultCwd, writeFile })
      if (uploaded.ok) {
        boxLoginUpload = { boxPath: uploaded.boxPath, digest: uploaded.digest }
        refreshBoxLogin = createBoxLoginRefresher({
          decl,
          path: uploaded.boxPath,
          read: () => readRecipeLoginJson(decl.recipe, decl.methodId),
          write: writeFile,
          digest: uploaded.digest,
        })
      } else {
        // Named file, never a token — `uploadBoxLoginCopy`'s message rules.
        console.warn(`[restartAgentSession] ${uploaded.message}`)
      }
    }

    let remoteSessionId: string
    try {
      const remoteDesc = await host.start({
        adapter: adapterSlug,
        ...(boxResumeId ? { resumeSessionId: boxResumeId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(effModel ? { model: effModel } : {}),
        ...(effRoute?.gateway
          ? {
              route: {
                gateway: effRoute.gateway,
                ...(effRoute.baseUrl ? { baseUrl: effRoute.baseUrl } : {}),
              },
            }
          : {}),
        ...(effEffort ? { effort: effEffort } : {}),
        ...(prev.label ? { label: prev.label } : {}),
        ...(sandboxMcpServers ? { mcpServers: toBoxMcpServerMounts(sandboxMcpServers) } : {}),
        // BOX-LOGIN BRIDGE: stamp `loginFile` ONLY on a copy that actually
        // landed — the stamp is what tells the box's verify the file exists.
        ...(authSpec
          ? {
              auth: boxLoginUpload
                ? { ...sandboxAuthForBox(authSpec, authEcho), loginFile: true }
                : sandboxAuthForBox(authSpec, authEcho),
            }
          : {}),
      })
      remoteSessionId = remoteDesc.id
      // The box reports `resumeVia` only when its own adapter actually
      // rehydrated the prior conversation. A blank answer after a resume
      // attempt (old box daemon that strips the unknown field, a row id it
      // doesn't know, or an adapter rejection it absorbed) is a flagged
      // fallback: `desc.resumeVia` stays "" and the transcript digest below
      // still runs — never a silent claim of continuity.
      boxResumed = remoteDesc.resumeVia === "resumed via ACP"
      if (boxResumeId && !boxResumed) resumeFallback = true
    } catch (err) {
      await host.stop().catch(() => undefined)
      throw new Error(
        `restartAgentSession: the sandbox's own agent_start failed for adapter ` +
          `"${adapterSlug}" — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // The prior session's work branch is still in the box: carry its delivery
    // target over so this session's teardown pushes (or bundles) it too.
    const deliveryTarget = prev.sandboxDeliveryTarget
    // A tar-mode session (workspace with no git remote) keeps checkpointing
    // its working dir; the live box still holds it, so nothing is restored.
    const tarTarget = deliveryTarget
      ? undefined
      : await adoptTarCheckpoint(sessionTranscriptDir(prev.id), sessionTranscriptDir(restartedSessionId))
    const agentSession = createSandboxAgentSessionProxy({
      host,
      remoteSessionId,
      lifecyclePolicy,
      // BOX-LOGIN BRIDGE refresh — re-upload the copy when the HOST's login
      // file changes under this re-attached box (see `createBoxLoginRefresher`;
      // the proxy owns the throttle + closed/detached gate). Absent when the
      // pre-start upload never happened, so a degraded restart stays degraded.
      ...(refreshBoxLogin ? { refreshLoginFile: refreshBoxLogin } : {}),
      ledger: { sandboxId: host.sandboxId, provider: providerSlug },
      ...(providerSlug.startsWith("device:") ? {} : { detachable: true }),
      ...(tarTarget
        ? tarCheckpointProxyOpts({
            exec: host.exec,
            ...(host.readFile ? { readFile: host.readFile } : {}),
            target: tarTarget,
            outDir: sessionTranscriptDir(restartedSessionId),
            config: checkpointConfig ?? resolveSandboxCheckpointConfig(undefined, undefined),
            notify: text => registry.recordNotice(restartedSessionId, text),
          })
        : {}),
      ...(deliveryTarget && host.exec
        ? trackedSandboxDeliveryOpts({
            exec: host.exec,
            ...(host.readFile ? { readFile: host.readFile } : {}),
            target: deliveryTarget,
            outDir: sessionTranscriptDir(restartedSessionId),
            config: checkpointConfig ?? resolveSandboxCheckpointConfig(undefined, undefined),
            baseRef: "origin/HEAD",
            onDelivery: record => {
              registry.recordSandboxDelivery(restartedSessionId, record, formatDeliveryNotice(record))
            },
            onCheckpoint: record => {
              registry.recordSandboxCheckpoint(restartedSessionId, record, formatDeliveryNotice(record))
            },
            onTargetChanged: target => {
              registry.setSandboxDeliveryTarget(restartedSessionId, target)
            },
          })
        : {}),
      watchdog: {},
    })
    return registerBoxSession(restartedSessionId, sandboxMcpServers, {
      agentSession,
      sandboxId: host.sandboxId,
      provider: providerSlug,
      sandboxTeardown: lifecyclePolicy.teardown,
      ...(boxResumed ? { resumeVia: "resumed via ACP" as const } : {}),
      ...(deliveryTarget ? { deliveryTarget } : {}),
      ...(host.ports && Object.keys(host.ports).length > 0 ? { sandboxPorts: host.ports } : {}),
    })
  }

  // Set once the restart left the old (dead) box behind for a new one.
  let movedToFreshBox = false
  // Set once prev's proxy was detached from the re-attached box — closing
  // prev is then safe again (its `close()` no longer touches the box).
  let priorProxyReleased = false
  // Box gone: boot a fresh one. A tar-mode session (workspace with no git
  // source) gets its last tarball checkpoint restored; otherwise the box is
  // cloned from the workspace remote (configured, or derived from the checkout's
  // git `origin`). With a recorded `wt/` work branch it is checked out again
  // (pushed commits + checkpoint snapshot); without one the fresh box starts
  // from the workspace's base branch on a new default work branch. `blocker`
  // says why the restart cannot proceed.
  const spawnOnFreshBox = async (
    providerSlug: string,
    restartedSessionId: string,
    sandboxMcpServers: SessionDescriptor["mcpServers"],
  ): Promise<{ ok: true; desc: SessionDescriptor } | { ok: false; blocker: string }> => {
    const target = prev.sandboxDeliveryTarget
    const prevDir = sessionTranscriptDir(prev.id)
    const resumeBranch = target?.branch.startsWith(SANDBOX_BRANCH_PREFIX) ? target.branch : undefined
    const noBranchNote = resumeBranch ? "" : " and the session recorded no work branch to resume from"
    const tarTarget = target ? undefined : await readTarTarget(prevDir)
    const notices: string[] = []
    let workspaceArgs: Pick<Parameters<typeof bootSandboxAgentSession>[0], "workspace" | "worktree" | "tarWorkspace">
    let slug: string
    if (tarTarget) {
      slug = prev.workspaceSlug ?? tarTarget.dir.split("/").filter(Boolean).pop() ?? "workspace"
      const archive = savedTarArchive(prevDir)
      if (!archive) {
        return {
          ok: false,
          blocker:
            `workspace "${slug}" has no git remote and no tarball checkpoint was saved before the box died ` +
            "(checkpoints are taken at turn end and at teardown; the 50 MiB cap may also have skipped it), so there " +
            `is nothing to restore. Give it a remote (\`agentproto workspace remote set ${slug} --url … --token-stdin\`) ` +
            "so future sessions are recoverable.",
        }
      }
      workspaceArgs = { tarWorkspace: { slug, restoreFrom: archive } }
    } else {
      if (!prev.workspaceSlug) {
        return {
          ok: false,
          blocker:
            `the session is not tied to a registered workspace${noBranchNote}, so there is no remote to clone ` +
            "into a new box. Spawn a fresh session on a workspace that has a remote " +
            "(`agentproto workspace remote set <slug> --url … --token-stdin`).",
        }
      }
      slug = prev.workspaceSlug
      const workspace = findWorkspace(await loadWorkspacesConfig(), slug)
      const source = workspace ? await resolveSandboxWorkspaceSource(workspace) : undefined
      if (!workspace || source?.kind !== "remote") {
        return {
          ok: false,
          blocker:
            `workspace "${slug}" ${workspace ? "has no remote configured" : "is no longer registered"}` +
            `${noBranchNote}, so a new box has nothing to clone. Configure one with ` +
            `\`agentproto workspace remote set ${slug} --url … --token-stdin\` and restart the session.` +
            (source && source.notices.length > 0 ? ` (${source.notices.join(" ")})` : ""),
        }
      }
      notices.push(...source.notices)
      workspaceArgs = {
        workspace: { slug: workspace.slug, remote: source.remote },
        ...(resumeBranch ? { worktree: { slug: resumeBranch.slice(SANDBOX_BRANCH_PREFIX.length) } } : {}),
      }
    }
    const booted = await bootSandboxAgentSession({
      sandbox: providerSlug,
      resolveSandboxProvider: opts.resolveSandboxProvider,
      checkpointConfig,
      adapter: adapterSlug,
      // Replaced by the fresh checkout's path (`explicitCwd: false`).
      cwd: prev.cwd ?? "",
      explicitCwd: false,
      ...(sandboxMcpServers ? { mcpServers: sandboxMcpServers } : {}),
      ...(effModel ? { model: effModel } : {}),
      ...(effRoute?.gateway ? { route: effRoute } : {}),
      ...(effEffort ? { effort: effEffort } : {}),
      ...(prev.label ? { label: prev.label } : {}),
      ...(authSpec ? { auth: sandboxAuthForBox(authSpec, authEcho), authSpec } : {}),
      // BOX-LOGIN BRIDGE: the fresh box verifies a login file exists before it
      // starts — `bootSandboxAgentSession` uploads the redacted copy first and
      // stamps `loginFile` on the block above, degrading to today's fail-loud
      // verify when it cannot. See `box-login-bridge.ts`.
      ...(boxLogin ? { boxLogin } : {}),
      ...workspaceArgs,
      sessionId: restartedSessionId,
      onDelivery: record => {
        registry.recordSandboxDelivery(restartedSessionId, record, formatDeliveryNotice(record))
      },
      onCheckpoint: record => {
        registry.recordSandboxCheckpoint(restartedSessionId, record, formatDeliveryNotice(record))
      },
      onDeliveryTargetChanged: target => {
        registry.setSandboxDeliveryTarget(restartedSessionId, target)
      },
      onNotice: text => registry.recordNotice(restartedSessionId, text),
    })
    if (booted.ok) movedToFreshBox = true
    if (!booted.ok) {
      throw new Error(
        `restartAgentSession: sandbox "${prev.sandboxId}" is gone and a fresh box for ` +
          `workspace "${slug}" could not be started — ${booted.message}`,
      )
    }
    // Best-effort: write the prior session's full transcript into the FRESH
    // box too. `bootSandboxAgentSession` doesn't expose the booted box's
    // file seam, so reconnect to the just-booted box for the write — and
    // never stop/pause that handle (it would tear the fresh box down). A
    // failure is not fatal; the handoff falls back to the old digest.
    try {
      const freshHandle = opts.resolveSandboxProvider
        ? await opts.resolveSandboxProvider(providerSlug)
        : null
      const freshBox = await freshHandle?.provider.connect?.(
        booted.sandboxId,
        { provider: providerSlug, config: {} },
        { env: {} },
      )
      if (freshBox) {
        const priorTranscripts = await writeBoxPriorTranscripts(freshBox, prev, registry).catch(
          err => {
            console.warn(
              `restartAgentSession: writing the prior transcript of ${prev.id} into the ` +
                `fresh box ${booted.sandboxId} failed — ` +
                `${err instanceof Error ? err.message : String(err)} ` +
                "(the handoff will fall back to the digest)",
            )
            return undefined
          },
        )
        boxPriorTranscriptPaths = priorTranscripts?.paths ?? []
        if (priorTranscripts && !priorTranscripts.ok) {
          console.warn(
            `restartAgentSession: prior transcript of ${prev.id} could not be written into ` +
              `the fresh box ${booted.sandboxId} — the handoff will fall back to the digest`,
          )
        }
      }
    } catch (err) {
      // Handoff is best-effort — the digest fallback covers a failed write.
      console.warn(
        `restartAgentSession: fresh-box transcript write for ${prev.id} skipped — ` +
          `${err instanceof Error ? err.message : String(err)} ` +
          "(the handoff will fall back to the digest)",
      )
    }
    notices.push(...(booted.notices ?? []))
    const restarted = registerBoxSession(restartedSessionId, sandboxMcpServers, {
      agentSession: booted.agentSession,
      sandboxId: booted.sandboxId,
      provider: booted.provider,
      sandboxTeardown: booted.sandboxTeardown,
      cwd: booted.cwd,
      ...(booted.deliveryTarget ? { deliveryTarget: booted.deliveryTarget } : {}),
      ...(booted.sandboxPorts ? { sandboxPorts: booted.sandboxPorts } : {}),
    })
    for (const notice of notices) registry.recordNotice(restartedSessionId, notice)
    return { ok: true, desc: restarted }
  }

  const registerBoxSession = (
    restartedSessionId: string,
    sandboxMcpServers: SessionDescriptor["mcpServers"],
    box: {
      agentSession: AgentSessionLike
      sandboxId: string
      provider: string
      sandboxTeardown: "kill" | "pause"
      /** The box-side cwd when it moved (a fresh box's checkout). */
      cwd?: string
      /** The box daemon's own `resumeVia` — set only when ITS adapter
       *  rehydrated the prior conversation. A fresh box spawn (or a
       *  resume attempt the box reported as blank) omits it, keeping the
       *  descriptor's `resumeVia: ""` + the strategy/`boxResumed` flags
       *  honest so the host digest injection still fires. */
      resumeVia?: "resumed via ACP"
      deliveryTarget?: SandboxDeliveryTarget
      sandboxPorts?: Record<number, string>
    },
  ): SessionDescriptor => {
    const { agentSession, deliveryTarget } = box
    const desc = registry.spawnAgent({
      id: restartedSessionId,
      workspaceSlug: prev.workspaceSlug,
      cwd: box.cwd ?? cwd,
      agentSession,
      adapterSlug,
      adapterConfigDir: adapterConfigDirFor(restartedSessionId),
      ...(resolved?.resumable !== undefined ? { resumable: resolved.resumable } : {}),
      ...(resolved?.nativeTerminalResume !== undefined
        ? { nativeTerminalResume: resolved.nativeTerminalResume }
        : {}),
      harness: effHarness,
      ...(resolved?.routeSelection !== undefined
        ? { routeSelection: resolved.routeSelection }
        : {}),
      ...(resolved?.authDescriptor?.provider !== undefined
        ? { adapterProvider: resolved.authDescriptor.provider }
        : {}),
      ...(resolved?.authDescriptor?.modelDerivedApiKey !== undefined
        ? { modelDerivedApiKey: resolved.authDescriptor.modelDerivedApiKey }
        : {}),
      ...(prev.label ? { label: prev.label } : {}),
      ...(sandboxMcpServers ? { mcpServers: sandboxMcpServers } : {}),
      ...(effModel ? { model: effModel } : {}),
      ...(effEffort ? { effort: effEffort } : {}),
      ...(effPosture !== undefined ? { posture: effPosture } : {}),
      ...(effRoute ? { route: effRoute } : {}),
      ...(effContextProfile ? { contextProfile: effContextProfile } : {}),
      ...(accessProfileEcho ? { accessProfile: accessProfileEcho } : {}),
      ...(effMode ? { mode: effMode } : {}),
      ...(prev.origin ? { origin: prev.origin } : {}),
      ...(prev.parentSessionId ? { parentSessionId: prev.parentSessionId } : {}),
      ...(prev.depth !== undefined ? { depth: prev.depth } : {}),
      ...(prev.keepAlive ? { keepAlive: true } : {}),
      ...(prev.notifyParentOnCrash ? { notifyParentOnCrash: true } : {}),
      ...(prev.sentinelAutoWatch === false ? { sentinelAutoWatch: false } : {}),
      ...(prev.restartPolicy ? { restartPolicy: prev.restartPolicy } : {}),
      ...(prev.turnRetry ? { turnRetry: prev.turnRetry } : {}),
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
      remote: true,
      sandboxId: box.sandboxId,
      sandboxProvider: box.provider,
      sandboxTeardown: box.sandboxTeardown,
      ...(deliveryTarget ? { sandboxDeliveryTarget: deliveryTarget } : {}),
      ...(deliveryTarget && prev.sandboxCheckpointOverride !== undefined
        ? { sandboxCheckpointOverride: prev.sandboxCheckpointOverride }
        : {}),
      ...(box.sandboxPorts ? { sandboxPorts: box.sandboxPorts } : {}),
      commandPreview: `sandbox:${box.provider} → ${adapterSlug}`,
      resumedFrom: prev.id,
      resumeVia: box.resumeVia ?? "",
    })
    return desc
  }

  let desc: SessionDescriptor
  // A capability-based downgrade (Fix B) is already a flagged fallback even
  // though nothing threw — `decideRestartStrategy` chose not to attempt
  // `resumeSessionId` at all.
  let resumeFallback = strategy.kind === "agent" && strategy.resumeFallback === true
  try {
    desc = await spawnWithResume(strategy.resumeSessionId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Two ways a resume attempt can fail without the adapter being broken:
    // it rejected the id (RESUME_ID_REJECTED_RE), or it took its transport
    // down mid-`loadSession` (RESUME_CONNECTION_LOST_RE — the shape that left
    // `session_restart` of a transport-dead session returning a bare "ACP
    // connection closed" with no session at all). Both mean the stored
    // conversation couldn't be rehydrated, and both are better served by one
    // fresh-spawn retry + the transcript digest below than by an error.
    if (
      strategy.resumeSessionId &&
      (RESUME_ID_REJECTED_RE.test(msg) || RESUME_CONNECTION_LOST_RE.test(msg))
    ) {
      desc = await spawnWithResume(undefined)
      resumeFallback = true
    } else {
      throw err
    }
  }

  // Fix D: `resumeFallback` covers BOTH blank-fallback cases — the
  // capability-based downgrade above (adapter declared `resumable: false`)
  // and this catch block's rejected-resume-id retry (the adapter's own
  // conversation store is gone) — so `desc` just came back as a genuinely
  // fresh spawn wearing the old session's continuity fields. Best-effort
  // patch: reconstruct the prior session's context and stash it for
  // `runAgentTurn` to inject once. Gated strictly on `resumeFallback` — a
  // successful resume (pty-native or a clean ACP resume) never reaches
  // here, so it's never double-fed its own context.
  //
  // A BOX restart that could not resume the in-box conversation (fresh box,
  // or the box answered blank to the resume id) prefers the structured
  // handoff: a frame, a deterministic-extractor checkpoint, the most recent
  // turns, and the path(s) of the full transcript file(s) already written
  // into the box (`boxPriorTranscriptPaths`). A LOCAL blank-fallback gets
  // the same frame with the transcript written into the new session's own
  // host dir. The old 7k digest (`buildResumeContextDigest`) stays as the
  // fallback when the handoff can't be built (no transcript, or the write
  // failed). Never fails the restart.
  let digestRecovered = false
  let restartHandoff: RestartHandoff | undefined
  if (resumeFallback) {
    const handoff =
      sandboxId !== undefined
        ? await buildBoxRestartHandoff({
            prev,
            transcriptPaths: boxPriorTranscriptPaths,
            movedToFreshBox,
            ...(prev.workspaceSlug ? { workspaceSlug: prev.workspaceSlug } : {}),
            ...(prev.sandboxDeliveryTarget?.branch
              ? { deliveryBranch: prev.sandboxDeliveryTarget.branch }
              : {}),
            ...(prev.sandboxDeliveryTarget?.baseSha
              ? { deliveryBaseSha: prev.sandboxDeliveryTarget.baseSha }
              : {}),
          }).catch(err => {
            console.warn(
              `restartAgentSession: structured handoff for ${prev.id} could not be built — ` +
                `${err instanceof Error ? err.message : String(err)}`,
            )
            return undefined
          })
        : // Local blank-fallback: same frame, but the full transcript is
          // written into the NEW session's own host transcript dir and the
          // prompt points at that path.
          await buildLocalRestartHandoff(prev, desc).catch(err => {
            console.warn(
              `restartAgentSession: structured handoff for ${prev.id} could not be built — ` +
                `${err instanceof Error ? err.message : String(err)}`,
            )
            return undefined
          })
    if (handoff) {
      desc.pendingResumeContext = handoff.text
      digestRecovered = handoff.digestRecovered
      restartHandoff = handoff.handoff
    } else {
      console.warn(
        `restartAgentSession: no structured handoff for ${prev.id} ` +
          `(in-box transcript paths: ${boxPriorTranscriptPaths.length}) — ` +
          "falling back to the 7k resume-context digest",
      )
      const result = await buildResumeContextDigest(prev.id)
      if (result.digest) {
        desc.pendingResumeContext = result.digest
        digestRecovered = result.hasContent
      }
    }
  }

  // ── Close the superseded OLD row ──────────────────────────────────
  // This new-id path mints a FRESH descriptor continuing `prev`'s
  // conversation — the normal case is `prev` already ended (that's WHY a
  // restart was requested), so this is a no-op. But nothing upstream
  // actually requires `prev` to be dead (neither the HTTP `POST
  // /sessions/:id/restart` route nor the `session_restart` MCP verb check
  // `prev.status` before calling in), so restarting an ALIVE session used to
  // leave it running forever — two live processes on the same conversation,
  // the daemon only ever attributing to `desc.id` from here on. `kill()`
  // reads the row's CURRENT status off the registry (not this function's
  // stale `prev` snapshot) and already no-ops on an already-terminal row, so
  // calling it unconditionally here is safe. `"restarted"` is a DELIBERATE
  // end reason (`DELIBERATE_END_REASONS`, sentinel-runtime.ts) —
  // `status: "killed"`, never `"error"`, so it's invisible to both
  // `restart-scheduler.ts`'s crash-restart eligibility (which requires
  // `endedReason:"crashed"` or an unreasoned `"error"`) and
  // `supervisor-notify.ts`'s `notifyParentOnCrash` delivery (which gates on
  // that same unexpected-death pair) — the old row's own crash-handling
  // opt-ins never misfire for a restart that was never a crash.
  //
  // EXCEPT a sandbox restart: `prev.agentSession` is a
  // `SandboxAgentSessionProxy` over the SAME remote `sandboxId` the fresh
  // `desc` just reconnected to (`spawnInSandbox` above) — `kill()` would
  // call that proxy's `close()`, which kills/pauses the underlying BOX
  // (`SandboxAgentSessionHost.stop`/`pause`), tearing down the sandbox the
  // NEW session now depends on. There is no close-the-row-without-closing-
  // the-shared-resource primitive today, so a sandbox restart leaves `prev`
  // alive rather than risk destroying the box out from under its own
  // replacement — a narrower version of the pre-fix gap, scoped to sandbox
  // sessions only.
  // A restart that moved to a FRESH box shares nothing with `prev`'s dead
  // one, so closing `prev` is safe again — and stops its checkpoint/watchdog
  // timers.
  // Same once `spawnInSandbox` released prev's proxy: its `close()` is a
  // no-op from then on, so the row closes without the box going with it.
  if (sandboxId === undefined || movedToFreshBox || priorProxyReleased) {
    registry.kill(prev.id, "SIGTERM", "restarted")
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
    ...(digestRecovered ? { digestRecovered: true } : {}),
    ...(restartHandoff ? { handoff: restartHandoff } : {}),
  }
}

/** `command` stamped by sandbox spawns (`agent_start.sandbox`): the booted
 *  box's preview, `sandbox:<provider> → <adapter>`. This is the only place
 *  the sandbox provider slug survives onto the descriptor. */
const SANDBOX_PREVIEW_RE = /^sandbox:(\S+) → /

/** The sandbox provider slug a prior sandbox session was spawned with. */
export function parseSandboxProviderSlug(command: string | undefined): string | undefined {
  return command?.match(SANDBOX_PREVIEW_RE)?.[1]
}

/** session-spawn.ts's private `toMcpServerMounts` — keep in sync by inspection. */
function toBoxMcpServerMounts(entries: readonly AcpMcpServer[]): Array<{
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
  headers?: Record<string, string>
  args?: string[]
  env?: Record<string, string>
}> {
  return entries.map(e => ({
    name: e.name,
    transport: e.transport,
    ...(e.ref !== undefined ? { ref: e.ref } : {}),
    ...(e.headers !== undefined ? { headers: e.headers } : {}),
    ...(e.args !== undefined ? { args: e.args } : {}),
    ...(e.env !== undefined ? { env: e.env } : {}),
  }))
}

/** session-spawn.ts's private `sandboxAuthFromResolved` — keep in sync by inspection. */
function sandboxAuthForBox(auth: ResolvedAuthSpec, echo?: AuthEcho): DefaultsAdapterAuthConfig {
  return {
    mode: auth.mode,
    ...(auth.mode === "api-key"
      ? auth.credential !== undefined
        ? { apiKey: auth.credential }
        : {}
      : auth.credential !== undefined
        ? { token: auth.credential }
        : {}),
    ...(auth.credential !== undefined && !auth.externalCredential
      ? {
          ...(echo?.credentialSource === "subaccount" && auth.setEnv !== ""
            ? { credentialEnv: auth.setEnv }
            : {}),
          ...(auth.extraEnv ? { extraEnv: auth.extraEnv } : {}),
          ...(auth.isolateDataHome === false ? { isolateDataHome: false } : {}),
        }
      : {}),
  }
}

/** session-spawn.ts's private `resolveSandboxSecret` — keep in sync by inspection. */
export async function resolveSandboxSecretFromBroker(slug: string): Promise<string | null> {
  const { resolveSandboxSecret: resolve } = getMcpCredentialDeps()
  if (!resolve) return null
  try {
    return await resolve(slug)
  } catch (err) {
    console.warn(
      `[restartAgentSession] sandbox secret resolution failed for "${slug}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}
