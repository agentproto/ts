/**
 * Shared `agent_start` spawn logic — orchestrator scoped sub-gateway
 * minting, `mcpServers` merge, hermes default-mcpServers safety net,
 * depth/quota checks. Extracted from `agent-tools.ts` (the MCP tool)
 * so the HTTP route can reuse it without re-implementing (and
 * re-drifting from) the same behaviour.
 */

import type { AcpMcpServer } from "@agentproto/acp"
import type { AgentSessionLike, SessionsRegistry, SessionDescriptor } from "./sessions.js"
import type { AgentAdapterResolver } from "./http-server.js"
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
  normalizeSkillsOption,
  resolveAuthSpec,
  AuthResolutionError,
  type SpawnDefaultsConfig,
  type DefaultsAdapterAuthConfig,
  type ResolvedAuthSpec,
  type AuthEcho,
  type AdapterAuthDescriptor,
} from "./spawn-defaults.js"
import { getProviderKey } from "./providers-store.js"
import { getModelProvider } from "@agentproto/model-catalog/llm"
import type { CatalogProvider } from "@agentproto/model-catalog"
import {
  getAuthProfile,
  eligibleProfiles,
  KeychainStore,
  type AuthMethod,
  type AdapterAuthManifest,
} from "@agentproto/auth"
import type { Posture, RouteSpec, ContextProfile, EffortLevel } from "./session-config.js"
import { resolvePosture } from "./canonical-posture.js"
import type { UserPreset } from "./user-presets.js"
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
} from "./worktree-isolation.js"

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
 * This is deliberately CALLER-SUPPLIED (`idempotencyKey`), not derived from
 * request content (adapter+cwd+prompt+label hash). A content hash was tried
 * and rejected: this file's own test suite exercises a legitimate orchestrator
 * fan-out where two structurally-identical `agent_start` calls (same adapter,
 * cwd, no label/prompt) under one caller scope are expected to spawn as TWO
 * distinct sessions — the second is meant to be rejected by the maxChildren
 * quota check, not silently answered with the first session's descriptor.
 * Intentional identical-looking concurrent spawns are a real, exercised
 * pattern here (see also `Workflow`'s `isolation: "worktree"`, which exists
 * precisely because same-cwd concurrent agents are sometimes wanted and
 * sometimes dangerous) — content alone can't tell the two apart. Only the
 * caller's own declared intent can, so idempotency is opt-in: omitting
 * `idempotencyKey` is a byte-for-byte behavioural no-op.
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
 */
const SPAWN_CLAIM_WINDOW_MS = 30_000

