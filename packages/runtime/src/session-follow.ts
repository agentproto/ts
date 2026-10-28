/**
 * session-follow — wake a long-lived session (the FOLLOWER) when sessions it
 * did not necessarily spawn end a turn, await input, exit/crash, or get a PR
 * opened/merged. No polling: it hangs one `onAny` subscriber off the
 * in-process session event bus.
 *
 * Until now events only reached a parent (`supervisor-notify.ts`,
 * `notifyParentOnCrash`) or the owner of a PR sentinel. A follow is the
 * generic primitive: a SELECTOR (`sessionIds` / `all` / `cwdPrefix`, minus an
 * `exclude`) evaluated at EVENT time against the sessions that exist then, so
 * a session spawned later by anybody is covered automatically.
 *
 * Delivery mirrors `supervisor-notify.ts`: matched events are coalesced per
 * follower within `batchMs` into ONE daemon-attested system message
 * (`relation:"system"`, `kind:"notice"`, `urgency:"next-turn"`, or `"fyi"` per follow) through
 * `registry.sendMessage` — an idle follower runs it as its own turn now, a
 * busy one parks it in its prompt queue as a separate turn. It never
 * interrupts. The follower's own events are never delivered to itself, and
 * (by default) neither are its descendants'.
 *
 * Dead follower: first check whether a live replacement already exists —
 * either because the batch's follow(s) were re-pointed at a new follower
 * since the events were enqueued (`store.setFollower` / `upsert` by key), or
 * because the daemon's own lineage (`continuedTo`) already links to one —
 * and deliver the digest there instead of reviving anything. Only when no
 * replacement exists do we fall back to the `sentinel-runtime.ts` approach:
 * resume through the injected `restartSession` hook (never a
 * deliberately-closed one). Concurrent deliveries racing for the same dead
 * id share one in-flight revival, so a stale id is never resurrected twice.
 * Otherwise the digest parks in `~/.agentproto/follows-parked.jsonl` so the
 * events are not silently lost. The follow record is always kept.
 */

import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

import type { ActivityRecord } from "./activity-projection.js"
import { readTranscriptTail } from "./session-index.js"
import { createSessionMessage, type SessionMessage } from "./session-message.js"
import type { SessionEvent, SessionEventBus } from "./session-event-bus.js"
import type { FollowEvent, FollowUrgency, SessionFollow, SessionFollowStore } from "./session-follow-store.js"
import {
  SessionNotAliveError,
  type DigestEntry,
  type QueuedDigest,
  type QueuedPrompt,
  type SessionDescriptor,
} from "./sessions.js"
import { isRetired, resolveSuccessor } from "./session-retirement.js"
import { DELIBERATE_END_REASONS } from "./session-end-reason.js"
import {
  classifyFollowEvent,
  defaultFollowTriageConfig,
  resolveFollowTriageConfig,
  triageFollowEvent,
  type FollowTriageConfig,
  type TriageEvent,
  type TriageFacts,
  type TriageResult,
} from "./follow-triage.js"

/** Max characters of the per-line excerpt. */
export const FOLLOW_EXCERPT_MAX = 300
/** Max event lines in one digest; the rest collapse into a "+N more" line. */
export const FOLLOW_DIGEST_MAX_LINES = 40
/** Cap on retained events when queued digests merge (newest wins). */
export const FOLLOW_DIGEST_MERGE_MAX_ENTRIES = 50
const ANCESTOR_WALK_CAP = 32
const SEEN_PR_CAP = 500

/** The slice of the sessions registry this subscriber needs (structural, like
 *  `SupervisorNotifyRegistry`). */
export interface SessionFollowRegistry {
  get(id: string): SessionDescriptor | undefined
  sendMessage(
    msg: SessionMessage,
    opts?: {
      source?: string
      origin?: string
      coalesceKey?: string
      digest?: QueuedDigest
      merge?: (existing: QueuedPrompt) => {
        message: string
        envelope?: SessionMessage
        digest: QueuedDigest
      }
    },
  ): Promise<unknown>
}

export interface WireSessionFollowOptions {
  registry: SessionFollowRegistry
  sessionEvents: SessionEventBus
  store: SessionFollowStore
  /** Resume a dead follower; resolves to the session id to deliver to.
   *  Omitted → a dead follower's digest is parked. */
  restartSession?: (sessionId: string) => Promise<string>
  /** Last assistant text of a session, for the digest excerpt. Default: the
   *  tail of its `events.jsonl`. */
  readLastOutput?: (desc: SessionDescriptor) => string | undefined
  /** Injectable timers (tests). Default: global `setTimeout`/`clearTimeout`,
   *  resolved at call time so vitest fake timers apply. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Parked-digest journal (tests). Default `~/.agentproto/follows-parked.jsonl`. */
  parkedPath?: string
  /** Daemon-level triage default (what `config.follow.triage` resolves to).
   *  A follow's own `triage` block overrides it. Triage is OFF by default:
   *  with it off nothing about delivery changes. A FUNCTION is re-read
   *  before every digest (the daemon passes the live config resolver). */
  triage?: FollowTriageConfig | (() => FollowTriageConfig | Promise<FollowTriageConfig>)
  /** Per-event triage ledger (tests). Default `~/.agentproto/follow-triage.jsonl`. */
  triagePath?: string
  /** Extra facts the triage rules need but the engine cannot see alone (e.g.
   *  "did this session's cron run finish OK?"). */
  triageFacts?: TriageFacts
  /** Resolve, at EVENT time, whether a non-crashed exit is informational
   *  rather than a wake. Called once per exit with the descriptor captured
   *  then, so a later delete or rename cannot change the outcome. */
  sourceUrgency?: (desc: SessionDescriptor) => "fyi" | undefined
  log?: (line: string) => void
}

