/**
 * SessionsRegistryAgentHost — implements AgentSessionHost against the
 * runtime's in-process SessionsRegistry + SessionEventBus.
 *
 * This is a near-direct lift of the `spawnSession`/`waitTurnEnd` logic
 * that previously lived inside WorkflowRunner. The logic doesn't change;
 * it moves behind the AgentSessionHost interface so WorkflowRunner can
 * delegate to the workflow-runtime's step-walker.
 */

import { adapterConfigDirFor, mintSessionId, SESSION_ID_ENV, SessionNotAliveError, WORKSPACE_SLUG_ENV, type SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import { AgentSessionLostError } from "@agentproto/workflow-runtime"
import type { AgentHarness, AgentSandboxRef, AgentSessionHost, AgentStep, AgentStepAccess } from "@agentproto/workflow-runtime"
import { SandboxSpecSchema } from "@agentproto/sandbox"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type { AcpMcpServer } from "@agentproto/acp"
import { resolveAccessProfileAuth, shouldInjectDaemonSelfMount, spawnAgentSession, type SandboxSpecInput } from "./session-spawn.js"
import { exportAgentSession } from "./transcript-export.js"
import type { RoutinePolicy } from "./step-run-types.js"
import { AuthResolutionError, normalizeSkillsOption, resolveAuthSpec, resolveSpawnDefaults } from "./spawn-defaults.js"
import { loadConfig } from "./config.js"
import { getProviderKey } from "./providers-store.js"
import { loadImportedSkills, resolveSessionSkills, type ImportedSkillsConfig, type ResolvedSessionSkill } from "./skill-imports.js"
import type { EffortLevel } from "./session-config.js"
import {
  APP_BOUNDARY_UNENFORCEABLE,
  assessBoundaryEnforcement,
  boundaryMeta,
  boundaryToSandboxZones,
  resolveBoundaryPath,
  unenforceableMessage,
  unenforceableWarning,
  type AppBoundary,
} from "./app-boundary.js"
import { reviewWorktreeReadZones } from "./review-worktree.js"

/** Prompt provenance for workflow steps — classified as automated (`isAutomatedPromptSource`)
 *  so a step never revives a retired session. */
const WORKFLOW_PROMPT_SOURCE = "workflow:agent-step"

/** `endedReason`s meaning a session died UNDER its workflow step rather than
 *  being ended on purpose — the only deaths reported as
 *  {@link AgentSessionLostError}, which an agent step's transport `retry`
 *  re-spawns past. Absent is a kill/crash nobody tagged: the 2026-10-08
 *  mid-turn "ACP connection closed" death (`sess_bd64a550`) ended `killed`
 *  with no reason. Every deliberate end (operator kill, cost cap, provider
 *  limit, context hard-stop, steward, restart) carries one and stays a
 *  plain failure. */
const TRANSPORT_END_REASONS: ReadonlySet<string | undefined> = new Set([undefined, "crashed", "daemon-restart"])

/** A prompt rejection that means the session's transport is gone. */
const TRANSPORT_CLOSED_RE = /\bACP connection closed\b/i

/**
 * A step spawned IN a review worktree (`branch_gc_review_worktree`, the
 * maintain workflow's reviewers) gets that worktree and its repo's git common
 * dir as extra READ-ONLY zones for this one session: the worktree lives under
 * the OS tmp dir, outside every app zone, and git cannot read a commit
 * without the repo's object store. Read-only, so a reviewer still cannot
 * stash, checkout or commit in the shared repo. Any other cwd → unchanged.
 */
export function withReviewWorktreeZones(boundary: AppBoundary, cwd: string): AppBoundary {
  const zones = reviewWorktreeReadZones(cwd)
  if (!zones) return boundary
  const extra = [zones.worktree, zones.gitCommonDir].filter(z => !boundary.readOnly.includes(z))
  return extra.length === 0 ? boundary : { ...boundary, readOnly: [...boundary.readOnly, ...extra] }
}

/**
 * The daemon-gateway mount a workflow agent step's (host) session gets —
 * what `agent_start` gives an equivalent spawn, so a `kind:"agent"` step's
 * session can reach daemon tools (e.g. `branch_gc_verdict`) at all.
 *
 *  - The agent declared a `tools` list (AGENT.md `tools:`, carried as
 *    `agentTools`): mount the gateway for ANY adapter, scoped to exactly
 *    that list via `?allowTools=` — the declaration is the capability ask.
 *    Names the gateway doesn't serve (harness-native `run_command`, …)
 *    match nothing; the harness keeps its own tools for those. Deferred
 *    loading is forced off: `tool_search` isn't on the list, so a deferred
 *    tool would be unreachable.
 *  - No list declared: the same default `agent_start` applies
 *    (`shouldInjectDaemonSelfMount` — hermes and on-host claude-code get the
 *    full gateway, other adapters none).
 *
 * Every mount carries `callerSessionId` so calls attribute to the step's
 * session. `undefined` ⇒ mount nothing (no gateway URL wired, or an adapter
 * outside the default set with no declared tools).
 */
export function agentStepMcpServers(input: {
  adapter: string
  daemonMcpUrl: string | undefined
  sessionId: string
  agentTools?: readonly string[]
}): AcpMcpServer[] | undefined {
  const { adapter, daemonMcpUrl, sessionId, agentTools } = input
  if (!daemonMcpUrl) return undefined
  const params = new URLSearchParams()
  if (agentTools !== undefined && agentTools.length > 0) {
    params.set("allowTools", agentTools.join(","))
    params.set("deferred", "0")
  } else if (!shouldInjectDaemonSelfMount(adapter, undefined)) {
    return undefined
  }
  params.set("callerSessionId", sessionId)
  const sep = daemonMcpUrl.includes("?") ? "&" : "?"
  return [{ name: "agentproto", transport: "http", ref: `${daemonMcpUrl}${sep}${params.toString()}` }]
}

/**
 * A step with a declared `tools` allowlist gets a gateway mount scoped to
 * exactly those tools, with the daemon's own deferral already off
 * ({@link agentStepMcpServers}). A harness that ALSO defers MCP tools
 * client-side (claude-code's tool search) would still hide them behind its
 * own search tool — so when the adapter declares a `tool_search` option and
 * the caller didn't set one, turn it off. Adapters without the option are
 * untouched.
 */
export function withAllowlistToolSearchOff(
  options: Record<string, boolean | number | string> | undefined,
  agentTools: readonly string[] | undefined,
  declaredOptions: readonly { id: string }[] | undefined,
): Record<string, boolean | number | string> | undefined {
  if (!agentTools || agentTools.length === 0) return options
  if (!declaredOptions?.some(o => o.id === "tool_search")) return options
  if (options?.tool_search !== undefined) return options
  return { ...(options ?? {}), tool_search: "false" }
}

export class SessionsRegistryAgentHost implements AgentSessionHost {
  private readonly sessionsByLabel = new Map<string, string>()
  /** Sessions this host spawned and hasn't released yet (see
   *  {@link releaseSession} / {@link releaseAll}). */
  private readonly unreleased = new Set<string>()

  constructor(
    private readonly registry: SessionsRegistry,
    private readonly sessionEvents: SessionEventBus,
    private readonly resolveAgentAdapter: AgentAdapterResolver,
    private readonly opts?: {
      workspaceSlug?: string
      cwd?: string
      /** Optional webhook URL for escalation notifications. */
      notifyUrl?: string
      /** Resolves a sandbox provider slug for `AgentStep.sandbox` spawns —
       *  the same resolver `agent_start.sandbox` uses. Omitted ⇒ a sandbox
       *  step fails loudly (`sandbox_provider_not_found`), never silently
       *  spawns on the host. */
      resolveSandboxProvider?: SandboxProviderResolver
      /** The daemon's own plain `/mcp` gateway URL — mounted into host
       *  step sessions per {@link agentStepMcpServers}. Omitted ⇒ step
       *  sessions get no daemon gateway. */
      daemonMcpUrl?: string
      /** The run this host spawns for — step sessions are labelled
       *  `wf:<workflowId>/<stepKey>` and carry `meta.workflowRunId` /
       *  `meta.workflowId` / `meta.workflowStepId`, so they read as the run's
       *  steps instead of anonymous depth-0 roots. Omitted ⇒ the bare
       *  `agent-step:<adapter>` label. */
      run?: { runId: string; workflowId: string }
      /**
       * Durable-suspend handler for an `escalate` policy: awaited instead of
       * throwing immediately, so the caller (WorkflowRunner) can pause the
       * run (`status: "awaiting-input"`) and resume it once an external
       * `resolve()` call supplies the response. Omitted ⇒ escalate fails the
       * step fast, same as before this existed (`onAwaitingInput`'s stub
       * behaviour).
       */
      onEscalate?: (
        sessionId: string,
        policy: Extract<RoutinePolicy, { awaiting: "escalate" }>,
        stepId: string | undefined,
      ) => Promise<string>
      /** Notified every time a step's session id is resolved into
       *  `sessionsByLabel` (both spawn paths) — lets `WorkflowRunner`
       *  maintain a run-spanning sessionId → (runId, stepId) index for the
       *  `run_request_input` MCP tool (AIP-58 §9), without this host
       *  needing to know about runs at all. */
      onSessionLabeled?: (stepId: string, sessionId: string) => void
      /** Notified when a step's spawn BEGINS (before the adapter boots),
       *  keyed by the step's indexed key when it has one — lets
       *  `WorkflowRunner` show the step as `spawning` until
       *  `onSessionLabeled` attaches its session. */
      onSpawnStarted?: (stepKey: string) => void
      /**
       * The run's cancel signal — checked right after a spawn registers its
       * session (see {@link spawn}'s post-registration check). `cancel()`'s
       * own {@link releaseAll} call only reaches sessions already in
       * {@link unreleased} at the moment it runs; a spawn that was still
       * mid-flight (adapter boot in progress) when `cancel()` fired would
       * otherwise register into `unreleased` a moment too late and never get
       * killed, running to completion unobserved. Checking `signal.aborted`
       * again right after registration closes that race. Omitted ⇒ a spawn
       * racing a cancel is never caught here (only `releaseAll` applies).
       */
      signal?: AbortSignal
      /**
       * Fs zones for every session this host spawns (the run belongs to an
       * installed app — see `app-boundary.ts`): native tools are confined by
       * the OS sandbox when the harness supports it, an unenforceable spawn
       * is refused (`boundaries.enforce: required`) or warned about, and the
       * boundary rides on the session's meta so the daemon gateway can
       * confine its file/command tools. Omitted ⇒ unchanged behaviour.
       */
      boundary?: AppBoundary
      /** Imported-skills registry reader for session-skill delivery
       *  (test seam). Omitted ⇒ `~/.agentproto/imported-skills.json`. */
      loadImportedSkills?: () => Promise<ImportedSkillsConfig>
    },
  ) {}

  /** AIP-58 §3(a): pending `run.requestInput` signals, keyed by sessionId —
   *  recorded by `recordInputRequest` (called from the daemon's MCP tool
   *  handler) and consumed by `takeInputRequest` (called by
   *  `execAgentStep` right after a turn ends). */
  private readonly pendingInputRequests = new Map<string, { prompt: string; schema?: Record<string, unknown> }>()

  /** Record an AIP-58 §3(a) `run.requestInput` signal for `sessionId` — does
   *  NOT end the turn; it's read by `takeInputRequest` on the next check. */
  recordInputRequest(sessionId: string, req: { prompt: string; schema?: Record<string, unknown> }): void {
    this.pendingInputRequests.set(sessionId, req)
  }

  /** Consume (and clear) `sessionId`'s pending input request, if any. */
  takeInputRequest(sessionId: string): { prompt: string; schema?: Record<string, unknown> } | undefined {
    const req = this.pendingInputRequests.get(sessionId)
    if (req) this.pendingInputRequests.delete(sessionId)
    return req
  }

  async spawn(
    adapter: string,
    opts: {
      cwd?: string
      workspaceSlug?: string
      stepId?: string
      sandbox?: AgentSandboxRef
      options?: Record<string, boolean | number | string>
      harness?: AgentHarness
      access?: AgentStepAccess
      route?: string
      agentTools?: readonly string[]
      agentWarnings?: readonly string[]
      stepKey?: string
    },
  ): Promise<string> {
    const workspaceSlug = opts.workspaceSlug ?? this.opts?.workspaceSlug ?? "default"
    let cwd = opts.cwd ?? this.opts?.cwd ?? process.cwd()
    const boundary = this.opts?.boundary ? withReviewWorktreeZones(this.opts.boundary, cwd) : undefined
    if (boundary) {
      if (opts.sandbox !== undefined) {
        throw new Error(
          `agent step spawn refused (app_boundary_sandbox): \`sandbox\` spawns are not available inside app '${boundary.appId}' — ` +
            "fs zones cannot follow a session into a remote box",
        )
      }
      try {
        cwd = resolveBoundaryPath(boundary, cwd, "read")
      } catch (err) {
        throw new Error(
          `agent step spawn refused (app_boundary_cwd_outside): cwd is outside the app boundary of '${boundary.appId}': ${(err as Error).message}`,
        )
      }
    }
    const spawnKey = opts.stepKey ?? opts.stepId
    if (spawnKey !== undefined) this.opts?.onSpawnStarted?.(spawnKey)

    // Sandbox spawn: delegate to the same `spawnAgentSession` core the MCP
    // `agent_start` tool uses (session-spawn.ts) so the sandbox boot / secret
    // resolution / proxy path is shared rather than re-implemented here. The
    // host's local adapter registry has no bearing on a sandboxed spawn (the
    // box resolves `adapter` itself), so no local resolveAgentAdapter gate.
    if (opts.sandbox !== undefined) {
      let sandbox: string | SandboxSpecInput
      if (typeof opts.sandbox === "string") {
        sandbox = opts.sandbox
      } else {
        // Validate the workflow-authored inline spec against the same AIP-36
        // schema `agent_start.sandbox` enforces (config defaults to {}). A
        // malformed spec fails the step loudly here, before any boot.
        const parsed = SandboxSpecSchema.safeParse({ config: {}, ...opts.sandbox })
        if (!parsed.success) {
          throw new Error(
            `agent step sandbox spec invalid (provider "${opts.sandbox.provider}"): ${parsed.error.message}`,
          )
        }
        sandbox = parsed.data
      }
      const result = await spawnAgentSession(
        {
          registry: this.registry,
          resolveAgentAdapter: this.resolveAgentAdapter,
          ...(this.opts?.resolveSandboxProvider
            ? { resolveSandboxProvider: this.opts.resolveSandboxProvider }
            : {}),
        },
        {
          adapter,
          cwd,
          workspaceSlug,
          sandbox,
          label: this.stepLabel(adapter, opts),
          origin: "workflow",
          ...(opts.options !== undefined ? { options: opts.options } : {}),
          // AIP-15 P2 harness pinning: model/effort/role/skills all map onto
          // `spawnAgentSession`'s own top-level fields, which already resolve
          // role (against the built-in + pack registry) and fold skills into
          // the adapter's declared options — no duplicate logic needed here.
          ...(opts.harness?.model !== undefined ? { model: opts.harness.model } : {}),
          ...(opts.harness?.effort !== undefined ? { effort: opts.harness.effort } : {}),
          ...(opts.harness?.role !== undefined ? { role: opts.harness.role } : {}),
          ...(opts.access !== undefined ? { access: opts.access } : {}),
          ...(opts.route !== undefined ? { route: { gateway: opts.route } } : {}),
          ...(opts.harness?.skills !== undefined ? { skills: [...opts.harness.skills] } : {}),
          // AGENT.md text — `spawnAgentSession` re-decides the path on the
          // box (sandbox ⇒ its own prefix + never-silent warning; there is
          // no step prompt at spawn time, so the warning is the honest
          // fallback surface).
          ...(opts.harness?.systemPrompt !== undefined
            ? { appendSystemPrompt: opts.harness.systemPrompt }
            : {}),
        },
      )
      if (!result.ok) {
        throw new Error(`agent step sandbox spawn failed (${result.code}): ${result.message}`)
      }
      this.unreleased.add(result.descriptor.id)
      this.recordStepSession(opts, result.descriptor.id)
      await this.killIfCancelledDuringSpawn(result.descriptor.id)
      // `harness.tools` has no generic per-spawn allowlist mechanism this
      // runtime can drive — `run-workflow.ts` already records
      // `toolsApplied: false` on the step's own output; this is the
      // "never silently ignore" warning event alongside it.
      const sandboxWarnings = [...(opts.agentWarnings ?? []), ...(result.warnings ?? [])]
      if (opts.harness?.tools && opts.harness.tools.length > 0) {
        sandboxWarnings.push("harness.tools: no generic per-spawn tool allowlist exists for this adapter — not applied")
      }
      if (sandboxWarnings.length > 0) {
        this.sessionEvents.emit({
          type: "session:harness-warning",
          sessionId: result.descriptor.id,
          warnings: sandboxWarnings,
          ...(opts.stepId ? { label: opts.stepId } : {}),
          ts: new Date().toISOString(),
        })
      }
      return result.descriptor.id
    }

    const resolved = await this.resolveAgentAdapter(adapter)
    if (!resolved) throw new Error(`adapter '${adapter}' not found`)
    // Named billing profile (`AgentStep.access`): resolve it into the same
    // `ResolvedAuthSpec` `agent_start` uses, so a workflow reviewer pinned to
    // a profile bills THAT profile's credential instead of ambient auth. The
    // profile-aware route fallback (`resolvedRouteGateway`) is threaded into
    // the launch auth just as an explicit `route: { gateway }` would be.
    type AccessResolution = Awaited<ReturnType<typeof resolveAccessProfileAuth>>
    let accessAuth: Extract<AccessResolution, { ok: true }> | undefined
    const accessProfileRef = opts.access?.profileRef
    const accessProfileRefs = opts.access?.profileRefs
    if (accessProfileRef !== undefined || (accessProfileRefs?.length ?? 0) > 0) {
      const auth = await resolveAccessProfileAuth({
        adapter,
        ...(accessProfileRef !== undefined ? { profileRef: accessProfileRef } : {}),
        ...(accessProfileRefs !== undefined ? { profileRefs: accessProfileRefs } : {}),
        authDescriptor: resolved.authDescriptor,
        ...(opts.route !== undefined ? { route: { gateway: opts.route } } : {}),
        ...(opts.harness?.model !== undefined ? { model: opts.harness.model } : {}),
        ...(resolved.defaultModel !== undefined ? { defaultModel: resolved.defaultModel } : {}),
      })
      if (!auth.ok) {
        throw new Error(`agent step access profile failed (${auth.code}): ${auth.message}`)
      }
      accessAuth = auth
    }
    const effectiveRoute =
      opts.route !== undefined
        ? { gateway: opts.route }
        : accessAuth?.resolvedRouteGateway !== undefined
          ? { gateway: accessAuth.resolvedRouteGateway }
          : undefined
    // Route WITHOUT a named profile: resolve an auth spec for the gateway the
    // same way `agent_start` does, so the route actually reaches the spawn
    // (base_url + key env + scrub) instead of only being echoed. Without this
    // the descriptor would claim a route the adapter never used.
    let authSpec = accessAuth?.authSpec
    let authEcho = accessAuth?.authEcho
    if (!accessAuth && effectiveRoute !== undefined) {
      if (!resolved.authDescriptor) {
        throw new Error(
          `agent step route "${effectiveRoute.gateway}" cannot be applied: adapter '${adapter}' presents no billing-auth descriptor`,
        )
      }
      const cfg = await loadConfig()
      const spawnDefaults = resolveSpawnDefaults(cfg.defaults, adapter, {})
      const apiKeyStoreCredential =
        spawnDefaults.auth.explicit && spawnDefaults.auth.apiKeyCredential === undefined
          ? await getProviderKey(effectiveRoute.gateway)
          : undefined
      try {
        const result = resolveAuthSpec({
          descriptor: resolved.authDescriptor,
          ...(opts.harness?.model !== undefined ? { model: opts.harness.model } : {}),
          routeGateway: effectiveRoute.gateway,
          ...(spawnDefaults.auth.requestedMode !== undefined
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
          ...(spawnDefaults.auth.provider !== undefined
            ? { requestedProvider: spawnDefaults.auth.provider }
            : {}),
          ...(spawnDefaults.auth.credentialEnvOverride !== undefined
            ? { credentialEnvOverride: spawnDefaults.auth.credentialEnvOverride }
            : {}),
          ...(spawnDefaults.auth.extraEnv !== undefined ? { extraEnv: spawnDefaults.auth.extraEnv } : {}),
          ...(spawnDefaults.auth.isolateDataHome === false ? { isolateDataHome: false } : {}),
        })
        authSpec = result?.spec
        authEcho = result?.echo
      } catch (err) {
        if (err instanceof AuthResolutionError) {
          throw new Error(`agent step route "${effectiveRoute.gateway}" failed: ${err.message}`)
        }
        throw err
      }
    }
    // Minted BEFORE the spawn so it can be injected as AGENTPROTO_SESSION_ID
    // into the child's own env, then reused (not re-minted) on `spawnAgent`.
    const stepSessionId = mintSessionId()
    const harness = opts.harness
    // AIP-15 P2 harness pinning, host (non-sandbox) spawn path. `skills`
    // folds into the adapter's declared option the same way `spawn-defaults
    // .ts`'s `normalizeSkillsOption` does for `spawnAgentSession` — this path
    // just isn't wired through that richer pipeline at all, so it's applied
    // directly here instead of duplicating role/orchestrator machinery this
    // simplified host has never composed for any step, harness or not.
    const harnessOptions = withAllowlistToolSearchOff(
      harness?.skills && harness.skills.length > 0
        ? normalizeSkillsOption([...harness.skills], opts.options ?? {}, resolved.declaredOptions)
        : opts.options,
      opts.agentTools,
      resolved.declaredOptions,
    )
    // What the harness can't honour of the step's agent manifest
    // (agent-projection.ts) — surfaced with this path's own warnings.
    const harnessWarnings: string[] = [...(opts.agentWarnings ?? [])]
    // Session-skill delivery (claude-code, opencode: imported skills copied
    // into the session's config dir), the same resolution `agent_start`
    // runs (session-spawn.ts) — without it a step's `harness.skills` (an
    // AGENT.md's declared skills included) reached only adapters with a
    // `skills` OPTION and vanished silently everywhere else.
    let sessionSkills: ResolvedSessionSkill[] = []
    if (resolved.deliversSessionSkills && harness?.skills && harness.skills.length > 0) {
      const resolvedSkills = resolveSessionSkills([...harness.skills], await (this.opts?.loadImportedSkills ?? loadImportedSkills)())
      sessionSkills = resolvedSkills.resolved
      harnessWarnings.push(...resolvedSkills.warnings)
    }
    if (harness?.tools && harness.tools.length > 0) {
      harnessWarnings.push(
        "harness.tools: no generic per-spawn tool allowlist exists for this adapter — not applied",
      )
    }
    if (harness?.role !== undefined) {
      // Unlike the sandboxed branch (which routes through `spawnAgentSession`
      // and gets full role resolution + tool-policy gating), this direct
      // host path never composes an orchestrator/tool-policy surface for
      // ANY step — so `harness.role` has no effect here today. Warn rather
      // than silently pretend it took hold.
      harnessWarnings.push(
        `harness.role ("${harness.role}"): this spawn path applies no role-based tool policy — not applied`,
      )
    }
    // AGENT.md system-prompt channel (harness.systemPrompt, compiled from
    // the agent ref's projected `systemPrompt`): a channel-capable adapter
    // takes it through `startSession({ appendSystemPrompt })`. This host
    // path has NO prompt at spawn time (the step's prompt arrives later via
    // `agent_prompt`), so an adapter without a usable channel gets the
    // never-silent warning here — there is nothing to prefix onto yet.
    // Same two extra conditions as `session-spawn.ts`: the channel must be
    // declared AND live (no `systemPromptUnavailable` reason), and the text
    // must fit its `systemPromptMaxChars` budget.
    const appendSystemPrompt =
      harness?.systemPrompt !== undefined &&
      resolved.supportsSystemPrompt === true &&
      !(
        resolved.systemPromptMaxChars !== undefined &&
        harness.systemPrompt.length > resolved.systemPromptMaxChars
      )
        ? harness.systemPrompt
        : undefined
    if (harness?.systemPrompt !== undefined && appendSystemPrompt === undefined) {
      // Inside this branch the text exists but didn't ride the channel:
      // either the adapter has none (today), or it has one and the text
      // exceeded its budget.
      harnessWarnings.push(
        resolved.supportsSystemPrompt !== true
          ? `harness.systemPrompt: this harness has no system-prompt channel — the AGENT.md text is not delivered.` +
              (resolved.systemPromptUnavailable !== undefined
                ? ` (${resolved.systemPromptUnavailable})`
                : "")
          : `harness.systemPrompt: the text is ${harness.systemPrompt.length} chars, over this harness's ${resolved.systemPromptMaxChars}-char system-prompt limit — not delivered.`,
      )
    }
    let fsZones: ReturnType<typeof boundaryToSandboxZones> | undefined
    let isolateHostContext = false
    if (boundary) {
      const enforcement = assessBoundaryEnforcement({
        harnessSupportsFsZones: resolved.supportsFsZones === true,
      })
      if (enforcement.enforced) {
        fsZones = boundaryToSandboxZones(boundary)
      } else if (boundary.enforce === "required") {
        throw new Error(
          `agent step spawn refused (${APP_BOUNDARY_UNENFORCEABLE}): ${unenforceableMessage(boundary, enforcement.reasons)}`,
        )
      } else {
        harnessWarnings.push(unenforceableWarning(boundary, enforcement.reasons))
      }
      if (resolved.supportsHostContextIsolation) {
        isolateHostContext = true
      } else {
        harnessWarnings.push(
          `app '${boundary.appId}': this harness cannot exclude the host repository's ` +
            "CLAUDE.md/AGENTS.md — host instructions may be loaded into the session.",
        )
      }
    }
    const mcpServers = agentStepMcpServers({
      adapter,
      daemonMcpUrl: this.opts?.daemonMcpUrl,
      sessionId: stepSessionId,
      ...(opts.agentTools !== undefined ? { agentTools: opts.agentTools } : {}),
    })
    const agentSession = await resolved.startSession({
      cwd,
      ...(fsZones ? { fsZones } : {}),
      ...(isolateHostContext ? { isolateHostContext: true } : {}),
      configDir: adapterConfigDirFor(stepSessionId),
      env: {
        [SESSION_ID_ENV]: stepSessionId,
        [WORKSPACE_SLUG_ENV]: workspaceSlug,
      },
      ...(harnessOptions !== undefined ? { options: harnessOptions } : {}),
      ...(harness?.model !== undefined ? { model: harness.model } : {}),
      ...(harness?.effort !== undefined ? { effort: harness.effort } : {}),
      ...(authSpec !== undefined ? { auth: authSpec } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(sessionSkills.length > 0 ? { sessionSkills } : {}),
      ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    })
    const desc = this.registry.spawnAgent({
      id: stepSessionId,
      workspaceSlug,
      cwd,
      agentSession,
      adapterSlug: adapter,
      adapterConfigDir: adapterConfigDirFor(stepSessionId),
      label: this.stepLabel(adapter, opts),
      origin: "workflow",
      ...(this.opts?.run || boundary
        ? {
            meta: {
              ...(this.opts?.run
                ? {
                    workflowRunId: this.opts.run.runId,
                    workflowId: this.opts.run.workflowId,
                    ...(opts.stepKey ?? opts.stepId ? { workflowStepId: (opts.stepKey ?? opts.stepId)! } : {}),
                  }
                : {}),
              ...(boundary ? boundaryMeta(boundary) : {}),
            },
          }
        : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(sessionSkills.length > 0 ? { sessionSkills } : {}),
      // Recorded regardless of delivery path, like `spawnAgentSession`
      // does, so a later restart/fresh-continuation still knows the text.
      ...(harness?.systemPrompt !== undefined
        ? { appendSystemPrompt: harness.systemPrompt }
        : {}),
      ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
      // Echo the pinned model/effort onto the descriptor the way agent_start
      // does (session-spawn.ts), so a `wf:*` step session shows its model —
      // `startSession` above already applied them; this is the display echo.
      ...(harness?.model !== undefined ? { model: harness.model } : {}),
      ...(harness?.effort !== undefined ? { effort: harness.effort as EffortLevel } : {}),
      ...(accessAuth ? { accessProfile: accessAuth.accessProfileEcho } : {}),
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
      ...(effectiveRoute !== undefined ? { route: effectiveRoute } : {}),
    })
    this.unreleased.add(desc.id)
    this.recordStepSession(opts, desc.id)
    await this.killIfCancelledDuringSpawn(desc.id)
    if (harnessWarnings.length > 0) {
      this.sessionEvents.emit({
        type: "session:harness-warning",
        sessionId: desc.id,
        warnings: harnessWarnings,
        ...(opts.stepId ? { label: opts.stepId } : {}),
        ts: new Date().toISOString(),
      })
    }
    return desc.id
  }

  /** `wf:<workflowId>/<stepKey>` for a run-bound host, else the legacy
   *  `agent-step:<adapter>`. */
  private stepLabel(adapter: string, opts: { stepId?: string; stepKey?: string }): string {
    const key = opts.stepKey ?? opts.stepId
    if (this.opts?.run && key) return `wf:${this.opts.run.workflowId}/${key}`
    return `agent-step:${adapter}`
  }

  /** Index a freshly spawned session under its step id (for `sessionRef`
   *  reuse — last spawn wins, as before) AND its indexed step key, so a
   *  `map` item's step record (`review[3]`) resolves to its own session. */
  private recordStepSession(opts: { stepId?: string; stepKey?: string }, sessionId: string): void {
    if (opts.stepId) {
      this.sessionsByLabel.set(opts.stepId, sessionId)
      this.opts?.onSessionLabeled?.(opts.stepId, sessionId)
    }
    if (opts.stepKey && opts.stepKey !== opts.stepId) {
      this.sessionsByLabel.set(opts.stepKey, sessionId)
      this.opts?.onSessionLabeled?.(opts.stepKey, sessionId)
    }
  }

  /**
   * Closes the race between `cancel()`'s `releaseAll()` (which only reaches
   * sessions already in {@link unreleased} at the moment it runs) and a
   * spawn that was still mid-flight (adapter boot) when the cancel fired:
   * `releaseAll` misses it, `unreleased.add` for THIS session then runs a
   * moment too late, and — without this — the session runs to completion
   * entirely unobserved by the cancel. Called right after a spawn registers
   * its session; re-checks the signal and, if the run was cancelled in the
   * meantime, kills the session immediately and throws, so the step doesn't
   * go on to prompt a session that's already dead.
   */
  private async killIfCancelledDuringSpawn(sessionId: string): Promise<void> {
    if (!this.opts?.signal?.aborted) return
    await this.releaseSession(sessionId)
    throw new Error(`run cancelled while session '${sessionId}' was spawning — killed immediately`)
  }

  /**
   * The run is done with `sessionId`: end it if it's still live (the same
   * graceful close `agent_kill` does) and archive it, so finished steps
   * don't linger as idle adapter processes / open rows. The id stays on the
   * step record and the transcript stays readable. Only sessions this host
   * spawned are touched; a second call is a no-op.
   */
  async releaseSession(sessionId: string): Promise<void> {
    if (!this.unreleased.delete(sessionId)) return
    const desc = this.registry.get(sessionId)
    if (!desc) return
    // Best-effort: a failed kill/archive must never fail the step or the
    // cancel that triggered it.
    try {
      if (desc.status === "running" || desc.status === "starting") this.registry.kill(sessionId)
      if (!desc.archived) this.registry.archiveSession(sessionId)
    } catch {
      // Still live (kill refused) — leave it visible rather than hide it.
    }
  }

  /** Release every session this host spawned and hasn't released yet — the
   *  run was cancelled (the engine never sees an abort mid-turn, so its own
   *  scope release would only fire once each turn happened to end). Killing
   *  an in-flight step's session also ends that step's wait. */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.unreleased].map(id => this.releaseSession(id)))
  }

  /**
   * `waitTurnEnd` subscribes before `sendPrompt` is even called, so a cancel
   * that kills the session WHILE `sendPrompt` is still in flight (the whole
   * turn, for an on-host claude-code step) rejects `turnEnded` before either
   * promise had a `.then`/`.catch` attached to it — an unhandled rejection
   * that crashes the daemon process outright (not just this run). Passing
   * both to `Promise.all` in the same expression attaches a handler to each
   * synchronously, before the event bus can fire the rejection asynchronously.
   */
  async sendPromptAndWait(sessionId: string, prompt: string): Promise<void> {
    await Promise.all([
      this.waitTurnEnd(sessionId),
      this.registry
        .sendPrompt(sessionId, prompt, { source: WORKFLOW_PROMPT_SOURCE })
        .catch((err: unknown) => {
          throw this.classifyPromptFailure(sessionId, err)
        }),
    ])
  }

  /** True when `sessionId` dying (with `reason`) is the session's transport
   *  failing under the step — not this host's own cancel/release, and not a
   *  deliberate end (see {@link TRANSPORT_END_REASONS}). */
  private diedUnderStep(sessionId: string, reason: string | undefined): boolean {
    if (this.opts?.signal?.aborted) return false
    if (!this.unreleased.has(sessionId)) return false
    return TRANSPORT_END_REASONS.has(reason)
  }

  /** The error a wait rejects with when the session ends mid-turn. */
  private sessionEndedError(sessionId: string, status: string, reason: string | undefined): Error {
    const message = `session ${sessionId} ended with status '${status}'${reason ? ` (${reason})` : ""}`
    return this.diedUnderStep(sessionId, reason) ? new AgentSessionLostError(sessionId, message) : new Error(message)
  }

  /** `registry.sendPrompt` rejected: a closed ACP connection or an already-
   *  dead session is a transport loss ({@link AgentSessionLostError});
   *  anything else propagates unchanged. */
  private classifyPromptFailure(sessionId: string, err: unknown): unknown {
    if (!(err instanceof Error)) return err
    const desc = this.registry.get(sessionId)
    const dead =
      err instanceof SessionNotAliveError ||
      TRANSPORT_CLOSED_RE.test(err.message) ||
      desc?.status === "killed" ||
      desc?.status === "error"
    if (!dead || !this.diedUnderStep(sessionId, desc?.endedReason)) return err
    return new AgentSessionLostError(sessionId, `session ${sessionId} lost before its turn ended — ${err.message}`, err)
  }

  resolveByLabel(stepId: string): string | undefined {
    return this.sessionsByLabel.get(stepId)
  }

  /** Pass-through behind `AgentSessionHost.emitHarnessWarning` — the runtime
   *  uses it for `harness.knowledge` empty matches (`knowledge-empty`); it
   *  surfaces as the same `session:harness-warning` event #1144 introduced. */
  emitHarnessWarning(input: {
    sessionId: string
    warnings: readonly string[]
    label?: string
  }): void {
    this.sessionEvents.emit({
      type: "session:harness-warning",
      sessionId: input.sessionId,
      warnings: [...input.warnings],
      ...(input.label ? { label: input.label } : {}),
      ts: new Date().toISOString(),
    })
  }

  /** Reverse lookup: the step id that spawned `sessionId`, if any — used to
   *  locate an escalated step's position for `onEscalate`. */
  private labelForSession(sessionId: string): string | undefined {
    for (const [label, sid] of this.sessionsByLabel) {
      if (sid === sessionId) return label
    }
    return undefined
  }

  async onAwaitingInput(
    sessionId: string,
    policy: NonNullable<AgentStep["policy"]>,
  ): Promise<void> {
    const desc = this.registry.get(sessionId)
    if (!desc?.awaitingInput) return

    if (policy.awaiting === "auto-allow") {
      await this.sendPromptAndWait(sessionId, policy.prompt)
    } else if (policy.awaiting === "escalate") {
      const escalateUrl = policy.webhookUrl ?? this.opts?.notifyUrl
      if (escalateUrl) {
        void fetch(escalateUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "workflow:awaiting-input",
            sessionId,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined)
      }
      if (this.opts?.onEscalate) {
        // Durable suspend: wait for the injected handler's external answer,
        // then send it and resume the step as usual.
        const response = await this.opts.onEscalate(sessionId, policy, this.labelForSession(sessionId))
        await this.sendPromptAndWait(sessionId, response)
        return
      }
      // No suspend handler wired: throw so the caller knows this step is
      // awaiting external input.
      throw new Error(`step escalated: session ${sessionId} awaiting input`)
    } else {
      throw new Error(`step failed: session ${sessionId} awaiting input`)
    }
  }

  async readFinalMessage(sessionId: string): Promise<string> {
    const result = await exportAgentSession({
      sessionId,
      registry: this.registry,
      format: "json",
    })
    // exportAgentSession returns a non-JSON `content` ("Error: …") when the
    // session can't be exported; degrade to "" (→ the interpreter re-prompts)
    // rather than throwing a raw SyntaxError out of the workflow.
    let raw: unknown
    try {
      raw = JSON.parse(result.content)
    } catch {
      return ""
    }
    if (typeof raw !== "object" || raw === null) return ""
    if (!("messages" in raw)) return ""
    const msgList = raw.messages
    if (!Array.isArray(msgList)) return ""
    for (let i = msgList.length - 1; i >= 0; i--) {
      const m = msgList[i]
      if (typeof m !== "object" || m === null) continue
      if (!("role" in m)) continue
      if (m.role !== "assistant") continue
      if (!("text" in m)) continue
      const text = m.text
      if (typeof text === "string" && text.trim()) {
        return text
      }
    }
    return ""
  }

  async readCostUsd(sessionId: string): Promise<number> {
    const desc = this.registry.get(sessionId)
    return desc?.costUsd ?? 0
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private waitTurnEnd(sessionId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const unsubs: Array<() => void> = []
      const done = (): void => {
        for (const u of unsubs) u()
        resolve()
      }
      const fail = (reason: string | Error): void => {
        for (const u of unsubs) u()
        reject(typeof reason === "string" ? new Error(reason) : reason)
      }
      unsubs.push(
        this.sessionEvents.on("session:turn-end", (ev) => {
          if (ev.sessionId !== sessionId) return
          // An empty turn — no assistant output, no tool call, not awaiting
          // input — is a silent no-op: e.g. the adapter's underlying CLI hit
          // "Authentication required" and returned nothing. Fail the step so
          // the workflow run reports `status: "failed"` instead of a false
          // "done", letting the caller fall back instead of passing blind.
          if (ev.empty === true) {
            fail(
              `session ${sessionId} produced an empty turn — no assistant output or ` +
                `tool call (commonly an auth failure or an invalid model id)`,
            )
          } else if (ev.reason === "error") {
            // A turn that ended in error (e.g. the adapter surfaced a 401 as a
            // `[claude-sdk error]` chunk then returned stopReason "refusal")
            // is NOT empty — the error text is output — so the empty-turn
            // guard above misses it. Fail the step so the workflow reports
            // `status: "failed"` instead of a false "done", letting the caller
            // fall back instead of passing blind.
            fail(
              `session ${sessionId} ended its turn with reason 'error' — the ` +
                `adapter reported a failed turn (commonly an auth failure)`,
            )
          } else {
            done()
          }
        }),
      )
      unsubs.push(
        this.sessionEvents.on("session:awaiting-input", (ev) => {
          if (ev.sessionId === sessionId) done()
        }),
      )
      unsubs.push(
        this.sessionEvents.on("session:exited", (ev) => {
          if (ev.sessionId !== sessionId) return
          // Reject on terminal-error/killed so step failures propagate to
          // the workflow run as `status: "failed"` — as AgentSessionLostError
          // when it died under the step, so a transport `retry` re-spawns.
          // Plain "exited" (clean exit code 0 path) resolves normally.
          if (ev.status === "killed" || ev.status === "error") {
            fail(this.sessionEndedError(sessionId, ev.status, ev.reason))
          } else {
            done()
          }
        }),
      )
      // Eagerly settle if the session is already in a terminal state.
      const desc = this.registry.get(sessionId)
      if (desc?.status === "exited" || desc?.awaitingInput === true) {
        done()
      } else if (desc?.status === "killed" || desc?.status === "error") {
        fail(this.sessionEndedError(sessionId, desc.status, desc.endedReason))
      }
    })
  }
}