interface SpawnClaim {
  result: Promise<SpawnAgentSessionResult>
  /** Wall-clock time the claim settled successfully — undefined while
   *  still in-flight. Only set for `ok: true` results; see the docblock
   *  above for why a failure is dropped instead of cached. */
  resolvedAt?: number
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

function profileMethodToAuthMode(method: AuthMethod): "subscription" | "api-key" {
  return method === "oauth-bearer" ? "subscription" : "api-key"
}

function directAuthMethods(descriptor: AdapterAuthDescriptor | undefined): AuthMethod[] {
  const methods: AuthMethod[] = []
  if (descriptor?.authSubscription) methods.push("oauth-bearer")
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
  const directEndpoint = descriptor?.provider ?? (model ? getModelProvider(model) : undefined)
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
}

export interface SpawnAgentSessionInput {
  adapter: string
  /** Canonical harness slug — recorded on the descriptor; defaults to `adapter`. */
  harness?: string
  cwd?: string
  workspaceSlug?: string
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
  /** Start this session in permission-hold mode: every ACP permission request
   *  is surfaced + parked in the cross-session inbox (`permissions_list` /
   *  `permissions_respond`) instead of auto-answered. Threaded to the driver's
   *  `startSession({ permissionHold })` and recorded on the descriptor. Ignored
   *  for sandbox spawns (the box's own daemon owns permission handling).
   *  Default false — unchanged auto-answer behaviour. */
  permissionHold?: boolean
  /** Caller-declared "this is the same logical spawn" token. A second
   *  `agent_start` with the same `(adapter, cwd, idempotencyKey)` within
   *  `SPAWN_CLAIM_WINDOW_MS` of a SUCCESSFUL spawn returns that spawn's
   *  descriptor instead of forking a second process — the fix for a
   *  retried call otherwise silently duplicating a live agent. Omit for
   *  today's behaviour (every call spawns). See the docblock on
   *  `SpawnClaim` for why this is opt-in rather than automatic. */
  idempotencyKey?: string
}

export type SpawnAgentSessionResult =
  | {
      ok: true
      descriptor: SessionDescriptor
      output?: string[]
      /** Set when this result was returned to a duplicate call recognized
       *  via `idempotencyKey` — no new process was spawned; `descriptor` is
       *  the ORIGINAL spawn's. Absent on the original (non-duplicate) call. */
      deduped?: boolean
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
        | "access_profile_not_found"
        | "access_profile_ineligible"
        | "agent_spawn_failed"
        | "sandbox_provider_not_found"
        | "sandbox_boot_failed"
        | "sandbox_reconnect_failed"
        | "sandbox_proxy_failed"
        | "worktree_disabled"
        | "worktree_provisioner_not_enabled"
        | "worktree_provision_failed"
        | "worktree_requires_explicit_repo"
      message: string
      details?: Record<string, unknown>
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
    }
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
  const resolved = input.sandbox === undefined ? await resolveAgentAdapter(input.adapter) : null
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
  // ── Recursion guardrails (WP4) ──────────────────────────────
  // When this call arrives through the scoped sub-gateway,
  // `callerScope` is the spawning orchestrator's identity. Enforce
  // the depth cap and per-parent child quota BEFORE spawning, and
  // compute the new session's parent attribution. A direct `/mcp`
  // spawn (no callerScope) is a root: depth 0, no parent, no caps.
  // (`childDepth` itself is computed earlier, above the cwd-resolution
  // block — see the explicit-repo guard's comment there.)
  const parentSessionId = callerScope?.ownerSessionId
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
  let worktreeRequest: { slug?: string; base?: string } | undefined
  if (input.sandbox === undefined) {
    const mode = resolveWorktreeIsolation
      ? await resolveWorktreeIsolation()
      : await loadWorktreeIsolation()
    const decision = decideWorktreeIsolation({
      mode,
      field: input.worktree,
      depth: childDepth,
    })
    if (decision.action === "reject") {
      return { ok: false, code: "worktree_disabled", message: decision.message }
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
  // hermes (unlike claude-code) has zero built-in tools — without an
  // explicit `mcpServers`, it silently spawns as a chat-only session
  // with no error. Default it to the daemon's own gateway so it's no
  // longer possible to get this wrong by omission. An explicit `[]`
  // is a deliberate opt-out and must be respected as such, so this
  // only fires when the caller passed no `mcpServers` at all.
  //
  // HARD GATE: when the resolved role denies delegation, the injected
  // gateway URL carries `denyTools=<DELEGATION_TOOL_NAMES>` so the
  // daemon's `/mcp` handler strips `agent_start`/`agent_prompt` from
  // what it registers for this one request — the child still gets the
  // rest of the daemon's tools (fs, command_execute, …) to do real work.
  if (!mcpServers && input.adapter === "hermes" && daemonMcpUrl) {
    const ref = delegationDenied
      ? `${daemonMcpUrl}${daemonMcpUrl.includes("?") ? "&" : "?"}denyTools=${DELEGATION_TOOL_NAMES.join(",")}`
      : daemonMcpUrl
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
  const spawnDefaults = resolveSpawnDefaults(configDefaults, input.adapter, {
    skills: input.skills,
    options: input.options,
    auth: input.auth,
  })
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
  if (resolved && input.sandbox === undefined && input.access?.profileRef) {
    const profileRef = input.access.profileRef
    const profile = await getAuthProfile(profileRef)
    if (!profile) {
      return {
        ok: false,
        code: "access_profile_not_found",
        message: `agent_start: no auth profile "${profileRef}" found.`,
      }
    }
    if (!resolved.authDescriptor) {
      return {
        ok: false,
        code: "access_profile_ineligible",
        message: `agent_start: adapter "${input.adapter}" presents no billing-auth; profile "${profile.id}" cannot be attached.`,
      }
    }
    const projected = spawnEligibilityManifest(
      input.adapter,
      resolved.authDescriptor,
      input.route,
      input.model ?? resolved.defaultModel,
    )
    if (!projected || eligibleProfiles([profile], projected.manifest, projected.routeId).length === 0) {
      const endpoint = projected?.manifest.endpointByRoute[projected.routeId] ?? "an unknown endpoint"
      return {
        ok: false,
        code: "access_profile_ineligible",
        message:
          `agent_start: profile "${profile.id}" (${profile.endpoint}/${profile.method}) is not eligible ` +
          `for adapter "${input.adapter}" on route "${projected?.routeId ?? "unknown"}" (billed endpoint: ${endpoint}).`,
      }
    }
    const stored = await new KeychainStore().read({ path: profile.credentialRef })
    const authMode = profileMethodToAuthMode(profile.method)
    try {
      const result = resolveAuthSpec({
        descriptor: resolved.authDescriptor,
        ...(input.model ? { model: input.model } : {}),
        ...(input.route?.gateway ? { routeGateway: input.route.gateway } : {}),
        ...(!input.route?.gateway ? { requestedProvider: profile.endpoint as CatalogProvider } : {}),
        requestedMode: authMode,
        // A profile reference is an explicit billing choice. Never consult the
        // ambient environment or a different provider-store key as fallback.
        explicit: true,
        ...(authMode === "subscription" && stored?.value !== undefined
          ? { subscriptionCredential: stored.value }
          : {}),
        ...(authMode === "api-key" && stored?.value !== undefined
          ? { apiKeyConfigCredential: stored.value }
          : {}),
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
          details: { adapter: input.adapter, provider: profile.endpoint },
        }
      }
      throw err
    }
    accessProfileEcho = {
      profileRef: profile.id,
      ...(profile.label !== undefined ? { label: profile.label } : {}),
      endpoint: profile.endpoint,
      method: profile.method,
    }
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
      (authModel ? getModelProvider(authModel) : undefined)
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
  const resolvedBaseUrl = authSpec?.baseUrl ?? input.route?.baseUrl
  const routedOptions =
    !hasExplicitBaseUrlOption &&
    typeof resolvedBaseUrl === "string" &&
    resolvedBaseUrl.length > 0
      ? { ...spawnDefaults.options, base_url: resolvedBaseUrl }
      : spawnDefaults.options
  const effectiveOptions = normalizeSkillsOption(
    spawnDefaults.skills,
    routedOptions,
    resolved?.declaredOptions,
  )
  // Compose the role's disposition (+ optional promptAppend, layered on
  // top, never replacing it) into the initial prompt — the only text
  // channel this codebase has into a freshly-spawned child (there's no
  // separate system-prompt field on `startSession`). No `prompt` at all
  // ⇒ nothing to compose onto; the child still gets the tool gate above,
  // it just doesn't see the disposition until its first turn.
  let effectivePrompt = input.prompt
    ? `${composeRoleContext(role, input.promptAppend, roleRegistry)}\n\n${input.prompt}`
    : input.prompt
  // The session's title must name the CALLER's ask, not whatever text
  // happens to be first in the composed prompt above. `deriveSessionTitle`
  // just takes the first sentence of what it's given — and the composed
  // prompt's first sentence is the role's disposition (e.g. executor's
  // "You are the leaf…"), not `input.prompt`. Derive from `input.prompt`
  // ITSELF, before role/promptAppend composition, so every future prepended
  // block (a skill header, a memory dump, another role field) can't
  // re-introduce this bug by ending up ahead of the caller's actual ask.
  // An explicit `--title` (FIX C) wins over the derivation; a trimmed empty
  // string is treated as "not supplied" so it falls through to the prompt.
  const explicitTitle = input.title?.trim() ? input.title.trim() : undefined
  const initialTitle =
    explicitTitle ?? (input.prompt ? deriveSessionTitle(input.prompt) : undefined)

  // ── retry-safety claim (see SpawnClaim docblock above) ────────────
  // Opt-in: no idempotencyKey ⇒ no map lookup, no behavioural change.
  let settleClaim: ((result: SpawnAgentSessionResult) => void) | undefined
  if (input.idempotencyKey) {
    const claims = claimsFor(registry)
    const key = `${input.adapter}\x1f${cwd}\x1f${input.idempotencyKey}`
    const now = Date.now()
    for (const [k, claim] of claims) {
      if (claim.resolvedAt !== undefined && now - claim.resolvedAt > SPAWN_CLAIM_WINDOW_MS) {
        claims.delete(k)
      }
    }
    const existing = claims.get(key)
    if (existing) {
      const result = await existing.result
      return result.ok ? { ...result, deduped: true } : result
    }
    let resolveClaim!: (result: SpawnAgentSessionResult) => void
    claims.set(key, { result: new Promise(resolve => { resolveClaim = resolve }) })
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
    const resolvedMcpServers = await resolveMcpCredentialHeaders(mcpServers)
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
        // Explicit billing-auth for the box's OWN agent_start. A fresh box
        // has no ~/.agentproto/config.json and claude-code never inherits
        // subscription auth from the shell env — the credential must ride the
        // spawn call itself. Only the caller's EXPLICIT `auth` is forwarded
        // (host config defaults stay host-scoped; the box resolves its own
        // defaults otherwise).
        ...(input.auth ? { auth: input.auth } : {}),
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
      agentSession = await resolved!.startSession({
        cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(Object.keys(effectiveOptions).length > 0
          ? { options: effectiveOptions }
          : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.posture !== undefined ? { posture: input.posture } : {}),
        ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
        ...(authSpec ? { auth: authSpec } : {}),
        ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
        ...(input.permissionHold ? { permissionHold: true } : {}),
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

    const desc = registry.spawnAgent({
      workspaceSlug: resolvedSlug,
      cwd,
      agentSession,
      adapterSlug: input.adapter,
      harness: input.harness ?? input.adapter,
      ...(input.model ? { model: input.model } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.effort ? { effort: input.effort as EffortLevel } : {}),
      ...(input.posture !== undefined ? { posture: input.posture } : {}),
      ...(input.route ? { route: input.route } : {}),
      ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
      ...(accessProfileEcho ? { accessProfile: accessProfileEcho } : {}),
      ...(input.wait && effectivePrompt ? {} : effectivePrompt ? { initialPrompt: effectivePrompt } : {}),
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
      // Parent attribution + depth (WP4) — only set for spawns that
      // arrived via the scoped sub-gateway; root spawns stay
      // parentless at depth 0.
      ...(parentSessionId ? { parentSessionId } : {}),
      depth: childDepth,
      ...(commandPreview ? { commandPreview } : {}),
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
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
      await registry.sendPrompt(desc.id, effectivePrompt)
      const waitLines: string[] = []
      const waitUnsub = registry.attach(desc.id, (line: string) => {
        waitLines.push(line)
      })
      if (waitUnsub) waitUnsub()
      const waitTail = waitLines.slice(-80)
      const output = cleanAgentLines(waitTail)
      return finish({ ok: true, descriptor: desc, output })
    }
    return finish({ ok: true, descriptor: desc })
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
