/**
 * SessionsRegistryAgentHost — implements AgentSessionHost against the
 * runtime's in-process SessionsRegistry + SessionEventBus.
 *
 * This is a near-direct lift of the `spawnSession`/`waitTurnEnd` logic
 * that previously lived inside WorkflowRunner. The logic doesn't change;
 * it moves behind the AgentSessionHost interface so WorkflowRunner can
 * delegate to the workflow-runtime's step-walker.
 */

import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { AgentAdapterResolver } from "./http-server.js"
import type { AgentSandboxRef, AgentSessionHost, AgentStep } from "@agentproto/workflow-runtime"
import { SandboxSpecSchema } from "@agentproto/sandbox"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import { spawnAgentSession, type SandboxSpecInput } from "./session-spawn.js"
import { exportAgentSession } from "./transcript-export.js"

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
    },
  ) {}

  async spawn(
    adapter: string,
    opts: { cwd?: string; workspaceSlug?: string; stepId?: string; sandbox?: AgentSandboxRef },
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
        },
      )
      if (!result.ok) {
        throw new Error(`agent step sandbox spawn failed (${result.code}): ${result.message}`)
      }
      if (opts.stepId) {
        this.sessionsByLabel.set(opts.stepId, result.descriptor.id)
      }
      return result.descriptor.id
    }

    const resolved = await this.resolveAgentAdapter(adapter)
    if (!resolved) throw new Error(`adapter '${adapter}' not found`)
    const agentSession = await resolved.startSession({ cwd })
    const desc = this.registry.spawnAgent({
      workspaceSlug,
      cwd,
      agentSession,
      adapterSlug: adapter,
      label: `agent-step:${adapter}`,
      ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
    })
    if (opts.stepId) {
      this.sessionsByLabel.set(opts.stepId, desc.id)
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
      // Escalate: throw so the caller knows this step is awaiting external input.
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
