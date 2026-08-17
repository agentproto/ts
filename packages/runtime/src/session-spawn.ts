/**
 * Shared `agent_start` spawn logic — orchestrator scoped sub-gateway
 * minting, `mcpServers` merge, hermes default-mcpServers safety net,
 * depth/quota checks. Extracted from `agent-tools.ts` (the MCP tool)
 * so the HTTP route can reuse it without re-implementing (and
 * re-drifting from) the same behaviour.
 */

import type { AcpMcpServer } from "@agentproto/acp"
import type { SandboxMode } from "@agentproto/command-sandbox"
import { adapterConfigDirFor, mintSessionId, SESSION_ID_ENV, WORKSPACE_SLUG_ENV, PARENT_SESSION_ID_ENV, type AgentSessionLike, type SessionsRegistry, type SessionDescriptor, type RestartPolicy } from "./sessions.js"
import type { AgentAdapterResolver, CatalogModelsLister } from "./http-server.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  findWorkspaceByPath,
  getActiveWorkspace,
} from "./workspaces-config.js"
import { loadConfig } from "./config.js"
import { resolveWorktreeIdentity } from "./worktree-identity.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import {
  resolveSpawnDefaults,
  resolveAuthSpec,
  AuthResolutionError,
  resolveSubscriptionCredential,
  SubscriptionSourceError,
  modelIdPrefixProvider,
  type SpawnDefaultsConfig,
  type DefaultsAdapterAuthConfig,
  type ResolvedAuthSpec,
  type AuthEcho,
  type AdapterAuthDescriptor,
  type CredentialSource,
} from "./spawn-defaults.js"
import {
  buildRouteAwareLaunchConfig,
  type RouteAwareLaunchConfig,
} from "./launch-config.js"
import {
  resolveClaudeCodeOauthToken,
  verifyLocalLoginPresent,
} from "./claude-code-oauth-source.js"
import { getProviderKey } from "./providers-store.js"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import {
  checkModelAdapterEligibility,
  checkModelWalletEligibility,
  modelAdapterIncompatibleMessage,
  modelWalletIneligibleMessage,
  reconcileModelRoute,
  serviceableModelRoutes,
  suggestModelSlugs,
} from "./catalog-models.js"
import type { CatalogProvider } from "@agentproto/model-catalog"
import {
  getAuthProfile,
  eligibleProfiles,
  KeychainStore,
  type AuthMethod,
  type AdapterAuthManifest,
  type CostBudget,
} from "@agentproto/auth"
import type { Posture, RouteSpec, ContextProfile, EffortLevel } from "./session-config.js"
import {
  resolveContextContinuityPolicy,
  type ContextContinuityPolicy,
  type ResolvedContextContinuityPolicy,
} from "./context-continuity.js"
import { resolvePosture } from "./canonical-posture.js"
import type { UserPreset } from "./user-presets.js"
import { getDefaultHarnessPreset } from "./harness-preset-store.js"
import { resolveRole, composeRoleContext, canSpawn, DELEGATION_TOOL_NAMES } from "./role.js"
import type { RoleProfile } from "./role.js"
import { loadDefaultRoleRegistry } from "./role-registry.js"
import { deriveSessionTitle } from "./session-title.js"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"
import {
  createSandboxAgentSessionHost,
  resolveLifecyclePolicy,
  type SandboxAgentSessionHost,
  type SandboxLifecyclePolicy,
  type SandboxSpec,
} from "@agentproto/sandbox"
import { createSandboxAgentSessionProxy } from "./sandbox-agent-session-proxy.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import {
  decideWorktreeIsolation,
  loadWorktreeIsolation,
  normalizeWorktreeField,
  type WorktreeField,
  type WorktreeIsolationMode,
  type WorktreeProvisioner,
  type WorktreeRequest,
} from "./worktree-isolation.js"
import {
  decideSpawnAttach,
  loadSpawnAttach,
  type AttachField,
  type SpawnAttachMode,
} from "./spawn-attach.js"
import {
  deriveImplicitIdempotencyKey,
  loadSpawnDedupe,
  type SpawnDedupeMode,
} from "./spawn-dedupe.js"
import {
  loadProvenanceWrapGh,
  ensureGhShimDir,
  buildGhShimEnv,
} from "./gh-provenance-shim.js"

/** `agent_start.sandbox`'s inline-spec form, plus the PR3 reuse field. See
 *  `SpawnAgentSessionInput.sandbox`. */
export type SandboxSpecInput = SandboxSpec & { reuse?: string }

/**
 * Retry-safety for the process-forking half of `agent_start`.
 *
 * Why: `agent_start` is a non-idempotent, side-effecting call (it forks a
 * real adapter process) exposed over MCP's at-least-once transport. A slow
 * or dropped response followed by a caller retry — measured in production as
 * two live agents, same label/cwd, 7.7s apart, sharing one working directory
 * for ~5 minutes before a human noticed — currently spawns TWO processes
 * with no way for the caller to detect it (the tool result only ever carries
 * the LAST spawn's id).
 *
 * The primary mechanism is deliberately CALLER-SUPPLIED (`idempotencyKey`),
 * not derived from request content (adapter+cwd+prompt+label hash). An
 * unconditional content hash was tried and rejected: this file's own test
 * suite exercises a legitimate orchestrator fan-out where two structurally-
 * identical `agent_start` calls (same adapter, cwd, no label/prompt) under
 * one caller scope are expected to spawn as TWO distinct sessions — the
 * second is meant to be rejected by the maxChildren quota check, not
 * silently answered with the first session's descriptor. Intentional
 * identical-looking concurrent spawns are a real, exercised pattern here
 * (see also `Workflow`'s `isolation: "worktree"`, which exists precisely
 * because same-cwd concurrent agents are sometimes wanted and sometimes
 * dangerous) — content alone, unconditionally, can't tell the two apart.
 *
 * WP-E (spawn-dedupe-default): omitting `idempotencyKey` is no longer a
 * byte-for-byte no-op. A guard that only works when a caller remembers to
 * ask for it is not a guard — the same argument `spawn.attach` already
 * settled for parent lineage (`config.ts`'s `SpawnConfig.attach` docblock)
 * — so by default (`spawn.dedupe: "always"`) the daemon now DERIVES an
 * implicit key from `label` + a hash of `prompt` when the caller supplies
 * none (`deriveImplicitIdempotencyKey`, `spawn-dedupe.ts`). This doesn't
 * reopen the fan-out rejection above: derivation requires a `label` to
 * produce anything at all, and the fan-out pattern this docblock protects
 * is unlabelled by construction (same adapter/cwd, no label/prompt) — so it
 * stays outside implicit dedup exactly as before. A `label`-bearing repeat
 * is the incident's actual shape (PR #803's independently-derived label+cwd
 * warning backstop below found the same boundary), not the fan-out pattern.
 * The caller's own declared intent (an explicit key) still always wins over
 * a derived guess, and a per-call `dedupe: false` opts back out entirely.
 *
 * Scope: guards only the actual fork + registry registration (the `try`
 * block below) — the one irreversible side effect. Pre-flight validation
 * (depth/quota/role checks) still re-runs for a deduped retry; those are
 * pure functions of current state, not side effects, so re-running them is
 * harmless. The one known gap: a retry that resolves `orchestrator: true`
 * still mints a fresh scope token via `buildOrchestratorMcp` before the
 * dedup check is reached, and that token is never bound (leaked) since the
 * retry returns the ORIGINAL session's descriptor — accepted as a narrower,
 * pre-existing-shape problem than the double-process bug this fixes.
 *
 * Window: a resolved (successful) claim is remembered for
 * `SPAWN_CLAIM_WINDOW_MS` so a same-key retry seconds later still hits it;
 * a FAILED claim is dropped immediately so a genuine post-error retry tries
 * fresh instead of replaying the same failure forever. Scoped per registry
 * instance (WeakMap) so independent daemons/tests never share a cache.
 *
 * Sizing `SPAWN_CLAIM_WINDOW_MS`: it must outlive the retry it exists to
 * absorb, not just "feel generous". The retry is provoked by the CALLER's
 * own idle/request timeout giving up on a slow-but-succeeding spawn and
 * trying again — measured in the incident this guards against at 300s (the
 * `agent-cli` driver's own default per-completion timeout,
 * `packages/driver/agent-cli/src/model.ts`'s `timeoutMs ?? 5 * 60 * 1000`,
 * is the same order of magnitude and the best first-party corroboration of
 * that figure). A resolved claim that's GC'd before that timeout even
 * fires is a guard that's already gone by the time the retry it was built
 * for shows up — exactly the gap the incident exposed at the old 30s
 * value. 10 minutes (2x the 300s timeout) covers the retry arriving the
 * instant the client's timer fires, plus slack for the retry's own network
 * transit and clock skew between caller and daemon, without being so long
 * that a stale claim starts looking like a memory leak.
 *
 * That alone would make the map's worst case "unboundedly many resolved
 * claims sitting for up to 10 minutes" under high spawn-rate idempotent
 * traffic — the same class of problem the original 30s GC existed to cap,
 * just with a longer fuse. `MAX_RESOLVED_CLAIMS` bounds it independently of
 * time: once resolved entries exceed the cap, the OLDEST-resolved are
 * evicted first (a size/LRU backstop), so a burst of distinct idempotency
 * keys can't grow the map without limit even inside the window.
 */
const SPAWN_CLAIM_WINDOW_MS = 600_000

/**
 * Window for a claim staked by a DERIVED (implicit) key — see
 * `spawn-dedupe.ts` for how that key is built. Deliberately shorter than
 * `SPAWN_CLAIM_WINDOW_MS`, not just "shorter to be safe": an explicit
 * `idempotencyKey` is the caller's PROMISE that a same-key repeat within the
 * window is the same logical spawn, so it's sized to the full retry horizon
 * that promise needs to survive (see that constant's own docblock). An
 * implicit key is only a GUESS built from `label` + a prompt hash — nobody
 * told the daemon these two calls are the same spawn, it just noticed they
 * look alike. The retry this guards against still arrives on the same
 * client-timeout horizon as an explicit key's retry would (nothing about
 * being implicit changes WHEN a dropped-response retry fires) — so this
 * can't be cut down to "just cover an instant double-click" without missing
 * the exact incident-shaped retry the feature exists to catch. What
 * shrinking DOES buy: less time for a coincidence to happen. Every implicit
 * key is reachable from ANY caller that supplies a label and skips
 * `idempotencyKey` — a much wider, largely-unaudited surface than the
 * targeted opt-in explicit-key path — so a false-collision candidate
 * (automation that deliberately re-issues one label into one cwd with an
 * unchanged prompt, e.g. a periodic health-check spawn) has less time to
 * wander into the window before it's safely treated as a fresh spawn again.
 * 120s (2 minutes) is chosen as comfortably inside typical retry timers
 * (the 300s client default this repo has measured is still ~2.5x this
 * window away) while being short enough that a deliberately-repeated
 * automation run separated by anything more than a couple of minutes gets
 * its own session rather than reattaching to a stale one.
 */
const IMPLICIT_SPAWN_CLAIM_WINDOW_MS = 120_000

/** Backstop on map growth, independent of `SPAWN_CLAIM_WINDOW_MS` — see the
 *  docblock above. Only resolved claims count against this; an in-flight
 *  claim is bounded by real concurrent spawn load, not by this cap. */
const MAX_RESOLVED_CLAIMS = 1_000

export interface SpawnClaim {
  result: Promise<SpawnAgentSessionResult>
  /** Wall-clock time the claim settled successfully — undefined while
   *  still in-flight. Only set for `ok: true` results; see the docblock
   *  above for why a failure is dropped instead of cached. */
  resolvedAt?: number
  /** Eviction window for THIS claim, in ms. Defaults to
   *  `SPAWN_CLAIM_WINDOW_MS` (an explicit-key claim) when omitted; a claim
   *  staked from a derived implicit key sets `IMPLICIT_SPAWN_CLAIM_WINDOW_MS`
   *  instead — see that constant's docblock for why the two differ. */
  windowMs?: number
}

const spawnClaimsByRegistry = new WeakMap<SessionsRegistry, Map<string, SpawnClaim>>()

function claimsFor(registry: SessionsRegistry): Map<string, SpawnClaim> {
  let claims = spawnClaimsByRegistry.get(registry)
  if (!claims) {
    claims = new Map()
    spawnClaimsByRegistry.set(registry, claims)
  }
  return claims
}

/** Two independent eviction passes — see the sizing docblock above the two
 *  constants. Time first (a claim past its OWN `windowMs` — explicit and
 *  implicit claims share one map but carry different windows, see
 *  `SpawnClaim.windowMs` — is simply stale, regardless of map size), then a
 *  size/LRU pass over whatever resolved claims survive it. In-flight claims
 *  (`resolvedAt` undefined) are never touched by either pass — evicting one
 *  would let a retry that's still genuinely in-flight fork a second
 *  process, the exact bug this module exists to prevent. */
// Exported (only) so the eviction policy can be unit-tested directly against
// a synthetic map, instead of via a 1000+ real spawnAgentSession() calls.
export function gcSpawnClaims(claims: Map<string, SpawnClaim>, now: number): void {
  const resolved: [string, SpawnClaim][] = []
  for (const [k, claim] of claims) {
    if (claim.resolvedAt === undefined) continue
    const window = claim.windowMs ?? SPAWN_CLAIM_WINDOW_MS
    if (now - claim.resolvedAt > window) {
      claims.delete(k)
    } else {
      resolved.push([k, claim])
    }
  }
  const excess = resolved.length - MAX_RESOLVED_CLAIMS
  if (excess <= 0) return
  resolved.sort((a, b) => a[1].resolvedAt! - b[1].resolvedAt!)
  for (const [k] of resolved.slice(0, excess)) claims.delete(k)
}

function profileMethodToAuthMode(method: AuthMethod): "subscription" | "api-key" {
  return method === "oauth-bearer" ? "subscription" : "api-key"
}

function directAuthMethods(descriptor: AdapterAuthDescriptor | undefined): AuthMethod[] {
  const methods: AuthMethod[] = []
  if (descriptor?.authSubscription || descriptor?.modelDerivedApiKey) methods.push("oauth-bearer")
  if (descriptor?.provider || descriptor?.modelDerivedApiKey) methods.push("api-key")
  return methods
}

/** Build the one-route eligibility projection used for an initial spawn.
 * Keep this deliberately identical to restart's projection: a gateway bills
 * the gateway endpoint and accepts only its API key; a direct route uses the
 * adapter's native auth vocabulary. */
function spawnEligibilityManifest(
  adapter: string,
  descriptor: AdapterAuthDescriptor | undefined,
  route: RouteSpec | undefined,
  model: string | undefined,
): { manifest: AdapterAuthManifest; routeId: string } | undefined {
  // Endpoint precedence: adapter's FIXED provider (single-provider adapters)
  // > the adapter's OWN declared per-model provider (`modelProviders`, a
  // model-derived-api-key adapter's `models.allowed[].provider` — the
  // authoritative statement of who bills THIS adapter for THIS model) > the
  // GLOBAL catalog's model→provider derivation. The middle tier exists
  // because a model-derived adapter has no fixed `provider` at all, so
  // without it the catalog fallback is the ONLY signal — and the catalog's
  // route for a given model id is a global fact that can legitimately differ
  // from what one specific adapter actually bills it through (D3: pi bills
  // `moonshotai/kimi-k2.7-code` via `moonshot`, but the catalog routes that
  // id to `openrouter`).
  const directEndpoint =
    descriptor?.provider ??
    (model ? descriptor?.modelProviders?.[model] : undefined) ??
    (model && descriptor?.modelDerivedApiKey
      ? modelIdPrefixProvider(model)
      : undefined) ??
    (model ? getModelProvider(model) : undefined)
  const routeId = route?.gateway ?? directEndpoint
  if (!routeId) return undefined
  const direct = directEndpoint !== undefined && routeId === directEndpoint
  return {
    manifest: {
      id: adapter,
      endpointByRoute: { [routeId]: direct ? directEndpoint : routeId },
      methodsByRoute: { [routeId]: direct ? directAuthMethods(descriptor) : ["api-key"] },
    },
    routeId,
  }
}

/** A resolved access-profile pin — the mechanical `spec` a driver applies
 *  plus the observable `echo` recorded on a session descriptor. */
export interface AccessProfileAuthResult {
  ok: true
  authSpec?: ResolvedAuthSpec
  authEcho?: AuthEcho
  accessProfileEcho: { profileRef: string; label?: string; endpoint: string; method: AuthMethod }
}

export interface AccessProfileAuthError {
  ok: false
  code:
    | "access_profile_not_found"
    | "access_profile_ineligible"
    | "unsupported_auth_mode"
    | "unsupported_auth_source"
    | "auth_source_unresolved"
  message: string
  details?: Record<string, unknown>
}

