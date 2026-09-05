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
import { spawnAgentSession, type SandboxSpecInput } from "./session-spawn.js"
import { exportAgentSession } from "./transcript-export.js"
import type { RoutinePolicy } from "./step-run-types.js"
import { normalizeSkillsOption } from "./spawn-defaults.js"

export class SessionsRegistryAgentHost implements AgentSessionHost {
  private readonly sessionsByLabel = new Map<string, string>()

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
    },
  ) {}

  async spawn(
    adapter: string,
    opts: {
      cwd?: string
      workspaceSlug?: string
      stepId?: string
      sandbox?: AgentSandboxRef
      options?: Record<string, boolean | number | string>
      harness?: AgentHarness
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
          label: `agent-step:${adapter}`,
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
      if (opts.stepId) {
        this.sessionsByLabel.set(opts.stepId, result.descriptor.id)
      }
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
    })
    const desc = this.registry.spawnAgent({
      id: stepSessionId,
      workspaceSlug,
      cwd,
      agentSession,
      adapterSlug: adapter,
      adapterConfigDir: adapterConfigDirFor(stepSessionId),
      label: `agent-step:${adapter}`,
      ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
    })
    if (opts.stepId) {
      this.sessionsByLabel.set(opts.stepId, desc.id)
    }
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

  async sendPromptAndWait(sessionId: string, prompt: string): Promise<void> {
    const turnEnded = this.waitTurnEnd(sessionId)
    await this.registry.sendPrompt(sessionId, prompt)
    await turnEnded
  }

  resolveByLabel(stepId: string): string | undefined {
    return this.sessionsByLabel.get(stepId)
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