export interface SessionFollowHandle {
  /** Deliver every pending batch now (or just `followerId`'s). Resolves once
   *  the deliveries settled. */
  flush(followerId?: string): Promise<void>
  /** Unsubscribe and drop pending batches (shutdown). */
  dispose(): void
}

// ── Event → signal ───────────────────────────────────────────────────

interface Signal {
  sessionId: string
  /** Raw kind; `turn-end` may be promoted to `awaiting-input` per follow. */
  event: FollowEvent
  /** A turn-end that also left the session awaiting input. */
  awaitingInput: boolean
  empty: boolean
  /** A turn-end the host recorded as an explicit no-op ack. */
  silent?: boolean
  ts: string
  label?: string
  /** Event-specific excerpt source (error, question, reason, PR title). */
  detail?: string
  /** Distinguishes collapse groups (a PR activity id). */
  key?: string
  /** Set on `task-changed` signals: the board whose task moved. Its presence
   *  is what routes a signal through board matching instead of session
   *  matching. */
  boardId?: string
  /** Set on `task-changed` signals: the task that moved. */
  taskId?: string
  /** The turn-end / exit reason (`cancelled`, `error`, `operator-stopped`, …). */
  reason?: string
}

function signalOf(ev: SessionEvent, seenPrs: Set<string>): Signal | undefined {
  switch (ev.type) {
    case "session:turn-end": {
      const detail =
        ev.error ??
        (ev.awaitingInput && ev.question?.text ? ev.question.text : undefined) ??
        (ev.reason && ev.reason !== "completed" ? `turn ended: ${ev.reason}` : undefined)
      return {
        sessionId: ev.sessionId,
        event: "turn-end",
        awaitingInput: ev.awaitingInput === true,
        empty: ev.empty === true,
        silent: ev.silent === true,
        ts: ev.ts,
        ...(ev.label ? { label: ev.label } : {}),
        ...(detail ? { detail } : {}),
        ...(ev.reason ? { reason: ev.reason } : {}),
      }
    }
    case "session:awaiting-input":
      return {
        sessionId: ev.sessionId,
        event: "awaiting-input",
        awaitingInput: true,
        empty: false,
        ts: ev.ts,
        ...(ev.label ? { label: ev.label } : {}),
        ...(ev.question?.text ? { detail: ev.question.text } : {}),
      }
    case "session:exited": {
      const crashed = ev.status === "error" || ev.reason === "crashed"
      return {
        sessionId: ev.sessionId,
        event: crashed ? "crashed" : "exited",
        awaitingInput: false,
        empty: false,
        ts: ev.ts,
        ...(ev.label ? { label: ev.label } : {}),
        ...(ev.reason ? { detail: ev.reason, reason: ev.reason } : {}),
      }
    }
    case "activity:changed":
      return prSignalOf(ev.activity, ev.ts, seenPrs)
    case "task:changed": {
      // A pure field edit (title/meta/…) is not something to wake anyone for;
      // created / claimed / status / released are.
      if (ev.change === "edited") return undefined
      return {
        sessionId: ev.sessionId ?? "",
        event: "task-changed",
        awaitingInput: false,
        empty: false,
        ts: ev.ts,
        boardId: ev.boardId,
        taskId: ev.taskId,
        detail: `${ev.change} → ${ev.status}`,
        key: `${ev.boardId}:${ev.taskId}`,
      }
    }
    default:
      return undefined
  }
}

/** Map a `kind:"pr"` activity to pr-opened (first sighting while open) /
 *  pr-merged (state `done`); cancelled/failed/other are ignored. Defensive
 *  about the payload shape — anything unexpected is simply not a PR signal. */
function prSignalOf(activity: ActivityRecord | undefined, ts: string, seenPrs: Set<string>): Signal | undefined {
  if (!activity || activity.kind !== "pr" || typeof activity.id !== "string") return undefined
  const sessionId = activity.sessionId
  if (typeof sessionId !== "string" || !sessionId) return undefined
  const title = typeof activity.title === "string" ? activity.title : activity.id
  if (activity.state === "done") {
    seenPrs.add(activity.id)
    return { sessionId, event: "pr-merged", awaitingInput: false, empty: false, ts, detail: title, key: activity.id }
  }
  if (activity.state === "cancelled" || activity.state === "failed") return undefined
  // Still open (pending/active/…): only the FIRST sighting is "opened".
  if (seenPrs.has(activity.id)) return undefined
  seenPrs.add(activity.id)
  if (seenPrs.size > SEEN_PR_CAP) {
    const oldest = seenPrs.values().next().value
    if (oldest !== undefined) seenPrs.delete(oldest)
  }
  return { sessionId, event: "pr-opened", awaitingInput: false, empty: false, ts, detail: title, key: activity.id }
}

// ── Selector matching ────────────────────────────────────────────────

