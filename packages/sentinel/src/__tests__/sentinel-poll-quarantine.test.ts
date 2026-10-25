/**
 * Phase 0a — poll batch ack ordering.
 *
 * An acknowledged cursor means every item at or before it is durably delivered
 * (or durably enqueued) or quarantined. Poison items are quarantined, never
 * stall the subscription, and the quarantine record is inspectable without
 * secrets.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createSentinelQuarantine } from "../sentinel-quarantine.js"
import { createFakeSentinelProvider, makeFakeEvent } from "../sentinel-providers/fake.js"
import { singleMatch, type SentinelMalformedItem } from "../sentinel-providers/types.js"
import type { SessionMessage } from "../session-message.js"

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sentinel-quar-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(9)).toString("base64")

const poison = (over: Partial<SentinelMalformedItem> = {}): SentinelMalformedItem => ({
  seq: 2,
  remoteDeliveryId: "dlv_poison_1",
  error: "envelope.id must be a non-empty string",
  excerpt: { type: "fake.widget.created", subject: "fake:widget-1" },
  digest: "abc123",
  bytes: 42,
  ...over,
})

const evt = (id: string) => makeFakeEvent({ id, type: "fake.widget.created", subject: "fake:widget-1" })

function setup(opts: { onAck?: (cursor: string) => void; quarantine?: ReturnType<typeof createSentinelQuarantine> } = {}) {
  const dir = tmp()
  const store = createSentinelStore({ persist: false })
  const acked: string[] = []
  const provider = createFakeSentinelProvider({
    onAck: (_h, cursor) => {
      acked.push(cursor)
      opts.onAck?.(cursor)
    },
  })
  const sent: SessionMessage[] = []
  const registry: SentinelRuntimeRegistry = {
    async sendMessage(msg) {
      sent.push(msg)
      return { messageId: "m", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" } as never
    },
  }
  const sentinel = store.create({
    provider: "fake",
    handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
    spec: {
      match: singleMatch("fake:widget-1"),
      until: { kind: "never" },
      target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
    },
  })
  const quarantinePath = join(dir, "quarantine.jsonl")
  const runtime = createSentinelRuntime({
    store,
    registry,
    resolveProvider: async slug => (slug === provider.slug ? provider : null),
    isSessionAlive: () => true,
    restartSession: async id => id,
    quarantinePath,
    cancelTombstonePath: join(dir, "tombstones.json"),
    outboxPath: join(dir, "outbox.json"),
    deliverEvent: async () => ({ ok: true, delivery: { attempts: 1, lastAt: new Date().toISOString() } }),
  })
  return { dir, store, provider, runtime, sentinel, acked, sent, quarantinePath }
}

describe("poll batch ack with poison items", () => {
  it("quarantines a poison item between valid events, delivers the later valid event, and acks the full cursor", async () => {
    const { provider, runtime, sentinel, store, acked, sent } = setup()
    provider.emit(evt("evt_1"))
    provider.emitMalformed(poison())
    provider.emit(evt("evt_3"))

    await runtime.pollOnce()

    expect(sent.map(m => m.text)).toHaveLength(2)
    expect(acked).toEqual(["3"])
    expect(store.get(sentinel.id)!.handle.cursor).toBe("3")
    const recs = runtime.quarantine.list({ sentinelId: sentinel.id })
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({
      remoteDeliveryId: "dlv_poison_1",
      seq: 2,
      error: "envelope.id must be a non-empty string",
      provider: "fake",
    })
  })

  it("a poison-only batch is quarantined and acked (does not stall the subscription)", async () => {
    const { provider, runtime, sentinel, acked } = setup()
    provider.emitMalformed(poison({ seq: 1 }))
    await runtime.pollOnce()
    expect(acked).toEqual(["1"])
    expect(runtime.quarantine.list({ sentinelId: sentinel.id })).toHaveLength(1)

    provider.emit(evt("evt_next"))
    await runtime.pollOnce()
    expect(acked).toEqual(["1", "2"])
  })

  it("the quarantine file is durable, survives reopen, and holds no payload data or secrets", async () => {
    const { provider, runtime, sentinel, quarantinePath } = setup()
    provider.emitMalformed(
      poison({
        // Even if a provider mistakenly stuffed a secret into the error text
        // path, the record only ever has the fields below; check the shape.
        excerpt: { id: "evt_x", type: "t", subject: "s", source: "src" },
      }),
    )
    await runtime.pollOnce()

    const raw = readFileSync(quarantinePath, "utf8")
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1)
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toMatch(/"data"/)
    const reopened = createSentinelQuarantine({ filePath: quarantinePath })
    const [rec] = reopened.list({ sentinelId: sentinel.id })
    expect(rec).toMatchObject({ remoteDeliveryId: "dlv_poison_1", digest: "abc123", error: expect.any(String) })
    expect(Object.keys(rec!).sort()).toEqual(
      ["bytes", "digest", "error", "excerpt", "key", "provider", "quarantinedAt", "remoteDeliveryId", "remoteId", "sentinelId", "seq"].sort(),
    )
  })

  it("re-serving the same poison item (crash between quarantine and ack) does not duplicate the record", async () => {
    const { provider, runtime, sentinel, quarantinePath } = setup()
    provider.emitMalformed(poison({ seq: 1 }))
    await runtime.pollOnce()
    // Simulate the cursor never having advanced: the same batch comes back.
    const s = runtime.quarantine
    s.record({ sentinelId: sentinel.id, provider: "fake", item: poison({ seq: 1 }) })
    expect(readFileSync(quarantinePath, "utf8").split("\n").filter(Boolean)).toHaveLength(1)
  })

  it("a quarantine write failure leaves the batch un-acked and the cursor unmoved", async () => {
    const dir = tmp()
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x") // quarantine path below this "directory" cannot be created
    const base = setup()
    const store = base.store
    const failingRuntime = createSentinelRuntime({
      store,
      registry: { sendMessage: async () => ({ messageId: "m", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" }) as never },
      resolveProvider: async slug => (slug === base.provider.slug ? base.provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      quarantinePath: join(blocker, "q.jsonl"),
      cancelTombstonePath: join(dir, "t.json"),
      outboxPath: join(dir, "o.json"),
      deliverEvent: async () => ({ ok: true, delivery: { attempts: 1, lastAt: new Date().toISOString() } }),
    })
    base.provider.emit(evt("evt_1"))
    base.provider.emitMalformed(poison())

    await failingRuntime.pollOnce()

    expect(base.acked).toEqual([])
    expect(store.get(base.sentinel.id)!.handle.cursor).toBe("0")
    expect(store.get(base.sentinel.id)!.lastError).toMatch(/quarantine write failed/)
  })

  it("a delivery failure mid-batch keeps the cursor and does not ack", async () => {
    const dir = tmp()
    const store = createSentinelStore({ persist: false })
    const acked: string[] = []
    const provider = createFakeSentinelProvider({ onAck: (_h, c) => void acked.push(c) })
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: {
        match: singleMatch("fake:widget-1"),
        until: { kind: "never" },
        target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
      },
    })
    const runtime = createSentinelRuntime({
      store,
      registry: {
        sendMessage: async () => {
          throw new Error("registry exploded")
        },
      },
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      quarantinePath: join(dir, "q.jsonl"),
      cancelTombstonePath: join(dir, "t.json"),
      outboxPath: join(dir, "o.json"),
      deliverEvent: async () => ({ ok: true, delivery: { attempts: 1, lastAt: new Date().toISOString() } }),
    })
    provider.emit(evt("evt_1"))
    provider.emitMalformed(poison({ seq: 2 }))

    await runtime.pollOnce()

    expect(acked).toEqual([])
    expect(store.get(sentinel.id)!.handle.cursor).toBe("0")
    // The poison item is still durably recorded; re-serving is idempotent.
    expect(runtime.quarantine.list({ sentinelId: sentinel.id })).toHaveLength(1)
  })
})

describe("webhook target: ack only after the durable outbox enqueue", () => {
  function webhookSetup(outboxPath: string) {
    const dir = tmp()
    const store = createSentinelStore({ persist: false })
    const acked: string[] = []
    const provider = createFakeSentinelProvider({ onAck: (_h, c) => void acked.push(c) })
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: {
        match: singleMatch("fake:widget-1"),
        until: { kind: "never" },
        target: { kind: "webhook", url: "https://callback.example/hook", secret: SECRET },
      },
    })
    const runtime = createSentinelRuntime({
      store,
      registry: { sendMessage: async () => ({}) as never },
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      quarantinePath: join(dir, "q.jsonl"),
      cancelTombstonePath: join(dir, "t.json"),
      outboxPath,
      deliverEvent: () => new Promise(() => {}), // never completes: only enqueue durability is under test
    })
    return { store, provider, sentinel, runtime, acked }
  }

  it("acks the cursor once the row is on disk, even though delivery has not happened", async () => {
    const outboxPath = join(tmp(), "outbox.json")
    const { provider, runtime, acked } = webhookSetup(outboxPath)
    provider.emit(evt("evt_1"))
    await runtime.pollOnce()
    expect(acked).toEqual(["1"])
    const onDisk = JSON.parse(readFileSync(outboxPath, "utf8")) as Record<string, { eventId: string }>
    expect(Object.values(onDisk).map(r => r.eventId)).toEqual(["evt_1"])
  })

  it("an outbox write failure means no ack (poll) and failed:true (push → HTTP 5xx)", async () => {
    const dir = tmp()
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x")
    const { provider, runtime, acked, sentinel, store } = webhookSetup(join(blocker, "outbox.json"))

    provider.emit(evt("evt_1"))
    await runtime.pollOnce()
    expect(acked).toEqual([])
    expect(store.get(sentinel.id)!.handle.cursor).toBe("0")

    const pushed = await runtime.deliverPushed(sentinel.id, [evt("evt_2")])
    expect(pushed.failed).toBe(true)
  })
})
