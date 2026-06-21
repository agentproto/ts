/**
 * Completion-policy supervisor — WP1 + WP2 + WP3.
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
 * WP3: persists PolicyRunState + input to ~/.agentproto/policies.json (or an
 * injected persistPath). Debounced async write on every transition; sync flush
 * at shutdown(). On boot, active policies (watching/gating/nudging/acting) are
 * re-armed to "watching" and re-subscribed to the bus. Terminal states (done/
 * blocked/cancelled) are kept for history. Session absent at reload → cancelled.
 */

import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import { homedir } from "node:os"
import { resolve } from "node:path"
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  promises as fsp,
} from "node:fs"
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
  /**
   * Sync flush of the policy snapshot to disk. Call from the daemon
   * stop() path — mirrors sessions.shutdown().
   */
  shutdown(): void
}

// ── Internal ─────────────────────────────────────────────────────────

interface RunEntry {
  input: AttachPolicyInput
  state: PolicyRunState
  unsubscribes: Array<() => void>
  cancelled: boolean
}

/** Persisted envelope written to policies.json. */
interface PolicySnapshot {
  savedAt: string
  policies: Array<{ input: AttachPolicyInput; state: PolicyRunState }>
}

const DEFAULT_NUDGE_TEMPLATE =
  "Le gate a échoué (exit {code}). Corrige et termine jusqu'à ce qu'il passe."
const DEFAULT_MAX_RETRIES = 2
const PERSIST_DEBOUNCE_MS = 1_500

export const POLICIES_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "policies.json")

// ── Factory ──────────────────────────────────────────────────────────

export function createCompletionPolicySupervisor(opts: {
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  workspace: string
  /** Override the persist path — used in tests to avoid touching ~/.agentproto. */
  persistPath?: string
  /** Disable persistence entirely (e.g. for unit tests that don't need it). */
  persist?: boolean
}): CompletionPolicySupervisor {
  const { registry, sessionEvents, workspace } = opts
  const persistPath = opts.persistPath ?? POLICIES_FILE_PATH()
  // Default false: WP1/WP2 tests (no opts.persist, no opts.persistPath)
  // don't touch ~/.agentproto. Set opts.persist:true in production
  // (createGateway) or supply persistPath to implicitly enable it.
  const persist = opts.persist ?? (opts.persistPath !== undefined)
  const anchorCwd = makeCwdAnchor(workspace)
  const runs = new Map<string, RunEntry>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let shutdownDone = false

  // ── persistence helpers ──────────────────────────────────────────

  const buildSnapshot = (): PolicySnapshot => ({
    savedAt: new Date().toISOString(),
    policies: Array.from(runs.values()).map(e => ({
      input: e.input,
      state: e.state,
    })),
  })

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void (async () => {
        try {
          const snap = buildSnapshot()
          await fsp.mkdir(dirname(persistPath), { recursive: true })
          await fsp.writeFile(
            persistPath,
            JSON.stringify(snap, null, 2) + "\n",
          )
        } catch (err) {
          console.warn(
            `[supervisor] persist failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })()
    }, PERSIST_DEBOUNCE_MS)
  }

  // ── arm logic (shared by attach() and reload) ────────────────────

  /**
   * Set up bus subscriptions for a run entry. Called both when
   * attaching a fresh policy and when re-arming after reload.
   * The caller is responsible for inserting the entry into `runs`.
   */
  function armEntry(entry: RunEntry): void {
    const { input, state, unsubscribes } = entry

    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      for (const u of unsubscribes) u()
      unsubscribes.length = 0
    }

    const emitFailed = (exitCode: number | undefined, error?: string) => {
      if (error) state.error = error
      state.status = "blocked"
      state.endedAt = new Date().toISOString()
      sessionEvents.emit({
        type: "policy:failed",
        policyId: state.policyId,
        sessionId: input.sessionId,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ts: new Date().toISOString(),
      })
      schedulePersist()
      cleanup()
    }

    const act = async (passed: boolean, exitCode: number) => {
      if (entry.cancelled) return
      state.status = "acting"
      schedulePersist()

      if (passed) {
        sessionEvents.emit({
          type: "policy:passed",
          policyId: state.policyId,
          sessionId: input.sessionId,
          ts: new Date().toISOString(),
        })
        state.status = "done"
        state.endedAt = new Date().toISOString()
        schedulePersist()
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
            schedulePersist()
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
            schedulePersist()
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
      schedulePersist()

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

        state.lastGate = {
          exitCode: result.exitCode,
          at: new Date().toISOString(),
        }
        schedulePersist()
        await act(result.exitCode === 0, result.exitCode)
      } catch (err) {
        emitFailed(-1, err instanceof Error ? err.message : String(err))
      }
    }

    // Watch for turn-end on the target session
    unsubscribes.push(
      sessionEvents.on("session:turn-end", ev => {
        if (ev.sessionId !== input.sessionId) return
        if (state.status !== "watching") return
        void runGate()
      }),
    )

    // If the session exits while we're watching, gating, or nudging → cancel
    unsubscribes.push(
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
          schedulePersist()
          cleanup()
        }
      }),
    )
  }

  // ── boot-time reload ─────────────────────────────────────────────

  if (persist) {
    let raw: string
    try {
      raw = readFileSync(persistPath, "utf8")
    } catch {
      raw = ""
    }
    if (raw) {
      let parsed: PolicySnapshot | null = null
      try {
        parsed = JSON.parse(raw) as PolicySnapshot
      } catch {
        // corrupt file — ignore
      }
      if (parsed?.policies) {
        for (const { input, state } of parsed.policies) {
          const isTerminal =
            state.status === "done" ||
            state.status === "blocked" ||
            state.status === "cancelled"

          if (isTerminal) {
            // Keep for history, no re-arm needed.
            const entry: RunEntry = {
              input,
              state,
              unsubscribes: [],
              cancelled: true,
            }
            runs.set(state.policyId, entry)
            continue
          }

          // Active state at crash time — check if the session still exists.
          const session = registry.get(input.sessionId)
          if (!session || (session.status !== "running" && session.status !== "starting")) {
            // Session gone — cancel proprely instead of hanging.
            const cancelledState: PolicyRunState = {
              ...state,
              status: "cancelled",
              endedAt: state.endedAt ?? new Date().toISOString(),
              error: "session absent at reload",
            }
            runs.set(state.policyId, {
              input,
              state: cancelledState,
              unsubscribes: [],
              cancelled: true,
            })
            continue
          }

          // Re-arm to watching and re-subscribe.
          const rearmedState: PolicyRunState = {
            ...state,
            status: "watching",
          }
          const entry: RunEntry = {
            input,
            state: rearmedState,
            unsubscribes: [],
            cancelled: false,
          }
          runs.set(state.policyId, entry)
          armEntry(entry)
        }
      }
    }
  }

  // ── public interface ─────────────────────────────────────────────

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
      const entry: RunEntry = {
        input,
        state,
        unsubscribes: [],
        cancelled: false,
      }
      runs.set(policyId, entry)
      schedulePersist()
      armEntry(entry)
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
        schedulePersist()
      }
    },

    list() {
      return Array.from(runs.values()).map(e => e.state)
    },

    shutdown() {
      if (shutdownDone) return
      shutdownDone = true
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      if (!persist) return
      try {
        const snap = buildSnapshot()
        mkdirSync(dirname(persistPath), { recursive: true })
        writeFileSync(persistPath, JSON.stringify(snap, null, 2) + "\n")
      } catch {
        // best-effort
      }
    },
  }
}
