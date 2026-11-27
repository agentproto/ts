/**
 * `events/stream` engine (no HTTP). Same journal and leases as `events/poll`; the only faked boundary is the sentinel
 * provider. Timers are injected: `advance(ms)` fires what is due, in order.
 */

import "../sentinel-platform.js"

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeSentinelProvider, makeFakeEvent, type FakeSentinelProvider } from "@agentproto/sentinel"

import { eventsPoll, toJournalEvent } from "../mcp-events/adapter.js"
import { daemonBearerPrincipal, findEventDefinition, sessionPrincipal, type Principal } from "../mcp-events/events-registry.js"
import { createPollJournal, journalKey, type PollJournal } from "../mcp-events/poll-journal.js"
import { createPollLeaseManager, type PollLeaseManager } from "../mcp-events/poll-lease.js"
import {
  createStreamSlots,
  openEventsStream,
  type EventsStreamContext,
  type EventsStreamOutcome,
  type StreamSlots,
  type StreamTimers,
} from "../mcp-events/stream.js"

const NAME = "github.pull_request.closed"
const ARGS = { repo: "agentproto/ts", number: 1428 }
const SUBJECT = "github:agentproto/ts#1428"
const KEY = journalKey(NAME, ARGS)
const SUB = "io.modelcontextprotocol/subscriptionId"
const IDLE_TTL = 60_000

type Msg = Record<string, any>

let dir: string
let clock: number
let provider: FakeSentinelProvider
let journal: PollJournal
let leases: PollLeaseManager
let slots: StreamSlots
let timers: ManualTimers

interface ManualTimers extends StreamTimers {
  advance(ms: number): Promise<void>
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

function manualTimers(): ManualTimers {
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      pending.set(id, { at: clock + ms, fn })
      return id
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
    async advance(ms) {
      const target = clock + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        clock = due[1].at
        pending.delete(due[0])
        due[1].fn()
        await settle()
      }
      clock = target
      await settle()
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-events-stream-"))
  clock = 1_800_000_000_000
  provider = createFakeSentinelProvider({ slug: "local-gh" })
  journal = createPollJournal({ dir, now: () => clock })
  leases = createPollLeaseManager({
    journal,
    resolveProvider: async () => provider,
    toEvent: toJournalEvent,
    now: () => clock,
    pumpIntervalMs: 1000,
    idleTtlMs: IDLE_TTL,
    background: false,
  })
  slots = createStreamSlots()
  timers = manualTimers()
})
afterEach(async () => {
  await leases.stop()
  rmSync(dir, { recursive: true, force: true })
})

function ctx(over: Partial<EventsStreamContext> = {}): EventsStreamContext {
  return { principal: daemonBearerPrincipal(), journal, leases, slots, subscriptionId: 7, timers, ...over }
}

interface Running {
  messages: Msg[]
  client: AbortController
  closing: AbortController
  done: Promise<EventsStreamOutcome>
}

async function start(input: Record<string, unknown> = {}, over: Partial<EventsStreamContext> = {}, send?: () => Promise<void>): Promise<Running> {
  const stream = await openEventsStream({ name: NAME, arguments: ARGS, cursor: null, ...input } as never, ctx(over))
  const messages: Msg[] = []
  const client = new AbortController()
  const closing = new AbortController()
  const done = stream.run({
    send: async message => {
      if (send) return send()
      messages.push(message)
    },
    signal: client.signal,
    closing: closing.signal,
  })
  await settle()
  return { messages, client, closing, done }
}

const methods = (r: Running): string[] => r.messages.map(m => m.method ?? "result")
const events = (r: Running): Msg[] => r.messages.filter(m => m.method === "notifications/events/event").map(m => m.params)

function emit(id: string): void {
  provider.emit(makeFakeEvent({ id, type: NAME, subject: SUBJECT, subjects: [SUBJECT], summary: id, data: { id } }))
}

