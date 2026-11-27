/**
 * `events/stream`: push delivery of the MCP Events extension (SEP-3415, protocol 2026-07-28).
 *
 * A third read of the SAME journal `events/poll` reads: same validation, same shared watch lease, same cursor format
 * (a poll cursor resumes a stream and a stream cursor resumes a poll). No new source of events.
 *
 * Two phases:
 *   - `openEventsStream` validates, reserves a stream slot, takes and HOLDS the lease, and reads the first page. Every
 *     failure happens here, before any frame, so the transport answers it as an ordinary JSON-RPC error ("the server
 *     responds immediately with a JSON-RPC error and no stream is opened").
 *   - the returned `run(sink)` writes `notifications/events/active` first, replays the backlog, then wakes on every
 *     journal append. It owns every resource taken by `open` and releases them in one `finally`, whatever the exit.
 *
 * Every message carries `params._meta["io.modelcontextprotocol/subscriptionId"]` = the JSON-RPC id of the request.
 * The caller MUST call `run` exactly once (with an already-aborted signal if the client is gone): that is what
 * returns the slot and the lease hold.
 */

import { EVENTS_ERR, McpEventsError, decodePollCursor, encodePollCursor, validateArgsOrThrow, validateMaxAgeMs } from "./adapter.js"
import { findEventDefinition, type EventRegistration, type Principal } from "./events-registry.js"
import { journalKey, type JournalRead, type PollJournal } from "./poll-journal.js"
import { PollLeaseError, type PollLeaseManager } from "./poll-lease.js"

export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId"

export const HEARTBEAT_DEFAULT_MS = 30_000
export const HEARTBEAT_MIN_MS = 5_000
export const HEARTBEAT_MAX_MS = 60_000
export const MAX_CONCURRENT_STREAMS = 32
/** A write that has not drained after this long closes the stream; the client resumes from its cursor. */
export const BACKPRESSURE_TIMEOUT_MS = 10_000
/** How often an open stream re-checks that its event type still exists and its principal is still authorized. */
export const RECHECK_INTERVAL_MS = 60_000
const PAGE_SIZE = 100

export interface EventsStreamInput {
  name: string
  arguments: Record<string, unknown>
  /** `null` / omitted = from now. */
  cursor?: string | null
  maxAgeMs?: number
  /** Suggested heartbeat interval; the granted one (clamped) is announced in every `active`. */
  heartbeatMs?: number
}

/** Where the stream writes. `send` resolves once the message is written (after `drain` if the socket buffered). */
export interface EventsStreamSink {
  send(message: Record<string, unknown>): Promise<void>
  /** Aborted when the client goes away: stop, release, write nothing more. */
  signal: AbortSignal
  /** Aborted when the server shuts down: write the final result frame, then stop. */
  closing?: AbortSignal
}

/**
 * How a stream ended, for the transport:
 *   - `closed`: the server ended it and wrote the final frame (shutdown, or after `terminated`);
 *   - `aborted`: the client went away, nothing more can be written;
 *   - `stalled`: a write did not drain in time, or the stream failed; the transport drops the connection.
 */
export type EventsStreamOutcome = "closed" | "aborted" | "stalled"

export interface EventsStream {
  run(sink: EventsStreamSink): Promise<EventsStreamOutcome>
}

export interface StreamTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const DEFAULT_TIMERS: StreamTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Process-wide cap on open streams (`-32025`, `limit:"streams"`). No general request cap applies to streams. */
export interface StreamSlots {
  readonly max: number
  /** Reserve one slot; returns the idempotent release, or `null` when every slot is taken. */
  reserve(): (() => void) | null
  size(): number
}

export function createStreamSlots(max: number = MAX_CONCURRENT_STREAMS): StreamSlots {
  let open = 0
  return {
    max,
    reserve() {
      if (open >= max) return null
      open++
      let released = false
      return () => {
        if (released) return
        released = true
        open--
      }
    },
    size: () => open,
  }
}

