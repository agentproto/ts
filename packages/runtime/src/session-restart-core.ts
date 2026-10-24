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
 * announced via `session:config-changed` (#490). `mcpServers` (read off
 * `SessionConfig` itself) is the one array-shaped axis and is a FULL
 * REPLACEMENT, not a merge — see `buildRestartMcpServers`'s comment in
 * `restartAgentSession`.
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
import {
  CloudSpawnError,
  CLOUD_SESSION_META_FILE_ENV,
  cloudHarnessFor,
  cloudMetaOf,
  cloudRepoSpawnEnv,
  cloudSessionMetaFilePath,
  encodeCloudSessionMeta,
  resolveCloudResumeId,
} from "./cloud-vendors.js"
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
import { mintRemoteParentForBox, revokeParentRelayGrant } from "./parent-relay.js"
import { sandboxConfigForReattach } from "./sandbox-session-holder.js"
import { recordSandboxBoot, recordSessionDetach } from "./sandbox-ledger.js"
import { createBoxLoginRefresher, type BoxLoginRefreshOutcome } from "./box-login-bridge.js"
import { findWorkspace, loadWorkspacesConfig } from "./workspaces-config.js"
import { SANDBOX_BRANCH_PREFIX, resolveSharedBoxWorktreeTeardown } from "./sandbox-workspace-remote.js"
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
import { checkModelPolicy } from "./model-policy.js"
import { getModelListSource } from "./model-list-store.js"
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
import { boxSpawnEnforcedPosturesOf, createSandboxAgentSessionProxy } from "./sandbox-agent-session-proxy.js"
import {
  formatDeliveryNotice,
  trackedSandboxDeliveryOpts,
  resolveSandboxCheckpointConfig,
  type SandboxDeliveryTarget,
} from "./sandbox-delivery.js"
import { savedAdapterStoreArchive } from "./sandbox-adapter-store.js"
import { latestCheckpointRef } from "./checkpoint-resume.js"
import { sessionTranscriptDir } from "./transcript-writer.js"
import { resolveSandboxWorkspaceSource } from "./sandbox-workspace-derive-remote.js"
import {
  adoptTarCheckpoint,
  readTarTarget,
  savedTarArchive,
  tarCheckpointProxyOpts,
} from "./sandbox-tar-checkpoint.js"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"
import {
  composeTeardownHooks,
  createGithubWorkspacePushAtClose,
  readAppGithubWorkspaceSync,
} from "./sandbox-app-serve.js"
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
 * Why a restart failed — the machine-readable vocabulary every transport
 * (HTTP `POST /sessions/:id/restart`, the `session_restart` MCP verb, the
 * CLI) hands to clients so a UI can show a human sentence AND offer the
 * right next step instead of echoing a provider's raw string.
 *
 * `unsupported_strategy` is an addition beyond the sandbox vocabulary: the
 * pre-sandbox guard (`only agent-adapter sessions are resumable this way`)
 * needs a code of its own for the same reason the sandbox paths do.
 */
export type SessionRestartErrorCode =
  | "sandbox_gone"
  | "sandbox_unreachable"
  | "sandbox_provider_missing"
  | "sandbox_box_start_failed"
  | "no_workspace"
  | "no_workspace_remote"
  | "no_known_branch"
  | "adapter_not_found"
  | "unsupported_strategy"
  | "retired"
  | "override_invalid"
  | "cloud_spawn_refused"

/**
 * The optional "and here's what to do about it" hint a client turns into a
 * button. `spawn-on-branch`/`spawn-fresh` are the two recovery moves for a
 * dead box (re-clone the recorded `wt/` work branch, or start over from the
 * workspace's base branch); `fix-config` carries the literal remediation
 * (the command the user has to run before a restart can succeed at all).
 */
export type SessionRestartAction =
  | { kind: "spawn-on-branch"; branch: string }
  | { kind: "spawn-fresh" }
  | { kind: "fix-config"; detail: string }

/**
 * The one-line human sentence behind each code. Sentences, not fragments:
 * several surfaces (session-chat, the CLI) show `reason` on its own, with
 * the technical `message` as the detail underneath. Overridable per throw
 * site when the generic sentence would be wrong for that specific failure.
 */
export const SESSION_RESTART_REASONS: Record<SessionRestartErrorCode, string> = {
  sandbox_gone:
    "The box this session ran in is gone, so the session can't be resumed where it was.",
  sandbox_unreachable:
    "The box this session ran in isn't answering, so the session can't be resumed there right now.",
  sandbox_provider_missing:
    "This daemon can't reach the sandbox provider that ran this session.",
  sandbox_box_start_failed:
    "A replacement box couldn't be started for this session.",
  no_workspace:
    "This session isn't tied to a registered workspace, so a new box has nothing to clone.",
  no_workspace_remote:
    "This session's workspace has no git remote, so a new box has nothing to clone.",
  no_known_branch:
    "This session recorded no work branch, so a new box has nothing to check out.",
  adapter_not_found: "The adapter this session used isn't installed on this host.",
  unsupported_strategy:
    "This session's restart strategy doesn't run through the agent adapter, so it can't be restarted this way.",
  retired: "This session is retired and is never revived automatically.",
  override_invalid: "That restart override isn't valid for this session.",
  cloud_spawn_refused:
    "This cloud session's workspace remote can't be used, so the session can't be restarted.",
}

