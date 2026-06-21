/**
 * Completion-policy supervisor — WP1 (MVP).
 *
 * State machine per attached policy:
 *   watching → gating → acting → done
 *                    ↘ blocked   (gate failed)
 *   watching → cancelled  (watched session exited before turn-end)
 *
 * Trigger: session:turn-end on the watched session.
 * Gate: optional shell command via the same allowlist + cwd-anchor as
 *       execute_command. exit 0 = pass.
 * Action (then:"emit"): emits policy:passed / policy:failed on the bus
 *       (readable via poll_events).
 *
 * In-memory only for WP1. Persistence is WP3.
 */

import { randomUUID } from "node:crypto"
import { basename } from "node:path"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import { runCommand, loadAllowlist, makeCwdAnchor } from "./command-tools.js"

// ── Public types ─────────────────────────────────────────────────────

export interface ShellGateSpec {
  command: string
  args?: string[]
  /** Working directory for the gate command. Defaults to the watched
   *  session's cwd, anchored to the workspace. */
  cwd?: string
  timeoutMs?: number
}

export interface AttachPolicyInput {
  /** Session id whose turn-end triggers the policy. */
  sessionId: string
  /** Optional shell gate. Absent → always pass immediately. */
  gate?: ShellGateSpec
  /** Only "emit" is supported in WP1. */
  then: "emit"
}

export type PolicyRunStatus =
  | "watching"
  | "gating"
  | "acting"
  | "done"
  | "blocked"
  | "cancelled"

export interface PolicyRunState {
  policyId: string
  sessionId: string
  status: PolicyRunStatus
  startedAt: string
  endedAt?: string
  lastGate?: { exitCode: number; at: string }
  error?: string
}

export interface CompletionPolicySupervisor {
  /**
   * Attach a completion policy to an already-running session.
   * Returns immediately with the initial (watching) state.
   * The state machine runs in the background.
   */
  attach(input: AttachPolicyInput): PolicyRunState
  getStatus(policyId: string): PolicyRunState | undefined
  cancel(policyId: string): void
  list(): PolicyRunState[]
}

// ── Internal ─────────────────────────────────────────────────────────

interface RunEntry {
  state: PolicyRunState
  unsubscribes: Array<() => void>
  cancelled: boolean
}

// ── Factory ──────────────────────────────────────────────────────────

export function createCompletionPolicySupervisor(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  workspace: string
}): CompletionPolicySupervisor {
  const { registry, sessionEvents, workspace } = opts
  const runs = new Map<string, RunEntry>()
  const anchorCwd = makeCwdAnchor(workspace)

  return {
    attach(input) {
      const policyId = `policy_${randomUUID().slice(0, 8)}`
      const state: PolicyRunState = {
        policyId,
        sessionId: input.sessionId,
        status: "watching",
        startedAt: new Date().toISOString(),
      }
      const unsubs: Array<() => void> = []
      const entry: RunEntry = { state, unsubscribes: unsubs, cancelled: false }
      runs.set(policyId, entry)

      let settled = false
      const cleanup = () => {
        if (settled) return
        settled = true
        for (const u of unsubs) u()
      }

      const emitFailed = (exitCode: number | undefined, error?: string) => {
        if (error) state.error = error
        state.status = "blocked"
        state.endedAt = new Date().toISOString()
        sessionEvents.emit({
          type: "policy:failed",
          policyId,
          sessionId: input.sessionId,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ts: new Date().toISOString(),
        })
        cleanup()
      }

      const act = async (passed: boolean, exitCode: number) => {
        if (entry.cancelled) return
        state.status = "acting"

        if (passed) {
          sessionEvents.emit({
            type: "policy:passed",
            policyId,
            sessionId: input.sessionId,
            ts: new Date().toISOString(),
          })
          state.status = "done"
          state.endedAt = new Date().toISOString()
          cleanup()
        } else {
          emitFailed(exitCode)
        }
      }

      const runGate = async () => {
        if (entry.cancelled || state.status !== "watching") return
        state.status = "gating"

        if (!input.gate) {
          await act(true, 0)
          return
        }

        try {
          const allowlist = await loadAllowlist(workspace)
          const baseName = basename(input.gate.command)
          if (!allowlist.has(baseName)) {
            emitFailed(-1, `gate command '${baseName}' not in allowlist`)
            return
          }

          const sessionCwd = registry.get(input.sessionId)?.cwd ?? workspace
          const resolvedCwd = anchorCwd(input.gate.cwd ?? sessionCwd)

          const result = await runCommand({
            command: input.gate.command,
            args: input.gate.args ?? [],
            cwd: resolvedCwd,
            timeoutMs: input.gate.timeoutMs ?? 60_000,
          })

          state.lastGate = { exitCode: result.exitCode, at: new Date().toISOString() }
          await act(result.exitCode === 0, result.exitCode)
        } catch (err) {
          emitFailed(-1, err instanceof Error ? err.message : String(err))
        }
      }

      // Watch for turn-end on the target session
      unsubs.push(
        sessionEvents.on("session:turn-end", ev => {
          if (ev.sessionId !== input.sessionId) return
          if (state.status !== "watching") return
          void runGate()
        }),
      )

      // If the session exits before we gate, cancel the policy
      unsubs.push(
        sessionEvents.on("session:exited", ev => {
          if (ev.sessionId !== input.sessionId) return
          if (state.status === "watching" || state.status === "gating") {
            entry.cancelled = true
            state.status = "cancelled"
            state.endedAt = new Date().toISOString()
            cleanup()
          }
        }),
      )

      return state
    },

    getStatus(policyId) {
      return runs.get(policyId)?.state
    },

    cancel(policyId) {
      const entry = runs.get(policyId)
      if (!entry) return
      entry.cancelled = true
      if (entry.state.status === "watching" || entry.state.status === "gating") {
        entry.state.status = "cancelled"
        entry.state.endedAt = new Date().toISOString()
        for (const u of entry.unsubscribes) u()
        entry.unsubscribes.length = 0
      }
    },

    list() {
      return Array.from(runs.values()).map(e => e.state)
    },
  }
}
