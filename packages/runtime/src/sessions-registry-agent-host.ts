/**
 * SessionsRegistryAgentHost — implements AgentSessionHost against the
 * runtime's in-process SessionsRegistry + SessionEventBus.
 *
 * This is a near-direct lift of the `spawnSession`/`waitTurnEnd` logic
 * that previously lived inside WorkflowRunner. The logic doesn't change;
 * it moves behind the AgentSessionHost interface so WorkflowRunner can
 * delegate to the workflow-runtime's step-walker.
 */

import { adapterConfigDirFor, mintSessionId, SESSION_ID_ENV, WORKSPACE_SLUG_ENV, type SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { AgentHarness, AgentSandboxRef, AgentSessionHost, AgentStep } from "@agentproto/workflow-runtime"
import { SandboxSpecSchema } from "@agentproto/sandbox"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import type { AcpMcpServer } from "@agentproto/acp"
import { shouldInjectDaemonSelfMount, spawnAgentSession, type SandboxSpecInput } from "./session-spawn.js"
import { exportAgentSession } from "./transcript-export.js"
import type { RoutinePolicy } from "./step-run-types.js"
import { normalizeSkillsOption } from "./spawn-defaults.js"

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
      agentTools?: readonly string[]
      stepKey?: string
    },
  ): Promise<string> {
    const workspaceSlug = opts.workspaceSlug ?? this.opts?.workspaceSlug ?? "default"
    const cwd = opts.cwd ?? this.opts?.cwd ?? process.cwd()

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
          ...(opts.harness?.skills !== undefined ? { skills: [...opts.harness.skills] } : {}),
        },
      )
      if (!result.ok) {
        throw new Error(`agent step sandbox spawn failed (${result.code}): ${result.message}`)
      }
      this.unreleased.add(result.descriptor.id)
      this.recordStepSession(opts, result.descriptor.id)
      // `harness.tools` has no generic per-spawn allowlist mechanism this
      // runtime can drive — `run-workflow.ts` already records
      // `toolsApplied: false` on the step's own output; this is the
      // "never silently ignore" warning event alongside it.
      if (opts.harness?.tools && opts.harness.tools.length > 0) {
        this.sessionEvents.emit({
          type: "session:harness-warning",
          sessionId: result.descriptor.id,
          warnings: [
            "harness.tools: no generic per-spawn tool allowlist exists for this adapter — not applied",
          ],
          ...(opts.stepId ? { label: opts.stepId } : {}),
          ts: new Date().toISOString(),
        })
      }
      return result.descriptor.id
    }

    const resolved = await this.resolveAgentAdapter(adapter)
    if (!resolved) throw new Error(`adapter '${adapter}' not found`)
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
    const harnessOptions =
      harness?.skills && harness.skills.length > 0
        ? normalizeSkillsOption([...harness.skills], opts.options ?? {}, resolved.declaredOptions)
        : opts.options
    const harnessWarnings: string[] = []
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
    const mcpServers = agentStepMcpServers({
      adapter,
      daemonMcpUrl: this.opts?.daemonMcpUrl,
      sessionId: stepSessionId,
      ...(opts.agentTools !== undefined ? { agentTools: opts.agentTools } : {}),
    })
    const agentSession = await resolved.startSession({
      cwd,
      configDir: adapterConfigDirFor(stepSessionId),
      env: {
        [SESSION_ID_ENV]: stepSessionId,
        [WORKSPACE_SLUG_ENV]: workspaceSlug,
      },
      ...(harnessOptions !== undefined ? { options: harnessOptions } : {}),
      ...(harness?.model !== undefined ? { model: harness.model } : {}),
      ...(harness?.effort !== undefined ? { effort: harness.effort } : {}),
      ...(mcpServers ? { mcpServers } : {}),
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
      ...(this.opts?.run
        ? {
            meta: {
              workflowRunId: this.opts.run.runId,
              workflowId: this.opts.run.workflowId,
              ...(opts.stepKey ?? opts.stepId ? { workflowStepId: (opts.stepKey ?? opts.stepId)! } : {}),
            },
          }
        : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
    })
    this.unreleased.add(desc.id)
    this.recordStepSession(opts, desc.id)
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

  async sendPromptAndWait(sessionId: string, prompt: string): Promise<void> {
    const turnEnded = this.waitTurnEnd(sessionId)
    await this.registry.sendPrompt(sessionId, prompt)
    await turnEnded
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
      const turnEnded = this.waitTurnEnd(sessionId)
      await this.registry.sendPrompt(sessionId, policy.prompt)
      await turnEnded
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
      const fail = (reason: string): void => {
        for (const u of unsubs) u()
        reject(new Error(reason))
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
          // the workflow run as `status: "failed"`. Plain "exited" (clean
          // exit code 0 path) resolves normally.
          if (ev.status === "killed" || ev.status === "error") {
            fail(`session ${sessionId} ended with status '${ev.status}'`)
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
        fail(`session ${sessionId} ended with status '${desc.status}'`)
      }
    })
  }
}