function cwdUnder(cwd: string | undefined, prefix: string): boolean {
  if (!cwd) return false
  const norm = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p)
  const c = norm(cwd)
  const p = norm(prefix)
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`)
}

function descendsFrom(
  registry: SessionFollowRegistry,
  desc: SessionDescriptor | undefined,
  ancestorId: string,
): boolean {
  let parent = desc?.parentSessionId
  for (let i = 0; parent && i < ANCESTOR_WALK_CAP; i++) {
    if (parent === ancestorId) return true
    parent = registry.get(parent)?.parentSessionId
  }
  return false
}

/** Does `follow`'s selector (minus exclusions) cover this session NOW? Pure
 *  of event kind/filters — see {@link followWants} for those. `desc` is the
 *  session's current descriptor (absent → only id-based rules can match). */
export function followCoversSession(
  follow: SessionFollow,
  sessionId: string,
  desc: SessionDescriptor | undefined,
  registry: Pick<SessionFollowRegistry, "get">,
  eventLabel?: string,
): boolean {
  if (sessionId === follow.follower) return false
  if (follow.exclude?.sessionIds?.includes(sessionId)) return false
  const label = desc?.label ?? eventLabel
  if (label && follow.exclude?.labels?.includes(label)) return false
  const ownDescendant = descendsFrom(registry as SessionFollowRegistry, desc, follow.follower)
  if (ownDescendant && follow.excludeFollowerChildren) return false
  const sel = follow.selector
  if (sel.sessionIds?.includes(sessionId)) return true
  // Opting IN to its own descendants (`excludeFollowerChildren: false`) must
  // actually deliver them: a supervisor following `all` (rootOnly by default)
  // would otherwise still miss every child it spawned, since those have a
  // parent. They bypass `rootOnly` and `cwdPrefix`, like explicit ids.
  if (ownDescendant && (sel.all === true || (sel.cwdPrefix !== undefined && sel.cwdPrefix !== ""))) return true
  const broad = sel.all === true || (sel.cwdPrefix !== undefined && sel.cwdPrefix !== "")
  if (!broad) return false
  if (sel.cwdPrefix && !cwdUnder(desc?.cwd, sel.cwdPrefix)) return false
  const rootOnly = sel.rootOnly ?? sel.all === true
  if (rootOnly && desc?.parentSessionId) return false
  return true
}

/** Would the follow's selector cover the FOLLOWER's own session? Used by
 *  the triage path: the follower's own board write may reach the triage
 *  stage (where the `ownTaskChanges` rule drops it) but triage must never
 *  WIDEN what a follow sees. */
function selectorCoversFollower(
  follow: SessionFollow,
  followerDesc: SessionDescriptor | undefined,
): boolean {
  const sel = follow.selector
  if (sel.sessionIds?.includes(follow.follower)) return true
  const broad = sel.all === true || (sel.cwdPrefix !== undefined && sel.cwdPrefix !== "")
  if (!broad) return false
  if (sel.cwdPrefix && !cwdUnder(followerDesc?.cwd, sel.cwdPrefix)) return false
  const rootOnly = sel.rootOnly ?? sel.all === true
  if (rootOnly && followerDesc?.parentSessionId) return false
  return true
}

/** The event kind `follow` would deliver for `signal`, or undefined when its
 *  event filter / empty-turn rule drops it. */
function followWants(follow: SessionFollow, signal: Signal): FollowEvent | undefined {
  const wants = (e: FollowEvent): boolean => follow.events.includes(e)
  if (signal.event === "turn-end") {
    if (signal.awaitingInput && wants("awaiting-input")) return "awaiting-input"
    if (!wants("turn-end")) return undefined
    if (signal.empty && follow.skipEmptyTurns && !signal.awaitingInput) return undefined
    if (signal.silent && follow.skipEmptyTurns && !signal.awaitingInput) return undefined
    return "turn-end"
  }
  return wants(signal.event) ? signal.event : undefined
}

/** Does `follow` cover a `task-changed` signal for `boardId`? Board follows
 *  match purely on the board id — the session selector (`sessionIds`/`all`/
 *  `cwdPrefix`) does not apply. The follower's own writes are filtered earlier
 *  (the actor session id never equals the follower), so a board the brain
 *  itself edited never wakes it. */
function followMatchesBoard(follow: SessionFollow, boardId: string): boolean {
  return follow.selector.boardId !== undefined && follow.selector.boardId === boardId
}

// ── Digest ───────────────────────────────────────────────────────────

interface BatchEntry {
  sessionId: string
  event: FollowEvent
  ts: string
  label?: string
  cwd?: string
  detail?: string
  key?: string
  /** Task-board entries (`task-changed`): the board and task that moved. When
   *  `boardId` is set the digest renders a board line, not a session line. */
  boardId?: string
  taskId?: string
  /** `turn-end` / `awaiting-input`: the session is waiting on the human. */
  awaitingInput?: boolean
  /** `turn-end`: the turn produced no output at all. */
  empty?: boolean
  /** `turn-end`: the host recorded the agent's explicit no-op ack. */
  silent?: boolean
  /** `exited`: the source declared this success informational (fyi). */
  fyi?: boolean
  /** The turn-end / exit reason. */
  reason?: string
}

const TURN_FAMILY: ReadonlySet<FollowEvent> = new Set(["turn-end", "awaiting-input"])

/** The always-wake events (`follow-triage.ts` rule `always-wake`): a session
 *  waiting on the human, a crash, or a turn-end carrying a question. These
 *  are pinned through both digest caps. */
function isMustWakeEntry(entry: { event: string; awaitingInput?: boolean }): boolean {
  return (
    entry.event === "awaiting-input" ||
    entry.event === "crashed" ||
    (entry.event === "turn-end" && entry.awaitingInput === true)
  )
}

function sameCollapseGroup(a: BatchEntry, b: BatchEntry): boolean {
  if (a.sessionId !== b.sessionId) return false
  if ((a.key ?? "") !== (b.key ?? "")) return false
  if (!(a.event === b.event || (TURN_FAMILY.has(a.event) && TURN_FAMILY.has(b.event)))) return false
  // A must-wake entry is never replaced by a later event of the same session:
  // the later event is kept next to it. An identical must-wake event (the
  // same awaiting-input reported twice) still collapses to one line.
  if (isMustWakeEntry(a)) return a.event === b.event && isMustWakeEntry(b)
  return true
}

/** Squeeze to one line, <= {@link FOLLOW_EXCERPT_MAX} chars. The TAIL is kept
 *  (the conclusion, not the preamble). */
export function excerptOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return flat.length <= FOLLOW_EXCERPT_MAX ? flat : `…${flat.slice(flat.length - (FOLLOW_EXCERPT_MAX - 1))}`
}

/** Compose the digest text. Exported for tests. `mode:"fyi"` renders the
 *  header of a digest that must NOT wake the follower. */
export function formatFollowDigest(
  entries: readonly DigestEntry[],
  resolveText: (entry: DigestEntry) => string | undefined,
  desc: (id: string) => SessionDescriptor | undefined,
  mode: "wake" | "fyi" = "wake",
  omitted = 0,
  coalesced = 1,
): string {
  const coalescedNote =
    coalesced > 1 ? ` Coalesced from ${coalesced} queued digests.` : ""
  const header =
    (mode === "fyi"
      ? `[session-follow] automatic digest (for your information only — no action expected) — ` +
        `${entries.length} event${entries.length === 1 ? "" : "s"} from sessions you follow.`
      : `[session-follow] automatic digest — ${entries.length} event${entries.length === 1 ? "" : "s"} ` +
        `from sessions you follow. Decide whether anything needs the human's attention; ` +
        `if not, no reply is needed.`) + coalescedNote
  const omittedLine =
    omitted > 0
      ? `[session-follow] ${omitted} earlier event${omitted === 1 ? "" : "s"} omitted`
      : undefined
  // Must-wake lines are pinned: when the render cap bites, non-must-wake
  // lines are dropped first. A digest with no must-wake entry keeps the
  // original oldest-first prefix, byte-identical to before.
  const mustWakeCount = entries.reduce((n, entry) => n + (isMustWakeEntry(entry) ? 1 : 0), 0)
  let nonMustWakeBudget = Math.max(0, FOLLOW_DIGEST_MAX_LINES - mustWakeCount)
  const rendered =
    mustWakeCount === 0
      ? entries.slice(0, FOLLOW_DIGEST_MAX_LINES)
      : entries.filter(entry => {
          if (isMustWakeEntry(entry)) return true
          if (nonMustWakeBudget <= 0) return false
          nonMustWakeBudget--
          return true
        })
  const lines = rendered.map(entry => {
    if (entry.boardId !== undefined) {
      const parts = [`[session-follow] board ${entry.boardId} task ${entry.taskId ?? "?"} ${entry.event}`]
      const text = excerptOf(entry.detail)
      if (text) parts.push(text)
      return parts.join(" — ")
    }
    const d = desc(entry.sessionId)
    const label = d?.label ?? entry.label
    const who = `${label ?? entry.sessionId} (${entry.sessionId})`
    const cwd = d?.cwd ?? entry.cwd
    const parts = [`[session-follow] ${who} ${entry.event}`]
    if (cwd) parts.push(basename(cwd) || cwd)
    const text = excerptOf(resolveText(entry))
    if (text) parts.push(text)
    return parts.join(" — ")
  })
  const hidden = entries.length - rendered.length
  if (hidden > 0) {
    lines.push(`[session-follow] … and ${hidden} more event(s)`)
  }
  return [header, ...(omittedLine ? [omittedLine] : []), ...lines].join("\n")
}