/**
 * A restart failure with a machine-readable `code`, a short human `reason`
 * and — when there is one — an `action` hint a client can turn into a
 * button. `message` stays the technical detail (unchanged from the plain
 * `Error`s these replace), so logs, tests and `--json` output keep reading
 * exactly as before; `reason` is what a person is shown.
 *
 * `status` is the HTTP/MCP rejection status the transports preserve
 * (400 for a rejected override, 500 for everything else).
 */
export class SessionRestartError extends Error {
  readonly code: SessionRestartErrorCode
  readonly reason: string
  readonly action?: SessionRestartAction
  readonly status: number
  constructor(
    code: SessionRestartErrorCode,
    message: string,
    opts: { reason?: string; action?: SessionRestartAction; status?: number } = {},
  ) {
    super(message)
    this.name = "SessionRestartError"
    this.code = code
    this.reason = opts.reason ?? SESSION_RESTART_REASONS[code]
    if (opts.action) this.action = opts.action
    this.status = opts.status ?? 500
  }
}

/**
 * Thrown when a restart override is invalid — an unknown access profile, or a
 * profile that isn't eligible for the resolved `(adapter, route)` endpoint
 * (SPEC risks Rx/Ry). Carries `status: 400` so the MCP/HTTP surfaces reject the
 * restart with a clear reason instead of ever spawning with the wrong wallet.
 *
 * A {@link SessionRestartError} (`code: "override_invalid"`) so every
 * transport reports it like any other restart failure; `instanceof
 * RestartOverrideError` callers are untouched.
 */
export class RestartOverrideError extends SessionRestartError {
  constructor(message: string) {
    super("override_invalid", message, { status: 400 })
    this.name = "RestartOverrideError"
  }
}

/**
 * Env a cloud relay needs on (re)start: the meta-file path plus, for a
 * workspace with a declared remote, the clone source the original spawn gave
 * it. Shared by `session_restart` and the lazy in-place resume so the two
 * can never hand the relay different inputs. Throws {@link CloudSpawnError}.
 */
export async function cloudRelayEnv(input: {
  workspaceSlug: string | undefined
  configDir: string
}): Promise<Record<string, string>> {
  return {
    [CLOUD_SESSION_META_FILE_ENV]: cloudSessionMetaFilePath(input.configDir),
    ...(input.workspaceSlug
      ? await cloudRepoSpawnEnv(
          findWorkspace(await loadWorkspacesConfig(), input.workspaceSlug)?.remote,
          input.configDir,
          async ref => (await new KeychainStore().read({ path: ref }))?.value,
        )
      : {}),
  }
}

/** Map a {@link spawnOnFreshBox} `blocker` string onto its code — the three
 *  why-texts #1910 can produce (no workspace, no remote, no known work
 *  branch). Order matters: a workspace blocker also mentions the missing
 *  branch, so the workspace cause wins over the branch one. */
export function restartBlockerCode(blocker: string): SessionRestartErrorCode {
  if (blocker.includes("not tied to a registered workspace")) return "no_workspace"
  if (
    blocker.includes("has no remote configured") ||
    blocker.includes("no longer registered") ||
    blocker.includes("has no git remote")
  )
    return "no_workspace_remote"
  if (blocker.includes("no work branch")) return "no_known_branch"
  return "sandbox_gone"
}

/**
 * The wire shape of a restart failure — `POST /sessions/:id/restart`'s body
 * and the `session_restart` MCP result both carry it. `error.code`/
 * `error.reason`/`error.action` are the typed part; `error.message` and the
 * top-level `message` are the technical detail, kept so every existing
 * reader (`formatHttpError` in the CLI, `describeError` in the VS Code
 * client, `--json` consumers) still finds what it looked for before.
 */
export interface SessionRestartErrorPayload {
  error: {
    code: SessionRestartErrorCode
    reason: string
    message: string
    action?: SessionRestartAction
  }
  message: string
}

/**
 * Build {@link SessionRestartErrorPayload} for a thrown restart error, or
 * `undefined` when the error carries no restart code (a plain `Error` from a
 * driver, say) — callers keep their existing `{error:"restart_failed",
 * message}` fallback for those, which is what "fall back to today's message
 * when no code" means on the client too.
 *
 * `SessionRetiredError` is mapped rather than subclassed: it already extends
 * `SessionNotAliveError` (whose `instanceof` callers must not move) and
 * already carries its own `code`, so only its payload spelling is derived
 * here.
 */
