/**
 * `events/poll`: durable journal + shared watch lease. The ONLY faked boundary is the sentinel
 * provider (an in-memory fake); the journal writes real files under a temp dir.
 */

import "../sentinel-platform.js"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeSentinelProvider, makeFakeEvent, type FakeSentinelProvider } from "@agentproto/sentinel"

import { eventsList, eventsPoll, toJournalEvent, type EventsPollContext, type EventsPollResult } from "../mcp-events/adapter.js"
import { daemonBearerPrincipal, sessionPrincipal, type Principal } from "../mcp-events/events-registry.js"
import { createPollJournal, journalKey, type PollJournal } from "../mcp-events/poll-journal.js"
import { createPollLeaseManager, type PollLeaseManager } from "../mcp-events/poll-lease.js"

const NAME = "github.pull_request.closed"
const ARGS = { repo: "agentproto/ts", number: 1428 }
const SUBJECT = "github:agentproto/ts#1428"

let dir: string
let clock: number
let provider: FakeSentinelProvider
let journal: PollJournal
let leases: PollLeaseManager
let providerResolutions: number

function build(overrides: { retentionMs?: number; idleTtlMs?: number; maxLeases?: number } = {}) {
  journal = createPollJournal({ dir, now: () => clock, ...(overrides.retentionMs ? { retentionMs: overrides.retentionMs } : {}) })
  leases = createPollLeaseManager({
    journal,
    resolveProvider: async () => {
      providerResolutions++
      return provider
    },
    toEvent: toJournalEvent,
    now: () => clock,
    pumpIntervalMs: 1000,
    idleTtlMs: overrides.idleTtlMs ?? 60_000,
    ...(overrides.maxLeases ? { maxLeases: overrides.maxLeases } : {}),
    background: false,
  })
}

const ctx = (principal: Principal = daemonBearerPrincipal()): EventsPollContext => ({ principal, journal, leases })
const poll = (input: Record<string, unknown> = {}, principal?: Principal): Promise<EventsPollResult> =>
  eventsPoll({ name: NAME, arguments: ARGS, cursor: null, ...input } as never, ctx(principal))

function emit(id: string, type = NAME): void {
  provider.emit(makeFakeEvent({ id, type, subject: SUBJECT, subjects: [SUBJECT], summary: `${id}`, data: { id } }))
}