/**
 * Resolve a named `access.profileRef` into a `ResolvedAuthSpec` — profile
 * lookup, route/model eligibility check, credential fetch (source-backed
 * subscription resolved FRESH via Mode 3, or a static keychain read), then
 * `resolveAuthSpec`. Extracted from `spawnAgentSession`'s inline branch so a
 * SECOND spawn path — the completion-policy supervisor's judge gate
 * (`supervisor.ts`'s `runJudge`, WP-D) — can pin an explicit billing profile
 * for a judge agent without duplicating this ~130-line resolution chain.
 * Deliberately narrow: a single named profile, no eligibility-ranked list, no
 * automatic fail-over across profiles — that's a wallet LADDER, a bigger
 * feature this function does not attempt (see `runJudge`'s doc).
 *
 * Messages are UNPREFIXED (no `"agent_start: "` etc.) so each caller can
 * frame the error in its own vocabulary; `spawnAgentSession` re-adds its
 * historical prefix at the call site, preserving its exact error strings.
 */
export async function resolveAccessProfileAuth(input: {
  adapter: string
  profileRef: string
  authDescriptor: AdapterAuthDescriptor | undefined
  route?: RouteSpec
  /** Model used for eligibility (route/provider derivation) — falls back to
   *  `defaultModel` when omitted. */
  model?: string
  /** Adapter's own default model (`resolved.defaultModel`) — used ONLY for
   *  the eligibility check above, deliberately NOT as a fallback for the
   *  `resolveAuthSpec({model})` call below (that call passes raw `model` as
   *  a caller-explicit signal; a resolver-supplied default there would
   *  misrepresent the request as having named a model it didn't). */
  defaultModel?: string
}): Promise<AccessProfileAuthResult | AccessProfileAuthError> {
  const { adapter, profileRef, authDescriptor, route, model, defaultModel } = input
  const profile = await getAuthProfile(profileRef)
  if (!profile) {
    return {
      ok: false,
      code: "access_profile_not_found",
      message: `no auth profile "${profileRef}" found.`,
    }
  }
  if (!authDescriptor) {
    return {
      ok: false,
      code: "access_profile_ineligible",
      message: `adapter "${adapter}" presents no billing-auth; profile "${profile.id}" cannot be attached.`,
    }
  }
  const projected = spawnEligibilityManifest(adapter, authDescriptor, route, model ?? defaultModel)
  if (!projected || eligibleProfiles([profile], projected.manifest, projected.routeId).length === 0) {
    const endpoint = projected?.manifest.endpointByRoute[projected.routeId] ?? "an unknown endpoint"
    return {
      ok: false,
      code: "access_profile_ineligible",
      message:
        `profile "${profile.id}" (${profile.endpoint}/${profile.method}) is not eligible ` +
        `for adapter "${adapter}" on route "${projected?.routeId ?? "unknown"}" (billed endpoint: ${endpoint}).`,
    }
  }
  const authMode = profileMethodToAuthMode(profile.method)
  // Subscription-credential resolution: a source-backed profile
  // (`profile.source`) resolves the credential FRESH via Mode 3 on every
  // spawn instead of a one-shot static keychain read — reusing
  // `resolveSubscriptionCredential` rather than duplicating it. A
  // credential-backed profile keeps a static read.
  let subscriptionCredential: string | undefined
  let subscriptionCredentialSource: CredentialSource | undefined
  let apiKeyCredential: string | undefined
  let externalSubscriptionVerified = false
  // File-based (external) subscription — codex/gemini: the CLI reads its OWN
  // login file, so a source-backed profile injects NOTHING. Verify the login
  // is present (fail-loud) and let `resolveAuthSpec` produce a scrub-only
  // external spec; never resolve/inject a bearer.
  const externalSub = authDescriptor.authSubscription?.external === true
  if (authMode === "subscription" && externalSub) {
    try {
      await verifyLocalLoginPresent(profile.source ?? adapter, adapter)
      externalSubscriptionVerified = true
    } catch (err) {
      if (err instanceof SubscriptionSourceError) {
        return {
          ok: false,
          code: err.code,
          message: err.message,
          details: { adapter, profile: profile.id },
        }
      }
      throw err
    }
  } else if (authMode === "subscription" && profile.source !== undefined) {
    try {
      const subResolution = await resolveSubscriptionCredential(
        { source: profile.source },
        resolveClaudeCodeOauthToken,
      )
      subscriptionCredential = subResolution.credential
      subscriptionCredentialSource = subResolution.source
    } catch (err) {
      if (err instanceof SubscriptionSourceError) {
        return {
          ok: false,
          code: err.code,
          message: err.message,
          details: { adapter, profile: profile.id },
        }
      }
      throw err
    }
  } else if (profile.credentialRef === undefined) {
    return {
      ok: false,
      code: "access_profile_ineligible",
      message: `profile "${profile.id}" has neither a credential nor a source configured.`,
      details: { adapter },
    }
  } else {
    const stored = await new KeychainStore().read({ path: profile.credentialRef })
    if (authMode === "subscription") subscriptionCredential = stored?.value
    else apiKeyCredential = stored?.value
  }
  let authSpec: ResolvedAuthSpec | undefined
  let authEcho: AuthEcho | undefined
  try {
    const result = resolveAuthSpec({
      descriptor: authDescriptor,
      ...(model ? { model } : {}),
      ...(route?.gateway ? { routeGateway: route.gateway } : {}),
      ...(!route?.gateway ? { requestedProvider: profile.endpoint as CatalogProvider } : {}),
      requestedMode: authMode,
      // A profile reference is an explicit billing choice. Never consult the
      // ambient environment or a different provider-store key as fallback.
      explicit: true,
      ...(subscriptionCredential !== undefined ? { subscriptionCredential } : {}),
      ...(subscriptionCredentialSource !== undefined ? { subscriptionCredentialSource } : {}),
      ...(externalSubscriptionVerified ? { externalSubscriptionVerified } : {}),
      ...(apiKeyCredential !== undefined ? { apiKeyConfigCredential: apiKeyCredential } : {}),
    })
    if (result) {
      authSpec = result.spec
      authEcho = result.echo
    }
  } catch (err) {
    if (err instanceof AuthResolutionError) {
      return {
        ok: false,
        code: "unsupported_auth_mode",
        message: err.message,
        details: { adapter, provider: profile.endpoint },
      }
    }
    throw err
  }
  return {
    ok: true,
    authSpec,
    authEcho,
    accessProfileEcho: {
      profileRef: profile.id,
      ...(profile.label !== undefined ? { label: profile.label } : {}),
      endpoint: profile.endpoint,
      method: profile.method,
    },
  }
}

/** Matches `RegisterAgentToolsOptions.buildOrchestratorMcp` in
 *  agent-tools.ts — kept as its own alias here since that's the shape
 *  actually passed in (opts required), not the more permissive
 *  `OrchestratorInjector` (opts optional) from orchestrator-gateway.ts. */
export type BuildOrchestratorMcp = (opts: {
  tools?: readonly string[]
  caller?: OrchestratorScope
  maxDepth?: number
  maxChildren?: number
  role?: string
}) => {
  entry: AcpMcpServer
  bindLifecycle: (sessionId: string) => () => void
}

/**
 * Should this spawn get the daemon's own `/mcp` gateway mounted by default
 * (caller supplied no `mcpServers`)? Pure — the per-adapter reasoning lives
 * here so the injection site and its tests share one decision.
 *
 *  - `hermes`: always. It has zero built-in tools — without a mount it
 *    silently spawns chat-only. Sandbox spawns keep the historical
 *    behaviour (inject) — the box's own daemon re-resolves the spawn on
 *    its side anyway.
 *  - `claude-code`: on-host spawns only. The mount is about IDENTITY, not
 *    capability: ambient MCP config (project `.mcp.json` / global claude
 *    config) already points these sessions at the daemon but can never
 *    carry a per-session `callerSessionId`, leaving every spawn they make
 *    an anonymous depth-0 orphan (observed in production: 0 of 663
 *    sessions ever carried a `parentSessionId`). The injected same-named
 *    entry shadows the ambient one at the SDK layer and carries the stamp.
 *    A sandbox spawn is excluded — the box cannot reach this daemon's
 *    loopback gateway, and unlike hermes there is no historical behaviour
 *    to preserve.
 *  - everything else: never. Mounting the daemon into adapters that never
 *    had it (codex, gemini, …) would be a capability grant, not a fix —
 *    those callers opt in explicitly via `mcpServers`.
 */
export function shouldInjectDaemonSelfMount(
  adapter: string,
  sandbox: unknown,
): boolean {
  if (adapter === "hermes") return true
  if (adapter === "claude-code") return sandbox === undefined
  return false
}

/** Strip ANSI escapes and drop the ACP framing/marker noise (`── … ──`
 *  turn frames + `[thought]` / `[tool]` lines) so the lines read as plain,
 *  human-friendly text. Used by `agent_output({clean})` and the
 *  `spawnAgentSession({wait})` one-shot output. */
