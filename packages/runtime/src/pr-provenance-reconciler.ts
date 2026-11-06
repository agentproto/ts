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
 *   C. TEXTUAL — pull-request urls mentioned in the session's own assistant
 *      output (bounded transcript-tail scan); records on `openedPrs`
 *      (adapter "output-scan") but never stamps a footer — a mention is
 *      not proof of creation.
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

import { homedir } from "node:os"
import type { SessionEventBus } from "./session-event-bus.js"
import { stampFooterOnPr, type GhRunner, type PrFooterState } from "./pr-provenance-stamp.js"
import { checkpointRefPrefixForSession } from "./sandbox-delivery.js"
import type { FooterSession } from "./pr-provenance.js"
import { readToolCallRecords } from "./tool-call-log.js"
import type { ToolCallRecord } from "./tool-call-record.js"
import { readRecentTurnsSync } from "./session-evidence.js"
import { parsePrUrl } from "./review-pr.js"
import { OUTPUT_SCAN_ADAPTER } from "./sessions.js"

/**
 * Resolve the OPEN pull request for a session's working directory — i.e. the
 * PR whose head is that cwd's current git branch. Returns `null` when there is
 * no branch, no open PR, or the forge is unreachable (never throws; the
 * reconciler treats any failure as "no PR right now"). Injected by the CLI host
 * because branch→PR resolution runs over `@agentproto/worktree`, a dependency
 * the runtime deliberately does not take.
 *
 * `opts.branch` overrides "the cwd's current branch": a sandboxed session's
 * work branch lives in its box (`SessionDescriptor.sandboxDeliveryTarget`), so
 * the reconciler asks about THAT branch against a local checkout of the same
 * repo (the session's workspace) — `cwd` then only identifies the repo.
 */
export type OpenPrResolver = (
  cwd: string,
  opts?: { branch?: string },
) => Promise<{ number: number; url: string } | null>

/** A session as the reconciler inspects it: the footer's {@link FooterSession}
 *  shape plus the two descriptor fields it reads for dedupe/attribution. The
 *  full `SessionDescriptor` satisfies this structurally. */
export interface ReconcilerSession extends FooterSession {
  worktreePath?: string
  openedPrs?: readonly {
    url: string
    number?: number
    /** Footer bookkeeping the daemon persists (see `PrFooterState`). */
    footerStampedAt?: string
    footerBodyHash?: string
    footerRemovals?: number
    footerDisabled?: boolean
  }[]
  /** Ephemeral transcript path the live registry stamps on every read
   *  (see `SessionDescriptor.eventsPath`); lane C's bounded tail read
   *  needs it. Absent from test fakes without a transcript on disk. */
  eventsPath?: string
  /** Sandboxed session: its cwd is a path inside the box, never on this
   *  host — see {@link localRepoCwdFor}. */
  remote?: boolean
  /** Sandboxed session's work branch inside its box. */
  sandboxDeliveryTarget?: { branch: string }
  workspaceSlug?: string
}

/** PR number from a forge PR url (`…/pull/42`), for `openedPrs` rows recorded
 *  before the number was kept. Null when the url has no such segment. */
export function prNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)
  return m ? Number(m[1]) : null
}

/** The registry slice the reconciler needs — structurally satisfied by the full
 *  `SessionsRegistry`, and by a trivial fake in tests. It is also a valid
 *  `StampRegistry` for {@link stampFooterOnPr} (get/list/recordOpenedPr). */
export interface ReconcilerRegistry {
  get(id: string): ReconcilerSession | undefined
  list(): readonly FooterSession[]
  recordOpenedPr(sessionId: string, input: { adapter: string; number: number; url: string }): unknown
  /** Persist footer bookkeeping onto an already-recorded PR. Optional so
   *  lightweight fakes keep working. */
  recordPrFooterState?(sessionId: string, url: string, state: PrFooterState): unknown
}

