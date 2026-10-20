/**
 * `clerk-turn-end` — the daemon subscriber that runs ONE clerk pass
 * (AIP-68, steward/secretary) after a session's turn ends.
 *
 * ## WHY IT EXISTS
 *
 * The daemon knows when a session finished a turn (`session:turn-end` on
 * the session-event bus). A clerk pass is what turns that knowledge into
 * housekeeping: the steward/secretary looks at the session's context and
 * decides whether it is done, stuck, or needs a nudge. Doing that on EVERY
 * turn-end would be both wasteful and wrong — most turns are followed by
 * another turn within seconds — so the pass is DEBOUNCED on the session's
 * idle time (AIP-68 §3.6: a 10-minute idle-pause by default).
 *
 * ## THE FOUR INVARIANTS
 *
 *   1. DEBOUNCED — one pass per session per idle window. Every turn-end
 *      RESTARTS the session's timer; the pass runs only once the session
 *      has been quiet for `debounceMs` (10 min by default).
 *   2. SINGLE-FLIGHT — never two passes on the SAME session at the same
 *      time. A pass that is still running when the timer fires makes that
 *      firing a no-op (the next turn-end re-arms the timer).
 *   3. FIRE-AND-FORGET — the pass is launched and NOT awaited. The bus
 *      handler returns in microseconds; a slow (or hanging) pass can never
 *      slow a turn down, let alone block it.
 *   4. DISABLED BY DEFAULT — the resolved configuration's `enabled` decides;
 *      with nothing configured the hook never fires.
 *
 * ## WHAT THE CLERK IGNORES
 *
 *   - its OWN sessions: the sessions the clerk itself runs in (the pass's
 *     own session, and anything the caller marks as a clerk session) — a
 *     clerk must never grade its own homework;
 *   - EMPTY turns (`session:turn-end` with `empty: true`): a turn that
 *     produced no assistant output and no tool call is not a session that
 *     needs stewarding;
 *   - interrupted turns (the daemon cut them off);
 *   - sessions the configuration EXCLUDES (by id, label, title, slug or
 *     agent id);
 *   - sessions that are not agent sessions (`kind !== "agent-cli"`).
 *
 * ## CONFIGURATION
 *
 * Three levels, most specific wins, resolved per field — see
 * `clerk-hook-config.ts` for the shapes and the precedence table.
 */

import type { SessionEventBus, SessionTurnEndEvent } from "./session-event-bus.js"
import type { ClerkHookConfig } from "./clerk-hook-config.js"

/** The slice of a session descriptor this controller reads. Structural on
 *  purpose: the controller never imports `sessions.ts` (that would be an
 *  import cycle — `sessions.ts` owns the registry). */
export interface ClerkSessionLike {
  id: string
  kind?: string
  label?: string
  title?: string
  slug?: string
  cwd?: string
  origin?: string
  /** The AGENT level of the hook config, when the session's agent declared
   *  one (manifest `metadata.hooks.clerk` or an `agent_start` option). */
  clerkHook?: Partial<ClerkHookConfig>
}

/** What the pass is told about the session it runs for. */
export interface ClerkPassInput {
  sessionId: string
  session: ClerkSessionLike
  config: ClerkHookConfig
}

