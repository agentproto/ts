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
 * unchanged: a bus subscription (set up once, see {@link getRing}) feeds a
 * capped in-memory ring buffer of already-normalized {@link SentinelEvent}s,
 * and `poll()` just slices that buffer by cursor — the same shape `fake.ts`'s
 * test provider uses, except the stream is real (and the cursor carries a
 * process-epoch tag — see further down).
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
 *
 * Cursor format is `<epoch>:<seq>`, NOT a bare numeric `seq` — `epoch` is a
 * random id minted once when a ring is built (see {@link getRing}), i.e. it
 * changes every process boot. A `Sentinel.handle.cursor` is PERSISTED
 * (`sentinel-store.ts`) and survives a daemon restart; the ring it was
 * minted against does not (`nextSeq` restarts at 0). Filtering a restart-era
 * cursor's numeric `seq` (e.g. `"7"`) against the fresh ring would silently
 * drop the first ~8 real events for that sentinel — including, worst case,
 * the very `session.exited` event `until: subject_terminal` is waiting on,
 * leaving the sentinel stuck `active` forever. Tagging the cursor with the
 * epoch it was minted against makes that mismatch detectable: `attach()`
 * (the real "daemon restarted" entry point, see `sentinel-runtime.ts`'s
 * `reattachAll`) resyncs it eagerly, and `poll()` carries the identical
 * check as a safety net for any cursor that reaches it unresynced (a stale
 * legacy cursor pre-dating this field, or any other path that skips
 * `attach()`) — see {@link resyncIfStale}.
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
  /** Minted once per ring instance (one per process boot, in practice —
   *  see `getRing`) — the cursor-staleness tag. See module doc. */
  epoch: string
  entries: RingEntry[]
  nextSeq: number
}

/** Caps total buffered events across EVERY watched session sharing this
 *  bus. Generous relative to realistic concurrent session-sentinel counts;
 *  overflow silently evicts the oldest entries. Non-durable by design (see
 *  module doc) — but note this cap is a SEPARATE loss mode from a restart:
 *  even within one process's lifetime, a sentinel that goes unpolled for
 *  long enough (longer than it takes `RING_CAP` events — across every
 *  session sharing this bus, not just the one it watches — to cycle
 *  through) can have its own events evicted before a poll ever reads them.
 *  `sentinel-runtime.ts`'s poll cadence (15-60s) makes this unlikely in
 *  practice, but it is a real possibility worth knowing about, not just a
 *  restart-time one. */
const RING_CAP = 2000

const ringsByBus = new WeakMap<SessionEventBus, SessionRing>()

function appendEvent(ring: SessionRing, event: SentinelEvent): number {
  const seq = ring.nextSeq++
  ring.entries.push({ seq, event })
  if (ring.entries.length > RING_CAP) ring.entries.splice(0, ring.entries.length - RING_CAP)
  return seq
}

/** `<epoch>:<seq>` → `{epoch, seq}`, or undefined for anything that doesn't
 *  parse (absent, malformed, or a pre-epoch legacy bare-numeric cursor —
 *  all three are treated identically by {@link resyncIfStale}: unknown
 *  epoch, so stale). */
function parseCursor(cursor: string | undefined): { epoch: string; seq: number } | undefined {
  if (!cursor) return undefined
  const i = cursor.lastIndexOf(":")
  if (i < 0) return undefined
  const seq = Number(cursor.slice(i + 1))
  return Number.isFinite(seq) ? { epoch: cursor.slice(0, i), seq } : undefined
}