/** Pull what the provider has into the journal, as the background pump would. */
async function pump(): Promise<void> {
  clock += 1500
  await leases.acquire({ key: KEY, name: NAME, mapped: { ok: true, matchClauses: [{ subject: SUBJECT, types: [NAME] }], providerSlug: "local-gh" } })
  await settle()
}

async function stop(r: Running): Promise<void> {
  r.client.abort()
  await r.done
}

describe("events/stream engine", () => {
  it("sends notifications/events/active first, with the granted heartbeatMs and the subscription id", async () => {
    const r = await start({ heartbeatMs: 15_000 })
    expect(r.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { truncated: false, heartbeatMs: 15_000, _meta: { [SUB]: 7 } },
    })
    expect(r.messages[0]!.params.cursor).toBeTypeOf("string")
    await stop(r)
  })

  it("cursor:null replays nothing; live events follow with their own cursor", async () => {
    await pump()
    emit("before")
    await pump()
    const r = await start()
    expect(methods(r)).toEqual(["notifications/events/active"])
    emit("live")
    await pump()
    expect(events(r).map(e => e.eventId)).toEqual(["live"])
    expect(events(r)[0]).toMatchObject({ name: NAME, data: expect.objectContaining({ id: "live" }), _meta: { [SUB]: 7 } })
    expect(events(r)[0]!.timestamp).toBeTypeOf("string")
    expect(events(r)[0]!.cursor).toBeTypeOf("string")
    await stop(r)
  })

  it("a cursor replays the backlog in order with the same eventId", async () => {
    const first = await start()
    const cursor = first.messages[0]!.params.cursor as string
    await stop(first)
    for (const id of ["a", "b", "c"]) emit(id)
    await pump()
    const r = await start({ cursor })
    expect(methods(r)[0]).toBe("notifications/events/active")
    expect(r.messages[0]!.params.truncated).toBe(false)
    expect(events(r).map(e => e.eventId)).toEqual(["a", "b", "c"])
    await stop(r)
  })

  it("a poll cursor resumes a stream, and a stream cursor resumes a poll", async () => {
    const pollCtx = { principal: daemonBearerPrincipal(), journal, leases }
    const polled = await eventsPoll({ name: NAME, arguments: ARGS, cursor: null }, pollCtx)
    emit("p1")
    await pump()
    const r = await start({ cursor: polled.cursor })
    expect(events(r).map(e => e.eventId)).toEqual(["p1"])
    const streamCursor = events(r)[0]!.cursor as string
    await stop(r)
    emit("p2")
    await pump()
    const again = await eventsPoll({ name: NAME, arguments: ARGS, cursor: streamCursor }, pollCtx)
    expect(again.events.map(e => e.eventId)).toEqual(["p2"])
    expect(again.truncated).toBe(false)
  })

  it("a short maxAgeMs skips old events and announces truncated:true in active", async () => {
    const first = await start()
    const cursor = first.messages[0]!.params.cursor as string
    await stop(first)
    emit("old")
    await pump()
    clock += 10 * 60_000
    emit("fresh")
    await pump()
    const r = await start({ cursor, maxAgeMs: 60_000 })
    expect(r.messages[0]!.params.truncated).toBe(true)
    expect(events(r).map(e => e.eventId)).toEqual(["fresh"])
    await stop(r)
  })

  it("a gap mid-stream sends a second active with truncated:true and a fresh cursor, and the stream goes on", async () => {
    const r = await start()
    journal.markGap(KEY)
    await settle()
    const actives = r.messages.filter(m => m.method === "notifications/events/active")
    expect(actives).toHaveLength(2)
    expect(actives[1]!.params).toMatchObject({ truncated: true, heartbeatMs: 30_000 })
    expect(actives[1]!.params.cursor).not.toBe(actives[0]!.params.cursor)
    emit("after-gap")
    await pump()
    expect(events(r).map(e => e.eventId)).toEqual(["after-gap"])
    await stop(r)
  })

  it("sends a heartbeat only after heartbeatMs of silence, carrying the head cursor", async () => {
    const r = await start({ heartbeatMs: 5_000 })
    await timers.advance(3_000)
    emit("e1")
    await pump()
    const eventCursor = events(r)[0]!.cursor
    await timers.advance(4_000)
    expect(methods(r)).not.toContain("notifications/events/heartbeat")
    await timers.advance(1_000)
    const beats = r.messages.filter(m => m.method === "notifications/events/heartbeat")
    expect(beats).toHaveLength(1)
    expect(beats[0]!.params).toEqual({ cursor: eventCursor, _meta: { [SUB]: 7 } })
    await stop(r)
  })

  it("clamps heartbeatMs into [5000, 60000] and defaults to 30000", async () => {
    for (const [asked, granted] of [
      [1, 5_000],
      [10_000_000, 60_000],
      [undefined, 30_000],
    ] as const) {
      const r = await start(asked === undefined ? {} : { heartbeatMs: asked })
      expect(r.messages[0]!.params.heartbeatMs).toBe(granted)
      await stop(r)
    }
  })

  it("a failing provider pull sends notifications/events/error with a reason category and keeps the stream open", async () => {
    const r = await start()
    const original = provider.poll
    provider.poll = async () => {
      throw new Error("upstream 503 with token=abc")
    }
    await pump()
    const errors = r.messages.filter(m => m.method === "notifications/events/error")
    expect(errors).toHaveLength(1)
    expect(errors[0]!.params).toEqual({
      error: { code: -32603, message: "UpstreamError", data: { reason: "upstream_poll_failed" } },
      _meta: { [SUB]: 7 },
    })
    expect(JSON.stringify(errors)).not.toContain("token=abc")
    provider.poll = original
    emit("recovered")
    await pump()
    expect(events(r).map(e => e.eventId)).toEqual(["recovered"])
    await stop(r)
  })

  it("a client abort releases the hold: the watch is swept after the idle TTL", async () => {
    const r = await start()
    expect(await stop(r).then(() => r.done)).toBe("aborted")
    clock += IDLE_TTL + 1
    expect(await leases.sweep()).toEqual([KEY])
    expect(leases.isActive(KEY)).toBe(false)
    expect(slots.size()).toBe(0)
  })

  it("a run started with an already-aborted signal writes nothing and releases slot, hold and listener", async () => {
    const stream = await openEventsStream({ name: NAME, arguments: ARGS, cursor: null }, ctx())
    expect(slots.size()).toBe(1)
    const messages: Msg[] = []
    const outcome = await stream.run({ send: async m => void messages.push(m), signal: AbortSignal.abort() })
    expect(outcome).toBe("aborted")
    expect(messages).toEqual([])
    expect(slots.size()).toBe(0)
    expect(journal.listenerCount(KEY)).toBe(0)
    clock += IDLE_TTL + 1
    expect(await leases.sweep()).toEqual([KEY])
  })

  it("an open stream keeps its watch past the idle TTL", async () => {
    const r = await start()
    clock += IDLE_TTL * 3
    expect(await leases.sweep()).toEqual([])
    expect(leases.isActive(KEY)).toBe(true)
    await stop(r)
  })

  it("leaves no journal listener behind once closed, whatever the exit", async () => {
    const a = await start()
    expect(journal.listenerCount(KEY)).toBe(1)
    await stop(a)
    expect(journal.listenerCount(KEY)).toBe(0)
    const b = await start()
    b.closing.abort()
    expect(await b.done).toBe("closed")
    expect(journal.listenerCount(KEY)).toBe(0)
  })

  it("server shutdown writes the final frame, an empty complete result with the subscription id", async () => {
    const r = await start()
    r.closing.abort()
    expect(await r.done).toBe("closed")
    expect(r.messages.at(-1)).toEqual({ jsonrpc: "2.0", id: 7, result: { resultType: "complete", _meta: { [SUB]: 7 } } })
  })

  it("a client abort writes nothing more", async () => {
    const r = await start()
    const before = r.messages.length
    await stop(r)
    emit("late")
    await pump()
    await timers.advance(60_000)
    expect(r.messages).toHaveLength(before)
  })

  it("a write that does not drain within 10 s closes the stream as stalled and releases everything", async () => {
    const r = await start({}, {}, () => new Promise<void>(() => {}))
    await timers.advance(10_000)
    expect(await r.done).toBe("stalled")
    expect(slots.size()).toBe(0)
    expect(journal.listenerCount(KEY)).toBe(0)
  })

  it("refuses the 33rd concurrent stream with -32025 limit:streams", async () => {
    const open: Running[] = []
    for (let i = 0; i < 32; i++) open.push(await start())
    await expect(openEventsStream({ name: NAME, arguments: ARGS, cursor: null }, ctx())).rejects.toMatchObject({
      code: -32025,
      data: { limit: "streams", max: 32 },
    })
    for (const r of open) await stop(r)
    expect(slots.size()).toBe(0)
  })

  it("rejects before any frame: unknown type -32023, bad arguments -32602, another principal's cursor -32024", async () => {
    const other = await start({}, { principal: sessionPrincipal("sess_other") })
    const foreign = other.messages[0]!.params.cursor as string
    await stop(other)
    const open = (input: Record<string, unknown>, principal: Principal = daemonBearerPrincipal()) =>
      openEventsStream({ name: NAME, arguments: ARGS, cursor: null, ...input } as never, ctx({ principal }))
    await expect(open({ name: "nope.event" })).rejects.toMatchObject({ code: -32023, data: { kind: "event" } })
    await expect(open({ arguments: { repo: "agentproto/ts" } })).rejects.toMatchObject({ code: -32602 })
    await expect(open({ heartbeatMs: "fast" })).rejects.toMatchObject({ code: -32602 })
    await expect(open({ cursor: foreign })).rejects.toMatchObject({ code: -32024 })
    expect(slots.size()).toBe(0)
  })

  it("a type without push is -32026 Unsupported with data {feature:deliveryMode, value:push}", async () => {
    const real = findEventDefinition(NAME)!
    const noPush = { ...real, definition: { ...real.definition, delivery: ["poll" as const, "webhook" as const] } }
    await expect(
      openEventsStream({ name: NAME, arguments: ARGS, cursor: null }, ctx({ findRegistration: () => noPush })),
    ).rejects.toMatchObject({ code: -32026, data: { feature: "deliveryMode", value: "push" } })
  })

  it("returns the slot when the watch cannot be opened", async () => {
    const failing = createPollLeaseManager({ journal, resolveProvider: async () => null, toEvent: toJournalEvent, background: false })
    await expect(openEventsStream({ name: NAME, arguments: ARGS, cursor: null }, ctx({ leases: failing }))).rejects.toMatchObject({
      code: -32026,
    })
    expect(slots.size()).toBe(0)
  })

  it("an exhausted watch pool is -32025 with the same data as events/poll (limit pollWatches, max)", async () => {
    const full = createPollLeaseManager({
      journal,
      resolveProvider: async () => provider,
      toEvent: toJournalEvent,
      maxLeases: 1,
      background: false,
    })
    await full.acquire({
      key: journalKey(NAME, { repo: "agentproto/ts", number: 1 }),
      name: NAME,
      mapped: { ok: true, matchClauses: [{ subject: "github:agentproto/ts#1", types: [NAME] }], providerSlug: "local-gh" },
    })
    await expect(openEventsStream({ name: NAME, arguments: ARGS, cursor: null }, ctx({ leases: full }))).rejects.toMatchObject({
      code: -32025,
      data: { reason: "poll_watch_quota", limit: "pollWatches", max: 1 },
    })
    expect(slots.size()).toBe(0)
    await full.stop()
  })

  it("terminated: a type that leaves the registry ends the stream with notifications/events/terminated, then the final frame", async () => {
    let registered = true
    const real = findEventDefinition(NAME)!
    const r = await start({}, { findRegistration: () => (registered ? real : undefined), recheckIntervalMs: 1_000 })
    await timers.advance(1_000)
    expect(methods(r)).not.toContain("notifications/events/terminated")
    registered = false
    await timers.advance(1_000)
    expect(await r.done).toBe("closed")
    const terminated = r.messages.find(m => m.method === "notifications/events/terminated")
    expect(terminated?.params).toEqual({
      error: { code: -32023, message: "NotFound", data: { kind: "event", reason: "event_type_removed" } },
      _meta: { [SUB]: 7 },
    })
    expect(r.messages.at(-1)).toMatchObject({ id: 7, result: { resultType: "complete" } })
  })

  it("terminated: revoked access ends the stream with -32024 Forbidden", async () => {
    let allowed = true
    const real = findEventDefinition(NAME)!
    const gated = { ...real, meta: { ...real.meta, authorize: () => allowed } }
    const r = await start({}, { findRegistration: () => gated, recheckIntervalMs: 1_000 })
    allowed = false
    await timers.advance(1_000)
    expect(await r.done).toBe("closed")
    expect(r.messages.find(m => m.method === "notifications/events/terminated")?.params.error).toMatchObject({ code: -32024 })
  })

  it("echoes a string request id unchanged in every message", async () => {
    const r = await start({}, { subscriptionId: "req-42" })
    r.closing.abort()
    await r.done
    for (const m of r.messages) {
      if (m.method) expect(m.params._meta[SUB]).toBe("req-42")
      else expect(m).toMatchObject({ id: "req-42", result: { _meta: { [SUB]: "req-42" } } })
    }
  })

  it("every message has the shape of the spec example (fixtures)", async () => {
    const fixture = (name: string): Msg =>
      JSON.parse(readFileSync(new URL(`./fixtures/mcp-2026-07-28/${name}.json`, import.meta.url), "utf8")).body
    const keys = (m: Msg | undefined): string[] => Object.keys(m?.params ?? m?.result ?? {}).sort()
    const r = await start({ heartbeatMs: 5_000 })
    emit("shape")
    await pump()
    await timers.advance(5_000)
    const original = provider.poll
    provider.poll = async () => {
      throw new Error("down")
    }
    await pump()
    provider.poll = original
    r.closing.abort()
    await r.done
    const byMethod = (method: string) => r.messages.find(m => m.method === method)
    for (const [method, name] of [
      ["notifications/events/active", "events-active"],
      ["notifications/events/event", "events-event"],
      ["notifications/events/heartbeat", "events-heartbeat"],
      ["notifications/events/error", "events-error"],
    ] as const) {
      expect(keys(byMethod(method)), method).toEqual(keys(fixture(name)))
      expect(Object.keys(byMethod(method)!).sort()).toEqual(Object.keys(fixture(name)).sort())
    }
    const final = r.messages.at(-1)!
    expect(Object.keys(final).sort()).toEqual(Object.keys(fixture("events-stream-result")).sort())
    expect(keys(final)).toEqual(keys(fixture("events-stream-result")))
    expect(Object.keys(byMethod("notifications/events/error")!.params.error).sort()).toEqual(
      Object.keys(fixture("events-error").params.error).sort(),
    )

    let registered = true
    const real = findEventDefinition(NAME)!
    const t = await start({}, { findRegistration: () => (registered ? real : undefined), recheckIntervalMs: 1_000 })
    registered = false
    await timers.advance(1_000)
    await t.done
    expect(keys(t.messages.find(m => m.method === "notifications/events/terminated"))).toEqual(keys(fixture("events-terminated")))
  })
})