export function sessionRestartErrorPayload(
  err: unknown,
): SessionRestartErrorPayload | undefined {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof SessionRestartError) {
    return {
      error: {
        code: err.code,
        reason: err.reason,
        message,
        ...(err.action ? { action: err.action } : {}),
      },
      message,
    }
  }
  if (err instanceof SessionRetiredError) {
    return {
      error: {
        code: "retired",
        reason: err.continuedTo
          ? `This session was superseded by "${err.continuedTo}" — prompt that session instead.`
          : SESSION_RESTART_REASONS.retired,
        message,
      },
      message,
    }
  }
  return undefined
}

/**
 * The body a transport sends when a restart failed: the typed payload for a
 * coded failure, today's `{error:"restart_failed", message}` for anything
 * else (an uncoded driver error must keep its current shape — no code, no
 * invented reason). Pass the caught `err` straight in; no branching needed.
 */
export function sessionRestartErrorBody(
  err: unknown,
): SessionRestartErrorPayload | { error: "restart_failed"; message: string } {
  return (
    sessionRestartErrorPayload(err) ?? {
      error: "restart_failed",
      message: err instanceof Error ? err.message : String(err),
    }
  )
}

/**
 * HTTP status for a restart failure: the error's own (400 for a rejected
 * override, 500 for the rest), 409 for a retired/superseded row — the status
 * `retiredErrorWire` already uses for a refused prompt — else 500. Note
 * `SessionRetiredError.status` is the SESSION's status string, never an HTTP
 * code, so it is deliberately not read here.
 */