/** Union two queued digest payloads, keeping the newest
 *  {@link FOLLOW_DIGEST_MERGE_MAX_ENTRIES} events and counting the rest as
 *  `omitted`. Must-wake events are pinned: they are never dropped by the cap,
 *  and only non-must-wake events count toward the omitted total. */
export function mergeQueuedDigests(existing: QueuedDigest | undefined, incoming: QueuedDigest): QueuedDigest {
  const all = [...(existing?.entries ?? []), ...incoming.entries]
  const mustWakeCount = all.reduce((n, entry) => n + (isMustWakeEntry(entry) ? 1 : 0), 0)
  let nonMustWakeBudget = Math.max(0, FOLLOW_DIGEST_MERGE_MAX_ENTRIES - mustWakeCount)
  let overflow = 0
  const retained: DigestEntry[] = []
  // Walk backwards so the newest non-must-wake events win, then emit the kept
  // entries in their original chronological order.
  for (let i = all.length - 1; i >= 0; i--) {
    const entry = all[i]!
    if (isMustWakeEntry(entry)) {
      retained.unshift(entry)
    } else if (nonMustWakeBudget > 0) {
      nonMustWakeBudget--
      retained.unshift(entry)
    } else {
      overflow++
    }
  }
  return {
    entries: retained,
    omitted: (existing?.omitted ?? 0) + incoming.omitted + overflow,
  }
}

// ── Wiring ───────────────────────────────────────────────────────────