/** Advance the clock past the pump interval so the next poll pulls from the provider. */
const tick = (ms = 1500): void => {
  clock += ms
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-events-poll-"))
  clock = 1_800_000_000_000
  provider = createFakeSentinelProvider({ slug: "local-gh" })
  providerResolutions = 0
  build()
})
afterEach(async () => {
  await leases.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe("events/poll", () => {
  it("needs no subscribe: cursor:null opens the watch and returns only what comes next", async () => {
    emit("before")
    const first = await poll()
    expect(first.events).toEqual([])
    expect(first.cursor).toBeTypeOf("string")
    expect(first.truncated).toBe(false)
    expect(first.hasMore).toBe(false)
    expect(first.nextPollMs).toBe(1000)
    expect(leases.size()).toBe(1)

    emit("e1")
    tick()
    const second = await poll({ cursor: first.cursor })
    expect(second.events.map(e => e.eventId)).toEqual(["e1"])
    expect(second.events[0]).toMatchObject({ name: NAME, data: expect.objectContaining({ subject: SUBJECT }) })
    expect(second.events[0]).toHaveProperty("timestamp")
  })

  it("replays from a cursor: same events, same order, and a stable eventId", async () => {
    const start = await poll()
    emit("e1")
    emit("e2")
    tick()
    const a = await poll({ cursor: start.cursor })
    const b = await poll({ cursor: start.cursor })
    expect(a.events.map(e => e.eventId)).toEqual(["e1", "e2"])
    expect(b.events).toEqual(a.events)
    // resuming from the new cursor yields nothing new
    const c = await poll({ cursor: a.cursor })
    expect(c.events).toEqual([])
  })

  it("only journals the polled event type", async () => {
    const start = await poll()
    emit("other", "github.pull_request.synchronize")
    emit("mine")
    tick()
    expect((await poll({ cursor: start.cursor })).events.map(e => e.eventId)).toEqual(["mine"])
  })

  it("maxEvents bounds a page and sets hasMore with nextPollMs 0; the cursor resumes where it stopped", async () => {
    const start = await poll()
    for (const id of ["e1", "e2", "e3"]) emit(id)
    tick()
    const page1 = await poll({ cursor: start.cursor, maxEvents: 2 })
    expect(page1.events.map(e => e.eventId)).toEqual(["e1", "e2"])
    expect(page1.hasMore).toBe(true)
    expect(page1.nextPollMs).toBe(0)
    const page2 = await poll({ cursor: page1.cursor, maxEvents: 2 })
    expect(page2.events.map(e => e.eventId)).toEqual(["e3"])
    expect(page2.hasMore).toBe(false)
  })

  it("maxAgeMs bounds the replay window and reports truncated", async () => {
    const start = await poll()
    emit("old")
    tick(1500)
    await poll({ cursor: start.cursor }) // pulls "old" into the journal at t0+1500
    tick(10_000)
    emit("fresh")
    tick(1500)
    const bounded = await poll({ cursor: start.cursor, maxAgeMs: 5_000 })
    expect(bounded.events.map(e => e.eventId)).toEqual(["fresh"])
    expect(bounded.truncated).toBe(true)
    const unbounded = await poll({ cursor: start.cursor })
    expect(unbounded.events.map(e => e.eventId)).toEqual(["old", "fresh"])
    expect(unbounded.truncated).toBe(false)
  })

  it("two pollers share ONE provider watch but keep independent cursors", async () => {
    const a = await poll()
    const b = await poll()
    expect(provider.attachCalls).toHaveLength(1)
    expect(leases.size()).toBe(1)
    emit("e1")
    tick()
    const ra = await poll({ cursor: a.cursor })
    emit("e2")
    tick()
    const rb = await poll({ cursor: b.cursor })
    expect(ra.events.map(e => e.eventId)).toEqual(["e1"])
    expect(rb.events.map(e => e.eventId)).toEqual(["e1", "e2"])
    expect(provider.attachCalls).toHaveLength(1)
  })

  it("refuses a cursor issued to another principal (-32024)", async () => {
    const mine = await poll()
    await expect(poll({ cursor: mine.cursor }, sessionPrincipal("other"))).rejects.toMatchObject({
      code: -32024,
      data: { reason: "cursor_principal_mismatch" },
    })
  })

  it("rejects a garbage cursor with -32602 invalid_cursor", async () => {
    for (const cursor of ["nope", Buffer.from("{}").toString("base64url"), 7]) {
      await expect(poll({ cursor })).rejects.toMatchObject({ code: -32602, data: { reason: "invalid_cursor" } })
    }
  })

  it("an idle lease is released after the TTL (provider watch cancelled) and the next poll opens a new one", async () => {
    const first = await poll()
    expect(leases.size()).toBe(1)
    tick(61_000)
    expect(await leases.sweep()).toHaveLength(1)
    expect(leases.size()).toBe(0)
    expect(provider.canceled.size).toBe(1)
    await poll({ cursor: first.cursor })
    expect(provider.attachCalls).toHaveLength(2)
    expect(leases.size()).toBe(1)
  })

  it("a cursor from before a new watch reads as truncated (events may have been missed), never an error", async () => {
    const first = await poll()
    tick(61_000)
    await leases.sweep()
    tick()
    const resumed = await poll({ cursor: first.cursor })
    expect(resumed.truncated).toBe(true)
    expect(resumed.events).toEqual([])
    // the fresh cursor is clean
    expect((await poll({ cursor: resumed.cursor })).truncated).toBe(false)
  })

  it("survives a restart: the journal is read back from disk; a new watch marks a gap", async () => {
    const start = await poll()
    emit("e1")
    tick()
    const seen = await poll({ cursor: start.cursor })
    expect(seen.events).toHaveLength(1)
    await leases.stop()

    // "restart": new journal + lease manager over the same directory
    build()
    const resumed = await poll({ cursor: start.cursor })
    // the persisted event is replayed, and the new watch is flagged
    expect(resumed.events.map(e => e.eventId)).toEqual(["e1"])
    expect(resumed.truncated).toBe(true)
  })

  it("a purged / absent journal answers truncated:true with a fresh cursor, not an error", async () => {
    const first = await poll()
    await leases.stop()
    rmSync(dir, { recursive: true, force: true })
    build()
    const after = await poll({ cursor: first.cursor })
    expect(after.truncated).toBe(true)
    expect(after.events).toEqual([])
    expect((await poll({ cursor: after.cursor })).truncated).toBe(false)
  })

  it("retention drops old entries: a cursor behind them is truncated and the rest is still served", async () => {
    build({ retentionMs: 10_000 })
    const start = await poll()
    emit("old")
    tick()
    await poll({ cursor: start.cursor })
    tick(20_000)
    emit("new")
    tick()
    const r = await poll({ cursor: start.cursor })
    expect(r.truncated).toBe(true)
    expect(r.events.map(e => e.eventId)).toEqual(["new"])
  })

  it("purge keeps an emptied journal a live watch feeds and removes one nobody feeds", async () => {
    build({ retentionMs: 10_000 })
    await poll()
    const key = journalKey(NAME, ARGS)
    tick(20_000)
    expect(journal.purge(() => true)).toBeGreaterThan(0)
    expect(journal.has(key)).toBe(true)
    journal.purge(() => false)
    expect(journal.has(key)).toBe(false)
  })

  it("periodic purge: after the purge interval, an emptied journal nobody feeds is removed without a restart", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      await leases.stop()
      journal = createPollJournal({ dir, now: () => clock, retentionMs: 10_000 })
      leases = createPollLeaseManager({
        journal,
        resolveProvider: async () => provider,
        toEvent: toJournalEvent,
        now: () => clock,
        pumpIntervalMs: 1000,
        idleTtlMs: 60_000,
      })
      await poll()
      const key = journalKey(NAME, ARGS)
      expect(journal.has(key)).toBe(true)
      // the lease goes idle and is released; the gap entry ages out of retention
      tick(61_000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(leases.size()).toBe(0)
      // purge runs every 10 min of the injected clock, not on every pump tick
      tick(10 * 60 * 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(journal.has(key)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a re-served provider event is journaled once", async () => {
    const start = await poll()
    emit("dup")
    tick()
    await poll({ cursor: start.cursor })
    // a replacement watch over a provider that re-serves its history
    await leases.stop()
    build()
    tick()
    const r = await poll({ cursor: start.cursor })
    expect(r.events.map(e => e.eventId)).toEqual(["dup"])
  })
})

describe("events/list delivery modes", () => {
  it("offers poll and webhook per type, and drops poll when the extension is switched off", async () => {
    const on = await eventsList({}, { principal: daemonBearerPrincipal() })
    for (const def of on.events) expect(def.delivery).toEqual(["poll", "webhook"])
    const off = await eventsList({}, { principal: daemonBearerPrincipal(), pollEnabled: false })
    for (const def of off.events) expect(def.delivery).toEqual(["webhook"])
  })
})
