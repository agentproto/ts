/**
 * Completion-policy supervisor — WP1 + WP2 + WP3 + WP4.
 *
 * State machine per attached policy:
 *   watching → gating → acting → done
 *                    ↘ nudging (retries < maxRetries) → watching  (gate failed, nudge sent)
 *                    ↘ blocked                                     (gate failed, retries exhausted)
 *   watching → cancelled  (watched session exited before turn-end)
 *
 * Trigger: session:turn-end on the watched session(s).
 * Gate: optional shell command via the same allowlist + cwd-anchor as
 *       execute_command. exit 0 = pass.
 * Action (then:"emit"): emits policy:passed / policy:failed on the bus
 *       (readable via poll_events).
 * onFail (WP2): when gate fails, re-prompts the session(s) (sendPrompt) up to
 *       maxRetries times, then transitions to blocked + emits policy:failed.
 *
 * WP3: persists PolicyRunState + input to ~/.agentproto/policies.json (or an
 * injected persistPath). Debounced async write on every transition; sync flush
 * at shutdown(). On boot, active policies (watching/gating/nudging/acting) are
 * re-armed to "watching" and re-subscribed to the bus. Terminal states (done/
 * blocked/cancelled) are kept for history. Session absent at reload → cancelled.
 *
 * WP4 (fan-in): a policy may watch a GROUP of sessions (`sessionIds`). The gate
 * runs ONCE, only after EVERY member of the group has finished its turn. Members
 * are tracked in an idempotent `pending` set: a member is removed on its first
 * `session:turn-end`; a repeated turn-end for an already-removed member is a
 * no-op (no double-count). When the set empties → gating.
 *
 * A member that emits `session:exited` is treated as "this member is done": it
 * is removed from the pending set exactly like a turn-end (a dead session will
 * never emit one), so a partially-crashed group can still complete. If every
 * member exits, the set empties and the gate runs once. The one exception is the
 * degenerate group of size 1 (the legacy single-`sessionId` form): a lone
 * watched session that exits has nothing left to gate on, so the policy is
 * cancelled — preserving the original single-session contract.
 *
 * Back-compat: the legacy `sessionId` (single) form is a group of one. `state.
 * sessionId` is retained as the group's representative (group[0]) and is the id
 * carried on policy:passed / policy:failed events.
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
  /**
   * Session id whose turn-end triggers the policy (single-session / legacy
   * form). Equivalent to `sessionIds: [sessionId]`. Provide this OR
   * `sessionIds`; if both are given, `sessionIds` wins.
   */
  sessionId?: string
  /**
   * Fan-in group (WP4): the gate runs once, only after EVERY listed session
   * has finished its turn (turn-end or exit). Supersedes `sessionId` when
   * present and non-empty. A single-element array behaves like `sessionId`.
   */
  sessionIds?: string[]
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
  /** Representative session id (the fan-in group's first member, group[0]).
   *  Carried on policy:passed / policy:failed events. */
  sessionId: string
  /** The full fan-in group being watched. Always present; a length-1 group is
   *  the legacy single-session form. */
  sessionIds: string[]
  /** Sessions in the group that have NOT yet finished their turn. The gate
   *  fires once this set empties. Idempotent: a member is removed on its first
   *  turn-end/exit; repeats are no-ops. Reset to the full group on each nudge. */
  pending: string[]
  status: PolicyRunStatus
  /** Number of nudges sent so far (incremented after each nudge round). */
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
  /** Resolved fan-in group (deduped, order-preserved). group[0] is the repr. */
  group: string[]
  /** Live idempotent set of sessions still awaited. Mirrored to state.pending. */
  pending: Set<string>
  state: PolicyRunState
  unsubscribes: Array<() => void>
  cancelled: boolean
}

/**
 * Resolve the watched group from an attach input. `sessionIds` (when present
 * and non-empty) wins over the legacy `sessionId`. Deduped, order-preserved.
 * Throws if neither yields a session id.
 */
