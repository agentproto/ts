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
 * bus and, at each executor session's turn-end / exit, checks two lanes in
 * order and stamps the same `@agentproto-bot` footer if it's missing —
 * reusing {@link stampFooterOnPr}:
 *
 *   A. EXACT — the session's own recorded tool calls: the transcript writer
 *      marks a successful `gh pr create` with the created PR's url/number
 *      (`ToolCallRecord.createdPrUrl`), naming the author session directly.
 *      Immune to branch switches and shared checkouts.
 *   B. BRANCH — resolve the OPEN PR for the session cwd's current branch
 *      (via the injected {@link OpenPrResolver} port), the fallback for
 *      adapters whose tool calls aren't recorded.
 *
 * Turn-end/exit are only poll checkpoints, never an assertion the PR is
 * ready: the real predicate is "did this session create a PR / does an open
 * PR for this branch now exist?", answered by the records and resolver, not
 * by timing.
 *
 * Strictly best-effort: every handler is wrapped so a missing session, an
 * unreachable forge, or a failed `gh` can never throw out of a bus callback.
 * Idempotent by construction — the footer's `MARKER` guard (inside
 * `stampFooterOnPr`) plus `SessionDescriptor.openedPrs` and an in-memory set of
 * already-stamped PR urls mean each PR is stamped at most once. The dedupe is
 * per-PR, not per-session, so a session that opens several PRs (across
 * branches) stamps each of them exactly once.
 */

import type { SessionEventBus } from "./session-event-bus.js"
import { stampFooterOnPr, type GhRunner } from "./pr-provenance-stamp.js"
import type { FooterSession } from "./pr-provenance.js"
import { readToolCallRecords } from "./tool-call-log.js"
import type { ToolCallRecord } from "./tool-call-record.js"

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
  openedPrs?: readonly { url: string }[]
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
  /** Session's recorded tool calls, the exact-attribution source (lane A).
   *  Defaults to reading the session's own events.jsonl via
   *  {@link readToolCallRecords}; injectable for tests. */
  listToolCalls?: (sessionId: string) => Promise<ToolCallRecord[]>
  run?: GhRunner
  host?: string
}): PrProvenanceReconciler {
  // PR urls already stamped this daemon run — the dedupe is per-PR, not per
  // session, so a session that opens several PRs stamps each one once. Also
  // short-circuited by the descriptor's own `openedPrs` (survives restarts).
  const stampedPrUrls = new Set<string>()
  const lastPollAt = new Map<string, number>()

  const reconcile = async (sessionId: string, terminal: boolean): Promise<void> => {
    const desc = opts.registry.get(sessionId)
    // Only executor agent-cli sessions open PRs; a command/terminal session
    // never does.
    if (!desc || desc.kind !== "agent-cli") return
    const cwd = desc.cwd ?? desc.worktreePath
    if (!cwd) return

    // Throttle the turn-end path only; a terminal exit always gets its look.
    // This also bounds re-polling for a long-lived session that already stamped
    // one PR but might still open another on a later branch.
    if (!terminal) {
      const last = lastPollAt.get(sessionId)
      if (last !== undefined && Date.now() - last < POLL_THROTTLE_MS) return
      lastPollAt.set(sessionId, Date.now())
    }

    // Per-PR dedupe shared by both lanes: skip a PR already stamped this run,
    // or one already recorded on the descriptor (a prior daemon generation, or
    // the command_execute path). A session may legitimately open more than one
    // PR — each distinct url is stamped exactly once. Returns true when the
    // caller should stamp.
    const shouldStamp = (url: string): boolean => {
      if (stampedPrUrls.has(url)) return false
      if (desc.openedPrs && desc.openedPrs.some(recorded => recorded.url === url)) {
        stampedPrUrls.add(url)
        return false
      }
      return true
    }

    const supervisor =
      desc.parentSessionId != null
        ? opts.registry.get(desc.parentSessionId) ?? { id: desc.parentSessionId }
        : null

    const stamp = async (pr: { number: number; url: string }): Promise<void> => {
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
      // Record this PR as stamped only on a real stamp (or an already-stamped
      // body). A transient `gh` failure leaves it unstamped so a later event
      // retries.
      if (outcome.stamped) stampedPrUrls.add(pr.url)
    }

    // Lane A — EXACT attribution from the session's own recorded tool calls.
    // The transcript writer marks a successful shell-shaped `gh pr create`
    // with the created PR's url/number on its `tool-call-record` line (see
    // tool-call-record.ts `createdPrUrl`), so the session whose log holds the
    // record IS the creator — no branch inference, immune to the two failure
    // modes of lane B: a chat session that branches → PRs → checks the shared
    // main checkout back out within one turn (the PR's branch is gone by
    // turn-end), and two sessions sharing one cwd (branch→PR answers the same
    // for both; the record answers only for the real author).
    const records = await (opts.listToolCalls ?? readToolCallRecords)(sessionId)
    for (const record of records) {
      if (!record.createdPrUrl || record.createdPrNumber === undefined) continue
      if (!shouldStamp(record.createdPrUrl)) continue
      await stamp({ number: record.createdPrNumber, url: record.createdPrUrl })
    }

    // Lane B — branch→PR reconciliation, the fallback for adapters whose tool
    // calls aren't recorded (or a PR opened by a path no record captured).
    const pr = await opts.resolveOpenPr(cwd)
    if (!pr) return
    if (!shouldStamp(pr.url)) return
    await stamp(pr)
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
      stampedPrUrls.clear()
      lastPollAt.clear()
    },
  }
}
