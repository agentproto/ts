/**
 * Runtime webhook fire-path tests (plan §4 W-B): a matching event lands →
 * persisted outbox row, ack AFTER terminal status (crash-loss proof at the
 * runtime level), ingress expiry gate, periodic expiry sweep, restart
 * re-dispatch by exact stored bytes, and dual-secret replay during the
 * rotation window. `deliverEventEnvelope` is replaced through the runtime's
 * DI hook — never through module fakes.
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime } from "../sentinel-runtime.js"
import { createFakeSentinelProvider, makeFakeEvent } from "../sentinel-providers/fake.js"
import { serializeEnvelope, toWebhookEnvelope, type DeliveryOutcome, type DeliveryReplay } from "../webhook-egress/delivery.js"
import { signWebhook } from "../webhook-egress/signing.js"
import type { SessionMessage } from "../session-message.js"

const okResult = () => ({
  messageId: "msg_test",
  delivered: { via: "turn" },
  queued: false,
  urgencyApplied: "next-turn" as const,
})

function stubRegistry(calls: Array<SessionMessage>) {
  return {
    async sendMessage(msg: SessionMessage) {
      calls.push(msg)
      return okResult() as never
    },
  }
}

const whsecSecret = "whsec_" + Buffer.from(new Uint8Array(32).fill(8)).toString("base64")
const whsecSecret2 = "whsec_" + Buffer.from(new Uint8Array(32).fill(6)).toString("base64")

const webhookSpec = () => ({
  match: [{ subject: "fake:widget-1" }],
  until: { kind: "never" as const },
  target: { kind: "webhook" as const, url: "https://callback.example/hook", secret: whsecSecret },
  provider: "fake",
})

const evt = (id: string, overrides = {}) =>
  makeFakeEvent({
    id,
    type: "fake.widget.created",
    subject: "fake:widget-1",
    summary: "Widget created",
    time: new Date().toISOString(),
    ...overrides,
  })

describe("sentinel runtime — webhook fire path", () => {
  it("a matching event lands: the outbox row is created and the event is acked ONLY after terminal status", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const registry: Array<SessionMessage> = []
    const deliverCalls: Array<{ replay: DeliveryReplay; bytes: Uint8Array | undefined }> = []
    let attempt = 0

    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: webhookSpec(),
    })

    const runtime = createSentinelRuntime({
      store,
      registry: stubRegistry(registry),
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      deliverEvent: async (input: { replay: DeliveryReplay; row: { bodyBytes?: string; event: unknown } }) => {
        attempt++
        deliverCalls.push({
          replay: input.replay,
          bytes: input.row.bodyBytes ? Buffer.from(input.row.bodyBytes, "base64") : undefined,
        })
        return { ok: true, delivery: { attempts: attempt, lastAt: new Date().toISOString() } }
      },
    })

    provider.emit(evt("evt_1"))
    await runtime.pollOnce()
    await runtime.webhookOutbox.dispatch() // the enqueue's fire-and-forget chain drains here

    const rows = runtime.webhookOutbox.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe("delivered")
    // Ack-after-terminal: seen ONLY now, not before the row went terminal.
    expect(store.isSeen(sentinel.id, "evt_1")).toBe(true)
    expect(store.get(sentinel.id)!.eventCount).toBe(1)
    expect(deliverCalls).toHaveLength(1)

    // I2 — sent bytes == the frozen envelope serialization of the same event.
    const expectedBytes = Buffer.from(serializeEnvelope(toWebhookEnvelope(evt("evt_1"))))
    expect(Buffer.from(deliverCalls[0]!.bytes!)).toEqual(expectedBytes)

    // The signing secret came from the sidecar (never from the record).
    expect(deliverCalls[0]!.replay.secrets).toEqual([whsecSecret])
    expect(deliverCalls[0]!.replay.callbackUrl).toBe("https://callback.example/hook")
    // No session message was produced for a webhook target.
    expect(registry).toHaveLength(0)
  })

  it("crash-loss proof: a failing dispatcher leaves the event NOT marked seen and the row pending", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const registry: Array<SessionMessage> = []
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: webhookSpec(),
    })

    const runtime = createSentinelRuntime({
      store,
      registry: stubRegistry(registry),
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      deliverEvent: async () => {
        throw new Error("crash-shaped dispatch failure")
      },
    })

    provider.emit(evt("evt_1"))
    await runtime.pollOnce()
    await runtime.webhookOutbox.dispatch()

    const row = runtime.webhookOutbox.rows()[0]!
    expect(row.status).toBe("pending")
    // THE CRITICAL INVARIANT — evolved from the plan: a failed dispatch NEVER acks.
    expect(store.isSeen(sentinel.id, "evt_1")).toBe(false)
    expect(registry).toHaveLength(0)
  })

  it("expiry gate at the ingress: an event arriving after until.at never creates a delivery-capable row", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: { ...webhookSpec(), until: { kind: "at", ms: Date.now() - 1000 } },
    })

    const runtime = createSentinelRuntime({
      store,
      registry: stubRegistry([]),
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      deliverEvent: async () => {
        throw new Error("never called — the expiry gate precedes dispatch")
      },
    })

    provider.emit(evt("evt_late"))
    await runtime.pollOnce()

    expect(runtime.webhookOutbox.rows()).toHaveLength(0)
    expect(store.get(sentinel.id)!.status).toBe("expired")
    // Even the potential post-expiry event was never acked out silently.
    expect(store.isSeen(sentinel.id, "evt_late")).toBe(false)
  })

  it("the periodic sweep flips an already-active sentinel past its until.at to end:expired", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: webhookSpec(),
    })

    const runtime = createSentinelRuntime({
      store,
      registry: stubRegistry([]),
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      deliverEvent: async () => ({ ok: false, reason: "retries_exhausted", delivery: { attempts: 1 } }),
    })

    provider.emit(evt("evt_1"))
    await runtime.pollOnce()
    await runtime.webhookOutbox.dispatch()
    expect(store.get(sentinel.id)!.status).toBe("active")

    store.update(sentinel.id, { spec: { ...webhookSpec(), until: { kind: "at", ms: Date.now() - 1000 } } })
    await runtime.pollOnce() // the sweep lives inside every tick
    expect(store.get(sentinel.id)!.status).toBe("expired")
  })

  it("restart resume: a pending row from a crashed run is re-dispatched at start() by exact bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-resume-"))
    const outboxPath = join(dir, "sentinel-webhook-outbox.json")
    try {
      // Run 1: dispatch throws → the row survives pending, event un-acked.
      const store1 = createSentinelStore({ persist: false })
      const provider1 = createFakeSentinelProvider()
      const sentinel1 = store1.create({
        provider: "fake",
        handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
        spec: webhookSpec(),
      })
      const runtime1 = createSentinelRuntime({
        store: store1,
        registry: stubRegistry([]),
        resolveProvider: async slug => (slug === provider1.slug ? provider1 : null),
        isSessionAlive: () => true,
        restartSession: async id => id,
        outboxPath,
        deliverEvent: async () => {
          throw new Error("crash")
        },
      })
      provider1.emit(evt("evt_1"))
      await runtime1.pollOnce()
      runtime1.webhookOutbox.flushSync()
      expect(store1.isSeen(sentinel1.id, "evt_1")).toBe(false)

      // Run 2 (post-restore): fresh store+runtime over the same files.
      const store2 = createSentinelStore({ persist: false })
      const sentinel2 = store2.create({
        provider: "fake",
        handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "1" },
        spec: webhookSpec(),
      })
      const provider2 = createFakeSentinelProvider()
      const run2Deliveries: Array<Uint8Array | undefined> = []
      let attempts = 0
      const runtime2 = createSentinelRuntime({
        store: store2,
        registry: stubRegistry([]),
        resolveProvider: async slug => (slug === provider2.slug ? provider2 : null),
        isSessionAlive: () => true,
        restartSession: async id => id,
        outboxPath,
        deliverEvent: async (input: { row: { bodyBytes?: string } }) => {
          attempts++
          run2Deliveries.push(input.row.bodyBytes ? Buffer.from(input.row.bodyBytes, "base64") : undefined)
          return { ok: true, delivery: { attempts } }
        },
      })
      await runtime2.start()

      const row = runtime2.webhookOutbox.rows()[0]!
      expect(row.status).toBe("delivered")
      expect(store2.isSeen(sentinel2.id, "evt_1")).toBe(true)

      // Re-delivered bytes are BIT-IDENTICAL to the stored bytes.
      expect(Buffer.from(run2Deliveries[0]!)).toEqual(Buffer.from(row.bodyBytes, "base64"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("session-target behaviour is byte-identical to today (no regression; the webhook deliverer is never consulted)", async () => {
    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const registry: Array<SessionMessage> = []
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: {
        match: [{ subject: "fake:widget-1" }],
        until: { kind: "never" },
        target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
        provider: "fake",
      },
    })
    const runtime = createSentinelRuntime({
      store,
      registry: stubRegistry(registry),
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      deliverEvent: async () => {
        throw new Error("the webhook deliverer must never be consulted for a session target")
      },
    })
    provider.emit(evt("evt_x"))
    await runtime.pollOnce()

    expect(registry).toHaveLength(1)
    expect((registry[0]! as { correlationId?: string }).correlationId).toBe("sentinel:fake:widget-1")
    expect(store.isSeen(sentinel.id, "evt_x")).toBe(true)
    expect(runtime.webhookOutbox.rows()).toHaveLength(0)
  })

  it("rotation window: the delivery signs with BOTH secrets while now - rotatedAt < 10 min", async () => {
    const tRotation = Date.parse("2026-09-30T00:00:00Z")
    let now = tRotation

    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: webhookSpec(),
    })

    const seenReplays: Array<{ replay: DeliveryReplay; body: Uint8Array | undefined }> = []
    const runtime = createSentinelRuntime({
      store,
      registry: stubRegistry([]),
      resolveProvider: async slug => (slug === provider.slug ? provider : null),
      isSessionAlive: () => true,
      restartSession: async id => id,
      nowMs: () => now,
      deliverEvent: async (input: { replay: DeliveryReplay; row: { bodyBytes?: string } }) => {
        seenReplays.push({
          replay: input.replay,
          body: input.row.bodyBytes ? Buffer.from(input.row.bodyBytes, "base64") : undefined,
        })
        return { ok: true, delivery: { attempts: 1 } }
      },
    })

    // Pre-deliver once with the single secret.
    provider.emit(evt("evt_a"))
    await runtime.pollOnce()
    await runtime.webhookOutbox.dispatch()
    expect(seenReplays[0]!.replay.secrets).toEqual([whsecSecret])
    expect(store.isSeen(sentinel.id, "evt_a")).toBe(true)

    // Rotate: putSentinelSecret with a new secret keeps prevSecret + rotatedAt.
    const ref = (store.get(sentinel.id)!.spec.target as { secretRef: string }).secretRef
    store.putSentinelSecret(ref, { secret: whsecSecret2 })

    provider.emit(evt("evt_b"))
    now = tRotation + 60_000 // inside the 10-min window
    await runtime.pollOnce()
    await runtime.webhookOutbox.dispatch()
    expect(seenReplays.length).toBe(2)
    expect(seenReplays[1]!.replay.secrets).toEqual([whsecSecret2, whsecSecret])

    // Outside the window — only the current secret.
    provider.emit(evt("evt_c"))
    now = tRotation + 11 * 60_000
    await runtime.pollOnce()
    await runtime.webhookOutbox.dispatch()
    expect(seenReplays[2]!.replay.secrets).toEqual([whsecSecret2])

    // And the dual-sign header space: `v1,<A> v1,<B>` — distinct signatures.
    const bytes = seenReplays[1]!.body!
    const sealedA = signWebhook({ msgId: "evt_b", timestamp: tRotation + 60_000, payload: bytes, secrets: [whsecSecret2] })
    const sealedB = signWebhook({ msgId: "evt_b", timestamp: tRotation + 60_000, payload: bytes, secrets: [whsecSecret] })
    expect(sealedA["webhook-signature"]).not.toBe(sealedB["webhook-signature"])
  })
})