export function cleanAgentLines(lines: string[]): string[] {
  return lines
    .map(l => l.replace(/\x1b\[[0-9;]*m/g, ""))
    .filter(l => {
      const t = l.trim()
      // A tool ERROR must never be filtered — a failing turn is exactly when a
      // caller reads the output, and hiding it makes the session look silently
      // stuck. Only decorative framing and non-error [thought]/[tool]/[tool-result]
      // chatter is dropped in clean mode.
      if (/^\[tool-error\]/.test(t)) return true
      return !t.startsWith("──") && !/^\[(thought|tool)\b/.test(t)
    })
}

export interface SpawnAgentSessionDeps {
  registry: SessionsRegistry
  /** Required — callers must check for its absence themselves (the MCP
   *  tool and HTTP route each have their own "not enabled" response
   *  shape for the missing-resolver case). */
  resolveAgentAdapter: AgentAdapterResolver
  /** Optional orchestrator-injection builder (WP3). See
   *  `RegisterAgentToolsOptions.buildOrchestratorMcp` for the full
   *  contract. Omitted → `orchestrator` is rejected with
   *  `orchestrator_not_enabled`. */
  buildOrchestratorMcp?: BuildOrchestratorMcp
  /** The daemon's own plain `/mcp` gateway URL. See
   *  `RegisterAgentToolsOptions.daemonMcpUrl`. */
  daemonMcpUrl?: string
  /** Calling orchestrator's scope (orchestrator WP4). See
   *  `RegisterAgentToolsOptions.callerScope`. */
  callerScope?: OrchestratorScope
  /** Optional webhook notifier — see `RegisterAgentToolsOptions.webhookNotifier`. */
  webhookNotifier?: WebhookNotifier
  /** Loads config.json's `defaults` block (global + per-adapter skills/
   *  options auto-applied at every spawn — see `resolveSpawnDefaults`).
   *  Defaults to reading the real `~/.agentproto/config.json` via
   *  `loadConfig` when omitted; tests inject a stub to avoid touching
   *  the real file. */
  loadDefaultsConfig?: () => Promise<SpawnDefaultsConfig | undefined>
  /** Loads the custom (pack-carried) role registry, merged with the
   *  two built-ins by `resolveRole`/`canSpawn` — see `role.ts`'s
   *  `mergeRoleRegistry`. Defaults to `loadDefaultRoleRegistry()`
   *  (`~/.agentproto/roles/` + adapter-carried packs) when omitted;
   *  tests inject a stub registry to avoid touching the real
   *  filesystem. */
  loadRoleRegistry?: () => Promise<Record<string, RoleProfile>>
  /** Resolves an `agent_start.sandbox` slug (or an inline spec's own
   *  `.provider`) to a concrete sandbox provider handle. Required for
   *  `input.sandbox` — omitted ⇒ `sandbox_provider_not_found`. */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Provision a git worktree and return the cwd the spawn should land in —
   *  the injected port behind `agent_start.worktree` (see
   *  `worktree-isolation.ts`). Wired at the composition root by a host that
   *  depends on `@agentproto/worktree` (the CLI). Omitted ⇒ a spawn the
   *  policy says to isolate fails with `worktree_provisioner_not_enabled`
   *  rather than silently spawning unisolated. */
  provisionWorktree?: WorktreeProvisioner
  /** Resolves the effective `worktrees.isolation` policy (env > config >
   *  `on-request`). Defaults to reading the real `~/.agentproto/config.json`
   *  via `loadWorktreeIsolation` when omitted; tests inject a stub to pin the
   *  mode without touching the real file or env. */
  resolveWorktreeIsolation?: () => Promise<WorktreeIsolationMode>
  /** Resolves the effective `spawn.attach` policy (env > config > `always`).
   *  Defaults to `loadSpawnAttach` (reads the real config) when omitted;
   *  tests inject a stub to pin the mode without touching env or the file. */
  resolveSpawnAttach?: () => Promise<SpawnAttachMode>
  /** Resolves the effective `spawn.dedupe` policy (env > config > `always`).
   *  Defaults to `loadSpawnDedupe` (reads the real config) when omitted;
   *  tests inject a stub to pin the mode without touching env or the file.
   *  See `spawn-dedupe.ts`. */
  resolveSpawnDedupe?: () => Promise<SpawnDedupeMode>
  /** Resolves the effective `provenance.wrapGh` opt-in (env > config >
   *  `false`). When it resolves true, a `gh` PATH shim is prepended to the
   *  spawned session's env so any `gh pr create` it (or an adapter
   *  subprocess) runs gets the daemon's provenance footer appended to the
   *  created PR's body — see `gh-provenance-shim.ts`. Defaults to
   *  `loadProvenanceWrapGh` (reads the real config) when omitted; tests
   *  inject a stub to pin it without touching env or the file. */
  resolveProvenanceWrapGh?: () => Promise<boolean>
  /** Feeds the adapter-capability spawn guard (`checkModelAdapterEligibility`)
   *  — the SAME `listCatalogModels` the `catalog_models` MCP tool /
   *  `GET /catalog/models` route already use (`RegisterAgentToolsOptions.
   *  listCatalogModels`), reused here rather than re-derived. Omitted ⇒ the
   *  guard is skipped — a spawn that would 404 upstream on an adapter's
   *  manifest not covering the requested model still reaches the driver,
   *  same as before this guard existed. */
  listCatalogModels?: CatalogModelsLister
}

export interface SpawnAgentSessionInput {
  adapter: string
  /** Canonical harness slug — recorded on the descriptor; defaults to `adapter`. */
  harness?: string
  cwd?: string
  workspaceSlug?: string
  /** Trusted-loopback parent-lineage hint (WP-R1). Attributes this spawn to a
   *  logical parent session so it nests under that node in the sessions tree,
   *  filling the gap that otherwise leaves an anonymous `agent_start` (an
   *  agent-to-agent spawn on the root `/mcp`, or a caller that IS a session but
   *  didn't come through the scoped orchestrator gateway) a depth-0 orphan.
   *
   *  Trust boundary: the scoped `/mcp/orchestrator` gateway derives parent from
   *  its unspoofable scope token, so a hint arriving WITH a `callerScope` is
   *  IGNORED — the scope always wins. The hint is honoured ONLY on the
   *  anonymous root path (no `callerScope`), where there is no scope to
   *  attribute from. `depth` is derived from the resolved parent descriptor
   *  (parent's `depth + 1`, defaulting to 1 when the parent isn't registered)
   *  rather than trusted from the caller. Descriptor-only: a hint never relaxes
   *  the depth-gated worktree/role guards — declaring a logical parent is not
   *  the same as being a nested (scoped) spawn. */
  parentSessionId?: string
  /** Attach policy override for THIS spawn (`agent_start.attach`). `false`
   *  forces an independent root even when a parent is derivable; `true` opts
   *  in to attaching under the derived parent even under an `on-request`
   *  policy; `{ parent }` pins an explicit parent. Omitted ⇒ the daemon's
   *  `spawn.attach` policy decides. Resolved together with `parentSessionId`
   *  and `autoParentSessionId` in `decideSpawnAttach` — see `spawn-attach.ts`.
   *  Ignored WITH a `callerScope` (the scoped orchestrator token always wins). */
  attach?: AttachField
  /** Daemon-DERIVED caller session id — the spawning session's own id, read
   *  from the trusted `?callerSessionId=` query the self-ref `mcpServers` URL
   *  carries (PR 7 / Gap 7), NOT from the caller's arguments. This is the
   *  implicit auto-parent that makes attach-by-default work without the caller
   *  passing its own id. Threaded from `registerAgentTools`' `callerSessionId`
   *  option; lower precedence than an explicit `parentSessionId` hint. */
  autoParentSessionId?: string
  /** Task-board pin for the spawned child, stamped onto its descriptor as
   *  `meta.boardId`. The Task ledger's board resolution prefers this over
   *  the `parentSessionId` lineage walk (see task-ledger.ts's
   *  `resolveBoardId`), so a client spawning several depth-0 roots — a
   *  cowork/operator harness fanning out executors with no shared lineage —
   *  can join them all onto ONE board. Descriptor-only: it never enters the
   *  depth/quota/role gates, and an explicit `boardId` on a task verb still
   *  wins over it. */
  boardId?: string
  /** Source label for this spawn (channel/harness). Descriptor-only. */
  origin?: string
  /** Reattach to a pre-existing adapter-native session (claude-code's
   *  conversation id, hermes' chat handle, …) instead of starting
   *  blank. Not exposed on the MCP `agent_start` tool today — only the
   *  HTTP route (`sessions restart`) passes this. */
  resumeSessionId?: string
  prompt?: string
  label?: string
  /** Explicit session title (SPEC-3 FIX C, `agentproto sessions start
   *  --title`). When set, it wins over the first-sentence derivation from
   *  `prompt` — so a CLI-named session isn't limited to whatever its opening
   *  prompt happened to say. Unlike `label`, it fills the `title` slot, so a
   *  spawner `label` still out-ranks it in the display chain. */
  title?: string
  mode?: string
  /** Manifest-declared option id → value map (AIP-45 `options`), applied
   *  at spawn time alongside `mode`. Forwarded verbatim to the driver's
   *  `startSession({ options })` → `composeSpawn`'s option patches. */
  options?: Record<string, boolean | number | string>
  /** Normalized, adapter-agnostic skill ids for this session. Merged with
   *  config.json's `defaults.skills` / `defaults.adapters.<slug>.skills`
   *  (global < per-adapter < this field, which REPLACES the union rather
   *  than merging into it when provided — a deliberate exact set). Folded
   *  into `options.skills` per the resolved adapter's declared `skills`
   *  option shape (e.g. hermes' comma-joined string); adapters with no
   *  such option (e.g. claude-code, which auto-discovers skills) ignore
   *  it. See `resolveSpawnDefaults` / `normalizeSkillsOption`. */
  skills?: string[]
  model?: string
  effort?: string
  /** Decomposed route identity.  This is canonical transport; `mode` remains
   * a legacy adapter projection only. */
  route?: RouteSpec
  /** Named billing credential. Resolved from auth-profiles + keychain at the
   * final spawn boundary; the secret never crosses HTTP/MCP. */
  access?: { profileRef?: string }
  posture?: Posture
  contextProfile?: ContextProfile
  /** A preloaded user preset. Callers resolve its id at their boundary so a
   * preset can also provide the adapter before this core is invoked. */
  preset?: UserPreset
  /**
   * Deterministic billing-auth mode + EXPLICIT credential for adapters that
   * declare an env-var vocabulary for it (today: claude-code — see
   * `AgentCliAuth.modes` in `@agentproto/driver-agent-cli`). `mode` wins over
   * `~/.agentproto/config.json`'s `defaults.adapters.<slug>.auth.mode`
   * (default `"subscription"`); the credential (`token` for `"subscription"`,
   * `apiKey` for `"api-key"`) wins over the config field matching the
   * RESOLVED mode — see `resolveSpawnDefaults`. Never read from the ambient
   * shell env; never logged (only a fingerprint is recorded on the session
   * descriptor — see `credentialFingerprint`). Adapters that don't declare
   * the vocabulary ignore this field entirely.
   */
  auth?: DefaultsAdapterAuthConfig
  mcpServers?: AcpMcpServer[]
  orchestrator?: boolean | { tools?: string[]; maxDepth?: number; maxChildren?: number }
  notifyUrl?: string
  wait?: boolean
  maxCostUsd?: number
  /** Windowed cost-budget cap (phase 4). DISTINCT from the scalar `maxCostUsd`
   *  session-kill: this is recorded on the descriptor/runtime and drives an
   *  auto-attached governance policy (`policy:failed` on windowed overage) — it
   *  never kills the session. Omit ⇒ no windowed budget. */
  costBudget?: CostBudget
  /** Opt-in auto-restart policy (restart-scheduler, PR-2). When set, an
   *  unexpected death (`crashed` and/or `error`, per `restartPolicy.on`) is
   *  proactively revived in place — see `RestartPolicy`'s doc in
   *  `sessions.ts`. Omitted ⇒ today's lazy-resume-only behaviour. */
  restartPolicy?: RestartPolicy
  /** Context-continuity policy for this session — controls warning,
   *  opportunistic compaction, fresh-continuation, and hard-stop thresholds.
   *  Resolved from global → per-adapter → per-model → explicit override. */
  contextContinuity?: ContextContinuityPolicy
  /** Spawn-time role — `"executor"` | `"supervisor"` | omitted. See
   *  `resolveRole` in `role.ts`. Omitted ⇒ derived from spawn depth
   *  against `defaults.defaultRoleDepthCutoff` (default 1). A resolved
   *  role with `toolPolicy.delegation === "deny"` is a HARD gate:
   *  `orchestrator` is ignored outright and the hermes/default
   *  full-gateway injection excludes `DELEGATION_TOOL_NAMES` — neither
   *  this field's own request nor `promptAppend` can re-open it. */
  role?: string
  /** One-off runtime text layered ON TOP of the resolved role's
   *  disposition (never replacing it) and prepended to `prompt`. See
   *  `composeRoleContext`. Cannot widen `toolPolicy` — see `role` above. */
  promptAppend?: string
  /** Opt this session into Langfuse tracing (prompt/completion + tool spans +
   *  tokens/cost). Effective opt-in is `trace ?? langfuseTracingDefault ?? false`
   *  — see `SpawnAgentInput.trace` in sessions.ts. */
  trace?: boolean
  /** Run this session inside a sandbox instead of on the host — a provider
   *  slug from `list_sandbox_providers` (e.g. `"local"`, `"e2b"`), or an
   *  inline AIP-36 `SandboxSpec`, optionally carrying `reuse: "<sandboxId>"`
   *  to reconnect to an existing box instead of booting fresh. When set,
   *  this branch resolves the provider, boots (or reconnects) the box,
   *  spawns `adapter` on the BOX's own `agent_start`, and wires a
   *  `SandboxAgentSessionProxy` in place of the local `resolveAgentAdapter`
   *  path — see `sandbox-agent-session-proxy.ts`. */
  sandbox?: string | SandboxSpecInput
  /** Isolate this session into its own git worktree instead of spawning in
   *  `cwd` directly. `true` provisions a worktree with an auto-minted branch/
   *  slug; `{ slug?, base? }` pins the slug and/or the base ref it's cut from.
   *  Honoured only at spawn depth 0 (a nested spawn inherits the parent's
   *  ground) and only for a `cwd` inside a git repo (nothing to isolate
   *  otherwise ⇒ spawns plain). The daemon's `worktrees.isolation` policy can
   *  force this on (`always`) or off (`never`) regardless — see
   *  `worktree-isolation.ts`. Ignored entirely for a `sandbox` spawn (the box
   *  already isolates). Cleanup is the human's job (`agentproto worktree
   *  rm|archive|gc`); the tree is never auto-removed on session exit. */
  worktree?: WorktreeField
  /** Acknowledge that spawning IN PLACE into a shared, dirty working tree is
   *  intended, silencing the `sharedDirtyCwd` warning a nested implicit spawn
   *  would otherwise emit (see `decideWorktreeIsolation`). Only meaningful for
   *  a nested (depth > 0) spawn with no `worktree` request and no `sandbox`;
   *  ignored everywhere else. Default false — the warning fires. */
  allowSharedCwd?: boolean
  /** Start this session in permission-hold mode: every ACP permission request
   *  is surfaced + parked in the cross-session inbox (`permissions_list` /
   *  `permissions_respond`) instead of auto-answered. Threaded to the driver's
   *  `startSession({ permissionHold })` and recorded on the descriptor. Ignored
   *  for sandbox spawns (the box's own daemon owns permission handling).
   *  Default false — unchanged auto-answer behaviour. */
  permissionHold?: boolean
  /** Opt this child into the direct in-band crash notification: when it
   *  crashes (`markCrashed`), the supervisor-notify subscriber
   *  (`supervisor-notify.ts`) delivers a `[child-crashed] …` notice into its
   *  `parentSessionId`, if any — enqueued immediately when the parent is
   *  alive and idle, queued for its next turn when busy (never
   *  interrupted). Recorded verbatim onto {@link SessionDescriptor
   *  .notifyParentOnCrash}; see that field's doc. Default false — the free
   *  external webhook path (`notifyUrl`) already fires regardless of this
   *  flag. */
  notifyParentOnCrash?: boolean
  /** Exempt this session from the idle-reaper (`isReapable` in
   *  idle-reaper.ts) regardless of how long it sits idle. Stamped straight
   *  onto the descriptor — see `SessionDescriptor.keepAlive`. Default false
   *  — unchanged reap-eligible behaviour. Toggleable later via the
   *  `session_set_keepalive` MCP verb. */
  keepAlive?: boolean
  /** Caller-declared "this is the same logical spawn" token — a PROMISE, not
   *  a guess. A second `agent_start` with the same `(adapter, cwd,
   *  idempotencyKey)` within `SPAWN_CLAIM_WINDOW_MS` of a SUCCESSFUL spawn
   *  returns that spawn's descriptor instead of forking a second process —
   *  the fix for a retried call otherwise silently duplicating a live
   *  agent. Always wins over the daemon's own derived (implicit) key when
   *  both would apply — see `dedupe` and `spawn-dedupe.ts`. Omitting this
   *  does NOT mean "spawn unconditionally" anymore: when the daemon's
   *  `spawn.dedupe` policy is `"always"` (the default) and this spawn
   *  carries a `label`, the daemon derives an implicit key in its place —
   *  see `dedupe` below to opt out per-call. */
  idempotencyKey?: string
  /** Per-call override for the daemon's `spawn.dedupe` policy (implicit
   *  dedupe when no `idempotencyKey` was supplied — see `spawn-dedupe.ts`).
   *  `false` is the escape hatch: never derive an implicit key for THIS
   *  spawn, regardless of policy — mirrors `attach: false` / `worktree:
   *  false`. `true` forces derivation even under an `"on-request"` policy,
   *  mirroring `attach: true`. Omitted ⇒ the policy mode decides. Has no
   *  effect when an explicit `idempotencyKey` is supplied (it already wins
   *  outright) or when this spawn carries no `label` (nothing to derive
   *  from either way). */
  dedupe?: boolean
  /**
   * OS-level confinement for the adapter's OWN spawned process
   * (`@agentproto/command-sandbox` — macOS Seatbelt / Linux bubblewrap),
   * threaded verbatim to `resolved.startSession({ commandSandbox })` →
   * `AgentCliRuntime.start`. NOT the AIP-36 `sandbox` field above — that
   * boots a whole nested daemon on a different machine/box (remote-box
   * session provider); this wraps THIS host's spawn argv so the adapter's
   * own process tree can't read/write outside `cwd` (and, `"strict"`,
   * reach the network), confinement an ACP permission seam can never see
   * since it only covers tool calls the adapter chooses to report. Exposed
   * on the `agent_start` MCP tool schema (`agent-tools.ts`) as of PR 6b —
   * when omitted here, the driver falls back to the workspace's
   * `.agentproto/command-sandbox.json` `adapterSpawn` key (a key distinct
   * from the top-level `mode` that same file also carries for
   * `command_execute` — see `@agentproto/command-sandbox`'s module doc for
   * why the two axes are never shared), or stays unconfined if that's unset
   * too. Ignored for a `sandbox` spawn (the box's own daemon would need to
   * apply this itself).
   */
  commandSandbox?: SandboxMode
}

export type SpawnAgentSessionResult =
  | {
      ok: true
      descriptor: SessionDescriptor
      output?: string[]
      /** Non-fatal spawn-time notices surfaced to the caller — currently the
       *  shared-dirty-cwd warning for a nested in-place spawn (see
       *  `decideWorktreeIsolation`'s `warn`). Absent when there's nothing to
       *  warn about. The spawn still succeeded; these are advisory. */
      warnings?: string[]
      /** Set when this result was returned to a duplicate call recognized
       *  via `idempotencyKey` OR a derived implicit key — no new process was
       *  spawned; `descriptor` is the ORIGINAL spawn's. Absent on the
       *  original (non-duplicate) call. */
      deduped?: boolean
      /** Set alongside `deduped` to say WHICH kind of dedup matched:
       *  `"explicit"` for a caller-supplied `idempotencyKey`, `"implicit"`
       *  for a daemon-derived key (see `spawn-dedupe.ts`). An implicit match
       *  is a GUESS, not a promise the caller made — surfacing which one
       *  fired lets a caller tell "you got back the session you thought you
       *  started" from "the daemon merged this into an unrelated-looking
       *  earlier spawn because it looked similar", instead of silently
       *  returning a different session than the one someone thought they
       *  started. Absent when `deduped` is absent. */
      dedupeSource?: "explicit" | "implicit"
    }
  | {
      ok: false
      code:
        | "adapter_not_found"
        | "no_cwd"
        | "orchestrator_not_enabled"
        | "orchestrator_max_depth_exceeded"
        | "orchestrator_child_quota_exceeded"
        | "invalid_role"
        | "role_spawn_denied"
        | "unsupported_auth_mode"
        | "unsupported_auth_source"
        | "auth_source_unresolved"
        | "access_profile_not_found"
        | "access_profile_ineligible"
        | "model_wallet_ineligible"
        | "model_adapter_incompatible"
        | "gateway_base_url_unsupported"
        | "agent_spawn_failed"
        | "sandbox_provider_not_found"
        | "sandbox_boot_failed"
        | "sandbox_reconnect_failed"
        | "sandbox_proxy_failed"
        | "worktree_disabled"
        | "worktree_provisioner_not_enabled"
        | "worktree_provision_failed"
        | "worktree_requires_explicit_repo"
        | "worktree_async_wait_conflict"
      message: string
      details?: Record<string, unknown>
    }

/**
 * Recover the daemon-composed SYSTEM preamble from a spawned child's
 * composed initial prompt. `composed` is the single string the adapter
 * receives; the CALLER's own ask (`callerPrompt`) is the LAST block,
 * joined from the preamble by "\n\n". The daemon knows the split because
 * it composed the string — the adapter only ever sees the whole thing, so
 * this is recorded on the daemon's OWN event stream (as a `system-prompt`
 * record ahead of the `user-prompt`) so UIs can fold the disposition /
 * AGENTS.md / lineage text instead of rendering it as a user bubble.
 *
 * Returns the preamble text WITHOUT the trailing "\n\n" separator, or
 * undefined when there's no preamble (the whole prompt is the caller's
 * ask) or the composition invariant doesn't hold (never split rather
 * than risk mis-tagging user text as system).
 */
function composedPreamble(
  composed: string | undefined,
  callerPrompt: string | undefined,
): string | undefined {
  if (!callerPrompt || !composed) return undefined
  const tail = `\n\n${callerPrompt}`
  if (!composed.endsWith(tail)) return undefined
  const pre = composed.slice(0, composed.length - tail.length)
  return pre || undefined
}

export async function spawnAgentSession(
  deps: SpawnAgentSessionDeps,
  input: SpawnAgentSessionInput,
): Promise<SpawnAgentSessionResult> {
  // Presets are a lower-precedence layer than an explicit spawn request. Do
  // this once, at the common core, so HTTP, MCP and future clients have the
  // same semantics rather than each expanding a preset slightly differently.
  if (input.preset) {
    const { preset, ...explicit } = input
    input = {
      ...explicit,
      model: explicit.model ?? preset.model,
      route: explicit.route ?? preset.route,
      access: explicit.access ?? preset.access,
      posture: explicit.posture ?? preset.posture,
      effort: explicit.effort ?? preset.effort,
      contextProfile: explicit.contextProfile ?? preset.contextProfile,
      // A preset `cwd` pins the favorite to a fixed repo — it feeds the same
      // slot an explicit request would, so the cwd ladder below treats it as
      // caller-named (and the worktree guard sees a real repo, not a fallback).
      cwd: explicit.cwd ?? preset.cwd,
      skills: explicit.skills ?? preset.skills,
    }
  }

  // Harness default preset (`harness-presets.json`): when NEITHER an explicit
  // request NOR a user preset pinned a billing profile, fall back to the
  // harness's persisted default preset — its `profileRef` + `defaultModel`
  // replace the legacy "first eligible profile" ambient resolution below. This
  // is the lowest-precedence layer: it fills `access.profileRef` only when
  // unset, and `model` only when the caller named none. A harness with no
  // default preset (the common case, and every test that doesn't provision one)
  // reads an empty store and leaves the spawn untouched.
  if (!input.access?.profileRef) {
    const preset = await getDefaultHarnessPreset(input.harness ?? input.adapter)
    if (preset) {
      input = {
        ...input,
        access: { profileRef: preset.profileRef },
        model: input.model ?? preset.defaultModel,
      }
    }
  }

  // Reconcile `model` and `route` so callers cannot describe two different
  // billing endpoints (e.g. `@openrouter` model + `requesty` route). A model
  // with an explicit `@route` wins; a model-only override synthesizes the
  // route field; contradicting overrides throw before any side effects.
  const reconciled = reconcileModelRoute({
    model: input.model,
    route: input.route,
  })
  input = {
    ...input,
    ...(reconciled.model !== undefined ? { model: reconciled.model } : {}),
    ...(reconciled.route !== undefined ? { route: reconciled.route } : {}),
  }
  const {
    registry,
    resolveAgentAdapter,
    buildOrchestratorMcp,
    daemonMcpUrl,
    callerScope,
    webhookNotifier,
    loadDefaultsConfig,
    resolveSandboxProvider,
    provisionWorktree,
    resolveWorktreeIsolation,
    resolveSpawnAttach,
    resolveSpawnDedupe,
    resolveProvenanceWrapGh,
    listCatalogModels,
  } = deps

  // cwd resolution: explicit cwd wins, then workspaceSlug lookup, then —
  // for a SCOPED spawn (callerScope set) — the spawning session's own cwd,
  // OR — for a ROOT spawn (no callerScope) — the daemon's global active
  // workspace, then a hard error (the operator probably forgot a step). A
  // scoped spawn never falls back to the global active workspace; see the
  // `callerScope` branch below.
  //
  // Captured BEFORE the active-workspace fallback below can fill `cwd`/
  // `resolvedSlug` in — the worktree guard downstream (see
  // `worktree_requires_explicit_repo`) needs to know whether the caller
  // actually named a repo, or whether resolution only succeeded because
  // it fell through to "whatever the daemon's active workspace happens to
  // be right now". A plain (non-worktree) spawn is unaffected: the active-
  // workspace fallback still resolves `cwd` for it exactly as before.
  const explicitCwd = input.cwd !== undefined
  const explicitWorkspaceSlug = input.workspaceSlug !== undefined
  // Hoisted above the cwd-resolution fallback (its usual home is right
  // before the depth/quota gates below) — the explicit-repo guard right
  // after this needs to know the spawn's depth BEFORE resolving `cwd`,
  // since a nested spawn (depth > 0) never provisions a worktree of its
  // own regardless of what `worktree` says (see `decideWorktreeIsolation`)
  // and must NOT be rejected here for lacking an explicit repo — it
  // inherits the parent's ground either way.
  const childDepth = callerScope ? callerScope.depth + 1 : 0
  // Explicit-repo guard, part 1 (the field-driven half — see part 2 inside
  // the worktree decision block below for the policy-driven `always` half).
  // A root spawn that explicitly asked for `worktree` isolation but named
  // NEITHER `cwd` NOR `workspaceSlug` has no caller-declared repo to cut
  // from; letting cwd resolution silently fall through to the active
  // workspace is exactly the incident this guard exists to prevent (a
  // worktree + branch cut on an unrelated repo because it happened to be
  // active at spawn time). Checked before cwd resolution even runs so it
  // fires regardless of whether the fallback would have found A path —
  // the point is the caller didn't say which one.
  if (
    childDepth === 0 &&
    !explicitCwd &&
    !explicitWorkspaceSlug &&
    normalizeWorktreeField(input.worktree) !== undefined
  ) {
    return {
      ok: false,
      code: "worktree_requires_explicit_repo",
      message:
        "agent_start: `worktree` isolation was requested but neither `cwd` nor " +
        "`workspaceSlug` was passed — refusing to guess the base repo from the " +
        "daemon's active workspace. Pass `cwd` (an explicit path inside the repo " +
        "to worktree from) or `workspaceSlug` (a slug from `agentproto workspace " +
        "list`) to `agent_start`.",
    }
  }
  let cwd = input.cwd
  let resolvedSlug = input.workspaceSlug
  if (!cwd || !resolvedSlug) {
    try {
      const config = await loadWorkspacesConfig()
      if (!cwd) {
        if (input.workspaceSlug) {
          const ws = findWorkspace(config, input.workspaceSlug)
          if (ws) {
            cwd = ws.path
            resolvedSlug = ws.slug
          }
        } else if (callerScope) {
          // Scoped (nested) spawn with neither `cwd` nor `workspaceSlug`:
          // default to the SPAWNING session's own cwd rather than the
          // daemon's global active workspace, which has no relationship to
          // the parent's repo (see AUDIT.md, agentproto-workspace-cwd-audit).
          // `ownerSessionId` is bound synchronously right after the owning
          // orchestrator session is registered (`bindOrchestratorLifecycle`
          // below, called immediately after `registry.spawnAgent`) — strictly
          // before that session can be reached to make this nested call, so
          // it is always populated here. A scoped spawn that still can't
          // resolve a cwd (a parent with no recorded cwd) falls through to
          // the `no_cwd` error below instead of guessing `active` — `active`
          // is reserved for root spawns only.
          const parentCwd = callerScope.ownerSessionId
            ? registry.get(callerScope.ownerSessionId)?.cwd
            : undefined
          if (parentCwd) {
            cwd = parentCwd
            const ws = findWorkspaceByPath(config, parentCwd)
            if (ws) {
              resolvedSlug = ws.slug
            }
          }
        } else {
          const ws = getActiveWorkspace(config)
          if (ws) {
            cwd = ws.path
            resolvedSlug = ws.slug
          }
        }
      } else if (!resolvedSlug) {
        // cwd provided but no explicit workspaceSlug — try to match
        // cwd against a registered workspace so the session lands in
        // the right workspace instead of the global default.
        const ws = findWorkspaceByPath(config, cwd)
        if (ws) {
          resolvedSlug = ws.slug
        } else {
          // cwd matched no workspace directly — if it's a linked git worktree,
          // fall back to the workspace of the repo it was cut from, so worktree
          // sessions group under their base repo instead of the "default" bucket.
          const identity = resolveWorktreeIdentity(cwd)
          if (identity?.mainRepoPath) {
            const baseWs = findWorkspaceByPath(config, identity.mainRepoPath)
            if (baseWs) resolvedSlug = baseWs.slug
          }
        }
      }
    } catch {
      // fall through to error below
    }
  }
  resolvedSlug = resolvedSlug ?? "default"
  if (!cwd) {
    return {
      ok: false,
      code: "no_cwd",
      message:
        "agent_start: no cwd resolvable. Pass `cwd` explicitly, " +
        "or pass `workspaceSlug` matching `agentproto workspace list`, " +
        "or set an active workspace via `agentproto workspace use <slug>`.",
    }
  }
  // A sandboxed spawn runs `adapter` on the BOX's own `agent_start` — the
  // host's local adapter registry has no bearing on it (the box resolves
  // `adapter` itself), so the local resolution + not-found gate are
  // skipped entirely for `input.sandbox`. See the sandbox branch below,
  // which short-circuits BEFORE `resolved.startSession(...)` is ever
  // reached.
  // Sandboxed spawns normally resolve the adapter inside the sandbox, not on
  // the host. A named host auth profile is the one exception: resolve the
  // host descriptor just long enough to select the requested billing rail and
  // turn the keychain-backed profile into the explicit credential a fresh box
  // needs. Keep the normal sandbox path free of this host dependency.
  const resolveHostAuth = input.sandbox !== undefined && input.access?.profileRef !== undefined
  const resolved =
    input.sandbox === undefined || resolveHostAuth ? await resolveAgentAdapter(input.adapter) : null
  if (input.sandbox === undefined && !resolved) {
    // `resolveAgentAdapter` collapses every failure reason to `null` by
    // contract (it's injected across a dozen call sites that all assume it
    // never throws — see its doc comment), so this message can't name the
    // exact cause the way `resolveAdapter`'s own thrown error can. It CAN
    // stop asserting "not found" as settled fact: an adapter that resolved
    // moments ago and now doesn't is most likely mid-rebuild, not
    // uninstalled — a resolver with a warm last-known-good cache (the CLI's
    // `resolveAdapter`) already returns successfully through that window,
    // so reaching this branch at all means either the adapter has never
    // resolved in this process, or it went unresolvable long enough to
    // exhaust that grace period.
    return {
      ok: false,
      code: "adapter_not_found",
      message:
        `agent_start: adapter "${input.adapter}" could not be resolved. If it was ` +
        `working a moment ago, something may be mid-rebuild — wait and retry. If it ` +
        `has never been installed, run \`agentproto install ${input.adapter}\` first.`,
    }
  }
  if (resolveHostAuth && !resolved) {
    return {
      ok: false,
      code: "access_profile_ineligible",
      message:
        `agent_start: adapter "${input.adapter}" must be available on the host to resolve ` +
        `access profile "${input.access?.profileRef}" for a sandbox spawn.`,
    }
  }
  // ── Recursion guardrails (WP4) ──────────────────────────────
  // When this call arrives through the scoped sub-gateway,
  // `callerScope` is the spawning orchestrator's identity. Enforce
  // the depth cap and per-parent child quota BEFORE spawning, and
  // compute the new session's parent attribution. A direct `/mcp`
  // spawn (no callerScope) is subject to NO caps — but it can still be
  // ATTRIBUTED to a logical parent via the trusted `parentSessionId` hint
  // below (WP-R1), which only records lineage and never enters these caps.
  // (`childDepth`, the cap/gate depth, is computed earlier, above the
  // cwd-resolution block — see the explicit-repo guard's comment there.)
  // Parent attribution. The scoped orchestrator gateway's token is the
  // unspoofable source: when `callerScope` is present, parent is derived from
  // it and every non-scope signal (the caller's `parentSessionId` hint, the
  // daemon-derived `autoParentSessionId`, and the `attach` field) is IGNORED —
  // the scope always wins. Only on the anonymous root path — no `callerScope`,
  // hence no scope to attribute from — does `decideSpawnAttach` resolve the
  // parent from the attach policy × the explicit hint × the trusted auto-
  // parent (`?callerSessionId=`), filling the gap that otherwise leaves an
  // agent-to-agent spawn a depth-0 orphan. `attach: false` forces a root here.
  const attachDecision = callerScope
    ? { parent: undefined as string | undefined, detached: false }
    : decideSpawnAttach({
        mode: resolveSpawnAttach ? await resolveSpawnAttach() : await loadSpawnAttach(),
        field: input.attach,
        ...(input.autoParentSessionId ? { autoParent: input.autoParentSessionId } : {}),
        ...(input.parentSessionId ? { hint: input.parentSessionId } : {}),
      })
  const parentHint = attachDecision.parent
  const parentSessionId = callerScope?.ownerSessionId ?? parentHint
  // Recorded lineage depth. For a scope-attributed spawn this is the gating
  // depth (`callerScope.depth + 1`, computed above). For a hint-attributed
  // root spawn — which carries no scope and therefore no gating depth — derive
  // it from the resolved parent descriptor's own depth (+1), defaulting to 1
  // when the parent isn't in the registry (e.g. a not-yet-self-registered
  // synthetic root). A parentless root stays depth 0. Descriptor-only on
  // purpose: the hint never moves `childDepth`, so it can't relax the
  // depth-gated worktree/role guards above — an agent declaring a logical
  // parent is not a nested (scoped) spawn.
  const recordedDepth = callerScope
    ? childDepth
    : parentHint
      ? (registry.get(parentHint)?.depth ?? 0) + 1
      : 0
  if (callerScope) {
    if (childDepth > callerScope.maxDepth) {
      return {
        ok: false,
        code: "orchestrator_max_depth_exceeded",
        message:
          `Spawn rejected: this orchestrator is at depth ${callerScope.depth}; ` +
          `a child would be depth ${childDepth}, exceeding the max depth ` +
          `${callerScope.maxDepth}. No session was created.`,
        details: {
          depth: callerScope.depth,
          childDepth,
          maxDepth: callerScope.maxDepth,
        },
      }
    }
    // Count this orchestrator's currently-alive children. Killed/
    // exited children free a slot (the cap bounds concurrent load,
    // not lifetime spawns).
    const aliveChildren = parentSessionId
      ? registry.list().filter(
          s =>
            s.parentSessionId === parentSessionId &&
            (s.status === "running" || s.status === "starting"),
        ).length
      : 0
    if (aliveChildren >= callerScope.maxChildren) {
      return {
        ok: false,
        code: "orchestrator_child_quota_exceeded",
        message:
          `Spawn rejected: this orchestrator already has ${aliveChildren} ` +
          `alive children, at the max of ${callerScope.maxChildren}. ` +
          `Kill one before spawning another. No session was created.`,
        details: {
          aliveChildren,
          maxChildren: callerScope.maxChildren,
        },
      }
    }
  }
  // ── Worktree isolation decision (policy-driven) ─────────────────
  // Resolve the daemon's `worktrees.isolation` policy and decide WHETHER to
  // isolate this spawn into its own git worktree — a pure decision here; the
  // actual `git worktree add` runs later, inside the fork's try block, so a
  // deduped idempotency retry never provisions a second tree. Skipped for a
  // sandbox spawn: a remote box already isolates, and a local worktree there
  // would be meaningless. Validation-class rejects (`never` + explicit
  // request, or a provision with no provisioner wired) fail LOUD here, before
  // any side effect — mirroring the role/depth gates above.
  let worktreeRequest: WorktreeRequest | undefined
  // Non-fatal spawn-time notices, surfaced on the success result (`warnings`)
  // AND logged. Populated by the worktree decision below (shared-dirty-cwd).
  const spawnWarnings: string[] = []
  if (input.sandbox === undefined) {
    const mode = resolveWorktreeIsolation
      ? await resolveWorktreeIsolation()
      : await loadWorktreeIsolation()
    // Impure signal for the implicit nested-in-place case only: is the
    // inherited cwd a SHARED, DIRTY tree the child would edit in place (dirty
    // AND not a daemon-provisioned worktree)? Computed here — never inside the
    // pure decision — and only when it can matter (a nested spawn that made no
    // explicit `worktree` request), so a root spawn or an explicit request
    // pays no git-status cost and the decision matrix stays pure/testable.
    const sharedDirtyCwd =
      childDepth > 0 && normalizeWorktreeField(input.worktree) === undefined
        ? await isSharedDirtyCwd(cwd)
        : false
    const decision = decideWorktreeIsolation({
      mode,
      field: input.worktree,
      depth: childDepth,
      sharedDirtyCwd,
      ...(input.allowSharedCwd ? { allowSharedCwd: true } : {}),
    })
    if (decision.action === "reject") {
      return { ok: false, code: "worktree_disabled", message: decision.message }
    }
    if (decision.action === "spawn-in-place" && decision.warn) {
      spawnWarnings.push(decision.warn)
      console.warn(`[agent_start] ${decision.warn}`)
    }
    if (decision.action === "provision") {
      // Deterministic base-repo guard (the incident this exists to prevent):
      // a worktree spawn with NEITHER an explicit `cwd` NOR an explicit
      // `workspaceSlug` has no caller-declared repo to cut from — `cwd`
      // above only got filled in by falling through to the daemon's
      // active-workspace fallback, which can silently be some unrelated
      // repo (a stale/wrong `workspaces.json` entry, or whatever the
      // operator last `workspace use`'d). Provisioning a worktree — a
      // side-effecting `git worktree add` plus a new branch — off that
      // guess is exactly the failure mode observed in production: a
      // worktree spawn with no cwd/workspaceSlug cut a worktree + branch on
      // an unrelated client repo because it happened to be the active
      // workspace at that moment. Fail fast instead of guessing; a plain
      // (non-worktree) spawn is untouched by this and keeps using the
      // active-workspace fallback exactly as before.
      if (!explicitCwd && !explicitWorkspaceSlug) {
        return {
          ok: false,
          code: "worktree_requires_explicit_repo",
          message:
            "agent_start: `worktree` isolation was requested but neither `cwd` nor " +
            "`workspaceSlug` was passed — refusing to guess the base repo from the " +
            "daemon's active workspace. Pass `cwd` (an explicit path inside the repo " +
            "to worktree from) or `workspaceSlug` (a slug from `agentproto workspace " +
            "list`) to `agent_start`.",
        }
      }
      if (!provisionWorktree) {
        return {
          ok: false,
          code: "worktree_provisioner_not_enabled",
          message:
            "agent_start: `worktree` isolation is required (by request or the " +
            `"${mode}" policy) but this daemon has no worktree provisioner wired ` +
            "(createGateway needs `provisionWorktree`, injected by the CLI over " +
            "@agentproto/worktree).",
        }
      }
      worktreeRequest = decision.request
    }
  }
  // `worktree.async` returns before the tree — and therefore the driver
  // session — exists, so there is no first-turn output for `wait` to block
  // on and return. The two are a contradiction, not a priority order; fail
  // loud here (no side effects yet) rather than silently picking one.
  if (worktreeRequest?.async && input.wait) {
    return {
      ok: false,
      code: "worktree_async_wait_conflict",
      message:
        "agent_start: `worktree.async` and `wait` cannot be combined — async " +
        "provisioning returns before the worktree (and the driver session in " +
        "it) exists, so there is no first-turn output for `wait` to block on. " +
        "Drop `wait` and poll the session's `status` instead, or drop " +
        "`worktree.async` to provision synchronously.",
    }
  }
  // ── Model-slug advisory (opaque late failure → early "did you mean") ──────
  // The money-safety guard below (`checkModelWalletEligibility`) DELIBERATELY
  // passes a slug unknown to the local catalog (`serviceableModelRoutes` empty
  // ⇒ a mismatch can't be proven, so it never rejects): a genuinely-new model,
  // and an adapter like hermes whose `model` option is free-form OpenRouter/
  // OpenAI ids, must still spawn. The cost of that latitude is a TYPO'd slug —
  // `deepseek-chat` for `deepseek/deepseek-chat`, `moonshot/kimi-k2` for
  // `moonshotai/kimi-k2`, `glm-5.2` for `z-ai/glm-5.2` — sailing through and
  // 404'ing opaquely deep inside the provider call, with nothing at the spawn
  // boundary to point at it. When the caller named an EXPLICIT `model` the
  // catalog doesn't know BUT a known id shares its bare product (the wrong- or
  // missing-vendor/route-prefix signal), surface a non-fatal "did you mean" so
  // the breadcrumb lands in the spawn response (`warnings`) + the log instead
  // of only in an upstream stack trace. Advisory, NEVER a reject — a
  // suggestion-less unknown slug (a real new model) still spawns silently, in
  // step with the guard's own never-reject-an-unknown-model rule. Skipped for a
  // sandbox spawn (the box's own daemon validates its model) and for the
  // adapter's own default (always a catalogued id).
  if (
    input.sandbox === undefined &&
    input.model !== undefined &&
    serviceableModelRoutes(input.model).length === 0
  ) {
    const suggestions = suggestModelSlugs(input.model)
    if (suggestions.length > 0) {
      const warn =
        `agent_start: model "${input.model}" is not in the local model catalog, but ` +
        `${suggestions.length > 1 ? "these known ids share" : `"${suggestions[0]}" shares`} its ` +
        `name — did you mean ${suggestions.map(s => `"${s}"`).join(", ")}? Spawning anyway ` +
        `(the adapter/provider validates the slug upstream); if this is a typo it will fail ` +
        `opaquely there, so re-spawn with the fully-qualified id above.`
      spawnWarnings.push(warn)
      console.warn(`[agent_start] ${warn}`)
    }
  }
  // Config-level defaults (WP: session-skills-defaults) — auto-apply
  // `defaults.skills` / `defaults.options` (global + per-adapter) unless
  // the caller's explicit `agent_start` fields already say otherwise.
  // Pure merge in `resolveSpawnDefaults`; adapter-shape folding (e.g.
  // hermes' comma-joined `options.skills`) in `normalizeSkillsOption`,
  // using the manifest's own declared option type via `resolved`.
  // Loaded here (before the role/orchestrator decisions below) because
  // both `defaultRoleDepthCutoff` and `skills`/`options` come from the
  // same block.
  const configDefaults = loadDefaultsConfig
    ? await loadDefaultsConfig()
    : (await loadConfig()).defaults
  // Role REGISTRY (spawn-role-profiles extensibility): custom
  // (pack-carried) roles merged with the two built-ins at every
  // resolution below — see `role.ts`'s `mergeRoleRegistry`. Loaded once
  // per spawn so the child-role resolution and the parent-role gate
  // check (right below) agree on the exact same set.
  const roleRegistry = deps.loadRoleRegistry
    ? await deps.loadRoleRegistry()
    : await loadDefaultRoleRegistry()
  // Spawn-time role (see role.ts). Resolved BEFORE the orchestrator/
  // hermes-default mcpServers decisions below so `toolPolicy.delegation`
  // can gate both — the hard tool gate this whole primitive exists for.
  let role
  try {
    role = resolveRole(input.role, childDepth, configDefaults?.defaultRoleDepthCutoff, roleRegistry)
  } catch (err) {
    return {
      ok: false,
      code: "invalid_role",
      message: `agent_start: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  // Privilege-lattice spawn gate: when this spawn arrives through the
  // scoped orchestrator sub-gateway, `callerScope` carries the resolved
  // role of the SPAWNING session (see `OrchestratorScope.role`). Reject
  // BEFORE any tool injection when the caller may not spawn this role —
  // the second line of defense (after `toolPolicy.delegation`) for a
  // custom role that keeps delegation but must not spawn UP. A root
  // spawn (no callerScope) has no parent to gate against, same as the
  // existing depth/quota checks above.
  if (callerScope) {
    let parentRole: RoleProfile
    try {
      parentRole = resolveRole(
        callerScope.role,
        callerScope.depth,
        configDefaults?.defaultRoleDepthCutoff,
        roleRegistry,
      )
    } catch (err) {
      return {
        ok: false,
        code: "invalid_role",
        message: `agent_start: caller role — ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!canSpawn(parentRole, role)) {
      return {
        ok: false,
        code: "role_spawn_denied",
        message:
          `agent_start: role "${parentRole.name}" (level ${parentRole.level}) may not spawn ` +
          `role "${role.name}" (level ${role.level}). ` +
          (parentRole.spawnableRoles
            ? `Allowed: ${parentRole.spawnableRoles.join(", ") || "(none)"}.`
            : `Open mode requires a level at or below ${parentRole.level} — spawning something more privileged than yourself is never allowed.`),
        details: {
          parentRole: parentRole.name,
          parentLevel: parentRole.level,
          childRole: role.name,
          childLevel: role.level,
        },
      }
    }
  }
  const delegationDenied = role.toolPolicy.delegation === "deny"
  // Orchestrator role (WP3): when requested, mint a scoped
  // sub-gateway token and MERGE its `mcpServers` entry with any
  // caller-provided ones (WP1) — both coexist on the child's
  // session. The child thus receives the curated orchestration
  // toolset and can spawn + supervise its own sub-agents. The
  // token is revoked when the session exits (bindLifecycle below).
  // When the spawn is itself recursive (callerScope present), the
  // child's token inherits depth+1 and is bounded by the caller's
  // tools (non-re-grant — a child can't widen past its parent).
  //
  // HARD GATE: a role that denies delegation drops `orchestrator`
  // outright, regardless of what the caller requested — this is the
  // capability gate applied from outside; `promptAppend` cannot
  // reopen it (it's never consulted here at all).
  let mcpServers = input.mcpServers
  // Minted here (not left to `registry.spawnAgent`'s own default) so it can
  // be baked into the daemon-self-ref URL below BEFORE the child's static
  // MCP config is written — `spawnAgent` doesn't return an id until AFTER
  // the child has already started (see its call below), which is too late
  // for anything embedded in the child's own callback URL. Handed to
  // `spawnAgent` via `SpawnAgentInput.id` so the descriptor ends up with
  // this exact id rather than a second, different one (PR 7 / Gap 7).
  const mintedSessionId = mintSessionId()
  // Default the daemon's own gateway onto spawns that supplied no
  // `mcpServers` — two distinct rationales, one mechanism (see
  // `shouldInjectDaemonSelfMount` for the per-adapter reasoning):
  //   - hermes: CAPABILITY — it has zero built-in tools; without an
  //     explicit `mcpServers` it silently spawns as a chat-only session
  //     with no error. The default makes that impossible by omission.
  //   - claude-code: IDENTITY — its sessions typically reach this same
  //     daemon anyway through ambient MCP config (a project `.mcp.json` /
  //     the operator's global claude config), but those static mounts can
  //     never carry a per-session `callerSessionId`, so every spawn such a
  //     session made landed as an anonymous depth-0 orphan —
  //     `spawn-attach.ts`'s auto-parent had nothing to derive from, and
  //     origin grouping had no lineage to walk. The injected entry reuses
  //     the same `agentproto` server name, and a session-level entry
  //     SHADOWS an ambient same-named one at the SDK layer (verified live:
  //     the child sees only the session-level server's tools), so the
  //     child keeps the daemon toolset it already had — now with identity
  //     baked in, its own spawns auto-attaching, and the ambient unstamped
  //     mount neutralized in one move.
  // An explicit `[]` is a deliberate opt-out and must be respected as
  // such, so this only fires when the caller passed no `mcpServers` at all.
  //
  // HARD GATE: when the resolved role denies delegation, the injected
  // gateway URL carries `denyTools=<DELEGATION_TOOL_NAMES>` so the
  // daemon's `/mcp` handler strips `agent_start`/`agent_prompt` from
  // what it registers for this one request — the child still gets the
  // rest of the daemon's tools (fs, command_execute, …) to do real work.
  //
  // It also carries `callerSessionId=<mintedSessionId>` so a
  // `command_execute` call this child makes back through that URL can be
  // attributed to it (PR 7 / Gap 7) — `handleMcp` (http-server.ts) reads
  // the query param and threads it into `registerCommandTools`.
  if (!mcpServers && shouldInjectDaemonSelfMount(input.adapter, input.sandbox) && daemonMcpUrl) {
    let ref = delegationDenied
      ? `${daemonMcpUrl}${daemonMcpUrl.includes("?") ? "&" : "?"}denyTools=${DELEGATION_TOOL_NAMES.join(",")}`
      : daemonMcpUrl
    ref += `${ref.includes("?") ? "&" : "?"}callerSessionId=${encodeURIComponent(mintedSessionId)}`
    mcpServers = [{ name: "agentproto", transport: "http", ref }]
  }
  let bindOrchestratorLifecycle:
    | ((sessionId: string) => () => void)
    | undefined
  if (!delegationDenied && input.orchestrator !== undefined && input.orchestrator !== false) {
    if (!buildOrchestratorMcp) {
      return {
        ok: false,
        code: "orchestrator_not_enabled",
        message:
          "agent_start: `orchestrator` is not enabled — the daemon " +
          "was started without the scoped orchestrator sub-gateway. Wire " +
          "`buildOrchestratorMcp` in createGateway (it needs the scope-token " +
          "registry + HTTP port + session-event bus).",
      }
    }
    const orchestratorOpts =
      typeof input.orchestrator === "object" ? input.orchestrator : undefined
    const requestedTools = orchestratorOpts?.tools
    const injection = buildOrchestratorMcp({
      ...(requestedTools ? { tools: requestedTools } : {}),
      ...(callerScope ? { caller: callerScope } : {}),
      ...(orchestratorOpts?.maxDepth !== undefined
        ? { maxDepth: orchestratorOpts.maxDepth }
        : {}),
      ...(orchestratorOpts?.maxChildren !== undefined
        ? { maxChildren: orchestratorOpts.maxChildren }
        : {}),
      // This session's OWN resolved role — becomes the "parent role" the
      // gate above checks a FUTURE spawn (made through this scope)
      // against, once this session itself calls `agent_start`.
      role: role.name,
    })
    mcpServers = [...(mcpServers ?? []), injection.entry]
    bindOrchestratorLifecycle = injection.bindLifecycle
  }
  // ── Identity stamp: decouple attribution from capability ────────
  // Ensure EVERY mcpServers entry that targets THIS daemon's own `/mcp`
  // endpoint carries `callerSessionId=<own id>`, so any spawn this child makes
  // back through it attributes to the child (→ auto-parent, see
  // spawn-attach.ts) — regardless of adapter, and regardless of whether the
  // daemon default-injected the entry (the hermes case above, already stamped
  // and skipped as idempotent) or the CALLER supplied it (e.g. a claude-code
  // supervisor explicitly pointed at the daemon). This grants NO new
  // capability — it only identity-stamps daemon access the session already has
  // — which is why it's safe to apply uniformly. The scoped orchestrator entry
  // (`/mcp/orchestrator?scope=…`) attributes via its own token and sits on a
  // deeper path than `daemonMcpUrl`, so the exact-path match below leaves it
  // untouched. A caller who set `callerSessionId` themselves is respected.
  if (daemonMcpUrl && mcpServers) {
    const daemonQ = `${daemonMcpUrl}?`
    mcpServers = mcpServers.map(entry => {
      if (entry.transport !== "http" || typeof entry.ref !== "string") return entry
      const targetsDaemon = entry.ref === daemonMcpUrl || entry.ref.startsWith(daemonQ)
      if (!targetsDaemon || entry.ref.includes("callerSessionId=")) return entry
      const sep = entry.ref.includes("?") ? "&" : "?"
      return {
        ...entry,
        ref: `${entry.ref}${sep}callerSessionId=${encodeURIComponent(mintedSessionId)}`,
      }
    })
  }
  // ── Report-back channel (child → parent) ──────────────────────────
  // Every child with a recorded parent should be able to reach
  // `message_parent` (report a result or blocker UP to the session that
  // spawned it) without being handed the delegation surface. Two cases are
  // already covered: an orchestrator scope carries `message_parent` in its
  // default allowlist, and any daemon-targeting `/mcp` entry (the hermes
  // default above, or caller-supplied) reaches the root gateway, where the
  // tool is registered and never deny-gated. The remaining case is a child
  // with a parent and NO gateway at all (an adapter outside the default
  // self-mount set — a plain codex/gemini leaf — or a daemon running
  // without `daemonMcpUrl`; claude-code leaves land here only in the
  // latter case now that they get the full default mount):
  // mint a scope narrowed to `message_parent` only, riding the same
  // token/lifecycle machinery as a full orchestrator scope (revoked when
  // the child exits). This grants NO delegation — the scope's tool set has
  // no `agent_start`/`agent_prompt`, and its role is the child's own, so
  // the `canSpawn` gate stays shut for an executor. An explicit
  // `mcpServers` (including `[]`) or `orchestrator: false` is a deliberate
  // caller choice and is respected as an opt-out; a sandbox spawn is
  // skipped (a remote box can't reach the loopback gateway anyway).
  if (
    mcpServers === undefined &&
    parentSessionId &&
    buildOrchestratorMcp &&
    input.orchestrator !== false &&
    input.sandbox === undefined
  ) {
    // No `caller` ceiling on purpose: report-back is universal, not a
    // re-grant — a parent whose own scope lacks `message_parent` must not
    // strip its children of the ability to report up. The scope can spawn
    // nothing (no delegation tools), so depth bookkeeping is moot.
    const injection = buildOrchestratorMcp({
      tools: ["message_parent"],
      role: role.name,
    })
    mcpServers = [injection.entry]
    bindOrchestratorLifecycle = injection.bindLifecycle
  }
  const spawnDefaults = resolveSpawnDefaults(configDefaults, input.adapter, {
    skills: input.skills,
    options: input.options,
    auth: input.auth,
    contextContinuity: input.contextContinuity,
  })
  const resolvedContextContinuity: ResolvedContextContinuityPolicy =
    resolveContextContinuityPolicy(
      undefined,
      undefined,
      undefined,
      spawnDefaults.contextContinuity,
    )
  // ── Billing-auth resolution (DECISIONS 4/9/10) ──────────────────
  // The runtime decides provider → ordered mode → setEnv/scrub → credential
  // source → fingerprint, and emits BOTH the mechanical `spec` the driver
  // applies AND the observable `echo` recorded on the descriptor. Fail-loud
  // on a configured-but-missing credential is the DRIVER's job (it engages
  // then throws `missing_auth_credential`); a requested-but-unsupported mode
  // fails LOUD right here (`unsupported_auth_mode`). No provider resolves ⇒
  // no spec ⇒ ambient (no injection). Skipped for a sandbox spawn — the box's
  // own daemon resolves its own credential independently.
  // A `base_url` option targets this spawn at a non-Anthropic gateway
  // explicitly — the driver-level fix (define-agent-cli.ts's `engageAuth`)
  // already guarantees no native-Anthropic credential is ever injected into
  // such a spawn, but resolving+echoing an auth spec here regardless is
  // misleading: a caller reading the session descriptor's `auth` field would
  // see a native-Anthropic subscription spec for a spawn that will never
  // actually use it. Skip resolution entirely so the descriptor reflects
  // reality. (A `mode`-based gateway selection, e.g. `mode: "moonshot"`, is
  // not checked here — that would require introspecting the adapter's mode
  // declarations for whichever env keys the mode sets; the driver-level fix
  // covers that case regardless of whether the echo is accurate.)
  // A custom route is transport data, not a legacy `mode`. Project the one
  // route field the current driver understands without replacing a caller's
  // explicit option. Catalog-backed routes have their own adapter projection;
  // `baseUrl` exists specifically for custom gateways.
  // A preset gateway's base_url is resolved by `resolveAuthSpec` below; we
  // skip resolution only when the caller already supplied a base_url (custom
  // route or explicit option) because then the descriptor would misrepresent
  // the billing rail.
  const hasExplicitBaseUrlOption =
    typeof spawnDefaults.options?.base_url === "string" && spawnDefaults.options.base_url.length > 0
  const hasCustomRouteBaseUrl =
    typeof input.route?.baseUrl === "string" && input.route.baseUrl.length > 0
  const shouldSkipAuthResolution = hasExplicitBaseUrlOption || hasCustomRouteBaseUrl
  let authSpec: ResolvedAuthSpec | undefined
  let authEcho: AuthEcho | undefined
  let accessProfileEcho:
    | { profileRef: string; label?: string; endpoint: string; method: AuthMethod }
    | undefined
  // Echo of the resolved billing route for a BY-MODEL ROUTER adapter (no
  // fixed `authDescriptor.provider` — hermes, pi, opencode) when the caller
  // named no explicit `route.gateway`. Without this, the descriptor's
  // `route` field stays empty even though the spawn billed a real gateway
  // (derived from the model id via `getModelProvider`), and a later
  // `resolveEffectiveRoute(session.model, session.route?.gateway)` call
  // (e.g. the VS Code change-model picker) falls back to treating the
  // session as running the model's bare/direct route — a false "restart
  // required" the moment the operator picks a row with an explicit
  // `@route` suffix that happens to match the SAME gateway the session is
  // already on. A fixed-provider adapter (claude-code) needs none of this:
  // its `route` stays reserved for an operator-named gateway override.
  let resolvedRouteGateway: string | undefined
  if (resolved && input.access?.profileRef) {
    const result = await resolveAccessProfileAuth({
      adapter: input.adapter,
      profileRef: input.access.profileRef,
      authDescriptor: resolved.authDescriptor,
      route: input.route,
      model: input.model,
      defaultModel: resolved.defaultModel,
    })
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: `agent_start: ${result.message}`,
        ...(result.details ? { details: result.details } : {}),
      }
    }
    authSpec = result.authSpec
    authEcho = result.authEcho
    accessProfileEcho = result.accessProfileEcho
  } else if (
    resolved &&
    input.sandbox === undefined &&
    resolved.authDescriptor &&
    !shouldSkipAuthResolution
  ) {
    const authModel = input.model ?? resolved.defaultModel
    const pinnedProvider = spawnDefaults.auth.provider
    const resolvedProvider =
      pinnedProvider ??
      resolved.authDescriptor.provider ??
      (authModel && resolved.authDescriptor.modelDerivedApiKey
        ? modelIdPrefixProvider(authModel)
        : undefined) ??
      (authModel ? getModelProvider(authModel) : undefined)
    if (resolved.authDescriptor.provider === undefined && resolvedProvider !== undefined) {
      resolvedRouteGateway = resolvedProvider
    }
    // When an explicit gateway route is set, the provider-store key is looked
    // up under the gateway id (e.g. "moonshot") rather than the model-derived
    // vendor, because the gateway preset/custom route defines the credential
    // env var and the billing endpoint.
    const apiKeyStoreProvider = input.route?.gateway ?? resolvedProvider
    // Consult providers.json (the EXPLICIT store — never ambient env) ONLY
    // when the operator explicitly opted into auth for this spawn (`explicit`)
    // AND no explicit config key was already supplied. Gating on `explicit` is
    // the money-safety invariant: for an UNCONFIGURED spawn the store must NOT
    // be consulted — otherwise an `always` adapter (claude-code) would flip
    // ordered-mode to api-key off a leftover `auth provider set anthropic` key
    // and silently bill org credits (DECISION 5/10: unconfigured `always` ⇒
    // fail-fast, preserving #312). For `when-configured` adapters unconfigured
    // still means ambient (boot injection already placed keys in ambient env),
    // so gating on `explicit` is correct for every adapter.
    const apiKeyStoreCredential =
      apiKeyStoreProvider &&
      spawnDefaults.auth.explicit &&
      spawnDefaults.auth.apiKeyCredential === undefined
        ? await getProviderKey(apiKeyStoreProvider)
        : undefined
    // Subscription-credential precedence (SPEC §2): explicit per-spawn token >
    // self-refreshing `source` (resolved FRESH here, the impure caller) >
    // config static token. The recipe read is I/O — do it before the pure
    // resolveAuthSpec and hand it the fresh credential + its origin label. A
    // configured-but-unresolvable source fails LOUD (never a silent
    // fallthrough). api-key mode never touches this. The auth-PROFILE path
    // above resolves its own `source` the same way, scoped to that branch.
    let subscriptionCredential: string | undefined
    let subscriptionCredentialSource: CredentialSource | undefined
    let externalSubscriptionVerified = false
    // File-based (external) subscription — codex/gemini: the CLI reads its OWN
    // login file, so an explicit subscription opt-in (mode:"subscription" or a
    // configured source) verifies the login is present (fail-loud) and injects
    // NOTHING — never routed through resolveSubscriptionCredential (which
    // resolves+injects a bearer, and would reject a non-Anthropic source). An
    // unconfigured or api-key codex spawn skips this and stays untouched.
    const wantsExternalLogin =
      resolved.authDescriptor.authSubscription?.external === true &&
      spawnDefaults.auth.explicit &&
      (spawnDefaults.auth.requestedMode === "subscription" ||
        spawnDefaults.auth.subscriptionSource !== undefined)
    try {
      if (wantsExternalLogin) {
        await verifyLocalLoginPresent(
          spawnDefaults.auth.subscriptionSource ?? input.adapter,
          input.adapter,
        )
        externalSubscriptionVerified = true
      } else {
        const subResolution = await resolveSubscriptionCredential(
          {
            ...(input.auth?.token !== undefined ? { explicitToken: input.auth.token } : {}),
            ...(spawnDefaults.auth.subscriptionSource !== undefined
              ? { source: spawnDefaults.auth.subscriptionSource }
              : {}),
            ...(spawnDefaults.auth.subscriptionCredential !== undefined
              ? { fallbackStaticToken: spawnDefaults.auth.subscriptionCredential }
              : {}),
          },
          resolveClaudeCodeOauthToken,
        )
        subscriptionCredential = subResolution.credential
        subscriptionCredentialSource = subResolution.source
      }
    } catch (err) {
      if (err instanceof SubscriptionSourceError) {
        return {
          ok: false,
          code: err.code,
          message: `agent_start: ${err.message}`,
          details: { adapter: input.adapter },
        }
      }
      throw err
    }
    try {
      const result = resolveAuthSpec({
        descriptor: resolved.authDescriptor,
        ...(authModel ? { model: authModel } : {}),
        ...(input.route?.gateway ? { routeGateway: input.route.gateway } : {}),
        ...(pinnedProvider ? { requestedProvider: pinnedProvider } : {}),
        ...(spawnDefaults.auth.requestedMode
          ? { requestedMode: spawnDefaults.auth.requestedMode }
          : {}),
        explicit: spawnDefaults.auth.explicit,
        ...(subscriptionCredential !== undefined ? { subscriptionCredential } : {}),
        ...(subscriptionCredentialSource !== undefined
          ? { subscriptionCredentialSource }
          : {}),
        ...(externalSubscriptionVerified ? { externalSubscriptionVerified } : {}),
        ...(spawnDefaults.auth.apiKeyCredential !== undefined
          ? { apiKeyConfigCredential: spawnDefaults.auth.apiKeyCredential }
          : {}),
        ...(apiKeyStoreCredential !== undefined ? { apiKeyStoreCredential } : {}),
      })
      if (result) {
        authSpec = result.spec
        authEcho = result.echo
      }
    } catch (err) {
      if (err instanceof AuthResolutionError) {
        return {
          ok: false,
          code: "unsupported_auth_mode",
          message: `agent_start: ${err.message}`,
          details: { adapter: input.adapter, provider: resolvedProvider },
        }
      }
      throw err
    }
    // Money-safety spawn guard (SPEC §1c): now that the provider is resolved,
    // verify the requested MODEL is actually serviceable on the resolved
    // wallet. The auth-MODE path above validates only provider→mode support —
    // it never checks that the wallet can bill THIS model, so a gateway/router
    // model (e.g. `deepseek/deepseek-v4-pro`, which bills `openrouter`) spawned
    // with NO `route.gateway` resolves to claude-code's FIXED `anthropic`
    // wallet and 404s upstream with a confusing "model may not exist".
    //
    // Deliberately scoped to the UNNAMED-wallet case (`route.gateway`
    // undefined): an explicit `route.gateway` is the operator NAMING a wallet
    // — a deliberate billing choice this guard must not second-guess (routing
    // any model through any gateway's base_url + api-key is legitimate, e.g.
    // `claude-sonnet-5` via `moonshot`). The bug is exactly the silent fall-
    // through to the fixed provider when no wallet was named. FAIL LOUD when
    // the model bills a route that provider can't service; NEVER auto-switch to
    // an eligible wallet the operator didn't name. Reusing the catalog's own
    // route-resolution keeps this from re-deriving a parallel per-model table.
    if (
      input.route?.gateway === undefined &&
      authModel !== undefined &&
      resolvedProvider !== undefined &&
      !resolved.authDescriptor?.modelDerivedApiKey
    ) {
      const verdict = checkModelWalletEligibility(authModel, resolvedProvider)
      if (!verdict.ok) {
        return {
          ok: false,
          code: "model_wallet_ineligible",
          message: modelWalletIneligibleMessage({
            prefix: "agent_start",
            adapter: input.adapter,
            model: authModel,
            walletRoute: resolvedProvider,
            ...(authSpec?.mode ? { walletMode: authSpec.mode } : {}),
            suggestedRoutes: verdict.suggestedRoutes,
          }),
          details: {
            adapter: input.adapter,
            model: authModel,
            walletRoute: resolvedProvider,
            suggestedRoutes: verdict.suggestedRoutes,
          },
        }
      }
    }
    // Adapter-capability spawn guard: the money-safety guard above proves the
    // resolved ROUTE can bill this model; it says nothing about whether THIS
    // adapter's manifest can actually reach it there. The bug this exists for:
    // claude-code is routeSelection:"free" (genuinely able to reach several
    // gateways) but only hand-curates a SMALL vetted model list per gateway —
    // its ACP wrapper validates every model id against its own live selector
    // and rejects anything it doesn't recognize. A gateway model outside that
    // list (e.g. a Mastra-style `openrouter/deepseek/deepseek-v4-flash-0731`
    // id, never added to claude-code's `models.allowed`) resolves the route
    // fine (openrouter genuinely bills it) and STILL 404s upstream. Same scope
    // as the wallet guard immediately above and for the same reason: an
    // explicit `route.gateway` is the operator deliberately naming a gateway
    // to route an arbitrary model through via `base_url` + api-key (e.g.
    // `claude-sonnet-5` via `moonshot`) — this guard must not second-guess
    // that. Optional dep: a host that hasn't wired `listCatalogModels` (e.g.
    // `catalog_models` itself is disabled) gets no adapter-capability
    // protection, same as before this guard existed, rather than a hard
    // failure.
    if (
      input.route?.gateway === undefined &&
      authModel !== undefined &&
      resolvedProvider !== undefined &&
      !resolved.authDescriptor?.modelDerivedApiKey &&
      listCatalogModels
    ) {
      const catalog = await listCatalogModels({})
      const verdict = checkModelAdapterEligibility(
        catalog,
        input.adapter,
        authModel,
        resolvedProvider,
      )
      if (!verdict.ok) {
        return {
          ok: false,
          code: "model_adapter_incompatible",
          message: modelAdapterIncompatibleMessage({
            prefix: "agent_start",
            adapter: input.adapter,
            model: authModel,
            route: resolvedProvider,
            compatibleAdapters: verdict.compatibleAdapters,
          }),
          details: {
            adapter: input.adapter,
            model: authModel,
            route: resolvedProvider,
            compatibleAdapters: verdict.compatibleAdapters,
          },
        }
      }
    }
    // Non-authenticating hint for the driver's fail-fast message — NEVER fed
    // back into resolution. Only checked when the spec is about to hard-fail
    // (enforce "always", no credential) AND auth wasn't explicit — i.e. the
    // store was never consulted for real above (the #321 gate). An operator
    // who already ran `agentproto auth provider set` deserves to be told
    // their key is sitting there unused, not pointed at a subscription they
    // don't have.
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
  // The descriptor's `route` — the caller's explicit override, falling back
  // to the by-model router echo above so a live gateway resolution is never
  // silently dropped on the floor (see `resolvedRouteGateway`'s docblock).
  const descriptorRoute: RouteSpec | undefined =
    input.route ?? (resolvedRouteGateway ? { gateway: resolvedRouteGateway } : undefined)
  let launchConfig: RouteAwareLaunchConfig
  try {
    launchConfig = buildRouteAwareLaunchConfig({
      adapter: input.adapter,
      model: input.model,
      route: input.route,
      authSpec,
      options: spawnDefaults.options,
      declaredOptions: resolved?.declaredOptions,
      routeSelection: resolved?.routeSelection,
      adapterProvider: resolved?.authDescriptor?.provider,
      skills: spawnDefaults.skills,
      prefix: "agent_start",
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const gateway = input.route?.gateway
    return {
      ok: false,
      code: "gateway_base_url_unsupported",
      message,
      details: { adapter: input.adapter, gateway },
    }
  }
  // Compose the role's disposition (+ optional promptAppend, layered on
  // top, never replacing it) into the initial prompt — the only text
  // channel this codebase has into a freshly-spawned child (there's no
  // separate system-prompt field on `startSession`). No `prompt` at all
  // ⇒ nothing to compose onto; the child still gets the tool gate above,
  // it just doesn't see the disposition until its first turn.
  //
  // A child with a recorded parent also gets one lineage line: without it
  // the child has no way to KNOW it was spawned by another session (the
  // env var alone is invisible to harnesses that don't surface env), and
  // the report-back channel goes unused.
  const parentContextLine = parentSessionId
    ? `You were spawned by session ${parentSessionId} (also available in the ` +
      `${PARENT_SESSION_ID_ENV} env var). When you finish — or hit a blocker ` +
      `you cannot resolve — report back to it via the message_parent tool if ` +
      `one is available (no session id needed; the daemon resolves your parent).`
    : undefined
  let effectivePrompt = input.prompt
    ? [composeRoleContext(role, input.promptAppend, roleRegistry), parentContextLine, input.prompt]
        .filter((p): p is string => !!p)
        .join("\n\n")
    : input.prompt
  // The session's title must name the CALLER's ask, not whatever text
  // happens to be first in the composed prompt above. `deriveSessionTitle`
  // just takes the first sentence of what it's given — and the composed
  // prompt's first sentence is the role's disposition (e.g. executor's
  // "You are the leaf…"), not `input.prompt`. Derive from `input.prompt`
  // ITSELF, before role/promptAppend composition, so every future prepended
  // block (a skill header, a memory dump, another role field) can't
  // re-introduce this bug by ending up ahead of the caller's actual ask.
  // Precedence for the raw `title` slot at spawn:
  //   1. an explicit `--title` (FIX C) — the caller named it outright.
  //   2. else the spawn `label` — for orchestrator/agent spawns the prompt is
  //      boilerplate ("You are the leaf…", "You are a SUPERVISOR…") that
  //      derives to a useless title, while the `label` carries the real
  //      intent. A label is ALREADY a title, so it's used verbatim — NOT run
  //      through `deriveSessionTitle` (no sentence-splitting/truncation): it's
  //      not prose to summarise. This aligns the stored title with the display
  //      chain (`sessionDisplayName`), which already prefers the label.
  //   3. else the first-sentence derivation from `input.prompt`.
  // A trimmed-empty title/label is treated as "not supplied" so it falls
  // through to the next tier rather than stamping a blank.
  const explicitTitle = input.title?.trim() ? input.title.trim() : undefined
  const spawnLabel = input.label?.trim() ? input.label.trim() : undefined
  const initialTitle =
    explicitTitle ?? spawnLabel ?? (input.prompt ? deriveSessionTitle(input.prompt) : undefined)

  // ── retry-safety claim (see SpawnClaim docblock above) ────────────
  // Two independent doors into the SAME claim map. An EXPLICIT
  // `idempotencyKey` is a caller PROMISE ("these are the same logical
  // spawn") and always wins outright when present. A DERIVED implicit key
  // — built by `deriveImplicitIdempotencyKey` from `label` + a hash of
  // `prompt`, see `spawn-dedupe.ts` for the false-dedup analysis — is only
  // a GUESS, and is attempted ONLY when the caller supplied no explicit
  // key, didn't opt out (`dedupe: false`), and the resolved `spawn.dedupe`
  // policy (or a per-call `dedupe: true` override) says to derive one. No
  // `label` ⇒ nothing to derive ⇒ this spawn is untouched either way,
  // identical to pre-dedupe-default behaviour — the fan-out safety net.
  let settleClaim: ((result: SpawnAgentSessionResult) => void) | undefined
  let claimKey = input.idempotencyKey
  let dedupeSource: "explicit" | "implicit" | undefined = claimKey ? "explicit" : undefined
  if (!claimKey && input.dedupe !== false) {
    const dedupeMode = resolveSpawnDedupe ? await resolveSpawnDedupe() : await loadSpawnDedupe()
    if (dedupeMode === "always" || input.dedupe === true) {
      const implicitKey = deriveImplicitIdempotencyKey({ label: input.label, prompt: input.prompt })
      if (implicitKey) {
        claimKey = implicitKey
        dedupeSource = "implicit"
      }
    }
  }
  if (claimKey) {
    const claims = claimsFor(registry)
    const key = `${input.adapter}\x1f${cwd}\x1f${claimKey}`
    gcSpawnClaims(claims, Date.now())
    const existing = claims.get(key)
    if (existing) {
      const result = await existing.result
      return result.ok ? { ...result, deduped: true, dedupeSource } : result
    }
    let resolveClaim!: (result: SpawnAgentSessionResult) => void
    claims.set(key, {
      result: new Promise(resolve => { resolveClaim = resolve }),
      // An implicit claim expires sooner than an explicit one — see
      // `IMPLICIT_SPAWN_CLAIM_WINDOW_MS`'s docblock.
      ...(dedupeSource === "implicit" ? { windowMs: IMPLICIT_SPAWN_CLAIM_WINDOW_MS } : {}),
    })
    settleClaim = result => {
      if (result.ok) {
        const claim = claims.get(key)
        if (claim) claim.resolvedAt = Date.now()
      } else {
        claims.delete(key)
      }
      resolveClaim(result)
    }
  }
  const finish = (result: SpawnAgentSessionResult): SpawnAgentSessionResult => {
    settleClaim?.(result)
    return result
  }
  try {
    // Independent of cwd/the worktree — safe to resolve before either the
    // async or the synchronous provisioning branch below needs it.
    const resolvedMcpServers = await resolveMcpCredentialHeaders(mcpServers)
    // ── Async worktree provisioning ──────────────────────────────────
    // WP-F: `git worktree add` + the repo's `agentproto.json` setup hooks
    // can run minutes, and every prior guard (PR #803's claim window, #805's
    // implicit dedup) only treats the RETRY that provokes — this treats the
    // wait. Opt-in only (`worktree: { async: true }` — see
    // `WorktreeRequest.async`'s doc for why default stays synchronous):
    // register a real, stable session NOW (status "starting"), settle the
    // retry-safety claim with THIS early result so a caller retry arriving
    // mid-provision dedupes against this row instead of forking a second
    // `git worktree add`, then finish provisioning + the driver spawn in the
    // background. `registry.settlePendingAgent` is the only thing allowed to
    // move status off "starting" — on success it flips to "running" and
    // fires the deferred initial prompt (never dispatched into a tree that
    // isn't built yet); on failure it flips to "error" with a readable
    // `lastError` so a spawn that can never run ends VISIBLY instead of
    // sitting in "starting" forever.
    if (worktreeRequest?.async && provisionWorktree) {
      const defaultModel = resolved?.defaultModel
      const pendingDesc = registry.spawnAgentPending({
        id: mintedSessionId,
        workspaceSlug: resolvedSlug,
        cwd,
        adapterSlug: input.adapter,
        adapterConfigDir: adapterConfigDirFor(mintedSessionId),
        harness: input.harness ?? input.adapter,
        ...(resolved?.routeSelection !== undefined
          ? { routeSelection: resolved.routeSelection }
          : {}),
        ...(resolved?.authDescriptor?.provider !== undefined
          ? { adapterProvider: resolved.authDescriptor.provider }
          : {}),
        ...(input.model ? { model: input.model } : defaultModel ? { model: defaultModel } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.effort ? { effort: input.effort as EffortLevel } : {}),
        ...(input.posture !== undefined ? { posture: input.posture } : {}),
        ...(descriptorRoute ? { route: descriptorRoute } : {}),
        ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
        ...(accessProfileEcho ? { accessProfile: accessProfileEcho } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(initialTitle ? { title: initialTitle } : {}),
        ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(input.notifyParentOnCrash ? { notifyParentOnCrash: true } : {}),
        ...(input.boardId ? { meta: { boardId: input.boardId } } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        depth: recordedDepth,
        ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
        ...(input.costBudget !== undefined ? { costBudget: input.costBudget } : {}),
        contextContinuity: resolvedContextContinuity,
        ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
        ...(input.trace !== undefined ? { trace: input.trace } : {}),
        ...(authEcho?.fingerprint
          ? {
              auth: {
                mode: authEcho.authMode,
                fingerprint: authEcho.fingerprint,
                provider: authEcho.provider,
                credentialSource: authEcho.credentialSource,
                setEnv: authEcho.setEnv,
              },
            }
          : {}),
        ...(input.permissionHold ? { permissionHold: true } : {}),
        ...(input.keepAlive ? { keepAlive: true } : {}),
      })
      // Anything from here to the early return must never throw past this
      // point without settling the row it just registered — otherwise the
      // outer catch below would report `agent_spawn_failed` to the ORIGINAL
      // caller while leaving an orphaned "starting" placeholder no one will
      // ever resolve.
      try {
        bindOrchestratorLifecycle?.(pendingDesc.id)
        if (input.notifyUrl && webhookNotifier) {
          webhookNotifier.register(pendingDesc.id, input.notifyUrl)
        }
      } catch (err) {
        registry.settlePendingAgent(pendingDesc.id, {
          ok: false,
          message: `agent_start: spawn failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
        throw err
      }
      const earlyResult = finish({
        ok: true,
        descriptor: pendingDesc,
        ...(spawnWarnings.length ? { warnings: spawnWarnings } : {}),
      })
      const baseCwd = cwd
      void (async () => {
        let outcome: Awaited<ReturnType<WorktreeProvisioner>>
        try {
          outcome = await provisionWorktree({
            cwd: baseCwd,
            ...(worktreeRequest.slug ? { slug: worktreeRequest.slug } : {}),
            ...(worktreeRequest.base ? { base: worktreeRequest.base } : {}),
            ...(input.label ? { labelHint: input.label } : {}),
          })
        } catch (err) {
          registry.settlePendingAgent(pendingDesc.id, {
            ok: false,
            message: `agent_start: worktree provisioning failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
          return
        }
        const finalCwd = outcome.isolated ? outcome.cwd : baseCwd
        try {
          const agentSession = await resolved!.startSession({
            cwd: finalCwd,
            ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
            // Persistent isolated-config dir, keyed by this session's id —
            // recorded on the pending descriptor above so restart/lazy-resume
            // can hand the respawned adapter the same dir (native-resume
            // store). Adapters that don't isolate a config dir ignore it.
            configDir: adapterConfigDirFor(mintedSessionId),
            ...(input.mode ? { mode: input.mode } : {}),
            ...(launchConfig.options ? { options: launchConfig.options } : {}),
            ...(launchConfig.wireModel ? { model: launchConfig.wireModel } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.posture !== undefined ? { posture: input.posture } : {}),
            ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
            ...(authSpec ? { auth: authSpec } : {}),
            ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
            ...(input.permissionHold ? { permissionHold: true } : {}),
            ...(input.commandSandbox ? { commandSandbox: input.commandSandbox } : {}),
            onActivity: () => registry.pulseActivity(pendingDesc.id),
          })
          let asyncPrompt = effectivePrompt
          if (input.posture !== undefined) {
            const resolution = resolvePosture(input.posture, agentSession.availableModes ?? [])
            if (resolution.kind === "native" && agentSession.setSessionMode) {
              await agentSession.setSessionMode(resolution.mode.id)
            } else if (resolution.kind === "prompt" && asyncPrompt) {
              asyncPrompt = `${resolution.preamble}\n\n${asyncPrompt}`
            }
          }
          const commandPreview = resolved!.commandPreview
          const readUsage = resolved!.readUsage
            ? () => resolved!.readUsage!(agentSession.sessionId)
            : undefined
          // Best-effort duplicate-live-session advisory — see the sync
          // path's "no-key backstop" for the full rationale. Console-only:
          // the caller already got its (early) response, so there is no
          // `warnings` array left to attach this to.
          if (pendingDesc.label) {
            const dupe = registry
              .list()
              .find(
                s =>
                  s.id !== pendingDesc.id &&
                  s.label === pendingDesc.label &&
                  s.cwd === finalCwd &&
                  (s.status === "running" || s.status === "starting"),
              )
            if (dupe) {
              console.warn(
                `[agent_start] another LIVE session ("${dupe.id}") already has the same ` +
                  `label ("${pendingDesc.label}") and cwd ("${finalCwd}") as this one. If ` +
                  "this is a retried spawn rather than a deliberate parallel run, both are " +
                  "now editing the same working directory concurrently — check before proceeding.",
              )
            }
          }
          registry.settlePendingAgent(pendingDesc.id, {
            ok: true,
            agentSession,
            cwd: finalCwd,
            ...(commandPreview ? { commandPreview } : {}),
            ...(resolved?.resumable !== undefined ? { resumable: resolved.resumable } : {}),
            ...(resolved?.nativeTerminalResume !== undefined
              ? { nativeTerminalResume: resolved.nativeTerminalResume }
              : {}),
            ...(readUsage ? { readUsage } : {}),
            ...(asyncPrompt ? { initialPrompt: asyncPrompt } : {}),
            ...(asyncPrompt ? { initialPromptSystem: composedPreamble(asyncPrompt, input.prompt) } : {}),
          })
        } catch (err) {
          registry.settlePendingAgent(pendingDesc.id, {
            ok: false,
            message: `agent_start: spawn failed — ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
        }
      })()
      return earlyResult
    }
    // ── Worktree provisioning (side-effecting half) ─────────────────
    // Runs AFTER the idempotency dedup above (a deduped retry returned
    // early, so it never reaches here — one logical spawn ⇒ at most one
    // worktree). Reassigns `cwd` to the freshly-created worktree so every
    // downstream step — `startSession`, `registry.spawnAgent`, and the
    // descriptor's own `worktreeFields(cwd)` edge — sees the worktree as the
    // session's ground with no extra bookkeeping. `isolated: false` means
    // `cwd` sits in no git repo (nothing to isolate) ⇒ spawn plain, unchanged.
    if (worktreeRequest && provisionWorktree) {
      let outcome: Awaited<ReturnType<WorktreeProvisioner>>
      try {
        outcome = await provisionWorktree({
          cwd,
          ...(worktreeRequest.slug ? { slug: worktreeRequest.slug } : {}),
          ...(worktreeRequest.base ? { base: worktreeRequest.base } : {}),
          ...(input.label ? { labelHint: input.label } : {}),
        })
      } catch (err) {
        return finish({
          ok: false,
          code: "worktree_provision_failed",
          message: `agent_start: worktree provisioning failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
      }
      if (outcome.isolated) cwd = outcome.cwd
    }
    // The registry doesn't assign a session id until `spawnAgent`
    // returns below, but `onActivity` can start firing as soon as
    // `startSession` connects — this box lets the closure defer
    // pulsing until the id is known, dropping any pre-spawn activity.
    let liveSessionId: string | undefined

    let agentSession: AgentSessionLike
    let commandPreview: string | undefined
    let readUsage: (() => Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null>) | undefined
    let sandboxId: string | undefined
    let sandboxTeardown: SandboxLifecyclePolicy["teardown"] | undefined

    if (input.sandbox !== undefined) {
      const booted = await bootSandboxAgentSession({
        sandbox: input.sandbox,
        resolveSandboxProvider,
        adapter: input.adapter,
        // The host's own resolved `cwd` — valid as-is for a same-machine
        // provider (`local`); a genuinely remote box (e2b) needs its own
        // filesystem story (AIP-36 `mounts`, out of scope here — see the
        // plan's "local MCP servers unreachable from sandbox" risk, which
        // applies equally to bare filesystem paths). Forwarding it is
        // still strictly better than omitting it: the box's OWN
        // `agent_start` needs SOME cwd to resolve, and a bad path fails
        // no worse than no path at all.
        cwd,
        ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.label ? { label: input.label } : {}),
        // A fresh box has neither the host's named profiles nor its keychain.
        // Forward the already-resolved credential when the caller selected a
        // profile; raw explicit auth remains supported for existing callers.
        ...(authSpec ? { auth: sandboxAuthFromResolved(authSpec) } : input.auth ? { auth: input.auth } : {}),
        ...(descriptorRoute ? { route: descriptorRoute } : {}),
      })
      if (!booted.ok) return booted
      agentSession = booted.agentSession
      commandPreview = booted.commandPreview
      sandboxId = booted.sandboxId
      sandboxTeardown = booted.sandboxTeardown
    } else {
      // `resolved` is guaranteed non-null here — the `input.sandbox ===
      // undefined` branch above already returned `adapter_not_found`
      // otherwise.
      //
      // Opt-in `gh` provenance shim (provenance.wrapGh): when enabled, prepend
      // a shim dir to this session's PATH so any `gh pr create` it — or an
      // adapter subprocess shelling out — runs gets the daemon's provenance
      // footer stamped onto the created PR's body (see `gh-provenance-shim.ts`).
      // Off by default; only the local (non-sandbox) branch — a sandbox spawn
      // runs on the box's own daemon, which owns its own provenance.
      let ghProvenanceEnv: Record<string, string> = {}
      try {
        const wrapGh = await (resolveProvenanceWrapGh ?? loadProvenanceWrapGh)()
        if (wrapGh) {
          const shimDir = await ensureGhShimDir()
          ghProvenanceEnv = buildGhShimEnv({
            shimDir,
            basePath: process.env.PATH ?? "",
            adapter: input.harness ?? input.adapter,
            ...(input.model ?? resolved?.defaultModel
              ? { model: input.model ?? resolved?.defaultModel }
              : {}),
          })
        }
      } catch {
        // Stamping is cosmetic — a shim-preparation failure must never block a
        // spawn. Fall through with no PATH shim (unchanged behaviour).
        ghProvenanceEnv = {}
      }
      agentSession = await resolved!.startSession({
        cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        // Persistent isolated-config dir, keyed by this session's id —
        // recorded on the descriptor below so restart/lazy-resume can hand
        // the respawned adapter the same dir (native-resume store).
        // Adapters that don't isolate a config dir ignore it.
        configDir: adapterConfigDirFor(mintedSessionId),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(launchConfig.options ? { options: launchConfig.options } : {}),
        ...(launchConfig.wireModel ? { model: launchConfig.wireModel } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.posture !== undefined ? { posture: input.posture } : {}),
        ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
        ...(authSpec ? { auth: authSpec } : {}),
        ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
        ...(input.permissionHold ? { permissionHold: true } : {}),
        ...(input.commandSandbox ? { commandSandbox: input.commandSandbox } : {}),
        // Session identity (SESSION_ID_ENV's doc, sessions.ts) — minted
        // above as `mintedSessionId` (not left to `spawnAgent`'s own
        // default) specifically so it's known here, before the child ever
        // exec's. `agent_start` has no caller-facing `env` passthrough to
        // collide with, so this is the entire env for this spawn.
        env: {
          // Provenance shim env FIRST (PATH + adapter/model) so the identity
          // vars below always win — they must never be forgeable or shadowed,
          // and `ghProvenanceEnv` never carries an identity var anyway.
          ...ghProvenanceEnv,
          [SESSION_ID_ENV]: mintedSessionId,
          [WORKSPACE_SLUG_ENV]: resolvedSlug,
          // Lineage (PARENT_SESSION_ID_ENV's doc, sessions.ts) — mirrors
          // the descriptor's `parentSessionId` so the child can discover
          // who spawned it without a registry round-trip. Absent on a
          // parentless root spawn.
          ...(parentSessionId ? { [PARENT_SESSION_ID_ENV]: parentSessionId } : {}),
        },
        onActivity: () => {
          if (liveSessionId) registry.pulseActivity(liveSessionId)
        },
      })
      // A harness that advertises a matching ACP mode gets the canonical
      // posture as a real boundary before the initial prompt is sent. When no
      // native mode exists, the initial prompt carries the advisory preamble;
      // with no initial prompt there is no system-prompt channel to inject.
      if (input.posture !== undefined) {
        const resolution = resolvePosture(
          input.posture,
          agentSession.availableModes ?? [],
        )
        if (resolution.kind === "native" && agentSession.setSessionMode) {
          await agentSession.setSessionMode(resolution.mode.id)
        } else if (resolution.kind === "prompt" && effectivePrompt) {
          effectivePrompt = `${resolution.preamble}\n\n${effectivePrompt}`
        }
      }
      commandPreview = resolved!.commandPreview
      if (resolved!.readUsage) {
        const startedSession = agentSession
        readUsage = () => resolved!.readUsage!(startedSession.sessionId)
      }
    }

    const defaultModel = resolved?.defaultModel
    // The daemon-composed part of the initial prompt (role disposition +
    // lineage line + AGENTS.md + posture) sits AHEAD of the caller's own
    // `prompt`. Recover it now that `effectivePrompt` is final so it can be
    // recorded as a SYSTEM turn on the daemon's event stream (see
    // `composedPreamble`) — the adapter still receives the single
    // concatenated `effectivePrompt`, unchanged.
    const initialSystemPrompt = composedPreamble(effectivePrompt, input.prompt)
    const desc = registry.spawnAgent({
      id: mintedSessionId,
      workspaceSlug: resolvedSlug,
      cwd,
      agentSession,
      adapterSlug: input.adapter,
      adapterConfigDir: adapterConfigDirFor(mintedSessionId),
      ...(resolved?.resumable !== undefined ? { resumable: resolved.resumable } : {}),
      ...(resolved?.nativeTerminalResume !== undefined
        ? { nativeTerminalResume: resolved.nativeTerminalResume }
        : {}),
      harness: input.harness ?? input.adapter,
      ...(resolved?.routeSelection !== undefined
        ? { routeSelection: resolved.routeSelection }
        : {}),
      ...(resolved?.authDescriptor?.provider !== undefined
        ? { adapterProvider: resolved.authDescriptor.provider }
        : {}),
      ...(input.model ? { model: input.model } : defaultModel ? { model: defaultModel } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.effort ? { effort: input.effort as EffortLevel } : {}),
      ...(input.posture !== undefined ? { posture: input.posture } : {}),
      ...(descriptorRoute ? { route: descriptorRoute } : {}),
      ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
      ...(accessProfileEcho ? { accessProfile: accessProfileEcho } : {}),
      ...(input.wait && effectivePrompt ? {} : effectivePrompt ? { initialPrompt: effectivePrompt } : {}),
      ...(initialSystemPrompt ? { initialPromptSystem: initialSystemPrompt } : {}),
      ...(input.label ? { label: input.label } : {}),
      // Hand the caller-derived title to `spawnAgent` so it lands on the
      // descriptor BEFORE the `initialPrompt` (the ROLE-PREFIXED composed
      // prompt) is dispatched — otherwise `runAgentTurn`'s self-heal derives
      // the title from that composition's first sentence (the role
      // disposition) instead of the caller's ask. The overwrite below stays
      // as a belt-and-braces for the `wait` path (which sends the prompt
      // itself, not via `initialPrompt`).
      ...(initialTitle ? { title: initialTitle } : {}),
      ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
      // Parent attribution + depth. Set for spawns that arrived via the
      // scoped sub-gateway (WP4, parent from token) OR carry a trusted-loopback
      // `parentSessionId` lineage hint on the anonymous root path (WP-R1). A
      // plain root spawn with no hint stays parentless at depth 0. `depth` is
      // the scope-derived depth for a scoped spawn, else the hint parent's
      // `depth + 1` — see `recordedDepth`.
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(input.notifyParentOnCrash ? { notifyParentOnCrash: true } : {}),
      // Explicit board pin (`agent_start.boardId`) → `meta.boardId` on the
      // descriptor — the task ledger's board resolution reads it BEFORE the
      // lineage walk (see `resolveBoardId` in task-ledger.ts). Rides the
      // generic `meta` hint map so future spawn-time hints need no new field.
      ...(input.boardId ? { meta: { boardId: input.boardId } } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      depth: recordedDepth,
      ...(commandPreview ? { commandPreview } : {}),
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
      ...(input.costBudget !== undefined ? { costBudget: input.costBudget } : {}),
      contextContinuity: resolvedContextContinuity,
      ...(input.restartPolicy ? { restartPolicy: input.restartPolicy } : {}),
      ...(readUsage ? { readUsage } : {}),
      ...(input.trace !== undefined ? { trace: input.trace } : {}),
      // Verifiability: record the OBSERVABLE echo — resolved provider, mode,
      // credential source, the env var actually set, and a non-secret
      // fingerprint (never the credential). DECISION 9③/10②. Recorded only
      // when a credential actually resolved (fingerprint present); a
      // configured-but-missing-credential spawn fails fast in the driver
      // before a descriptor exists. Absent for sandbox spawns (the box
      // resolves its own credential, so a host-side echo would misrepresent
      // it — `authEcho` is already left undefined for those above).
      ...(authEcho?.fingerprint
        ? {
            auth: {
              mode: authEcho.authMode,
              fingerprint: authEcho.fingerprint,
              provider: authEcho.provider,
              credentialSource: authEcho.credentialSource,
              setEnv: authEcho.setEnv,
            },
          }
        : {}),
      ...(sandboxId ? { remote: true, sandboxId } : {}),
      ...(sandboxTeardown ? { sandboxTeardown } : {}),
      // Hold mode is a local-driver capability; a sandbox spawn proxies to the
      // box's own daemon, which handles permissions there.
      ...(input.permissionHold && input.sandbox === undefined ? { permissionHold: true } : {}),
      ...(input.keepAlive ? { keepAlive: true } : {}),
    })
    // Stamp the title from the caller's ask BEFORE anything else can name
    // this session from the composed prompt instead: `spawnAgent` above,
    // when `initialPrompt` was passed, already ran the first turn's
    // synchronous prelude (including `sessions.ts`'s own `if (!title)`
    // derivation) before returning — so without this, the composed
    // prompt's disposition text would already have claimed the title by
    // the time control gets here. Assigning unconditionally overwrites
    // that; assigning here (rather than relying on the `wait`-mode
    // `sendPrompt` below) also covers the non-`wait` path, which never
    // calls `sendPrompt` at all.
    if (initialTitle) desc.title = initialTitle
    liveSessionId = desc.id
    // No-key backstop for the same incident `idempotencyKey` guards: every
    // duplicate pair observed in production shared BOTH `label` AND `cwd`,
    // and both members were still alive when found. This needs no caller
    // opt-in (unlike the claim above) because it isn't trying to PREVENT the
    // second spawn — deliberate parallel spawns into one cwd are a real,
    // exercised pattern (see the `idempotencyKey` docblock) and refusing
    // them would break that. It just tells the operator, at spawn time
    // instead of twenty minutes later, that they now have two live sessions
    // that look like the same intent in the same place.
    //
    // Requires a shared `label`, not `cwd` alone: an unlabelled fan-out
    // (parallel workflow agents sharing one worktree, no label set) is
    // routine here and would make a cwd-only warning fire on essentially
    // every multi-agent worktree run, training operators to ignore it. A
    // shared label is the actual signal — it means the SAME declared intent
    // landed twice in the SAME place, which is what happened in the
    // incident and what deliberate fan-out (distinct labels, or no label at
    // all) doesn't look like.
    //
    // WP-E note: under the default `spawn.dedupe: "always"` policy this
    // branch mostly goes quiet for its own original incident shape — a
    // same-label/cwd/prompt repeat with no explicit `idempotencyKey` is now
    // usually caught (and DEDUPED, not merely warned about) by the implicit-
    // key claim above, which returns before a second `registry.spawnAgent`
    // is ever reached. This check still fires for the cases dedup doesn't
    // cover: a different `prompt` under the same label (implicit key
    // legitimately differs, so both spawn — and a human may still want to
    // know), `spawn.dedupe: "on-request"` with no per-call opt-in, or a
    // caller that set `dedupe: false`.
    if (desc.label && desc.cwd) {
      const dupe = registry
        .list()
        .find(
          s =>
            s.id !== desc.id &&
            s.label === desc.label &&
            s.cwd === desc.cwd &&
            (s.status === "running" || s.status === "starting"),
        )
      if (dupe) {
        const warn =
          `agent_start: another LIVE session ("${dupe.id}") already has the same ` +
          `label ("${desc.label}") and cwd ("${desc.cwd}") as this one. If this is a ` +
          `retried spawn rather than a deliberate parallel run, both are now editing ` +
          `the same working directory concurrently — check before proceeding.`
        spawnWarnings.push(warn)
        console.warn(`[agent_start] ${warn}`)
      }
    }
    // Bind the scope-token's lifetime to the child session — once
    // it exits, the token is revoked so it can't outlive its child.
    bindOrchestratorLifecycle?.(desc.id)
    // Per-session webhook: register if notifyUrl was supplied and
    // the notifier is wired. Unregistered on session:exited by the
    // gateway's session-event bus handler.
    if (input.notifyUrl && webhookNotifier) {
      webhookNotifier.register(desc.id, input.notifyUrl)
    }
    // wait mode: block until the first turn completes, then return
    // the descriptor with cleaned output appended.
    if (input.wait && effectivePrompt) {
      await registry.sendPrompt(desc.id, effectivePrompt, {
        ...(initialSystemPrompt ? { system: initialSystemPrompt } : {}),
      })
      const waitLines: string[] = []
      const waitUnsub = registry.attach(desc.id, (line: string) => {
        waitLines.push(line)
      })
      if (waitUnsub) waitUnsub()
      const waitTail = waitLines.slice(-80)
      const output = cleanAgentLines(waitTail)
      return finish({
        ok: true,
        descriptor: desc,
        output,
        ...(spawnWarnings.length ? { warnings: spawnWarnings } : {}),
      })
    }
    return finish({
      ok: true,
      descriptor: desc,
      ...(spawnWarnings.length ? { warnings: spawnWarnings } : {}),
    })
  } catch (err) {
    return finish({
      ok: false,
      code: "agent_spawn_failed",
      message: `agent_start: spawn failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    })
  }
}

/**
 * Impure signal for `decideWorktreeIsolation`: is `cwd` a SHARED, DIRTY
 * working tree the spawn would edit in place? True only when the tree has
 * uncommitted changes AND is not a daemon-provisioned worktree (which is
 * isolated by construction — its whole point is that the child edits it).
 *
 * Robust by design: a `cwd` outside any git repo, or a `git` that isn't on
 * PATH / errors, yields `false` (nothing to warn about) rather than throwing —
 * the warning is advisory, never a spawn blocker. Untracked files count as
 * dirty (bare `status --porcelain` reports them), matching the intuition that
 * a checkout with new untracked work is "in use".
 */
async function isSharedDirtyCwd(cwd: string): Promise<boolean> {
  // A daemon-provisioned worktree (carries a provision marker ⇒ `worktreeId`)
  // is isolated ground the child is meant to own — never "shared". A bare
  // `git worktree add` tree has no marker, so it (like the primary checkout)
  // is treated as shared. Sync, filesystem-only — no subprocess.
  const identity = resolveWorktreeIdentity(cwd)
  if (identity?.worktreeId !== undefined) return false
  const { spawn } = await import("node:child_process")
  return await new Promise<boolean>(resolve => {
    let stdout = ""
    let settled = false
    const done = (v: boolean) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    const child = spawn("git", ["-C", cwd, "status", "--porcelain"], {
      shell: false,
    })
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    // git missing / cwd not a repo (spawn error or non-zero exit) ⇒ not a
    // shared dirty tree we can warn about; stay quiet.
    child.on("error", () => done(false))
    child.on("close", code => done(code === 0 && stdout.trim().length > 0))
  })
}

/**
 * Resolve brokered auth headers for any `mcpServers` entry that names a
 * `credentialRef`. The returned headers are merged ON TOP of the entry's
 * static `headers` (brokered wins on collision). Hook errors are non-fatal:
 * the entry is left unchanged and a warning is logged. Entries without a
 * `credentialRef` pass through untouched.
 */
async function resolveMcpCredentialHeaders(
  mcpServers: AcpMcpServer[] | undefined,
): Promise<AcpMcpServer[] | undefined> {
  if (!mcpServers || mcpServers.length === 0) return mcpServers

  const { resolveMcpCredentialHeaders: resolve } = getMcpCredentialDeps()
  if (!resolve) return mcpServers

  return Promise.all(
    mcpServers.map(async (entry) => {
      const ref = entry.credentialRef
      if (!ref) return entry

      let brokered: Record<string, string> | undefined
      try {
        brokered = await resolve({ credentialRef: ref })
      } catch (err) {
        console.warn(
          `[agent_start] credentialRef resolution failed for "${entry.name}" ` +
            `(${ref}): ${err instanceof Error ? err.message : String(err)}`,
        )
        return entry
      }

      if (!brokered || Object.keys(brokered).length === 0) return entry

      return {
        ...entry,
        headers: { ...entry.headers, ...brokered },
      }
    }),
  )
}

type SandboxBootResult =
  | {
      ok: true
      agentSession: AgentSessionLike
      commandPreview: string
      sandboxId: string
      sandboxTeardown: SandboxLifecyclePolicy["teardown"]
    }
  | {
      ok: false
      code: "sandbox_provider_not_found" | "sandbox_boot_failed" | "sandbox_reconnect_failed" | "sandbox_proxy_failed"
      message: string
    }

/**
 * Rebuild `mcpServers` entries as the box daemon's own `agent_start` expects
 * them (`StartAgentArgs.mcpServers: McpServerMount[]`). A plain field-by-
 * field object literal (rather than forwarding `AcpMcpServer` values as-is)
 * because `McpServerMount` carries an index signature `AcpMcpServer` lacks —
 * and deliberately drops `credentialRef`: by the time a spawn reaches here,
 * `resolveMcpCredentialHeaders` has already resolved it into `headers` on
 * the HOST side, so the box would only re-attempt (and fail/warn on) a
 * broker it doesn't have.
 */
function toMcpServerMounts(entries: readonly AcpMcpServer[]): Array<{
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
  headers?: Record<string, string>
}> {
  return entries.map(e => ({
    name: e.name,
    transport: e.transport,
    ...(e.ref !== undefined ? { ref: e.ref } : {}),
    ...(e.headers !== undefined ? { headers: e.headers } : {}),
  }))
}

/**
 * Resolve `opts.sandbox`, boot the box, spawn `adapter` on the box's OWN
 * `agent_start`, and wrap the result in a `SandboxAgentSessionProxy`. Called
 * from inside `spawnAgentSession`'s try block, AFTER the role/depth/quota
 * gates above have already run — a rejected spawn never boots a box.
 *
 * Every failure mode returns its own discriminated `code` rather than
 * throwing into the generic `agent_spawn_failed` catch, so callers can
 * distinguish "no such provider" from "the box never came up" from "the
 * box's own agent_start rejected the adapter".
 */
async function bootSandboxAgentSession(opts: {
  sandbox: string | SandboxSpecInput
  resolveSandboxProvider?: SandboxProviderResolver
  adapter: string
  cwd: string
  mcpServers?: AcpMcpServer[]
  model?: string
  route?: RouteSpec
  effort?: string
  label?: string
  /** Explicit billing-auth forwarded to the BOX's own `agent_start` — see
   *  the call-site comment (fresh boxes have no config and claude-code never
   *  inherits shell-env subscription auth). */
  auth?: DefaultsAdapterAuthConfig
}): Promise<SandboxBootResult> {
  const providerSlug = typeof opts.sandbox === "string" ? opts.sandbox : opts.sandbox.provider
  if (!opts.resolveSandboxProvider) {
    return {
      ok: false,
      code: "sandbox_provider_not_found",
      message:
        `agent_start: sandbox provider "${providerSlug}" not found — the daemon has no ` +
        "sandbox provider resolver wired (createGateway needs `resolveSandboxProvider`).",
    }
  }
  const handle = await opts.resolveSandboxProvider(providerSlug)
  if (!handle) {
    return {
      ok: false,
      code: "sandbox_provider_not_found",
      message:
        `agent_start: sandbox provider "${providerSlug}" not found. Check ` +
        "`list_sandbox_providers`, then `setup_sandbox_provider` if it needs credentials.",
    }
  }
  const spec: SandboxSpec =
    typeof opts.sandbox === "string" ? { provider: opts.sandbox, config: {} } : opts.sandbox
  // Reuse target (PR3) — `agent_start.sandbox.reuse`. Undefined ⇒ boot a
  // fresh box, exactly as PR2. Also feeds `resolveLifecyclePolicy` below:
  // a reused box defaults to PAUSE (not kill) on close, since it would be
  // pointless to reconnect to a box that's about to be killed anyway.
  const reuseSandboxId = typeof opts.sandbox === "object" ? opts.sandbox.reuse : undefined
  const lifecyclePolicy = resolveLifecyclePolicy(spec, reuseSandboxId !== undefined)

  // AIP-36 `env.passthrough` / `env.auth.state.env` — the only env-var
  // slugs a spec actually declares today (see PLAN §4 AMENDMENT: no
  // provider-required-secrets surface exists on `SandboxProviderHandle`
  // yet, so this is the full slug set).
  const passthrough = spec.env?.passthrough ?? []
  const authEnv = spec.env?.auth?.state?.env ?? []
  const slugs = Array.from(new Set([...passthrough, ...authEnv]))

  let host: SandboxAgentSessionHost
  try {
    host = await createSandboxAgentSessionHost({
      provider: handle.provider,
      spec,
      ...(reuseSandboxId !== undefined ? { sandboxId: reuseSandboxId } : {}),
      // AMENDMENT — do NOT default to `process.env`: always pass an
      // explicit resolver backed by the host's own secrets broker
      // (`mcp-credential-deps.ts`'s `resolveSandboxSecret`, the same DI
      // seam `resolveMcpCredentialHeaders` above uses), never the bare
      // `defaultProcessEnvResolver` fallback `@agentproto/sandbox` would
      // otherwise apply when `resolver` is omitted.
      secrets: { slugs, resolver: resolveSandboxSecret },
    })
  } catch (err) {
    return reuseSandboxId !== undefined
      ? {
          ok: false,
          code: "sandbox_reconnect_failed",
          message:
            `agent_start: sandbox reconnect failed (provider "${providerSlug}", sandbox ` +
            `"${reuseSandboxId}") — ${err instanceof Error ? err.message : String(err)}`,
        }
      : {
          ok: false,
          code: "sandbox_boot_failed",
          message:
            `agent_start: sandbox boot failed (provider "${providerSlug}") — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        }
  }

  let remoteSessionId: string
  try {
    const remoteDesc = await host.start({
      adapter: opts.adapter,
      cwd: opts.cwd,
      ...(opts.mcpServers ? { mcpServers: toMcpServerMounts(opts.mcpServers) } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.route ? { route: opts.route } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.auth ? { auth: opts.auth } : {}),
    })
    remoteSessionId = remoteDesc.id
  } catch (err) {
    await host.stop().catch(() => undefined)
    return {
      ok: false,
      code: "sandbox_proxy_failed",
      message:
        `agent_start: the sandbox's own agent_start failed for adapter "${opts.adapter}" — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return {
    ok: true,
    agentSession: createSandboxAgentSessionProxy({ host, remoteSessionId, lifecyclePolicy }),
    commandPreview: `sandbox:${providerSlug} → ${opts.adapter}`,
    sandboxId: host.sandboxId,
    sandboxTeardown: lifecyclePolicy.teardown,
  }
}

/**
 * A resolved host profile is intentionally translated back to the narrow
 * per-spawn auth shape accepted by the sandbox daemon.  The profile reference
 * itself is host-local; only its selected credential can cross this boundary.
 */
function sandboxAuthFromResolved(auth: ResolvedAuthSpec): DefaultsAdapterAuthConfig {
  return {
    mode: auth.mode,
    ...(auth.mode === "api-key"
      ? auth.credential !== undefined
        ? { apiKey: auth.credential }
        : {}
      : auth.credential !== undefined
        ? { token: auth.credential }
        : {}),
  }
}

/**
 * `SandboxSecretsConfig.resolver` — resolves an AIP-36 env slug through the
 * host's secrets broker (`mcp-credential-deps.ts`), never `process.env`
 * directly. Returns null (not a thrown error) on any failure or when no
 * broker is wired — `@agentproto/sandbox`'s own `resolveSandboxSecretsEnv`
 * is what turns a null into the loud "missing secret" failure, so a
 * provider that genuinely needs the slug still fails the boot instead of
 * silently running with an empty value.
 */
async function resolveSandboxSecret(slug: string): Promise<string | null> {
  const { resolveSandboxSecret: resolve } = getMcpCredentialDeps()
  if (!resolve) return null
  try {
    return await resolve(slug)
  } catch (err) {
    console.warn(
      `[agent_start] sandbox secret resolution failed for "${slug}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}