export interface EventsStreamContext {
  principal: Principal
  journal: PollJournal
  leases: PollLeaseManager
  slots: StreamSlots
  /** JSON-RPC id of the `events/stream` request, echoed unchanged in every message. */
  subscriptionId: string | number
  /** Injected timers (tests). Default: the global ones, unref'd. */
  timers?: StreamTimers
  backpressureTimeoutMs?: number
  recheckIntervalMs?: number
  /** Registry lookup used at open and at each re-check (tests replace it to remove a type). */
  findRegistration?: (name: string) => EventRegistration | undefined
}

export function clampHeartbeatMs(value: number | undefined): number {
  if (value === undefined) return HEARTBEAT_DEFAULT_MS
  return Math.min(HEARTBEAT_MAX_MS, Math.max(HEARTBEAT_MIN_MS, Math.round(value)))
}

/** Position just before the first event of `read` (where delivery starts), or the read's end when it has none. */
function startSeq(read: JournalRead): number {
  const first = read.events[0]
  return first ? first.seq - 1 : read.lastReturnedSeq
}

/**
 * Validate and open one push subscription. Throws `McpEventsError` (never after the first frame):
 * `-32023` unknown type, `-32602` bad arguments / cursor / maxAgeMs / heartbeatMs, `-32024` not authorized or a cursor
 * issued to another caller, `-32026` type without `push`, `-32025` too many streams or watches.
 */
