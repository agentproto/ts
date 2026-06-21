/**
 * Completion-policy supervisor — WP1 + WP2.
 *
 * State machine per attached policy:
 *   watching → gating → acting → done
 *                    ↘ nudging (retries < maxRetries) → watching  (gate failed, nudge sent)
 *                    ↘ blocked                                     (gate failed, retries exhausted)
 *   watching → cancelled  (watched session exited before turn-end)
 *
 * Trigger: session:turn-end on the watched session.
 * Gate: optional shell command via the same allowlist + cwd-anchor as
 *       execute_command. exit 0 = pass.
 * Action (then:"emit"): emits policy:passed / policy:failed on the bus
 *       (readable via poll_events).
 * onFail (WP2): when gate fails, re-prompts the session (sendPrompt) up to
 *       maxRetries times, then transitions to blocked + emits policy:failed.
 *
 * In-memory only. Persistence is WP3.
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

export interface OnFailSpec {
  /**
   * Message sent to the watched session via sendPrompt when the gate fails.
   * Use the placeholder {code} to embed the actual exit code.
   * Default: "Le gate a échoué (exit {code}). Corrige et termine jusqu'à ce qu'il passe."
   */
  nudge?: string
  /**
   * Maximum number of consecutive gate failures before transitioning to
   * blocked. Must be >= 1. Default: 2.
   */
  maxRetries?: number
}

export interface AttachPolicyInput {
  /** Session id whose turn-end triggers the policy. */
  sessionId: string
  /** Optional shell gate. Absent → always pass immediately. */
  gate?: ShellGateSpec
  /** Only "emit" is supported in WP1/WP2. */
  then: "emit"
  /**
   * What to do when the gate fails (WP2). Absent → immediately blocked
   * (WP1 behaviour). Present → re-prompt the session up to maxRetries
   * times before blocking; the session must still be running to nudge.
   */
  onFail?: OnFailSpec
}

export type PolicyRunStatus =
  | "watching"
  | "gating"
  | "acting"
  | "nudging"
  | "done"
  | "blocked"
  | "cancelled"

export interface PolicyRunState {
  policyId: string
  sessionId: string
  status: PolicyRunStatus
  /** Number of nudges sent so far (incremented after each sendPrompt call). */
  retries: number
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

const DEFAULT_NUDGE_TEMPLATE =
  "Le gate a échoué (exit {code}). Corrige et termine jusqu'à ce qu'il passe."
const DEFAULT_MAX_RETRIES = 2

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
        retries: 0,
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
          return
        }

        // Gate failed — attempt bounded nudge if configured (WP2)
        if (input.onFail !== undefined) {
          const maxRetries = input.onFail.maxRetries ?? DEFAULT_MAX_RETRIES
          if (state.retries < maxRetries) {
            const session = registry.get(input.sessionId)
            if (session && session.status === "running") {
              const template = input.onFail.nudge ?? DEFAULT_NUDGE_TEMPLATE
              const nudgeMsg = template.replace("{code}", String(exitCode))
              state.status = "nudging"
              try {
                await registry.sendPrompt(input.sessionId, nudgeMsg)
              } catch {
                emitFailed(exitCode, "nudge prompt delivery failed")
                return
              }
              state.retries++
              // Return to watching — bus subscriptions remain active;
              // the next session:turn-end will re-trigger runGate.
              state.status = "watching"
              return
            }
          }
        }

        // No nudge configured, session not running, or retries exhausted → block
        emitFailed(exitCode)
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

      // If the session exits while we're watching, gating, or nudging → cancel
      unsubs.push(
        sessionEvents.on("session:exited", ev => {
          if (ev.sessionId !== input.sessionId) return
          if (
            state.status === "watching" ||
            state.status === "gating" ||
            state.status === "nudging"
          ) {
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
      if (
        entry.state.status === "watching" ||
        entry.state.status === "gating" ||
        entry.state.status === "nudging"
      ) {
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
