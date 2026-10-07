/**
 * `session` — the in-process sentinel provider that watches ANOTHER
 * session's own lifecycle (AIP-60). Lets a supervisor `sentinel_watch
 * {subject: "session:<childId>"}` and be woken when the child ends a turn,
 * starts awaiting input, or exits — even if the child never calls
 * `message_parent` — with the sentinel self-expiring once the child exits
 * (`until: subject_terminal`).
 *
 * Unlike every other provider in this family, the event source is not an
 * external system reached over HTTP/CLI — it's this SAME daemon's own
 * in-process `SessionEventBus` (`session-event-bus.ts`). The provider still
 * fits the poll-mode contract (`capabilities.poll: true`) so it reuses
 * `sentinel-runtime.ts`'s existing dedup/lifetime/dead-session machinery
 * unchanged: a bus subscription (set up once, see {@link getBuffer}) feeds a
 * capped in-memory ring buffer of already-normalized {@link SentinelEvent}s,
 * and `poll()` just slices that buffer by a numeric cursor — the same shape
 * `fake.ts`'s test provider uses, except the stream is real.
 *
 * Wiring note: every other builtin factory in `registry.ts` is
 * `(creds) => handle` — this provider needs the session event bus AND a
 * session lookup instead of credentials, neither of which exists at
 * `registry.ts` module-load time. `configureSessionSentinelProvider`
 * (registry.ts) is the seam: `index.ts` calls it once, right after the
 * sessions registry is constructed, to install the real factory in
 * `BUILTIN_SENTINEL_PROVIDERS`. Before that call (or in a test that never
 * makes it), resolving the `"session"` slug returns null — the same
 * "supported but not installed" signal an unconfigured third-party provider
 * gets.
 *
 * Non-durable (`capabilities.durable: false`): the ring buffer is
 * in-memory, so a daemon restart loses any buffered-but-undelivered events
 * for a session sentinel — same tradeoff `fake.ts` documents, except here it
 * is a real operational limitation, not just a test convenience. A
 * supervisor that genuinely needs to survive daemon restarts should prefer
 * `session_follow` (which has its own, separate dead-letter parking) or poll
 * `session_list`/`session_monitor` directly.
 */

import { createHash, randomUUID } from "node:crypto"
import type { SessionEvent, SessionEventBus } from "../session-event-bus.js"
import type {
  DeliveryPreference,
  SentinelEvent,
  SentinelHandle,
  SentinelProviderHandle,
  SentinelSpec,
} from "./types.js"

export const SESSION_SLUG = "session"

/** The three lifecycle facts this provider surfaces — AIP-60 "default type
 *  set" for the `session:` subject scheme. */
export const SESSION_DEFAULT_TYPES: readonly string[] = [
  "session.turn.ended",
  "session.awaiting_input",
  "session.exited",
]

const SESSION_SUBJECT_RE = /^session:(.+)$/

export function parseSessionSubject(subject: string): string | undefined {
  return SESSION_SUBJECT_RE.exec(subject)?.[1]
}

/** The tiny slice of a session descriptor `create()` needs to validate the
 *  subject and (for an already-dead target) synthesize an immediate exit
 *  event — kept structural so this provider never imports `sessions.ts`
 *  (same import-light discipline as every other file in this family). */
export interface SessionSentinelLookup {
  alive: boolean
  status?: string
  label?: string
  endedReason?: string
  exitCode?: number
}

export interface SessionSentinelDeps {
  sessionEvents: SessionEventBus
  /** undefined = no such session (`create()` refuses). */
  getSession: (sessionId: string) => SessionSentinelLookup | undefined
}

// ── Shared ring buffer (one per distinct bus instance — see module doc) ──

interface RingEntry {
  seq: number
  event: SentinelEvent
}

interface SessionRing {
  /** Unique per ring instance (i.e. per process / bus) — tags cursors so a
   *  cursor persisted by a previous daemon is recognised as stale. */
  epoch: string
  entries: RingEntry[]
  nextSeq: number
}