function resolveGroup(input: AttachPolicyInput): string[] {
  const raw =
    input.sessionIds && input.sessionIds.length > 0
      ? input.sessionIds
      : input.sessionId
        ? [input.sessionId]
        : []
  const group = Array.from(new Set(raw))
  if (group.length === 0) {
    throw new Error("attach_policy requires sessionId or a non-empty sessionIds")
  }
  return group
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
    const group = entry.group
    // Representative session id used for cwd resolution and event payloads.
    // group is guaranteed non-empty by resolveGroup.
    const repr = group[0]!

    // Keep the serializable mirror (state.pending) in sync with the live set.
    const syncPending = () => {
      state.pending = Array.from(entry.pending)
    }

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
        sessionId: repr,
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
          sessionId: repr,
          ts: new Date().toISOString(),
        })
        state.status = "done"
        state.endedAt = new Date().toISOString()
        schedulePersist()
        cleanup()
        return
      }

      // Gate failed — attempt bounded nudge if configured (WP2).
      if (input.onFail !== undefined) {
        const maxRetries = input.onFail.maxRetries ?? DEFAULT_MAX_RETRIES
        if (state.retries < maxRetries) {
          // Nudge every still-running member of the group (fan-in: WP4).
          const running = group.filter(
            id => registry.get(id)?.status === "running",
          )
          if (running.length > 0) {
            const template = input.onFail.nudge ?? DEFAULT_NUDGE_TEMPLATE
            const nudgeMsg = template.replace("{code}", String(exitCode))
            state.status = "nudging"
            schedulePersist()
            try {
              for (const id of running) {
                await registry.sendPrompt(id, nudgeMsg)
              }
            } catch {
              emitFailed(exitCode, "nudge prompt delivery failed")
              return
            }
            state.retries++
            // Reset the fan-in set to the full group and return to watching —
            // bus subscriptions remain active; the gate fires again only once
            // every member has finished another turn.
            entry.pending = new Set(group)
            syncPending()
            state.status = "watching"
            schedulePersist()
            return
          }
        }
      }

      // No nudge configured, no running member, or retries exhausted → block
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

        const sessionCwd = registry.get(repr)?.cwd ?? workspace
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

    /** Remove a member from the pending set (idempotent); gate once empty. */
    const markMemberDone = (sessionId: string) => {
      if (state.status !== "watching") return
      if (!entry.pending.has(sessionId)) return // idempotent — no double-count
      entry.pending.delete(sessionId)
      syncPending()
      schedulePersist()
      if (entry.pending.size === 0) void runGate()
    }

    // Fan-in: a member's first turn-end removes it from the pending set; the
    // gate runs once the set empties.
    unsubscribes.push(
      sessionEvents.on("session:turn-end", ev => {
        if (!group.includes(ev.sessionId)) return
        markMemberDone(ev.sessionId)
      }),
    )

    // Member exit handling:
    //  - group of 1 (legacy single-session form): a lone watched session that
    //    exits before turn-end has nothing to gate on → cancel (unchanged).
    //  - fan-in group (>1): the exited member is treated as "done" and removed
    //    from the pending set, exactly like a turn-end. If every member exits,
    //    the set empties and the gate runs once.
    unsubscribes.push(
      sessionEvents.on("session:exited", ev => {
        if (!group.includes(ev.sessionId)) return
        if (group.length === 1) {
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
          return
        }
        markMemberDone(ev.sessionId)
      }),
    )

    // If the pending set was already empty at arm time (e.g. re-armed after a
    // reload where every still-awaited member had exited), gate immediately.
    if (!entry.cancelled && state.status === "watching" && entry.pending.size === 0) {
      void runGate()
    }
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

          // Reconstruct the fan-in group + pending set defensively (older
          // snapshots predate sessionIds/pending and carry only sessionId).
          const group =
            state.sessionIds && state.sessionIds.length > 0
              ? Array.from(new Set(state.sessionIds))
              : resolveGroup(input)
          const persistedPending =
            state.pending && state.pending.length >= 0
              ? state.pending
              : [...group]

          if (isTerminal) {
            // Keep for history, no re-arm needed.
            const entry: RunEntry = {
              input,
              group,
              pending: new Set(persistedPending),
              state,
              unsubscribes: [],
              cancelled: true,
            }
            runs.set(state.policyId, entry)
            continue
          }

          // Active state at crash time. A member still counts as alive only if
          // the registry still reports it running/starting.
          const isAlive = (id: string): boolean => {
            const s = registry.get(id)
            return !!s && (s.status === "running" || s.status === "starting")
          }
          const aliveGroup = group.filter(isAlive)

          if (aliveGroup.length === 0) {
            // No member survived the restart — cancel instead of hanging.
            const cancelledState: PolicyRunState = {
              ...state,
              sessionIds: group,
              pending: [],
              status: "cancelled",
              endedAt: state.endedAt ?? new Date().toISOString(),
              error: "session absent at reload",
            }
            runs.set(state.policyId, {
              input,
              group,
              pending: new Set(),
              state: cancelledState,
              unsubscribes: [],
              cancelled: true,
            })
            continue
          }

          // Re-arm to watching. Re-subscribe only to members still awaited AND
          // still alive: a pending member that died while the daemon was down
          // counts as "done" (same rule as a live exit), so it drops out of the
          // pending set rather than wedging the fan-in forever.
          const rearmedPending = persistedPending.filter(
            id => group.includes(id) && isAlive(id),
          )
          const rearmedState: PolicyRunState = {
            ...state,
            sessionIds: group,
            pending: rearmedPending,
            status: "watching",
          }
          const entry: RunEntry = {
            input,
            group,
            pending: new Set(rearmedPending),
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
      const group = resolveGroup(input)
      const policyId = `policy_${randomUUID().slice(0, 8)}`
      const state: PolicyRunState = {
        policyId,
        sessionId: group[0]!,
        sessionIds: group,
        pending: [...group],
        status: "watching",
        retries: 0,
        startedAt: new Date().toISOString(),
      }
      const entry: RunEntry = {
        input,
        group,
        pending: new Set(group),
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
