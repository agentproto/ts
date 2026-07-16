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
} from "./spawn-defaults.js"
import { getProviderKey } from "./providers-store.js"
import { getModelProvider } from "@agentproto/model-catalog/llm"
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
}

export interface SpawnAgentSessionInput {
  adapter: string
  cwd?: string
  workspaceSlug?: string
  /** Reattach to a pre-existing adapter-native session (claude-code's
   *  conversation id, hermes' chat handle, …) instead of starting
   *  blank. Not exposed on the MCP `agent_start` tool today — only the
   *  HTTP route (`sessions restart`) passes this. */
  resumeSessionId?: string
  prompt?: string
  label?: string
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
        | "agent_spawn_failed"
        | "sandbox_provider_not_found"
        | "sandbox_boot_failed"
        | "sandbox_reconnect_failed"
        | "sandbox_proxy_failed"
      message: string
      details?: Record<string, unknown>
    }

export async function spawnAgentSession(
  deps: SpawnAgentSessionDeps,
  input: SpawnAgentSessionInput,
): Promise<SpawnAgentSessionResult> {
  const {
    registry,
    resolveAgentAdapter,
    buildOrchestratorMcp,
    daemonMcpUrl,
    callerScope,
    webhookNotifier,
    loadDefaultsConfig,
    resolveSandboxProvider,
  } = deps

  // cwd resolution mirrors the HTTP route: explicit cwd wins,
  // then workspaceSlug lookup, then active workspace, then a
  // hard error (the operator probably forgot a step).
  let cwd = input.cwd
  let resolvedSlug = input.workspaceSlug
  if (!cwd || !resolvedSlug) {
    try {
      const config = await loadWorkspacesConfig()
      if (!cwd) {
        const ws = input.workspaceSlug
          ? findWorkspace(config, input.workspaceSlug)
          : getActiveWorkspace(config)
        if (ws) {
          cwd = ws.path
          resolvedSlug = ws.slug
        }
      } else if (!resolvedSlug) {
        // cwd provided but no explicit workspaceSlug — try to match
        // cwd against a registered workspace so the session lands in
        // the right workspace instead of the global default.
        const ws = findWorkspaceByPath(config, cwd)
        if (ws) {
          resolvedSlug = ws.slug
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
    return {
      ok: false,
      code: "adapter_not_found",
      message: `agent_start: adapter "${input.adapter}" not found. Try \`agentproto install <slug>\` first.`,
    }
  }
  // ── Recursion guardrails (WP4) ──────────────────────────────
  // When this call arrives through the scoped sub-gateway,
  // `callerScope` is the spawning orchestrator's identity. Enforce
  // the depth cap and per-parent child quota BEFORE spawning, and
  // compute the new session's parent attribution. A direct `/mcp`
  // spawn (no callerScope) is a root: depth 0, no parent, no caps.
  const childDepth = callerScope ? callerScope.depth + 1 : 0
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
  let authSpec: ResolvedAuthSpec | undefined
  let authEcho: AuthEcho | undefined
  if (resolved && input.sandbox === undefined && resolved.authDescriptor) {
    const authModel = input.model ?? resolved.defaultModel
    const pinnedProvider = spawnDefaults.auth.provider
    const resolvedProvider =
      pinnedProvider ??
      resolved.authDescriptor.provider ??
      (authModel ? getModelProvider(authModel) : undefined)
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
      resolvedProvider &&
      spawnDefaults.auth.explicit &&
      spawnDefaults.auth.apiKeyCredential === undefined
        ? await getProviderKey(resolvedProvider)
        : undefined
    try {
      const result = resolveAuthSpec({
        descriptor: resolved.authDescriptor,
        ...(authModel ? { model: authModel } : {}),
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
  }
  const effectiveOptions = normalizeSkillsOption(
    spawnDefaults.skills,
    spawnDefaults.options,
    resolved?.declaredOptions,
  )
  // Compose the role's disposition (+ optional promptAppend, layered on
  // top, never replacing it) into the initial prompt — the only text
  // channel this codebase has into a freshly-spawned child (there's no
  // separate system-prompt field on `startSession`). No `prompt` at all
  // ⇒ nothing to compose onto; the child still gets the tool gate above,
  // it just doesn't see the disposition until its first turn.
  const effectivePrompt = input.prompt
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
  const initialTitle = input.prompt ? deriveSessionTitle(input.prompt) : undefined

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
        ...(authSpec ? { auth: authSpec } : {}),
        ...(resolvedMcpServers ? { mcpServers: resolvedMcpServers } : {}),
        ...(input.permissionHold ? { permissionHold: true } : {}),
        onActivity: () => {
          if (liveSessionId) registry.pulseActivity(liveSessionId)
        },
      })
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
      ...(input.model ? { model: input.model } : {}),
      ...(input.wait && effectivePrompt ? {} : effectivePrompt ? { initialPrompt: effectivePrompt } : {}),
      ...(input.label ? { label: input.label } : {}),
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