export interface ClerkTurnEndControllerOptions {
  /** Registry lookup (the daemon's `SessionsRegistry.get`). */
  registry: { get(id: string): ClerkSessionLike | undefined }
  /** The session-event bus to subscribe to. */
  sessionEvents: SessionEventBus
  /**
   * Resolve the EFFECTIVE configuration for a session. The daemon wires
   * this to the three-level resolution (agent > workspace > daemon
   * default); it may return `undefined` to mean "not configured at all".
   */
  resolveConfig: (session: ClerkSessionLike) => ClerkHookConfig | undefined
  /**
   * Launch the clerk pass. Called FIRE-AND-FORGET: the controller never
   * awaits it and never lets its failure escape into the bus.
   */
  runPass: (input: ClerkPassInput) => Promise<unknown> | unknown
  /**
   * Sessions the clerk must ignore — its OWN sessions (the pass's own
   * session, the clerk's helper sessions). Ids only.
   */
  selfSessionIds?: Iterable<string>
  /** Diagnostic sink (default: `console.error` for failures only). */
  onError?: (err: unknown, context: { sessionId: string }) => void
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable timer (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** Injectable timer cancel (tests). */
  clearTimer?: (timer: unknown) => void
}

export interface ClerkTurnEndController {
  dispose(): void
  /** Sessions with a pending (debounced) pass — for diagnostics/tests. */
  pendingIds(): string[]
  /** Sessions with a pass currently running — for diagnostics/tests. */
  inFlightIds(): string[]
}

type Timer = unknown

/**
 * Create the clerk turn-end controller. Subscribes to `session:turn-end`
 * immediately; `dispose()` unsubscribes and cancels every pending timer.
 */
export function createClerkTurnEndController(
  opts: ClerkTurnEndControllerOptions,
): ClerkTurnEndController {
  const pending = new Map<string, Timer>()
  const inFlight = new Set<string>()
  const selfSessionIds = new Set(opts.selfSessionIds ?? [])
  const now = opts.now ?? (() => Date.now())
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    opts.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const onError =
    opts.onError ??
    ((err: unknown, ctx: { sessionId: string }) =>
      console.error(`[runtime] clerk pass failed for session ${ctx.sessionId}:`, err))

  /** Would this session be excluded by the configuration? Matches the
   *  session id, its label / title / slug, or its origin. */
  function isExcluded(session: ClerkSessionLike, config: ClerkHookConfig): boolean {
    const list = config.exclude ?? []
    if (list.length === 0) return false
    const candidates = [session.id, session.label, session.title, session.slug, session.origin]
    for (const entry of list) {
      for (const candidate of candidates) {
        if (candidate && candidate === entry) return true
      }
    }
    return false
  }

  function arm(session: ClerkSessionLike, config: ClerkHookConfig): void {
    const id = session.id
    const existing = pending.get(id)
    if (existing !== undefined) clearTimer(existing)
    const timer = setTimer(() => {
      pending.delete(id)
      void fire(session, config)
    }, config.debounceMs)
    pending.set(id, timer)
  }

  async function fire(session: ClerkSessionLike, config: ClerkHookConfig): Promise<void> {
    const id = session.id
    if (inFlight.has(id)) {
      // SINGLE-FLIGHT — a pass for this session is already running. The
      // next turn-end re-arms the timer; nothing to do here.
      return
    }
    inFlight.add(id)
    try {
      await opts.runPass({ sessionId: id, session, config })
    } catch (err) {
      onError(err, { sessionId: id })
    } finally {
      inFlight.delete(id)
    }
  }

  const unsubscribe = opts.sessionEvents.on("session:turn-end", (ev: SessionTurnEndEvent) => {
    // Everything below is synchronous and cheap: the handler must never
    // slow a turn down.
    const session = opts.registry.get(ev.sessionId)
    if (!session) return
    const config = opts.resolveConfig(session)
    if (!config || !config.enabled) return
    if (config.on !== "turn_end") return
    // The clerk never grades its own homework.
    if (selfSessionIds.has(session.id)) return
    // Not an agent session — nothing to steward.
    if (session.kind !== undefined && session.kind !== "agent-cli") return
    // An empty turn (no output, no tool call) is not worth a pass.
    if (ev.empty === true) return
    // An interrupted turn never really ended.
    if (ev.interrupted === true) return
    if (isExcluded(session, config)) return
    arm(session, config)
  })

  return {
    dispose() {
      unsubscribe()
      for (const timer of pending.values()) clearTimer(timer)
      pending.clear()
      inFlight.clear()
    },
    pendingIds: () => [...pending.keys()],
    inFlightIds: () => [...inFlight.keys()],
  }
}