export async function openEventsStream(input: EventsStreamInput, ctx: EventsStreamContext): Promise<EventsStream> {
  const find = ctx.findRegistration ?? findEventDefinition
  const name = input.name
  const registration = typeof name === "string" ? find(name) : undefined
  if (!registration) {
    throw new McpEventsError(EVENTS_ERR.notFound, `NotFound: unknown event "${String(name)}"`, { kind: "event", reason: "unknown_event" })
  }
  const args = validateArgsOrThrow(name, registration, input.arguments)
  if (!registration.meta.authorize(args, ctx.principal)) {
    throw new McpEventsError(EVENTS_ERR.forbidden, `Forbidden: not authorized to stream "${name}" with the given arguments`, {
      reason: "unauthorized",
    })
  }
  if (!registration.definition.delivery.includes("push") || !registration.meta.replayable) {
    throw new McpEventsError(EVENTS_ERR.unsupported, `Unsupported: "${name}" is not offered for push delivery`, {
      feature: "deliveryMode",
      value: "push",
    })
  }
  const mapped = registration.meta.argumentsToMatch(args)
  if (!mapped.ok) {
    throw new McpEventsError(EVENTS_ERR.invalidParams, `Invalid params: arguments for "${name}": ${mapped.reason}`, {
      reason: "invalid_arguments",
    })
  }
  if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== "string") {
    throw new McpEventsError(EVENTS_ERR.invalidParams, "Invalid params: `cursor` must be a string or null", { reason: "invalid_cursor" })
  }
  validateMaxAgeMs(input.maxAgeMs)
  if (input.heartbeatMs !== undefined && (typeof input.heartbeatMs !== "number" || !Number.isFinite(input.heartbeatMs))) {
    throw new McpEventsError(EVENTS_ERR.invalidParams, "Invalid params: `heartbeatMs` must be a number", { reason: "invalid_heartbeat" })
  }
  const heartbeatMs = clampHeartbeatMs(input.heartbeatMs)
  const after = typeof input.cursor === "string" ? decodePollCursor(input.cursor, ctx.principal) : null

  const releaseSlot = ctx.slots.reserve()
  if (!releaseSlot) {
    throw new McpEventsError(EVENTS_ERR.resourceExhausted, `ResourceExhausted: too many open event streams (max ${ctx.slots.max})`, {
      limit: "streams",
      max: ctx.slots.max,
    })
  }

  const key = journalKey(name, args)
  let releaseHold: (() => void) | undefined
  let first: JournalRead
  try {
    try {
      await ctx.leases.acquire({ key, name, mapped })
    } catch (err) {
      if (err instanceof PollLeaseError) {
        if (err.kind === "exhausted") {
          // Same pool and same data as `events/poll` (`adapter.ts`): one name for the shared watch limit.
          throw new McpEventsError(EVENTS_ERR.resourceExhausted, `ResourceExhausted: ${err.message}`, {
            reason: "poll_watch_quota",
            limit: "pollWatches",
            ...(err.max !== undefined ? { max: err.max } : {}),
          })
        }
        if (err.kind === "unsupported") {
          throw new McpEventsError(EVENTS_ERR.unsupported, `Unsupported: ${err.message}`, { feature: "provider", value: mapped.providerSlug })
        }
        throw new McpEventsError(EVENTS_ERR.internal, `BackingSubscriptionError: ${err.message}`, {
          kind: "backing_subscription",
          reason: "backing_create_failed",
        })
      }
      throw err
    }
    releaseHold = ctx.leases.retain(key)
    first = ctx.journal.read(key, { after, ...(input.maxAgeMs !== undefined ? { maxAgeMs: input.maxAgeMs } : {}), maxEvents: PAGE_SIZE })
  } catch (err) {
    releaseHold?.()
    releaseSlot()
    throw err
  }
  const hold = releaseHold

  const timers = ctx.timers ?? DEFAULT_TIMERS
  const backpressureMs = ctx.backpressureTimeoutMs ?? BACKPRESSURE_TIMEOUT_MS
  const recheckMs = ctx.recheckIntervalMs ?? RECHECK_INTERVAL_MS
  const subscriptionId = ctx.subscriptionId
  const meta = { [META_SUBSCRIPTION_ID]: subscriptionId }
  const principal = ctx.principal
  const journal = ctx.journal
  let ran = false

  return {
    async run(sink) {
      if (ran) throw new Error("events/stream: run() called twice")
      ran = true
      let outcome: EventsStreamOutcome | undefined
      let resolveDone!: (o: EventsStreamOutcome) => void
      const done = new Promise<EventsStreamOutcome>(resolve => {
        resolveDone = resolve
      })
      const end = (o: EventsStreamOutcome): void => {
        if (outcome) return
        outcome = o
        resolveDone(o)
      }

      let chain: Promise<void> = Promise.resolve()
      /** Every write goes through one chain, so frames never interleave and order is the journal order. */
      const serial = (task: () => Promise<void>): void => {
        chain = chain
          .then(async () => {
            if (!outcome) await task()
          })
          .catch(() => end("stalled"))
      }

      let heartbeatTimer: unknown
      let recheckTimer: unknown
      let pos: { journalId: string; seq: number } = { journalId: first.journalId, seq: startSeq(first) }
      let backlogMaxAgeMs = first.hasMore ? input.maxAgeMs : undefined

      const write = async (message: Record<string, unknown>): Promise<boolean> => {
        if (outcome) return false
        let timer: unknown
        const timedOut = new Promise<"timeout">(resolve => {
          timer = timers.setTimeout(() => resolve("timeout"), backpressureMs)
        })
        try {
          const result = await Promise.race([sink.send(message).then(() => "ok" as const), timedOut])
          if (result === "timeout") {
            end("stalled")
            return false
          }
          return true
        } catch {
          end(sink.signal.aborted ? "aborted" : "stalled")
          return false
        } finally {
          timers.clearTimeout(timer)
        }
      }

      const armHeartbeat = (): void => {
        if (heartbeatTimer !== undefined) timers.clearTimeout(heartbeatTimer)
        if (outcome) return
        heartbeatTimer = timers.setTimeout(() => {
          heartbeatTimer = undefined
          serial(() => notify("notifications/events/heartbeat", { cursor: encodePollCursor(pos.journalId, pos.seq, principal) }))
        }, heartbeatMs)
      }

      const notify = async (method: string, params: Record<string, unknown>): Promise<void> => {
        if (await write({ jsonrpc: "2.0", method, params: { ...params, _meta: meta } })) armHeartbeat()
      }

      const deliver = async (read: JournalRead): Promise<void> => {
        for (const entry of read.events) {
          if (outcome) return
          await notify("notifications/events/event", {
            ...entry.event,
            cursor: encodePollCursor(read.journalId, entry.seq, principal),
          })
          pos = { journalId: read.journalId, seq: entry.seq }
        }
        if (!outcome) pos = { journalId: read.journalId, seq: read.lastReturnedSeq }
      }

      const drain = async (): Promise<void> => {
        for (;;) {
          if (outcome) return
          const read = journal.read(key, {
            after: pos,
            ...(backlogMaxAgeMs !== undefined ? { maxAgeMs: backlogMaxAgeMs } : {}),
            maxEvents: PAGE_SIZE,
          })
          // A gap mid-stream is not an error: a fresh `active` with `truncated:true`, then delivery continues.
          if (read.truncated) {
            await notify("notifications/events/active", {
              cursor: encodePollCursor(read.journalId, startSeq(read), principal),
              truncated: true,
              heartbeatMs,
            })
          }
          await deliver(read)
          if (!read.hasMore) {
            backlogMaxAgeMs = undefined
            return
          }
        }
      }

      const finalFrame = async (): Promise<void> => {
        await write({ jsonrpc: "2.0", id: subscriptionId, result: { resultType: "complete", _meta: meta } })
        end("closed")
      }

      const terminate = async (code: number, message: string, data: Record<string, unknown>): Promise<void> => {
        await notify("notifications/events/terminated", { error: { code, message, data } })
        if (!outcome) await finalFrame()
      }

      const recheck = async (): Promise<void> => {
        const current = (ctx.findRegistration ?? findEventDefinition)(name)
        if (!current) {
          await terminate(EVENTS_ERR.notFound, "NotFound", { kind: "event", reason: "event_type_removed" })
          return
        }
        if (!current.meta.authorize(args, principal)) {
          await terminate(EVENTS_ERR.forbidden, "Forbidden", { reason: "access_revoked" })
          return
        }
        if (!current.definition.delivery.includes("push")) {
          await terminate(EVENTS_ERR.unsupported, "Unsupported", { feature: "deliveryMode", value: "push" })
          return
        }
        armRecheck()
      }
      const armRecheck = (): void => {
        if (outcome) return
        recheckTimer = timers.setTimeout(() => {
          recheckTimer = undefined
          serial(recheck)
        }, recheckMs)
      }

      const onAbort = (): void => end("aborted")
      const onClosing = (): void => serial(finalFrame)
      let unsubscribeJournal: (() => void) | undefined
      let unsubscribePump: (() => void) | undefined
      try {
        if (sink.signal.aborted) {
          end("aborted")
        } else {
          sink.signal.addEventListener("abort", onAbort, { once: true })
          serial(async () => {
            await notify("notifications/events/active", {
              cursor: encodePollCursor(first.journalId, startSeq(first), principal),
              truncated: first.truncated,
              heartbeatMs,
            })
            await deliver(first)
          })
          unsubscribeJournal = journal.subscribe(key, () => serial(drain))
          unsubscribePump = ctx.leases.onPumpError(key, reason =>
            serial(() =>
              notify("notifications/events/error", { error: { code: EVENTS_ERR.internal, message: "UpstreamError", data: { reason } } }),
            ),
          )
          // Whatever landed between `open` and now (and the rest of a long backlog).
          serial(drain)
          armRecheck()
          if (sink.closing?.aborted) onClosing()
          else sink.closing?.addEventListener("abort", onClosing, { once: true })
        }
        return await done
      } finally {
        if (heartbeatTimer !== undefined) timers.clearTimeout(heartbeatTimer)
        if (recheckTimer !== undefined) timers.clearTimeout(recheckTimer)
        sink.signal.removeEventListener("abort", onAbort)
        sink.closing?.removeEventListener("abort", onClosing)
        unsubscribeJournal?.()
        unsubscribePump?.()
        hold()
        releaseSlot()
      }
    },
  }
}