function agentprotoHome(): string {
  return process.env.AGENTPROTO_HOME ?? join(homedir(), ".agentproto")
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function isAlive(desc: SessionDescriptor): boolean {
  return (desc.status === "running" || desc.status === "starting") && desc.processAlive !== false
}

interface Batch {
  entries: BatchEntry[]
  followIds: Set<string>
  /** "next-turn" as soon as any contributing follow asks for it; "fyi" only
   *  when every follow feeding this batch is passive. */
  urgency: FollowUrgency
  timer: unknown
}

export function wireSessionFollow(opts: WireSessionFollowOptions): SessionFollowHandle {
  const { registry, sessionEvents, store } = opts
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>))
  const parkedPath = opts.parkedPath ?? resolve(agentprotoHome(), "follows-parked.jsonl")
  const triagePath = opts.triagePath ?? resolve(agentprotoHome(), "follow-triage.jsonl")
  const daemonTriage: FollowTriageConfig =
    typeof opts.triage === "object" && opts.triage !== null
      ? opts.triage
      : defaultFollowTriageConfig()
  /** Re-read the daemon-level triage default (the daemon passes a resolver
   *  so a `config_set` applies to the next digest). */
  async function refreshDaemonTriage(): Promise<void> {
    if (typeof opts.triage !== "function") return
    try {
      const next = await opts.triage()
      if (next) {
        daemonTriage.enabled = next.enabled
        daemonTriage.rules = { ...next.rules }
        daemonTriage.reportWindowMs = next.reportWindowMs
        if (next.classifier) daemonTriage.classifier = next.classifier
        else delete daemonTriage.classifier
      }
    } catch (err) {
      log(`[session-follow] could not refresh the triage config: ${describeError(err)}`)
    }
  }
  const readLastOutput =
    opts.readLastOutput ??
    ((d: SessionDescriptor): string | undefined =>
      d.eventsPath ? readTranscriptTail(d.eventsPath).lastOutputText : undefined)

  const batches = new Map<string, Batch>()
  const seenPrs = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  /** One in-flight `restartSession` promise per dead follower id, so two
   *  stale batches racing for the same dead id collapse into one revival. */
  const revivals = new Map<string, Promise<string>>()
  /** follower id → reporter session id → epoch ms of the last report the
   *  reporter sent UP to that follower (`message_parent`). Bounded by the
   *  {@link REPORT_RETENTION_MS}: stale entries are pruned on every write. */
  const reports = new Map<string, Map<string, number>>()
  const REPORT_RETENTION_MS = 60 * 60_000

  function park(followerId: string, text: string, reason: string): void {
    log(`[session-follow] follower ${followerId}: ${reason} — digest parked`)
    try {
      mkdirSync(dirname(parkedPath), { recursive: true })
      appendFileSync(
        parkedPath,
        JSON.stringify({ follower: followerId, reason, text, ts: new Date().toISOString() }) + "\n",
        { mode: 0o600 },
      )
    } catch (err) {
      log(`[session-follow] failed to park digest for ${followerId}: ${describeError(err)}`)
    }
  }

  // ── Triage ──────────────────────────────────────────────────────────

  /** The effective triage config of a batch: the daemon default, overridden
   *  by every contributing follow. Triage runs for the batch as soon as ONE
   *  contributing follow turns it on. Per rule: a value a follow set
   *  explicitly beats the daemon default; when contributing follows disagree,
   *  ON wins (a follow that wants the rule beats one that does not). The
   *  classifier is operator-owned and only ever comes from the daemon config. */
  function triageConfigFor(follows: readonly SessionFollow[]): FollowTriageConfig {
    const rules = { ...daemonTriage.rules }
    for (const key of Object.keys(rules) as (keyof FollowTriageConfig["rules"])[]) {
      const explicit = follows
        .map(f => f.triage?.rules?.[key])
        .filter((v): v is boolean => typeof v === "boolean")
      if (explicit.length > 0) rules[key] = explicit.some(Boolean)
    }
    const reportWindowMs =
      follows.find(f => f.triage?.reportWindowMs !== undefined)?.triage?.reportWindowMs ??
      daemonTriage.reportWindowMs
    return {
      enabled: follows.some(f => (f.triage?.enabled ?? daemonTriage.enabled) === true),
      rules,
      ...(daemonTriage.classifier ? { classifier: daemonTriage.classifier } : {}),
      reportWindowMs,
    }
  }

  /** Did `sessionId` report UP to `follower` within the window before the
   *  event? A report is a child→parent message (`message_parent`). */
  function reportedRecently(event: TriageEvent, windowMs: number): boolean {
    const byReporter = reports.get(event.follower)
    const at = byReporter?.get(event.sessionId)
    if (at === undefined) return false
    const evAt = Date.parse(event.ts)
    if (!Number.isFinite(evAt)) return false
    // The report may land a hair AFTER the turn-end it announces (same
    // tick) — a 2s grace covers that without widening the window.
    const delta = evAt - at
    return delta <= windowMs && delta >= -2_000
  }

  /** Is this session one of the follower's OWN live sessions (the follower
   *  itself or one of its descendants)? */
  function isFollowerSession(sessionId: string, follower: string): boolean {
    if (sessionId === follower) return true
    const desc = registry.get(sessionId)
    if (!desc || !isAlive(desc)) return false
    return descendsFrom(registry, desc, follower)
  }

  /** Was this turn-end followed by a NEW turn of the same session? True
   *  when a later turn-end of the same session is already in the batch, or
   *  when the session is busy again (a new turn is in flight). */
  function supersededByNewTurn(event: TriageEvent, entries: readonly BatchEntry[]): boolean {
    const evAt = Date.parse(event.ts)
    for (const entry of entries) {
      if (entry.sessionId !== event.sessionId) continue
      if (entry.event !== "turn-end") continue
      const at = Date.parse(entry.ts)
      if (Number.isFinite(evAt) && Number.isFinite(at) && at > evAt) return true
    }
    return registry.get(event.sessionId)?.busy === true
  }

  /** The facts the triage rules read. Engine-owned ones first, then the
   *  caller's overrides (a cron-status probe, a test seam). */
  function factsFor(entries: readonly BatchEntry[]): TriageFacts {
    return {
      reportedRecently,
      isFollowerSession,
      supersededByNewTurn: event => supersededByNewTurn(event, entries),
      ...(opts.triageFacts ?? {}),
    }
  }

  function toTriageEvent(followerId: string, entry: BatchEntry): TriageEvent {
    return {
      follower: followerId,
      event: entry.event,
      sessionId: entry.sessionId,
      ts: entry.ts,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.key ? { key: entry.key } : {}),
      ...(entry.boardId ? { boardId: entry.boardId } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.awaitingInput !== undefined ? { awaitingInput: entry.awaitingInput } : {}),
      ...(entry.empty !== undefined ? { empty: entry.empty } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
    }
  }

  /** One JSONL line per triaged event — the training data a future
   *  classifier is fitted on. Never throws: a failed write is logged. */
  function writeTriageLedger(
    followerId: string,
    entries: readonly BatchEntry[],
    results: readonly TriageResult[],
    applied: boolean,
    digestId: string,
  ): void {
    try {
      mkdirSync(dirname(triagePath), { recursive: true })
      const lines = entries
        .map((entry, i) => {
          const result = results[i]
          if (!result) return null
          return JSON.stringify({
            ts: new Date().toISOString(),
            source: "follow",
            applied,
            follower: followerId,
            event: entry.event,
            sessionId: entry.sessionId,
            ...(entry.label ? { label: entry.label } : {}),
            decision: result.decision,
            rule: result.rule,
            eventTs: entry.ts,
            ...(entry.key ? { key: entry.key } : {}),
            ...(entry.taskId ? { taskId: entry.taskId } : {}),
            digestId,
          })
        })
        .filter((line): line is string => line !== null)
      if (lines.length === 0) return
      appendFileSync(triagePath, lines.join("\n") + "\n", { mode: 0o600 })
    } catch (err) {
      log(`[session-follow] failed to write the triage ledger: ${describeError(err)}`)
    }
  }

  const textFor = (entry: DigestEntry): string | undefined => {
    const d = registry.get(entry.sessionId)
    if (entry.event === "pr-opened" || entry.event === "pr-merged") return entry.detail
    if (entry.event === "crashed") {
      return [entry.detail, d?.lastError].filter(Boolean).join(": ") || undefined
    }
    if (entry.event === "exited") {
      const body = d?.outcome?.summary ?? (d ? readLastOutput(d) : undefined)
      return [entry.detail, body].filter(Boolean).join(": ") || undefined
    }
    // turn-end / awaiting-input: the question or error beats the prose.
    if (entry.detail) return entry.detail
    return d ? readLastOutput(d) : undefined
  }

  /** Capture everything `formatFollowDigest` needs for these events at
   *  classification time. A later merge re-renders from these plain entries
   *  only, never from a live session or transcript. */
  const digestEntriesFor = (entries: readonly BatchEntry[]): DigestEntry[] =>
    entries.map(entry => {
      const text = textFor(entry)
      return {
        sessionId: entry.sessionId,
        event: entry.event,
        ts: entry.ts,
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.detail ? { detail: entry.detail } : {}),
        ...(entry.key ? { key: entry.key } : {}),
        ...(entry.boardId ? { boardId: entry.boardId } : {}),
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
        ...(entry.awaitingInput !== undefined ? { awaitingInput: entry.awaitingInput } : {}),
        ...(entry.empty !== undefined ? { empty: entry.empty } : {}),
        ...(entry.silent !== undefined ? { silent: entry.silent } : {}),
        ...(entry.fyi ? { fyi: true } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(text ? { text } : {}),
      }
    })

  async function sendOnce(
    to: string,
    text: string,
    followerId: string,
    urgency: FollowUrgency,
    digest?: QueuedDigest,
  ): Promise<void> {
    // fyi digests only ever land in the inbox, never the prompt queue, so
    // they carry no merge payload.
    const queuedDigest = urgency === "fyi" ? undefined : digest
    const merge = queuedDigest
      ? (existing: QueuedPrompt): { message: string; digest: QueuedDigest } => {
          const merged = mergeQueuedDigests(existing.digest, queuedDigest)
          return {
            message: formatFollowDigest(
              merged.entries,
              entry => entry.text,
              id => registry.get(id),
              "wake",
              merged.omitted,
              (existing.coalescedCount ?? 1) + 1,
            ),
            digest: merged,
          }
        }
      : undefined
    await registry.sendMessage(
      createSessionMessage({ to, from: { relation: "system" }, text, kind: "notice", urgency }),
      {
        source: "session-follow",
        origin: `follow:${followerId}`,
        ...(queuedDigest
          ? { coalesceKey: `follow-digest:${followerId}`, digest: queuedDigest, merge: merge! }
          : {}),
      },
    )
  }

  /** A dead follower may already have a live replacement: its follow(s) may
   *  have been re-pointed since this batch's events were enqueued (repoint
   *  race), or the daemon's own lineage may already link to one. */
  function findLiveReplacement(followerId: string, followIds: ReadonlySet<string>): string | undefined {
    for (const followId of followIds) {
      const follower = store.get(followId)?.follower
      if (!follower || follower === followerId) continue
      const desc = registry.get(follower)
      if (desc && isAlive(desc)) return follower
    }
    const successor = resolveSuccessor(id => registry.get(id), followerId)
    if (successor) {
      const desc = registry.get(successor)
      if (desc && isAlive(desc)) {
        // The conversation moved on: the follow follows it, so the next
        // digest doesn't go through the dead row again.
        for (const f of store.list({ follower: followerId })) store.setFollower(f.id, successor)
        return successor
      }
    }
    return undefined
  }

  /** Resume a dead follower's id, reusing an already in-flight revival for
   *  the same id instead of starting a second one. */
  function reviveOnce(followerId: string): Promise<string> {
    const pending = revivals.get(followerId)
    if (pending) return pending
    const started = opts.restartSession!(followerId).finally(() => revivals.delete(followerId))
    revivals.set(followerId, started)
    return started
  }

  async function reviveAndSend(
    followerId: string,
    text: string,
    followIds: ReadonlySet<string>,
    urgency: FollowUrgency,
    digest?: QueuedDigest,
  ): Promise<void> {
    const replacement = findLiveReplacement(followerId, followIds)
    if (replacement) {
      try {
        await sendOnce(replacement, text, replacement, urgency, digest)
      } catch (err) {
        park(followerId, text, `could not deliver to replacement ${replacement}: ${describeError(err)}`)
      }
      return
    }
    const desc = registry.get(followerId)
    // The follower was superseded by a successor that is itself dead but not
    // retired: resume THAT row (the conversation's current head), never the
    // retired one.
    const headId = desc && isRetired(desc) ? resolveSuccessor(id => registry.get(id), followerId) : undefined
    const head = headId ? registry.get(headId) : undefined
    if (headId && head && !isRetired(head) && opts.restartSession) {
      try {
        const resumed = await reviveOnce(headId)
        for (const f of store.list({ follower: followerId })) store.setFollower(f.id, resumed)
        await sendOnce(resumed, text, resumed, urgency, digest)
      } catch (err) {
        park(followerId, text, `could not resume successor ${headId}: ${describeError(err)}`)
      }
      return
    }
    if (desc && isRetired(desc)) {
      // Retired (closed on purpose / archived / superseded) with no live
      // successor: never revived, in place or under a new id.
      const why = desc.continuedTo
        ? `superseded by ${desc.continuedTo}, which is not alive`
        : desc.archived
          ? "archived"
          : desc.endedReason && DELIBERATE_END_REASONS.has(desc.endedReason)
            ? `closed on purpose (${desc.endedReason})`
            : "retired"
      park(followerId, text, `follower is retired (${why}); not resuming`)
      return
    }
    if (!opts.restartSession) {
      park(followerId, text, "follower is not alive and no restart hook is wired")
      return
    }
    try {
      const resumed = await reviveOnce(followerId)
      if (resumed !== followerId) {
        for (const f of store.list({ follower: followerId })) store.setFollower(f.id, resumed)
      }
      await sendOnce(resumed, text, resumed, urgency, digest)
    } catch (err) {
      park(followerId, text, `could not resume follower: ${describeError(err)}`)
    }
  }

  async function deliver(
    followerId: string,
    text: string,
    followIds: ReadonlySet<string>,
    urgency: FollowUrgency,
    digest?: QueuedDigest,
  ): Promise<void> {
    const desc = registry.get(followerId)
    if (!desc) {
      log(`[session-follow] follower ${followerId} no longer exists — digest dropped (follow kept)`)
      return
    }
    if (!isAlive(desc)) {
      await reviveAndSend(followerId, text, followIds, urgency, digest)
      return
    }
    try {
      await sendOnce(followerId, text, followerId, urgency, digest)
    } catch (err) {
      if (err instanceof SessionNotAliveError) {
        await reviveAndSend(followerId, text, followIds, urgency, digest)
        return
      }
      log(`[session-follow] delivery to ${followerId} failed: ${describeError(err)}`)
    }
  }

  async function flushFollower(followerId: string): Promise<void> {
    const batch = batches.get(followerId)
    if (!batch) return
    batches.delete(followerId)
    clearTimer(batch.timer)
    if (batch.entries.length === 0) return
    await refreshDaemonTriage()
    const entries = batch.entries
    const follows = [...batch.followIds]
      .map(id => store.get(id))
      .filter((f): f is SessionFollow => f !== undefined)
    const triage = triageConfigFor(follows)
    const digestId = randomUUID()
    let text: string
    let deliveredEntries: BatchEntry[] = entries
    let urgency: FollowUrgency = batch.urgency
    if (triage.enabled) {
      // Deterministic triage BEFORE the wake: every event is classified,
      // every decision is logged, and only the `wake` ones (plus a count of
      // the informational ones) make it into a digest that may wake.
      try {
        const facts = factsFor(entries)
        const results: TriageResult[] = []
        for (const entry of entries) {
          const result = await triageFollowEvent(toTriageEvent(followerId, entry), triage, facts)
          // A source-declared fyi is already an explicit downgrade: triage may
          // drop it, but never raise it back to a wake.
          results.push(
            entry.fyi && result.decision === "wake"
              ? { decision: "fyi", rule: "source-fyi" }
              : result,
          )
        }
        writeTriageLedger(followerId, entries, results, true, digestId)
        const wakeEntries = entries.filter((_, i) => results[i]!.decision === "wake")
        const fyiEntries = entries.filter((_, i) => results[i]!.decision === "fyi")
        if (wakeEntries.length === 0) {
          if (fyiEntries.length === 0) {
            // Everything was dropped: nothing to deliver, nothing to wake.
            log(`[session-follow] follower ${followerId}: digest dropped by triage (${entries.length} event(s))`)
            return
          }
          text = formatFollowDigest(fyiEntries, textFor, id => registry.get(id), "fyi")
          deliveredEntries = fyiEntries
          urgency = "fyi"
        } else {
          text = formatFollowDigest(wakeEntries, textFor, id => registry.get(id))
          deliveredEntries = wakeEntries
          if (fyiEntries.length > 0) {
            text += `\n[session-follow] ${fyiEntries.length} other event(s) in info (not shown)`
          }
          urgency = batch.urgency === "fyi" ? "fyi" : "next-turn"
        }
      } catch (err) {
        // Fail open: triage is an optimisation, never a reason to lose the
        // batch (an awaiting-input or a crash must still reach the follower).
        log(`[session-follow] triage failed for ${followerId}: ${describeError(err)}`)
        text = formatFollowDigest(entries, textFor, id => registry.get(id))
        deliveredEntries = entries
        urgency = batch.urgency
      }
    } else {
      // Triage off still records the rules' verdict for every event, marked
      // as not applied: the ledger is always on, the delivery is unchanged.
      try {
        const facts = factsFor(entries)
        const results = entries.map(entry =>
          classifyFollowEvent(toTriageEvent(followerId, entry), triage.rules, facts, triage.reportWindowMs),
        )
        writeTriageLedger(followerId, entries, results, false, digestId)
      } catch (err) {
        log(`[session-follow] could not record the triage ledger for ${followerId}: ${describeError(err)}`)
      }
      if (entries.every(entry => entry.fyi === true)) {
        // Every event is informational: reuse the all-fyi path (inbox only).
        text = formatFollowDigest(entries, textFor, id => registry.get(id), "fyi")
        urgency = "fyi"
      } else {
        // A mixed digest keeps today's urgency and lists every line.
        text = formatFollowDigest(entries, textFor, id => registry.get(id))
      }
    }
    const digest = { entries: digestEntriesFor(deliveredEntries), omitted: 0 }
    const p = deliver(followerId, text, batch.followIds, urgency, digest)
      .catch(err => log(`[session-follow] flush for ${followerId} failed: ${describeError(err)}`))
      .finally(() => inFlight.delete(p))
    inFlight.add(p)
    return p
  }

  function enqueue(followerId: string, follow: SessionFollow, entry: BatchEntry): void {
    let batch = batches.get(followerId)
    if (!batch) {
      batch = { entries: [], followIds: new Set(), urgency: "fyi", timer: undefined }
      batches.set(followerId, batch)
    }
    // Same-session duplicates collapse, keeping the latest (moved to the end).
    for (let i = batch.entries.length - 1; i >= 0; i--) {
      if (sameCollapseGroup(batch.entries[i]!, entry)) {
        batch.entries.splice(i, 1)
        break
      }
    }
    batch.entries.push(entry)
    batch.followIds.add(follow.id)
    if (follow.urgency !== "fyi") batch.urgency = "next-turn"
    if (batch.timer === undefined) {
      const target = batch
      target.timer = setTimer(() => {
        void flushFollower(followerId)
      }, follow.batchMs)
      // Don't let a pending coalescing window hold the process open.
      ;(target.timer as { unref?: () => void } | undefined)?.unref?.()
    }
  }

  const unsubscribe = sessionEvents.onAny(ev => {
    try {
      const follows = store.list()
      if (follows.length === 0) return
      const signal = signalOf(ev, seenPrs)
      if (!signal) return
      const desc = registry.get(signal.sessionId)
      // Resolve the source's declared urgency ONCE, at event time. Only a
      // non-crashed exit can be an informational success.
      const sourceFyi =
        signal.event === "exited" && desc !== undefined && opts.sourceUrgency?.(desc) === "fyi"
      const claimed = new Set<string>()
      for (const follow of follows) {
        const alreadyClaimed = claimed.has(follow.follower)
        // A second matching follow adds no entry, but a next-turn one still
        // makes the shared batch wake the follower.
        if (alreadyClaimed && follow.urgency === "fyi") continue
        const event = followWants(follow, signal)
        if (!event) continue
        const triageOn = resolveFollowTriageConfig(daemonTriage, follow.triage).enabled
        // The follower's OWN board write. With triage on it reaches the
        // triage stage (where the `ownTaskChanges` rule drops it — and the
        // decision is logged as training data); with triage off the legacy
        // anti-loop filter below skips it outright.
        const selfTaskChange =
          signal.event === "task-changed" && signal.sessionId !== "" && signal.sessionId === follow.follower
        if (selfTaskChange) {
          if (!triageOn) continue
          // Only if the follow's selector would otherwise cover the
          // follower itself — triage must not WIDEN what a follow sees.
          if (!selectorCoversFollower(follow, registry.get(follow.follower))) continue
        } else if (signal.boardId !== undefined) {
          // Board follow: match the board, never wake the actor's own session
          // (anti-loop — the brain/secretary's own writes come back attributed
          // to it).
          if (!followMatchesBoard(follow, signal.boardId)) continue
          if (signal.sessionId !== "" && signal.sessionId === follow.follower) continue
        } else if (
          !followCoversSession(follow, signal.sessionId, desc, registry, signal.label)
        ) {
          continue
        }
        if (alreadyClaimed) {
          const batch = batches.get(follow.follower)
          if (batch) batch.urgency = "next-turn"
          continue
        }
        claimed.add(follow.follower)
        enqueue(follow.follower, follow, {
          sessionId: signal.sessionId,
          event,
          ts: signal.ts,
          ...((desc?.label ?? signal.label) ? { label: (desc?.label ?? signal.label)! } : {}),
          ...(desc?.cwd ? { cwd: desc.cwd } : {}),
          ...(signal.detail ? { detail: signal.detail } : {}),
          ...(signal.key ? { key: signal.key } : {}),
          ...(signal.boardId ? { boardId: signal.boardId } : {}),
          ...(signal.taskId ? { taskId: signal.taskId } : {}),
          ...(signal.awaitingInput ? { awaitingInput: true } : {}),
          ...(signal.empty ? { empty: true } : {}),
          ...(signal.silent ? { silent: true } : {}),
          ...(sourceFyi ? { fyi: true } : {}),
          ...(signal.reason ? { reason: signal.reason } : {}),
        })
      }
    } catch (err) {
      log(`[session-follow] event handling failed: ${describeError(err)}`)
    }
  })

  const unsubscribeReports = sessionEvents.on("session:message", ev => {
    // A child→parent report (`message_parent`): the follower will read it
    // as a message, so the turn-end that follows is its echo.
    if (ev.relation !== "child" || !ev.fromSessionId) return
    const at = Date.parse(ev.ts)
    if (!Number.isFinite(at)) return
    let byReporter = reports.get(ev.sessionId)
    if (!byReporter) {
      byReporter = new Map()
      reports.set(ev.sessionId, byReporter)
    }
    byReporter.set(ev.fromSessionId, at)
    for (const [reporter, reportedAt] of byReporter) {
      if (at - reportedAt > REPORT_RETENTION_MS) byReporter.delete(reporter)
    }
  })

  return {
    async flush(followerId) {
      if (followerId) await flushFollower(followerId)
      else await Promise.all([...batches.keys()].map(flushFollower))
      await Promise.all([...inFlight])
    },
    dispose() {
      unsubscribe()
      unsubscribeReports()
      reports.clear()
      for (const batch of batches.values()) clearTimer(batch.timer)
      batches.clear()
    },
  }
}
