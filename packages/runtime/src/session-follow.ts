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
 * (`relation:"system"`, `kind:"notice"`, `urgency:"next-turn"`) through
 * `registry.sendMessage` — an idle follower runs it as its own turn now, a
 * busy one parks it in its prompt queue as a separate turn. It never
 * interrupts. The follower's own events are never delivered to itself, and
 * (by default) neither are its descendants'.
 *
 * Dead follower: same approach as `sentinel-runtime.ts` — resume it through
 * the injected `restartSession` hook (never a deliberately-closed one) and
 * retry; otherwise park the digest in `~/.agentproto/follows-parked.jsonl`
 * so the events are not silently lost. The follow record is always kept.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

import type { ActivityRecord } from "./activity-projection.js"
import { readTranscriptTail } from "./session-index.js"
import { createSessionMessage, type SessionMessage } from "./session-message.js"
import type { SessionEvent, SessionEventBus } from "./session-event-bus.js"
import type { FollowEvent, SessionFollow, SessionFollowStore } from "./session-follow-store.js"
import { SessionNotAliveError, type SessionDescriptor } from "./sessions.js"
import { DELIBERATE_END_REASONS } from "./sentinel-runtime.js"

/** Max characters of the per-line excerpt. */
export const FOLLOW_EXCERPT_MAX = 300
/** Max event lines in one digest; the rest collapse into a "+N more" line. */
export const FOLLOW_DIGEST_MAX_LINES = 40
const ANCESTOR_WALK_CAP = 32
const SEEN_PR_CAP = 500

/** The slice of the sessions registry this subscriber needs (structural, like
 *  `SupervisorNotifyRegistry`). */
export interface SessionFollowRegistry {
  get(id: string): SessionDescriptor | undefined
  sendMessage(msg: SessionMessage, opts?: { source?: string; origin?: string }): Promise<unknown>
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
  ts: string
  label?: string
  /** Event-specific excerpt source (error, question, reason, PR title). */
  detail?: string
  /** Distinguishes collapse groups (a PR activity id). */
  key?: string
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
        ts: ev.ts,
        ...(ev.label ? { label: ev.label } : {}),
        ...(detail ? { detail } : {}),
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
        ...(ev.reason ? { detail: ev.reason } : {}),
      }
    }
    case "activity:changed":
      return prSignalOf(ev.activity, ev.ts, seenPrs)
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

/** The event kind `follow` would deliver for `signal`, or undefined when its
 *  event filter / empty-turn rule drops it. */
function followWants(follow: SessionFollow, signal: Signal): FollowEvent | undefined {
  const wants = (e: FollowEvent): boolean => follow.events.includes(e)
  if (signal.event === "turn-end") {
    if (signal.awaitingInput && wants("awaiting-input")) return "awaiting-input"
    if (!wants("turn-end")) return undefined
    if (signal.empty && follow.skipEmptyTurns && !signal.awaitingInput) return undefined
    return "turn-end"
  }
  return wants(signal.event) ? signal.event : undefined
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
}

const TURN_FAMILY: ReadonlySet<FollowEvent> = new Set(["turn-end", "awaiting-input"])

function sameCollapseGroup(a: BatchEntry, b: BatchEntry): boolean {
  if (a.sessionId !== b.sessionId) return false
  if ((a.key ?? "") !== (b.key ?? "")) return false
  return a.event === b.event || (TURN_FAMILY.has(a.event) && TURN_FAMILY.has(b.event))
}

/** Squeeze to one line, <= {@link FOLLOW_EXCERPT_MAX} chars. The TAIL is kept
 *  (the conclusion, not the preamble). */
export function excerptOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return undefined
  return flat.length <= FOLLOW_EXCERPT_MAX ? flat : `…${flat.slice(flat.length - (FOLLOW_EXCERPT_MAX - 1))}`
}