export function sessionRestartErrorStatus(err: unknown): number {
  if (err instanceof SessionRestartError) return err.status
  if (err instanceof SessionRetiredError) return 409
  return 500
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
  let strategy: RestartStrategy =
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
  // AIP-66 cloud: the cloud adapter resumes the VENDOR's own session id,
  // learned onto `meta.cloud.sessionId` — prefer it over the ACP uuid (which
  // is not the vendor id) in every agent-resume strategy. resolveCloudResumeId
  // also falls back to the relay's meta file inside this row's own config dir
  // when the descriptor never learned the id (the spawn-time watch died with
  // a daemon restart before it was stamped), stamping it back through
  // mergeMeta. A cloud row with neither source keeps `prev.adapterSessionId`
  // and fails closed at the vendor if that isn't resolvable there.
  if (strategy.kind === "agent" && strategy.resumeSessionId !== undefined) {
    const cloudId = await resolveCloudResumeId(prev, cloud =>
      registry.mergeMeta(prev.id, { cloud: encodeCloudSessionMeta(cloud) }),
    )
    if (cloudId !== undefined) strategy = { ...strategy, resumeSessionId: cloudId }
  }

  if (strategy.kind !== "agent") {
    // A request this path can't serve, not a server fault: a command session
    // (or a PTY going through the agent-adapter route) is a 400.
    throw new SessionRestartError(
      "unsupported_strategy",
      `restartAgentSession: session '${prev.id}' resolved to a '${strategy.kind}' ` +
        "restart strategy — only agent-adapter sessions are resumable this way.",
      { status: 400 },
    )
  }

  const adapterSlug = prev.adapterSlug
  if (!adapterSlug) {
    throw new SessionRestartError(
      "adapter_not_found",
      "restartAgentSession: internal error — agent resume strategy without adapterSlug",
    )
  }

  const resolved = await resolveAgentAdapter(adapterSlug)
  if (!resolved && sandboxId === undefined) {
    throw new SessionRestartError(
      "adapter_not_found",
      `restartAgentSession: adapter '${adapterSlug}' not found.`,
    )
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
  if (effModel !== undefined && effModel !== prev.model) {
    const verdict = checkModelPolicy(effModel, prev.modelPolicy, getModelListSource())
    if (!verdict.ok) {
      throw new RestartOverrideError(`restart model override refused by the session model policy: ${verdict.reason}`)
    }
  }
  const effEffort = overrides.effort ?? prev.effort
  const effRoute = reconciled.route ?? prev.route
  const effPosture = overrides.posture ?? prev.posture
  const effContextProfile = overrides.contextProfile ?? prev.contextProfile
  // AIP-66 cloud: a cloud session's recorded harness is the VENDOR's harness
  // (`claude-code`), never the local relay adapter slug (`claude-code-cloud`)
  // — see `cloud-vendors.ts` / `session-spawn.ts`. A restart must re-record
  // that same label instead of falling back to `prev.adapterSlug` when the
  // prior descriptor's own `harness` is absent or predates that fix (#1953).
  // Decoded from `meta.cloud`; a non-cloud session is untouched (the
  // `cloudHarness` term is undefined there). `prevCloudMeta` also drives the
  // vendor-binding carry-forward below.
  const prevCloudMeta = cloudMetaOf(prev)
  const cloudHarness = prevCloudMeta
    ? cloudHarnessFor(prevCloudMeta.vendor, prev.harness)
    : undefined
  const effHarness = overrides.harness ?? cloudHarness ?? prev.harness ?? prev.adapterSlug
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
    // The base list for this restart: an `mcpServers` OVERRIDE fully REPLACES
    // the prior descriptor's list (the same "present axis wins whole"
    // convention as `model`/`access` — the caller passes the complete new
    // list, never a delta; a merge here would make "remove exactly one
    // server" or "update one server's `allowTools` query params"
    // inexpressible). This is the restart-only axis that lets a persistent
    // consumer refresh a stale HTTP-mounted MCP mount (e.g. a baked-in
    // `?allowTools=` query string on the daemon self-mount) — a bare restart
    // could never change it because it clones the ORIGINAL list verbatim.
    // The identity re-stamp below STILL runs on the override list: an
    // `http` entry targeting this daemon's /mcp is re-pointed at THIS
    // restart's fresh session id, so a caller that replays a copied
    // self-mount URL never resurrects a dead session id.
    const baseMcpServers = overrides.mcpServers !== undefined ? overrides.mcpServers : prev.mcpServers
    if (!opts.daemonMcpUrl) {
      if (baseMcpServers && baseMcpServers.length > 0) {
        console.warn(
          `[restartAgentSession] no daemonMcpUrl wired for restart of ${prev.id} — ` +
            `carrying mcpServers forward WITHOUT re-stamping callerSessionId (the ` +
            `restarted session ${newSessionId} will keep speaking to the daemon under ` +
            `the OLD session's identity).`,
        )
      }
      return baseMcpServers
    }
    const stripped = stripOwnCallerStamp(baseMcpServers, prev.id)
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
      throw new SessionRestartError(
        "adapter_not_found",
        `restartAgentSession: adapter '${adapterSlug}' not found.`,
      )
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
    // AIP-66 cloud identity survives a restart too: a restart is the SAME
    // logical cloud session, and the re-attach path reads the vendor id off
    // `meta.cloud` (`resolveCloudResumeId`) — dropping it loses the vendor /
    // sessionId / url and forces the relay-side-file fallback on the next
    // resume. Merged with the app-boundary meta so carrying one never drops
    // the other; encoded through the cloud-vendors helper (never hand-rolled).
    // A cloud restart re-hands the relay its meta file and — for a workspace
    // with a declared remote — the same clone source the spawn gave it, so
    // `session/load` re-validates the relay's own checkout, never a host cwd
    // that may hold no clone at all.
    let cloudRestartEnv: Record<string, string> = {}
    if (prevCloudMeta) {
      try {
        cloudRestartEnv = await cloudRelayEnv({
          workspaceSlug: prev.workspaceSlug,
          configDir: restartConfigDir,
        })
      } catch (err) {
        if (err instanceof CloudSpawnError) {
          throw new SessionRestartError("cloud_spawn_refused", err.message, {
            ...(err.field
              ? { action: { kind: "fix-config" as const, detail: `fix ${err.field}` } }
              : {}),
          })
        }
        throw err
      }
    }
    const restartMeta: Record<string, string> = {
      ...(prevBoundary ? boundaryMeta(prevBoundary) : {}),
      ...(prevCloudMeta ? { cloud: encodeCloudSessionMeta(prevCloudMeta) } : {}),
    }
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
      // none — a channel-less lineage has nothing left to re-apply here) —
      // and only when it still fits the channel's char budget: an over-limit
      // text was prefixed at spawn, and re-applying it through the channel
      // would silently exceed the harness's cap.
      ...(prev.appendSystemPrompt &&
      resolved.supportsSystemPrompt === true &&
      (resolved.systemPromptMaxChars === undefined ||
        prev.appendSystemPrompt.length <= resolved.systemPromptMaxChars)
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
        ...cloudRestartEnv,
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
      ...(resolved.nativeHooks !== undefined && resolved.nativeHooks.length > 0
        ? { nativeHooks: resolved.nativeHooks }
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
      ...(Object.keys(restartMeta).length > 0 ? { meta: restartMeta } : {}),
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
      ...(prev.modelPolicy ? { modelPolicy: prev.modelPolicy } : {}),
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
    if (prev.operatorLabel) registry.setOperatorLabel(desc.id, prev.operatorLabel)
    // `allowPromptFrom` is spawn-time-only (`agent_start.allowPromptFrom`,
    // applied post-spawn by the MCP tool handler) — never re-derived by
    // `spawnAgentSession` itself, so a restart that lands on a NEW session
    // id must carry it forward explicitly, same as `operatorLabel` above.
    // Without this, a permanent agent's drive grants (e.g. the brain's
    // `label:pygmalion-brain-persistent` access) are silently dropped at
    // the next restart.
    if (prev.allowPromptFrom?.length) registry.setPromptPolicy(desc.id, [...prev.allowPromptFrom])
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
      throw new SessionRestartError(
        "sandbox_provider_missing",
        `restartAgentSession: session '${prev.id}' runs in a sandbox but the daemon has ` +
          "no sandbox provider resolver wired — cannot re-attach its box.",
        { action: { kind: "fix-config", detail: "restart the daemon with its sandbox provider configured" } },
      )
    }
    const providerSlug = parseSandboxProviderSlug(prev.command)
    if (!providerSlug) {
      throw new SessionRestartError(
        "sandbox_provider_missing",
        `restartAgentSession: session '${prev.id}' records no sandbox provider ` +
          "(no `sandbox:<provider>` command preview) — cannot re-attach its box.",
        { action: { kind: "fix-config", detail: "restart the session from a daemon that has its sandbox provider set up" } },
      )
    }
    const handle = await opts.resolveSandboxProvider(providerSlug)
    if (!handle) {
      throw new SessionRestartError(
        "sandbox_provider_missing",
        `restartAgentSession: sandbox provider "${providerSlug}" not found — cannot ` +
          `re-attach sandbox "${boxSandboxId}".`,
        { action: { kind: "fix-config", detail: `set up sandbox provider "${providerSlug}" on this daemon (MCP setup_sandbox_provider)` } },
      )
    }
    const sandboxMcpServers = buildRestartMcpServers(restartedSessionId)
    const sandboxConfig = sandboxConfigForReattach(prev.sandboxConfig, prev.id)
    const spec: SandboxSpec = { provider: providerSlug, config: sandboxConfig }
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
        const fresh = await spawnOnFreshBox(providerSlug, restartedSessionId, sandboxMcpServers, resumeSessionId)
        if (fresh.ok) return fresh.desc
        freshBlocker = fresh.blocker
      }
      // Code + reason for the client: a box the provider no longer knows is
      // `sandbox_gone`, one that answered but whose daemon died (and was
      // reaped) is `sandbox_unreachable`, and a fresh-box blocker narrows it
      // further to why the fallback couldn't run. The message stays the
      // exact technical sentence it has always been.
      const target = prev.sandboxDeliveryTarget
      const branch =
        target && target.branch.startsWith(SANDBOX_BRANCH_PREFIX) ? target.branch : undefined
      const code: SessionRestartErrorCode = freshBlocker
        ? restartBlockerCode(freshBlocker)
        : isSandboxBoxGoneError(err)
          ? "sandbox_gone"
          : "sandbox_unreachable"
      const action: SessionRestartAction | undefined = freshBlocker
        ? code === "no_known_branch"
          ? { kind: "spawn-fresh" }
          : // The blocker's own remediation command, when it names one —
            // that is literally the thing to fix before retrying.
            { kind: "fix-config", detail: freshBlocker.match(/`([^`]+)`/)?.[1] ?? freshBlocker }
        : branch
          ? { kind: "spawn-on-branch", branch }
          : { kind: "spawn-fresh" }
      throw new SessionRestartError(
        code,
        `restartAgentSession: sandbox "${boxSandboxId}" expired or is unreachable ` +
          `(provider "${providerSlug}")${freshBlocker ? ` and it cannot be restarted on a fresh box: ${freshBlocker}` : " — spawn a fresh session."} ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { action },
      )
    }
    // Register the RESUMED session on the LIVE box's ledger row. The ledger
    // is the gc's only view of who holds a box, and the pre-fix restart path
    // left the row pointing at the dead origin with an empty (or stale)
    // attaché list, so the periodic gc reaped a box the resumed session was
    // actively using (2026-10-23). The resumed id is the row's new origin
    // ("last reconnected to the box") and joins the shared-box refcount; the
    // prior id detaches in the same breath, because it no longer holds the
    // box. Best-effort, like every ledger write.
    recordSandboxBoot({
      sandboxId: boxSandboxId,
      provider: providerSlug,
      state: "connected",
      originSessionId: restartedSessionId,
      sessionId: restartedSessionId,
    })
    if (prev.id !== restartedSessionId) recordSessionDetach(boxSandboxId, prev.id)
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
        throw new SessionRestartError(
          "sandbox_unreachable",
          `restartAgentSession: could not stop the prior session "${priorRemoteSessionId}" ` +
            `inside sandbox "${host.sandboxId}" — refusing to start a second adapter next to ` +
            `it. ${err instanceof Error ? err.message : String(err)}`,
          { action: { kind: "spawn-fresh" } },
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
    let boxSpawnEnforcedPostures: string[] | undefined
    // PARENT RELAY: the restarted session is a NEW host row (fresh id) under
    // the same parent, so it gets a FRESH relay grant (the prior row's grant
    // was revoked when that row ended) and the box's new session gets the
    // remote parent again - without it a restart would silently drop the
    // relay. Revoked below when the box's agent_start fails.
    const remoteParent = mintRemoteParentForBox(
      prev.parentSessionId
        ? { parentSessionId: prev.parentSessionId, boxSessionId: restartedSessionId }
        : undefined,
    )
    try {
      const remoteDesc = await host.start({
        adapter: adapterSlug,
        ...(remoteParent ? { remoteParent } : {}),
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
        // The box daemon applies the posture itself (native mode, isolated
        // spawn config, or the advisory preamble) — the host never does for a
        // sandbox session, so a restart that dropped it would lose it outright.
        ...(effPosture !== undefined ? { posture: effPosture } : {}),
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
      boxSpawnEnforcedPostures = boxSpawnEnforcedPosturesOf(remoteDesc)
      // The box reports `resumeVia` only when its own adapter actually
      // rehydrated the prior conversation. A blank answer after a resume
      // attempt (old box daemon that strips the unknown field, a row id it
      // doesn't know, or an adapter rejection it absorbed) is a flagged
      // fallback: `desc.resumeVia` stays "" and the transcript digest below
      // still runs — never a silent claim of continuity.
      boxResumed = remoteDesc.resumeVia === "resumed via ACP"
      if (boxResumeId && !boxResumed) resumeFallback = true
    } catch (err) {
      if (remoteParent) revokeParentRelayGrant(remoteParent.token)
      await host.stop().catch(() => undefined)
      throw new SessionRestartError(
        "sandbox_box_start_failed",
        `restartAgentSession: the sandbox's own agent_start failed for adapter ` +
          `"${adapterSlug}" — ${err instanceof Error ? err.message : String(err)}`,
        { action: { kind: "spawn-fresh" } },
      )
    }
    // The prior session's work branch is still in the box: carry its delivery
    // target over so this session's teardown pushes (or bundles) it too.
    const deliveryTarget = prev.sandboxDeliveryTarget
    // AIP-36 — when the prior session ran on a shared box (its checkoutDir is
    // a per-session worktree of the shared clone), the resumed proxy removes
    // that worktree on its own later detach. `undefined` means the plain
    // per-workspace checkout, which no detach needs to clean up.
    const worktreeTeardown = deliveryTarget
      ? resolveSharedBoxWorktreeTeardown(deliveryTarget.checkoutDir, deliveryTarget.branch)
      : undefined
    // A tar-mode session (workspace with no git remote) keeps checkpointing
    // its working dir; the live box still holds it, so nothing is restored.
    const tarTarget = deliveryTarget
      ? undefined
      : await adoptTarCheckpoint(sessionTranscriptDir(prev.id), sessionTranscriptDir(restartedSessionId))
    // A2 — the app's github workspace: re-read its in-box declaration off the
    // live box and re-attach the opt-in close-time push, so a resumed
    // session pushes at close exactly like a freshly-spawned one (the spawn
    // path wires the same hook in `session-spawn.ts`). Best-effort: no
    // declaration / no exec seam / an unreadable WORKSPACE.md leaves no hook.
    let githubPushHook: (() => Promise<void>) | undefined
    if (prev.appServe && host.exec) {
      try {
        const sync = await readAppGithubWorkspaceSync(host.exec, prev.appServe.dir)
        if (sync) {
          githubPushHook = createGithubWorkspacePushAtClose({
            sync,
            exec: host.exec,
            sessionId: restartedSessionId,
          })
        }
      } catch {
        // A declaration that cannot be re-read simply means no push here.
      }
    }
    const tarOpts = tarTarget
      ? tarCheckpointProxyOpts({
          exec: host.exec,
          ...(host.readFile ? { readFile: host.readFile } : {}),
          target: tarTarget,
          outDir: sessionTranscriptDir(restartedSessionId),
          config: checkpointConfig ?? resolveSandboxCheckpointConfig(undefined, undefined),
          notify: text => registry.recordNotice(restartedSessionId, text),
        })
      : undefined
    const deliveryOpts =
      deliveryTarget && host.exec
        ? trackedSandboxDeliveryOpts({
            exec: host.exec,
            ...(host.readFile ? { readFile: host.readFile } : {}),
            target: deliveryTarget,
            outDir: sessionTranscriptDir(restartedSessionId),
            config: checkpointConfig ?? resolveSandboxCheckpointConfig(undefined, undefined),
            baseRef: "origin/HEAD",
            // The conversation-store passenger is keyed by THIS session's
            // box-side id — the id the descriptor records as
            // `adapterSessionId` (the proxy's `sessionId`).
            adapterStore: { adapterSessionId: remoteSessionId, adapter: adapterSlug },
            // Stamps `Agentproto-Session:` trailers onto the RESTARTED
            // session's checkpoint commits and work branch, for PR
            // authorship attribution (pr-provenance.ts
            // `collectBranchAuthors`). The restarted session has its own id:
            // after a restart the adapter runs under a new session id, and
            // the old one's descriptor is gone; without this the restarted
            // session's authorship cannot be recovered from trailers once it
            // is gone too.
            sessionId: restartedSessionId,
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
        : undefined
    // One `onBeforeTeardown` slot on the proxy: the delivery/tar hook (at
    // most one is set — tar only when there is no delivery target) composed
    // with the github push, delivery first (deadline-budgeted, box-critical).
    const onBeforeTeardown = composeTeardownHooks(
      deliveryOpts?.onBeforeTeardown ?? tarOpts?.onBeforeTeardown,
      githubPushHook,
    )
    const agentSession = createSandboxAgentSessionProxy({
      host,
      remoteSessionId,
      lifecyclePolicy,
      ...(boxSpawnEnforcedPostures ? { spawnEnforcedPostures: boxSpawnEnforcedPostures } : {}),
      // BOX-LOGIN BRIDGE refresh — re-upload the copy when the HOST's login
      // file changes under this re-attached box (see `createBoxLoginRefresher`;
      // the proxy owns the throttle + closed/detached gate). Absent when the
      // pre-start upload never happened, so a degraded restart stays degraded.
      ...(refreshBoxLogin ? { refreshLoginFile: refreshBoxLogin } : {}),
      ledger: { sandboxId: host.sandboxId, provider: providerSlug },
      ...(providerSlug.startsWith("device:") ? {} : { detachable: true }),
      ...(tarOpts ?? {}),
      ...(deliveryOpts ?? {}),
      ...(onBeforeTeardown ? { onBeforeTeardown } : {}),
      // AIP-36 — a re-attached shared-box session still removes its own git
      // worktree on detach (same wiring as spawn): the layout is recovered
      // from the persisted delivery target. Absent for the plain per-
      // workspace checkout (fresh box, no worktree) — see
      // `resolveSharedBoxWorktreeTeardown`.
      ...(worktreeTeardown ? { worktreeTeardown } : {}),
      watchdog: {},
    })
    return registerBoxSession(restartedSessionId, sandboxMcpServers, {
      agentSession,
      sandboxId: host.sandboxId,
      provider: providerSlug,
      sandboxTeardown: lifecyclePolicy.teardown,
      ...(lifecyclePolicy.pauseAfterIdleMs !== undefined
        ? { pauseAfterIdleMs: lifecyclePolicy.pauseAfterIdleMs }
        : {}),
      sandboxConfig,
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
  //
  // The adapter's CONVERSATION store rides along when a checkpoint saved one
  // (`adapter-store.tar.gz` next to the prior session's `checkpoint.json`):
  // it is extracted into the new box at the same path BEFORE the adapter
  // starts, and the restored store's id is passed through the box
  // `agent_start`'s `resumeSessionId` field so the box rehydrates that
  // conversation — the same field a live-box re-attach uses. A box that
  // rejects/ignores it falls back exactly like a live re-attach: blank
  // in-box spawn + the host's digest handoff (`resumeFallback` below).
  const spawnOnFreshBox = async (
    providerSlug: string,
    restartedSessionId: string,
    sandboxMcpServers: SessionDescriptor["mcpServers"],
    resumeSessionId?: string,
  ): Promise<{ ok: true; desc: SessionDescriptor } | { ok: false; blocker: string }> => {
    const target = prev.sandboxDeliveryTarget
    const prevDir = sessionTranscriptDir(prev.id)
    const resumeBranch = target?.branch.startsWith(SANDBOX_BRANCH_PREFIX) ? target.branch : undefined
    // CRASH RESUME - the checkpoint this session took before it died, as
    // recorded on its own row (`lastCheckpoint`). The fresh box restores
    // THAT ref with `git restore --source=<ref>` instead of guessing from
    // the branch name: the session -> checkpoint link survives the crash.
    const resumeCheckpoint = latestCheckpointRef(prev)
    const noBranchNote = resumeBranch ? "" : " and the session recorded no work branch to resume from"
    const tarTarget = target ? undefined : await readTarTarget(prevDir)
    const adapterStoreArchive = savedAdapterStoreArchive(prevDir)
    // Attempt the in-box resume ONLY when the conversation store actually
    // came back with the checkpoint: a fresh box daemon knows nothing of the
    // dead box's ids, so without the store files there is nothing to
    // rehydrate and the flagged fallback (digest handoff) is the honest
    // answer — never a resume attempt doomed to fail.
    const boxResumeId =
      resumeSessionId !== undefined && prev.resumable !== false && adapterStoreArchive !== undefined
        ? resumeSessionId
        : undefined
    if (resumeSessionId !== undefined && boxResumeId === undefined) resumeFallback = true
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
      // CRASH RESUME - restore the checkpoint the dead session recorded.
      ...(resumeCheckpoint
        ? {
            checkpointResume: {
              ref: resumeCheckpoint.ref,
              ...(resumeCheckpoint.sha ? { sha: resumeCheckpoint.sha } : {}),
            },
          }
        : {}),
      adapter: adapterSlug,
      sessionHolder: restartedSessionId,
      // Replaced by the fresh checkout's path (`explicitCwd: false`).
      cwd: prev.cwd ?? "",
      explicitCwd: false,
      ...(sandboxMcpServers ? { mcpServers: sandboxMcpServers } : {}),
      ...(effModel ? { model: effModel } : {}),
      ...(effRoute?.gateway ? { route: effRoute } : {}),
      ...(effEffort ? { effort: effEffort } : {}),
      ...(prev.label ? { label: prev.label } : {}),
      ...(authSpec ? { auth: sandboxAuthForBox(authSpec, authEcho), authSpec } : {}),
      // The saved conversation store is extracted into the box before the
      // adapter starts, and its id is the box `agent_start`'s resume target.
      ...(adapterStoreArchive ? { adapterStoreRestore: { restoreFrom: adapterStoreArchive } } : {}),
      ...(boxResumeId ? { resumeSessionId: boxResumeId } : {}),
      // BOX-LOGIN BRIDGE: the fresh box verifies a login file exists before it
      // starts — `bootSandboxAgentSession` uploads the redacted copy first and
      // stamps `loginFile` on the block above, degrading to today's fail-loud
      // verify when it cannot. See `box-login-bridge.ts`.
      ...(boxLogin ? { boxLogin } : {}),
      ...workspaceArgs,
      sessionId: restartedSessionId,
      // PARENT RELAY: re-pass the host-side parent so the fresh box's
      // session gets a fresh grant + remote parent (`bootSandboxAgentSession`
      // mints it, and revokes it if the boot fails).
      ...(prev.parentSessionId
        ? { parentRelay: { parentSessionId: prev.parentSessionId, boxSessionId: restartedSessionId } }
        : {}),
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
      throw new SessionRestartError(
        "sandbox_box_start_failed",
        `restartAgentSession: sandbox "${prev.sandboxId}" is gone and a fresh box for ` +
          `workspace "${slug}" could not be started — ${booted.message}`,
        { action: { kind: "fix-config", detail: booted.message } },
      )
    }
    // A resume attempt the box reported as blank (old box daemon that strips
    // the unknown field, a store the discovery couldn't bind, or an adapter
    // rejection the box absorbed into a fresh spawn) is a flagged fallback:
    // the digest handoff below still runs — never a silent claim of
    // continuity. Same honesty rule as the live-box re-attach path.
    if (boxResumeId !== undefined && !booted.resumeVia) resumeFallback = true
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
        {
          provider: providerSlug,
          config: sandboxConfigForReattach(booted.sandboxConfig, restartedSessionId),
        },
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
      ...(booted.pauseAfterIdleMs !== undefined ? { pauseAfterIdleMs: booted.pauseAfterIdleMs } : {}),
      cwd: booted.cwd,
      ...(booted.sandboxConfig ? { sandboxConfig: booted.sandboxConfig } : {}),
      ...(booted.resumeVia ? { resumeVia: "resumed via ACP" as const } : {}),
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
      pauseAfterIdleMs?: number
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
      /** Non-secret re-attach config (with the stable holder) to persist. */
      sandboxConfig?: Record<string, unknown>
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
      ...(resolved?.nativeHooks !== undefined && resolved.nativeHooks.length > 0
        ? { nativeHooks: resolved.nativeHooks }
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
      ...(prev.modelPolicy ? { modelPolicy: prev.modelPolicy } : {}),
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
      ...(box.sandboxConfig ? { sandboxConfig: box.sandboxConfig } : {}),
      sandboxTeardown: box.sandboxTeardown,
      ...(box.pauseAfterIdleMs !== undefined ? { sandboxPauseAfterIdleMs: box.pauseAfterIdleMs } : {}),
      ...(deliveryTarget ? { sandboxDeliveryTarget: deliveryTarget } : {}),
      ...(deliveryTarget && prev.sandboxCheckpointOverride !== undefined
        ? { sandboxCheckpointOverride: prev.sandboxCheckpointOverride }
        : {}),
      ...(box.sandboxPorts ? { sandboxPorts: box.sandboxPorts } : {}),
      commandPreview: `sandbox:${box.provider} → ${adapterSlug}`,
      resumedFrom: prev.id,
      resumeVia: box.resumeVia ?? "",
    })
    if (prev.operatorLabel) registry.setOperatorLabel(desc.id, prev.operatorLabel)
    // `allowPromptFrom` is spawn-time-only (`agent_start.allowPromptFrom`,
    // applied post-spawn by the MCP tool handler) — never re-derived by
    // `spawnAgentSession` itself, so a restart that lands on a NEW session
    // id must carry it forward explicitly, same as `operatorLabel` above.
    // Without this, a permanent agent's drive grants (e.g. the brain's
    // `label:pygmalion-brain-persistent` access) are silently dropped at
    // the next restart.
    if (prev.allowPromptFrom?.length) registry.setPromptPolicy(desc.id, [...prev.allowPromptFrom])
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
    // A typed SessionRestartError is NEVER retried: it already carries a
    // classified code/reason/action the client surfaces, and its message may
    // incidentally match RESUME_ID_REJECTED_RE (e.g. "repository not found"
    // on a failed clone) without meaning the resume id was rejected.
    if (
      strategy.resumeSessionId &&
      !(err instanceof SessionRestartError) &&
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
  //
  // `mcpServers` is announced REDACTED: an AcpMcpServer entry can carry
  // `headers` (often a bearer token), `env` and `credentialRef`, and this
  // event lands on the session event bus for every subscriber to read —
  // the same redaction logic `access` applies by emitting only the
  // `profileRef`. Names + transports + public refs are enough for a UI
  // to say "the mounts changed"; the mounts themselves are on the
  // descriptor, which stays the privileged read surface.
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
  if (overrides.mcpServers !== undefined) {
    emit(
      "mcpServers",
      // Redacted — see the comment above. Only the never-secret facets.
      overrides.mcpServers.map(s => {
        const { name, transport, ref } = s
        return { name, transport, ...(ref !== undefined ? { ref } : {}) } as AcpMcpServer
      }),
    )
  }

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