/** `owner/name` of a forge PR url (`https://host/owner/name/pull/42`), or
 *  undefined when the url does not have that shape. */
export function repoFromPrUrl(url: string): string | undefined {
  return /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1]
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
  /** Host-side checkout of the repo a SANDBOXED session works on (its
   *  workspace's path) — the session's own `cwd` is a box path that does not
   *  exist here. Lane B then resolves the PR whose head is the box's work
   *  branch (`sandboxDeliveryTarget.branch`) against that checkout, and every
   *  `gh` call runs there. Absent / unresolvable ⇒ lane B is skipped for the
   *  session and the url-addressed `gh` calls run from the home dir. */
  localRepoCwdFor?: (session: ReconcilerSession) => Promise<string | undefined>
  /** The daemon's GLOBAL checkpoint ref namespace
   *  (`defaults.sandbox.checkpoint.refPrefix`). The session's own per-spawn
   *  override wins over it, the checkpoint the delivery pushed lives under
   *  the session's namespace, not the global one. */
  checkpointRefPrefix?: string
  /** `owner/name` repos whose PRs never receive or refresh a footer
   *  (`defaults.prProvenance.footer.skipRepos`). Resolved on every reconcile
   *  so a config change takes effect without a daemon restart. */
  skipFooterRepos?: () => Promise<readonly string[]> | readonly string[]
  /** Info logger for the one line emitted when a PR opts out of stamping
   *  after two deliberate footer removals. Defaults to `console.log`. */
  log?: (line: string) => void
}): PrProvenanceReconciler {
  // Per-reconcile dedupe of the PRs lane A / lane B resolved (below, local to
  // `reconcile`), plus the session that stamped each url THIS daemon run.
  // The latter keeps a same-cwd sibling from stealing a PR another session
  // already stamped, while a session that owns the PR may re-check it on a
  // later turn-end (an agent may have rewritten the body since).
  const stampedByThisRun = new Map<string, string>()
  const log = opts.log ?? ((line: string) => console.log(line))
  // PRs whose footer has been re-rendered with the session's spend (or
  // already carried one) — the cost refresh is a once-per-PR follow-up to
  // the first, mid-turn stamp that lands before any usage is known.
  const costRefreshedPrUrls = new Set<string>()
  const lastPollAt = new Map<string, number>()
  // Lane C's dedupe: urls already recorded from an assistant-output mention
  // this daemon run (across sessions — a url is claimed at most once per
  // run even if two sessions both printed it; `openedPrs` covers restarts).
  const scannedPrUrls = new Set<string>()

  /** Where this host runs `gh` for the session, and which branch lane B asks
   *  about (`undefined` ⇒ the cwd's current branch; `null` ⇒ skip lane B). A
   *  local session uses its own cwd. A sandboxed one uses the workspace's
   *  local checkout + the box's work branch: matching on the branch name
   *  alone across repos would attribute another repo's same-named PR. */
  const hostSideOf = async (
    desc: ReconcilerSession,
    cwd: string,
  ): Promise<{ cwd: string; branch?: string | null }> => {
    if (!desc.remote) return { cwd }
    const branch = desc.sandboxDeliveryTarget?.branch
    const local = await opts.localRepoCwdFor?.(desc).catch(() => undefined)
    if (!local) return { cwd: homedir(), branch: null }
    return { cwd: local, branch: branch ?? null }
  }

  const reconcile = async (sessionId: string, terminal: boolean): Promise<void> => {
    const desc = opts.registry.get(sessionId)
    // Only executor agent-cli sessions open PRs; a command/terminal session
    // never does.
    if (!desc || desc.kind !== "agent-cli") return
    const sessionCwd = desc.cwd ?? desc.worktreePath
    if (!sessionCwd) return

    // Throttle the turn-end path only; a terminal exit always gets its look.
    // This also bounds re-polling for a long-lived session that already stamped
    // one PR but might still open another on a later branch.
    if (!terminal) {
      const last = lastPollAt.get(sessionId)
      if (last !== undefined && Date.now() - last < POLL_THROTTLE_MS) return
      lastPollAt.set(sessionId, Date.now())
    }

    const host = await hostSideOf(desc, sessionCwd)
    const cwd = host.cwd
    const skipRepos = await (async () => {
      try {
        return await (opts.skipFooterRepos?.() ?? [])
      } catch {
        return []
      }
    })()
    const repoOf = (url: string): string | undefined => repoFromPrUrl(url)
    const skipped = (url: string): boolean => {
      const repo = repoOf(url)
      return repo !== undefined && skipRepos.includes(repo)
    }

    // Per-reconcile set shared by both lanes (lane A and lane B can resolve
    // the same PR). Across turn-ends it resets: a PR the daemon stamped is
    // re-checked so an agent rewrite that dropped the footer is re-stamped.
    const handledPrUrls = new Set<string>()
    const footerStateFor = (url: string): PrFooterState | undefined => {
      const recorded = desc.openedPrs?.find(row => row.url === url)
      if (!recorded) return undefined
      return {
        ...(recorded.footerBodyHash !== undefined ? { bodyHash: recorded.footerBodyHash } : {}),
        ...(recorded.footerRemovals !== undefined ? { removals: recorded.footerRemovals } : {}),
        ...(recorded.footerDisabled ? { disabled: true } : {}),
      }
    }
    // Should this PR be (re)considered at all? A PR recorded but never
    // footer-stamped by the daemon (an older daemon, or another lane's
    // attribution) stays untouched, preserving the historical dedupe. A PR
    // this daemon DID stamp is reconsidered so its body can be re-checked.
    const shouldStamp = (url: string): boolean => {
      if (handledPrUrls.has(url)) return false
      handledPrUrls.add(url)
      if (skipped(url)) return false
      const recorded = desc.openedPrs?.find(row => row.url === url)
      if (recorded) {
        if (recorded.footerDisabled) return false
        if (recorded.footerBodyHash === undefined && recorded.footerStampedAt === undefined) return false
        return true
      }
      // Not recorded on THIS session: if another session stamped it this run,
      // it is theirs (the same-cwd sibling guard).
      const stampedBy = stampedByThisRun.get(url)
      if (stampedBy !== undefined && stampedBy !== desc.id) return false
      return true
    }

    const supervisor =
      desc.parentSessionId != null
        ? opts.registry.get(desc.parentSessionId) ?? { id: desc.parentSessionId }
        : null

    const stamp = async (pr: { number: number; url: string }, requireTrailerAuthorship = false): Promise<void> => {
      const prior = footerStateFor(pr.url)
      const outcome = await stampFooterOnPr({
        registry: opts.registry,
        session: desc,
        supervisor,
        prNumber: pr.number,
        prUrl: pr.url,
        cwd,
        ...(opts.run ? { run: opts.run } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        checkpointRefPrefix: checkpointRefPrefixForSession(desc, opts.checkpointRefPrefix),
        ...(requireTrailerAuthorship ? { requireTrailerAuthorship: true } : {}),
        ...(prior ? { footerState: prior } : {}),
      })
      // One info line when a PR opts itself out after two deliberate footer
      // removals. The disabled flag is persisted, so this fires once.
      if (outcome.footerState?.disabled === true && prior?.disabled !== true) {
        log(`[pr-provenance] ${pr.url} lost its footer twice with no body change; stopping stamps`)
      }
      if (outcome.stamped) stampedByThisRun.set(pr.url, desc.id)
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

    // Lane C — TEXTUAL: pull-request urls mentioned in the session's own
    // ASSISTANT output (a bounded tail read of its events.jsonl, same window
    // shape session_evidence already reads). Covers the session whose tool
    // calls lane A never saw recorded AND whose branch→PR answer lane B
    // missed or raced (branch already switched / unmountable cwd / no gh):
    // such a harness still almost always PRINTS the `…/pull/<n>` url it just
    // created. A mention is not proof of creation, so this lane never
    // stamps a footer — it only records the PR on `openedPrs` (adapter
    // "output-scan") so the session ↔ PR link at least exists for the
    // supervisor/polling lanes to consume. Sentinel auto-link skips this
    // adapter: a supervisor that reports a child's PR url must not become
    // its watcher. In-process, zero network: the
    // read is the same file the transcript writer already owns; dedupe is
    // the url set below + the descriptor's `openedPrs` (over restarts).
    if (desc.eventsPath) {
      for (const turn of readRecentTurnsSync(desc.eventsPath)) {
        if (turn.role !== "assistant") continue
        const re = /https?:\/\/[^\s<>"]+/g
        let m: RegExpExecArray | null
        while ((m = re.exec(turn.text)) !== null) {
          const url = m[0].replace(/[.,;:)\]]+$/, "")
          const parsed = parsePrUrl(url)
          if (!parsed) continue
          if (desc.openedPrs?.some(known => known.url === url)) continue
          if (scannedPrUrls.has(url)) continue
          scannedPrUrls.add(url)
          try {
            opts.registry.recordOpenedPr(sessionId, {
              adapter: OUTPUT_SCAN_ADAPTER,
              number: parsed.number,
              url,
            })
          } catch {
            // Bubble nothing: a registry hiccup must not break the stamp
            // lanes that would otherwise run after/beside this one.
          }
        }
      }
    }

    // Lane B — branch→PR reconciliation, the fallback for adapters whose tool
    // calls aren't recorded (or a PR opened by a path no record captured).
    // A sandboxed session asks about its box's work branch (see `hostSideOf`).
    // A supervisor shares its child's checkout (review-supervisor + executor on
    // one cwd), so the branch answers the same PR for both. Whichever turn
    // ends first would stamp ITS id when the body has no footer (an executor
    // `gh pr edit --body` dropped it; ts#2541/#2542). The supervisor is only
    // ever attributed through lane A's exact record, never by branch.
    const supervisesSharedCwd = opts.registry
      .list()
      .some(s => s.parentSessionId === desc.id && s.kind === "agent-cli" && (s.cwd ?? undefined) === sessionCwd)
    if (host.branch !== null && !supervisesSharedCwd) {
      const pr = host.branch
        ? await opts.resolveOpenPr(cwd, { branch: host.branch })
        : await opts.resolveOpenPr(cwd)
      // A sandboxed session on the PR's head branch may only have checked it
      // out (a reviewer box does): require its trailer before stamping.
      if (pr && shouldStamp(pr.url)) await stamp(pr, desc.remote === true)
    }

    await refreshCost(desc, supervisor, cwd)
  }

  // Cost refresh: a PR opened THROUGH the daemon (`command_execute`) is
  // stamped the instant `gh pr create` returns — mid-turn, when a
  // claude-code/claude-sdk session has reported no usage yet (cost only
  // arrives on the turn's `result`). Once the session knows its spend,
  // re-render each recorded PR's footer exactly once.
  const refreshCost = async (
    desc: ReconcilerSession,
    supervisor: { id: string } | null,
    cwd: string,
  ): Promise<void> => {
    if (typeof desc.costUsd !== "number") return
    const skipRepos = await (async () => {
      try {
        return await (opts.skipFooterRepos?.() ?? [])
      } catch {
        return []
      }
    })()
    for (const opened of desc.openedPrs ?? []) {
      if (costRefreshedPrUrls.has(opened.url)) continue
      const number = opened.number ?? prNumberFromUrl(opened.url)
      if (number === null) {
        costRefreshedPrUrls.add(opened.url)
        continue
      }
      // A repo opted out of footers is never stamped OR refreshed.
      const repo = repoFromPrUrl(opened.url)
      if (repo !== undefined && skipRepos.includes(repo)) {
        costRefreshedPrUrls.add(opened.url)
        continue
      }
      const prior: PrFooterState | undefined = {
        ...(opened.footerBodyHash !== undefined ? { bodyHash: opened.footerBodyHash } : {}),
        ...(opened.footerRemovals !== undefined ? { removals: opened.footerRemovals } : {}),
        ...(opened.footerDisabled ? { disabled: true } : {}),
      }
      if (prior.disabled) {
        costRefreshedPrUrls.add(opened.url)
        continue
      }
      const outcome = await stampFooterOnPr({
        registry: opts.registry,
        session: desc,
        supervisor,
        prNumber: number,
        prUrl: opened.url,
        cwd,
        refresh: true,
        ...(prior.bodyHash !== undefined || prior.removals !== undefined ? { footerState: prior } : {}),
        ...(opts.run ? { run: opts.run } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        checkpointRefPrefix: checkpointRefPrefixForSession(desc, opts.checkpointRefPrefix),
      })
      if (outcome.footerState?.disabled === true) {
        log(`[pr-provenance] ${opened.url} lost its footer twice with no body change; stopping stamps`)
      }
      // Settled either way (re-rendered, or already carried a cost); a
      // failed gh call is retried at the next turn-end.
      if (outcome.stamped) {
        costRefreshedPrUrls.add(opened.url)
        stampedByThisRun.set(opened.url, desc.id)
      }
    }
  }

  const safeReconcile = (sessionId: string, terminal: boolean): void => {
    // Fire-and-forget: a reconcile error must never escape the bus callback.
    void reconcile(sessionId, terminal).catch(() => {})
  }

  // Cost-only counterpart to `reconcile`'s PR-discovery lanes, for a turn
  // that can't have opened a NEW PR but may still have just learned the
  // session's spend. Some adapters (OpenRouter-routed models observed via
  // hermes AND direct ACP harnesses alike — see `SessionTurnEndEvent.empty`'s
  // doc) settle their cost on a trailing turn that carries no assistant text
  // and no tool call — exactly the shape `emptyTurn` flags. Skipping
  // `reconcile()` outright on that turn (as the turn-end handler below does,
  // correctly, for PR discovery) also skipped this cost refresh, so a session
  // whose PR-creating turn stamped a footer with no amount could go the rest
  // of its life — every later turn "empty" the same way, then no `exited`
  // event at all if it stays parked/kept-alive — without ever re-rendering
  // the footer, even once `desc.costUsd` was known. Never throws.
  const safeRefreshCostOnly = (sessionId: string): void => {
    void (async () => {
      const desc = opts.registry.get(sessionId)
      if (!desc || desc.kind !== "agent-cli") return
      const sessionCwd = desc.cwd ?? desc.worktreePath
      if (!sessionCwd) return
      const { cwd } = await hostSideOf(desc, sessionCwd)
      const supervisor =
        desc.parentSessionId != null
          ? opts.registry.get(desc.parentSessionId) ?? { id: desc.parentSessionId }
          : null
      await refreshCost(desc, supervisor, cwd)
    })().catch(() => {})
  }

  const unsubscribes: Array<() => void> = [
    opts.sessionEvents.on("session:turn-end", ev => {
      // A silent no-op turn (zero output, zero tool calls) can't have opened
      // a NEW PR, so the discovery lanes are skipped — but it CAN be the
      // turn that finally reports the session's cost (see
      // `safeRefreshCostOnly`'s doc), so that half still runs.
      if (ev.empty === true) {
        safeRefreshCostOnly(ev.sessionId)
        return
      }
      safeReconcile(ev.sessionId, false)
    }),
    opts.sessionEvents.on("session:exited", ev => {
      safeReconcile(ev.sessionId, true)
    }),
  ]

  return {
    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe()
      stampedByThisRun.clear()
      costRefreshedPrUrls.clear()
      lastPollAt.clear()
    },
  }
}