/** Caps total buffered events across EVERY watched session sharing this
 *  bus. Generous relative to realistic concurrent session-sentinel counts;
 *  overflow silently evicts the oldest entries (non-durable, see module
 *  doc) rather than growing unbounded in a long-lived daemon. */
const RING_CAP = 2000

const ringsByBus = new WeakMap<SessionEventBus, SessionRing>()

function appendEvent(ring: SessionRing, event: SentinelEvent): number {
  const seq = ring.nextSeq++
  ring.entries.push({ seq, event })
  if (ring.entries.length > RING_CAP) ring.entries.splice(0, ring.entries.length - RING_CAP)
  return seq
}

function mintEventId(parts: readonly string[]): string {
  return `evt_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)}`
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function makeEvent(input: {
  idParts: readonly string[]
  type: string
  subject: string
  time: string
  terminal: boolean
  data: Record<string, unknown>
  summary: string
}): SentinelEvent {
  return {
    specversion: "1.0",
    id: mintEventId(input.idParts),
    source: `//agentproto.local/sentinel/${SESSION_SLUG}`,
    type: input.type,
    subject: input.subject,
    time: input.time,
    datacontenttype: "application/json",
    data: input.data,
    summary: input.summary,
    subjects: [input.subject],
    terminal: input.terminal,
  }
}

/**
 * Normalize one raw bus event into zero or one {@link SentinelEvent}s.
 *
 * `session:awaiting-input` is intentionally mapped to the SAME event type
 * (`session.awaiting_input`) as a `session:turn-end` whose `awaitingInput`
 * is true — because `sessions.ts` always emits BOTH bus events, back to
 * back, with the identical `ts`, for one real transition (never
 * `awaiting-input` alone). Minting the id from `[sessionId, "awaiting_input",
 * ts]` for both makes them collide on purpose: `sentinel-runtime.ts`'s
 * persisted `seen` window delivers the first and silently skips the
 * (otherwise exact) redelivery — the same technique `local-gh.ts` uses to
 * fold a same-conclusion check rerun into one id. No per-event filtering
 * needed here as a result.
 */
function eventsForSessionEvent(ev: SessionEvent): SentinelEvent[] {
  switch (ev.type) {
    case "session:turn-end": {
      const subject = `session:${ev.sessionId}`
      const who = ev.label ? `${ev.label} (${ev.sessionId})` : ev.sessionId
      if (ev.awaitingInput) {
        const question = ev.question?.text
        return [
          makeEvent({
            idParts: [ev.sessionId, "awaiting_input", ev.ts],
            type: "session.awaiting_input",
            subject,
            time: ev.ts,
            terminal: false,
            data: { sessionId: ev.sessionId, ...(question ? { question } : {}) },
            summary: `${who} is awaiting input${question ? `: ${truncate(question)}` : ""}`,
          }),
        ]
      }
      const detail = ev.error ?? (ev.reason && ev.reason !== "completed" ? ev.reason : undefined)
      return [
        makeEvent({
          idParts: [ev.sessionId, "turn-end", ev.ts],
          type: "session.turn.ended",
          subject,
          time: ev.ts,
          terminal: false,
          data: {
            sessionId: ev.sessionId,
            ...(ev.reason ? { reason: ev.reason } : {}),
            ...(ev.error ? { error: ev.error } : {}),
          },
          summary: `${who} ended a turn${detail ? `: ${truncate(detail)}` : ""}`,
        }),
      ]
    }
    case "session:awaiting-input": {
      const subject = `session:${ev.sessionId}`
      const who = ev.label ? `${ev.label} (${ev.sessionId})` : ev.sessionId
      const question = ev.question?.text
      return [
        makeEvent({
          idParts: [ev.sessionId, "awaiting_input", ev.ts],
          type: "session.awaiting_input",
          subject,
          time: ev.ts,
          terminal: false,
          data: { sessionId: ev.sessionId, ...(question ? { question } : {}) },
          summary: `${who} is awaiting input${question ? `: ${truncate(question)}` : ""}`,
        }),
      ]
    }
    case "session:exited": {
      const subject = `session:${ev.sessionId}`
      const who = ev.label ? `${ev.label} (${ev.sessionId})` : ev.sessionId
      return [
        makeEvent({
          idParts: [ev.sessionId, "exited", ev.ts],
          type: "session.exited",
          subject,
          time: ev.ts,
          terminal: true,
          data: {
            sessionId: ev.sessionId,
            status: ev.status,
            ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
            ...(ev.reason ? { reason: ev.reason } : {}),
          },
          summary: `${who} exited (${ev.reason ?? ev.status})`,
        }),
      ]
    }
    default:
      return []
  }
}

/** Subscribe (once per distinct bus — see module doc) and return the shared
 *  ring every handle built off `bus` reads from. */
function getRing(bus: SessionEventBus): SessionRing {
  const existing = ringsByBus.get(bus)
  if (existing) return existing
  const ring: SessionRing = { epoch: randomUUID(), entries: [], nextSeq: 0 }
  ringsByBus.set(bus, ring)
  bus.onAny(ev => {
    for (const event of eventsForSessionEvent(ev)) appendEvent(ring, event)
  })
  return ring
}

/** Cursors are `<epoch>:<seq>`. The epoch identifies the per-process ring
 *  the seq belongs to; a persisted cursor from a previous process carries a
 *  different epoch and must not be compared numerically against this ring. */
function formatCursor(epoch: string, seq: number): string {
  return `${epoch}:${seq}`
}

function parseCursor(cursor: string | undefined): { epoch: string; seq: number } | undefined {
  if (!cursor) return undefined
  const idx = cursor.lastIndexOf(":")
  // A legacy bare-number cursor (pre-epoch) has no epoch → treated as stale.
  if (idx < 0) return { epoch: "", seq: Number(cursor) }
  const seq = Number(cursor.slice(idx + 1))
  return { epoch: cursor.slice(0, idx), seq: Number.isFinite(seq) ? seq : -1 }
}

function synthesizeExitEvent(
  sessionId: string,
  subject: string,
  info: SessionSentinelLookup | undefined,
): SentinelEvent {
  return makeEvent({
    idParts: [sessionId, "exited", "already-ended-at-create"],
    type: "session.exited",
    subject,
    time: new Date().toISOString(),
    terminal: true,
    data: {
      sessionId,
      status: info?.status ?? "exited",
      ...(info?.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
      ...(info?.endedReason ? { reason: info.endedReason } : {}),
    },
    summary: `${info?.label ?? sessionId} had already exited${info?.endedReason ? ` (${info.endedReason})` : ""}`,
  })
}

function identityOf(handle: SentinelHandle): string | undefined {
  const state = handle.state as { sessionId?: string } | undefined
  return typeof state?.sessionId === "string" ? state.sessionId : handle.remoteId
}

export function sessionSentinelProvider(deps: SessionSentinelDeps): SentinelProviderHandle {
  return {
    slug: SESSION_SLUG,
    name: "Session Lifecycle",
    version: "0.1.0",
    description:
      "In-process sentinel over this daemon's own session lifecycle — turn-end, " +
      "awaiting-input, exit. No credentials, no external system: the subject IS " +
      "another session (`session:<id>`).",
    requiresSetup: false,
    capabilities: {
      subjects: [SESSION_SLUG],
      push: false,
      poll: true,
      durable: false,
      needsPublicUrl: false,
      requiresAuth: false,
      typicalLatencyMs: 15_000,
    },

    async check(): Promise<boolean> {
      return true
    },

    async create(spec: SentinelSpec, _delivery: DeliveryPreference): Promise<SentinelHandle> {
      if (spec.match.length !== 1) {
        throw new Error(`${SESSION_SLUG}: exactly one match clause is supported (one sentinel per session)`)
      }
      const subject = spec.match[0]!.subject
      const sessionId = parseSessionSubject(subject)
      if (!sessionId) {
        throw new Error(`${SESSION_SLUG}: subject "${subject}" is not a "session:<id>" subject`)
      }
      const info = deps.getSession(sessionId)
      if (!info) {
        throw new Error(`${SESSION_SLUG}: no session "${sessionId}"`)
      }

      const ring = getRing(deps.sessionEvents)
      // Everything already in the ring (and every bus event before this
      // instant) is history, not news — the cursor is set to "the last seq
      // that already exists", so only events appended AFTER this point are
      // ever returned by poll(). Captured BEFORE the synthetic-exit append
      // below so that one entry (seq === lastSeq + 1) still clears it.
      const lastSeq = ring.nextSeq - 1

      if (!info.alive) {
        // The target already ended before the watch was created (a child
        // that finished between spawning and the supervisor's
        // `sentinel_watch` call). Rather than refuse outright, synthesize
        // the terminal event now so `until: subject_terminal` still closes
        // the watch on the very first poll instead of hanging forever on a
        // session that will never emit another bus event.
        appendEvent(ring, synthesizeExitEvent(sessionId, subject, info))
      }

      return {
        provider: SESSION_SLUG,
        remoteId: sessionId,
        cursor: formatCursor(ring.epoch, lastSeq),
        state: { sessionId },
      }
    },

    async attach(handle: SentinelHandle, _delivery: DeliveryPreference): Promise<SentinelHandle> {
      // Nothing external to re-point — the shared ring (while this process
      // lives) already has everything after `handle.cursor`.
      return { ...handle }
    },

    async cancel(_handle: SentinelHandle): Promise<void> {
      // No external resource — watching IS a bus subscription shared by
      // every session sentinel, never torn down per-watch.
    },

    async status(handle: SentinelHandle): Promise<{ ok: boolean; detail?: string }> {
      const sessionId = identityOf(handle)
      if (!sessionId) return { ok: false, detail: "no session identity on handle" }
      const info = deps.getSession(sessionId)
      if (!info) return { ok: false, detail: `session "${sessionId}" no longer exists` }
      return { ok: true }
    },

    async poll(handle: SentinelHandle, limit: number): Promise<{ events: SentinelEvent[]; cursor: string }> {
      const sessionId = identityOf(handle)
      if (!sessionId) return { events: [], cursor: handle.cursor ?? "-1" }
      const ring = getRing(deps.sessionEvents)
      const subject = `session:${sessionId}`
      const parsed = parseCursor(handle.cursor)
      let lastSeq: number
      if (parsed === undefined || parsed.epoch === ring.epoch) {
        lastSeq = parsed?.seq ?? -1
      } else {
        // Stale cursor: it was minted against a previous ring (daemon
        // restart, or a different bus) whose seq numbering is unrelated to
        // this one. Everything in the current ring was appended after that
        // cursor, so start from the beginning of it instead of comparing
        // seqs across epochs (which would silently drop new events).
        lastSeq = -1
        // Events emitted while the daemon was down are unrecoverable. If the
        // target is no longer alive, synthesize its terminal event so an
        // `until: subject_terminal` sentinel still closes.
        const info = deps.getSession(sessionId)
        const hasTerminal = ring.entries.some(e => e.event.subject === subject && e.event.terminal)
        if (!hasTerminal && (!info || !info.alive)) {
          appendEvent(ring, synthesizeExitEvent(sessionId, subject, info))
        }
      }
      const matching = ring.entries.filter(e => e.seq > lastSeq && e.event.subject === subject)
      // Note: if more than RING_CAP entries were evicted between polls,
      // those events are lost silently (non-durable, see module doc).
      const slice = matching.slice(0, limit)
      const newSeq = slice.length > 0 ? slice[slice.length - 1]!.seq : lastSeq === -1 ? ring.nextSeq - 1 : lastSeq
      return { events: slice.map(e => e.event), cursor: formatCursor(ring.epoch, newSeq) }
    },

    defaultTypes(subject: string): string[] {
      return parseSessionSubject(subject) ? [...SESSION_DEFAULT_TYPES] : []
    },
  }
}