/** Compose the digest text. Exported for tests. */
export function formatFollowDigest(
  entries: readonly BatchEntry[],
  resolveText: (entry: BatchEntry) => string | undefined,
  desc: (id: string) => SessionDescriptor | undefined,
): string {
  const header =
    `[session-follow] automatic digest — ${entries.length} event${entries.length === 1 ? "" : "s"} ` +
    `from sessions you follow. Decide whether anything needs the human's attention; ` +
    `if not, no reply is needed.`
  const lines = entries.slice(0, FOLLOW_DIGEST_MAX_LINES).map(entry => {
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
  if (entries.length > FOLLOW_DIGEST_MAX_LINES) {
    lines.push(`[session-follow] … and ${entries.length - FOLLOW_DIGEST_MAX_LINES} more event(s)`)
  }
  return [header, ...lines].join("\n")
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
  timer: unknown
}

export function wireSessionFollow(opts: WireSessionFollowOptions): SessionFollowHandle {
  const { registry, sessionEvents, store } = opts
  const log = opts.log ?? ((line: string): void => console.warn(line))
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  const clearTimer =
    opts.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>))
  const parkedPath = opts.parkedPath ?? resolve(agentprotoHome(), "follows-parked.jsonl")
  const readLastOutput =
    opts.readLastOutput ??
    ((d: SessionDescriptor): string | undefined =>
      d.eventsPath ? readTranscriptTail(d.eventsPath).lastOutputText : undefined)

  const batches = new Map<string, Batch>()
  const seenPrs = new Set<string>()
  const inFlight = new Set<Promise<void>>()

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

  const textFor = (entry: BatchEntry): string | undefined => {
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

  async function sendOnce(to: string, text: string, followerId: string): Promise<void> {
    await registry.sendMessage(
      createSessionMessage({ to, from: { relation: "system" }, text, kind: "notice", urgency: "next-turn" }),
      { source: "session-follow", origin: `follow:${followerId}` },
    )
  }

  async function reviveAndSend(followerId: string, text: string): Promise<void> {
    const desc = registry.get(followerId)
    if (desc?.endedReason && DELIBERATE_END_REASONS.has(desc.endedReason)) {
      park(followerId, text, `follower was closed on purpose (${desc.endedReason}); not resuming`)
      return
    }
    if (!opts.restartSession) {
      park(followerId, text, "follower is not alive and no restart hook is wired")
      return
    }
    try {
      const resumed = await opts.restartSession(followerId)
      if (resumed !== followerId) {
        for (const f of store.list({ follower: followerId })) store.setFollower(f.id, resumed)
      }
      await sendOnce(resumed, text, resumed)
    } catch (err) {
      park(followerId, text, `could not resume follower: ${describeError(err)}`)
    }
  }

  async function deliver(followerId: string, text: string): Promise<void> {
    const desc = registry.get(followerId)
    if (!desc) {
      log(`[session-follow] follower ${followerId} no longer exists — digest dropped (follow kept)`)
      return
    }
    if (!isAlive(desc)) {
      await reviveAndSend(followerId, text)
      return
    }
    try {
      await sendOnce(followerId, text, followerId)
    } catch (err) {
      if (err instanceof SessionNotAliveError) {
        await reviveAndSend(followerId, text)
        return
      }
      log(`[session-follow] delivery to ${followerId} failed: ${describeError(err)}`)
    }
  }

  function flushFollower(followerId: string): Promise<void> {
    const batch = batches.get(followerId)
    if (!batch) return Promise.resolve()
    batches.delete(followerId)
    clearTimer(batch.timer)
    if (batch.entries.length === 0) return Promise.resolve()
    const text = formatFollowDigest(batch.entries, textFor, id => registry.get(id))
    const p = deliver(followerId, text)
      .catch(err => log(`[session-follow] flush for ${followerId} failed: ${describeError(err)}`))
      .finally(() => inFlight.delete(p))
    inFlight.add(p)
    return p
  }

  function enqueue(followerId: string, follow: SessionFollow, entry: BatchEntry): void {
    let batch = batches.get(followerId)
    if (!batch) {
      batch = { entries: [], followIds: new Set(), timer: undefined }
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
      const claimed = new Set<string>()
      for (const follow of follows) {
        if (claimed.has(follow.follower)) continue
        const event = followWants(follow, signal)
        if (!event) continue
        if (!followCoversSession(follow, signal.sessionId, desc, registry, signal.label)) continue
        claimed.add(follow.follower)
        enqueue(follow.follower, follow, {
          sessionId: signal.sessionId,
          event,
          ts: signal.ts,
          ...((desc?.label ?? signal.label) ? { label: (desc?.label ?? signal.label)! } : {}),
          ...(desc?.cwd ? { cwd: desc.cwd } : {}),
          ...(signal.detail ? { detail: signal.detail } : {}),
          ...(signal.key ? { key: signal.key } : {}),
        })
      }
    } catch (err) {
      log(`[session-follow] event handling failed: ${describeError(err)}`)
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
      for (const batch of batches.values()) clearTimer(batch.timer)
      batches.clear()
    },
  }
}