function formatCursor(ring: SessionRing, seq: number): string {
  return `${ring.epoch}:${seq}`
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

/**
 * Subscribe (once per distinct bus — see module doc) and return the shared
 * ring every handle built off `bus` reads from.
 *
 * The returned unsubscribe fn is deliberately never called: the
 * subscription and the ring share the exact same lifetime as `bus` itself
 * (both live only as long as something still holds a reference to `bus`,
 * and the `WeakMap` key means the entry — and the listener the daemon's
 * EventEmitter holds — is freed together with `bus` once nothing does).
 * For the daemon's own lifetime bus this is a no-op either way; for a
 * short-lived bus (e.g. one built fresh per test) it means no separate
 * teardown call is needed, not an actual leak.
 */
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

function identityOf(handle: SentinelHandle): string | undefined {
  const state = handle.state as { sessionId?: string } | undefined
  return typeof state?.sessionId === "string" ? state.sessionId : handle.remoteId
}

/**
 * Append a synthetic terminal `session.exited` event for a target that will
 * never itself emit another bus event: either `info` describes it already
 * dead (ended before `create()`, or while the daemon was down), or `info` is
 * undefined because the session is gone entirely (e.g. GC'd across a
 * restart) — `goneReason` then stands in for the detail a live lookup would
 * have given. Without this, `until: subject_terminal` would wait forever.
 *
 * `tag` makes the minted id distinct per CALL SITE (`create()` vs
 * `attach()`) rather than per calendar instant — deterministic, and each
 * site only ever calls this once per handle before the sentinel is expected
 * to expire (see call sites), so there is no redelivery storm to dedup.
 */
function synthesizeExitEvent(
  ring: SessionRing,
  subject: string,
  sessionId: string,
  tag: string,
  info: SessionSentinelLookup | undefined,
  goneReason?: string,
): void {
  const data: Record<string, unknown> = info
    ? {
        sessionId,
        status: info.status ?? "exited",
        ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
        ...(info.endedReason ? { reason: info.endedReason } : {}),
      }
    : { sessionId, status: "exited", ...(goneReason ? { reason: goneReason } : {}) }
  const summary = info
    ? `${info.label ?? sessionId} had already exited${info.endedReason ? ` (${info.endedReason})` : ""}`
    : `${sessionId} no longer exists${goneReason ? ` (${goneReason})` : ""}`
  appendEvent(
    ring,
    makeEvent({
      idParts: [sessionId, "exited", tag],
      type: "session.exited",
      subject,
      time: new Date().toISOString(),
      terminal: true,
      data,
      summary,
    }),
  )
}

/**
 * The cursor-staleness check shared by `attach()` and `poll()` (see module
 * doc for why both need it). Returns the `seq` to filter/resume FROM:
 *
 * - `handle.cursor`'s epoch matches `ring.epoch` → the common case, this
 *   process already owns that ring continuously since the cursor was
 *   minted — returns the cursor's own `seq` untouched.
 * - Otherwise (a different/missing epoch — a daemon restart rebuilt the
 *   ring since, or a pre-epoch legacy cursor, or no cursor at all) → the
 *   cursor's numeric `seq` means nothing against THIS ring. Resync to "the
 *   last entry that already exists right now", i.e. treat it exactly like
 *   a brand-new `create()` — AND, since whatever gap this cursor spans
 *   might have included the target's entire death (no live bus event for
 *   it to have been caught by), check `getSession` and synthesize the
 *   terminal event if so. `tag`/`goneTag` distinguish the minted ids from
 *   `create()`'s own synthetic-event tags (distinct call sites, see that
 *   function's doc).
 */
function resyncIfStale(
  ring: SessionRing,
  handle: SentinelHandle,
  sessionId: string,
  subject: string,
  getSession: SessionSentinelDeps["getSession"],
  tag: string,
  goneTag: string,
): number {
  const parsed = parseCursor(handle.cursor)
  if (parsed && parsed.epoch === ring.epoch) return parsed.seq

  const lastSeq = ring.nextSeq - 1
  const info = getSession(sessionId)
  if (!info) {
    synthesizeExitEvent(ring, subject, sessionId, goneTag, undefined, "session no longer exists")
  } else if (!info.alive) {
    synthesizeExitEvent(ring, subject, sessionId, tag, info)
  }
  return lastSeq
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
        synthesizeExitEvent(ring, subject, sessionId, "already-ended-at-create", info)
      }

      return { provider: SESSION_SLUG, remoteId: sessionId, cursor: formatCursor(ring, lastSeq), state: { sessionId } }
    },

    async attach(handle: SentinelHandle, _delivery: DeliveryPreference): Promise<SentinelHandle> {
      const sessionId = identityOf(handle)
      if (!sessionId) return { ...handle }
      const subject = `session:${sessionId}`
      const ring = getRing(deps.sessionEvents)
      // This IS the real "the daemon restarted" entry point
      // (`sentinel-runtime.ts`'s `reattachAll`, called once at `start()`) —
      // `resyncIfStale` detects the epoch mismatch against the fresh ring
      // and resyncs eagerly (plus synthesizes the target's terminal event
      // if it died during the downtime). See module doc + that function's.
      const lastSeq = resyncIfStale(
        ring,
        handle,
        sessionId,
        subject,
        deps.getSession,
        "already-ended-at-attach",
        "gone-at-attach",
      )
      return { ...handle, cursor: formatCursor(ring, lastSeq) }
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
      if (!sessionId) return { events: [], cursor: handle.cursor ?? "" }
      const ring = getRing(deps.sessionEvents)
      const subject = `session:${sessionId}`
      // Safety net, not the primary path (that's `attach()`): a cursor
      // that reaches `poll()` without ever going through a matching-epoch
      // `attach()` (a stale legacy cursor, or any future call path that
      // skips it) gets resynced here instead of silently filtering against
      // a `seq` that means nothing for this ring. See module doc.
      const lastSeq = resyncIfStale(
        ring,
        handle,
        sessionId,
        subject,
        deps.getSession,
        "already-ended-at-poll",
        "gone-at-poll",
      )
      const matching = ring.entries.filter(e => e.seq > lastSeq && e.event.subject === subject)
      const slice = matching.slice(0, limit)
      const cursor = slice.length > 0 ? formatCursor(ring, slice[slice.length - 1]!.seq) : formatCursor(ring, lastSeq)
      return { events: slice.map(e => e.event), cursor }
    },

    defaultTypes(subject: string): string[] {
      return parseSessionSubject(subject) ? [...SESSION_DEFAULT_TYPES] : []
    },
  }
}
