/**
 * Daemon-lane PR provenance RECONCILER.
 *
 * The `command_execute` stamper (`pr-provenance-stamp.ts`, wired in
 * `command-tools.ts`) only fires when a PR is opened THROUGH the daemon's
 * `command_execute` tool. Executor harnesses (claude-code, codex, …) open PRs
 * with their OWN native shell tool, which never routes through
 * `command_execute` — so the daemon never observes that `gh pr create` and the
 * footer is never applied.
 *
 * This closes that gap tool-agnostically: it subscribes to the session event
 * bus and, at each executor session's turn-end / exit, resolves the OPEN PR for
 * that session's branch (via the injected {@link OpenPrResolver} port) and
 * stamps the same `@agentproto-bot` footer if it's missing — reusing
 * {@link stampFooterOnPr}. Turn-end/exit are only poll checkpoints, never an
 * assertion the PR is ready: the real predicate is "does an open PR for this
 * branch now exist?", answered by the resolver, not by timing.
 *
 * Strictly best-effort: every handler is wrapped so a missing session, an
 * unreachable forge, or a failed `gh` can never throw out of a bus callback.
 * Idempotent by construction — the footer's `MARKER` guard (inside
 * `stampFooterOnPr`) plus `SessionDescriptor.openedPrs` and an in-memory
 * `handled` set mean a session is stamped at most once.
 */

import type { SessionEventBus } from "./session-event-bus.js"
import { stampFooterOnPr, type GhRunner } from "./pr-provenance-stamp.js"
import type { FooterSession } from "./pr-provenance.js"

/**
 * Resolve the OPEN pull request for a session's working directory — i.e. the
 * PR whose head is that cwd's current git branch. Returns `null` when there is
 * no branch, no open PR, or the forge is unreachable (never throws; the
 * reconciler treats any failure as "no PR right now"). Injected by the CLI host
 * because branch→PR resolution runs over `@agentproto/worktree`, a dependency
 * the runtime deliberately does not take.
 */
export type OpenPrResolver = (cwd: string) => Promise<{ number: number; url: string } | null>

/** A session as the reconciler inspects it: the footer's {@link FooterSession}
 *  shape plus the two descriptor fields it reads for dedupe/attribution. The
 *  full `SessionDescriptor` satisfies this structurally. */
export interface ReconcilerSession extends FooterSession {
  worktreePath?: string
  openedPrs?: readonly unknown[]
}

/** The registry slice the reconciler needs — structurally satisfied by the full
 *  `SessionsRegistry`, and by a trivial fake in tests. It is also a valid
 *  `StampRegistry` for {@link stampFooterOnPr} (get/list/recordOpenedPr). */
export interface ReconcilerRegistry {
  get(id: string): ReconcilerSession | undefined
  list(): readonly FooterSession[]
  recordOpenedPr(sessionId: string, input: { adapter: string; number: number; url: string }): unknown
}

export interface PrProvenanceReconciler {
  /** Detach both bus subscriptions and clear in-memory state. */
  dispose(): void
}

/** Minimum gap between `gh` polls for one session on the turn-end path, so a
 *  chatty executor emitting many turn-ends doesn't hammer the forge. The
 *  terminal `exited` path is never throttled — it is the reliable last look. */
const POLL_THROTTLE_MS = 15_000

export function createPrProvenanceReconciler(opts: {
  registry: ReconcilerRegistry
  sessionEvents: SessionEventBus
  resolveOpenPr: OpenPrResolver
  run?: GhRunner
  host?: string
}): PrProvenanceReconciler {
  // Sessions already stamped (or terminally confirmed to have no PR) — never
  // re-polled. Seeded lazily from each event; also short-circuited by the
  // descriptor's own `openedPrs`, which survives daemon restarts.
  const handled = new Set<string>()
  const lastPollAt = new Map<string, number>()

  const reconcile = async (sessionId: string, terminal: boolean): Promise<void> => {
    if (handled.has(sessionId)) return
    const desc = opts.registry.get(sessionId)
    // Only executor agent-cli sessions open PRs; a command/terminal session
    // never does.
    if (!desc || desc.kind !== "agent-cli") return
    // Already carries a recorded PR (this or a prior daemon generation stamped
    // it) — done, and cheap to re-confirm without a `gh` poll.
    if (desc.openedPrs && desc.openedPrs.length > 0) {
      handled.add(sessionId)
      return
    }
    const cwd = desc.cwd ?? desc.worktreePath
    if (!cwd) return

    // Throttle the turn-end path only; a terminal exit always gets its look.
    if (!terminal) {
      const last = lastPollAt.get(sessionId)
      if (last !== undefined && Date.now() - last < POLL_THROTTLE_MS) return
      lastPollAt.set(sessionId, Date.now())
    }

    const pr = await opts.resolveOpenPr(cwd)
    if (!pr) {
      // No PR now. On a turn-end one may still open on a later turn; on a
      // terminal exit none ever will, so stop looking.
      if (terminal) handled.add(sessionId)
      return
    }

    const supervisor =
      desc.parentSessionId != null
        ? opts.registry.get(desc.parentSessionId) ?? { id: desc.parentSessionId }
        : null

    const outcome = await stampFooterOnPr({
      registry: opts.registry,
      session: desc,
      supervisor,
      prNumber: pr.number,
      prUrl: pr.url,
      cwd,
      ...(opts.run ? { run: opts.run } : {}),
      ...(opts.host ? { host: opts.host } : {}),
    })
    // Mark handled only on a real stamp (or an already-stamped body). A
    // transient `gh` failure leaves it unhandled so a later event retries.
    if (outcome.stamped) handled.add(sessionId)
  }

  const safeReconcile = (sessionId: string, terminal: boolean): void => {
    // Fire-and-forget: a reconcile error must never escape the bus callback.
    void reconcile(sessionId, terminal).catch(() => {})
  }

  const unsubscribes: Array<() => void> = [
    opts.sessionEvents.on("session:turn-end", ev => {
      // Skip silent no-op turns (zero output, zero tool calls) — they can't
      // have opened a PR.
      if (ev.empty === true) return
      safeReconcile(ev.sessionId, false)
    }),
    opts.sessionEvents.on("session:exited", ev => {
      safeReconcile(ev.sessionId, true)
    }),
  ]

  return {
    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe()
      handled.clear()
      lastPollAt.clear()
    },
  }
}
