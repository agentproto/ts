/**
 * Outbox tests (plan §4 W-B task 3): row created with exact stored bytes,
 * ack-after-terminal (crash-loss proof), restart resume by exact bytes,
 * expiry gate before dispatch, delivered reaping after 24h. The POST
 * boundary is the DI hook (never module fakes, never real network).
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSentinelWebhookOutbox,
  toWebhookEnvelope,
  webhookRequestId,
  type PersistedOutboxRow,
} from "../sentinel-webhook-outbox.js"
import { serializeEnvelope, type DeliveryOutcome, type DeliveryReplay } from "../webhook-egress/delivery.js"
import { makeFakeEvent } from "../sentinel-providers/fake.js"

const whsecSecret = "whsec_" + Buffer.from(new Uint8Array(32).fill(5)).toString("base64")
const replayOf = (): DeliveryReplay => ({
  subId: "sub_replay",
  callbackUrl: "https://callback.example/hook",
  secrets: [whsecSecret],
})
const secretMap = new Map<string, DeliveryReplay>()

interface Opts {
  deliver?: (input: { replay: DeliveryReplay; row: PersistedOutboxRow }) => Promise<DeliveryOutcome>
  filePath?: string
  isExpired?: (sentinelId: string) => boolean
  nowMs?: () => number
}

function makeOutbox(opts: Opts = {}) {
  const acks: Array<{ sentinelId: string; row: PersistedOutboxRow }> = []
  const outbox = createSentinelWebhookOutbox({
    ...(opts.filePath ? { filePath: opts.filePath } : {}),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    deliverEvent:
      opts.deliver ??
      (async () => ({ ok: true, delivery: { attempts: 1, lastAt: new Date().toISOString() } })),
    secretsFor: sentinelId => secretMap.get(sentinelId) ?? null,
    isExpired: opts.isExpired ?? (() => false),
    onTerminal: (sentinelId, row) => acks.push({ sentinelId, row }),
  })
  return { outbox, acks }
}

const evt = makeFakeEvent({
  id: "evt_1",
  type: "fake.widget.created",
  subject: "fake:widget-1",
  summary: "Widget created",
})

describe("sentinel webhook outbox", () => {
  it("row created on match: exact stored bytes + deterministic request id (I2/I1)", async () => {
    const { outbox, acks } = makeOutbox()
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(outbox.rows()).toHaveLength(1)
    const row = outbox.rows()[0]!
    expect(row.requestId).toBe(webhookRequestId("sen_1", "evt_1"))
    expect(row.cursor).toBeNull()
    expect(row.status).toBe("delivered")
    expect(Buffer.from(row.bodyBytes, "base64")).toEqual(Buffer.from(serializeEnvelope(toWebhookEnvelope(evt))))
    expect(acks).toHaveLength(1)
  })

  it("enqueue is idempotent per (sentinelId, eventId) — a redelivery never makes a second row (I1)", async () => {
    const { outbox } = makeOutbox()
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()
    const again = await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    expect(again).toBeUndefined()
    await outbox.dispatch()
    expect(outbox.rows()).toHaveLength(1)
  })

  it("ack-after-terminal (crash-loss proof): a THROWN dispatch leaves the row pending and the event UN-acked", async () => {
    let calls = 0
    const { outbox, acks } = makeOutbox({
      deliver: async () => {
        calls++
        throw new Error("connection reset mid-POST (crash-shaped)")
      },
    })
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(calls).toBeGreaterThanOrEqual(1) // the enqueue kick + the explicit drain each retry it in-flight
    expect(outbox.rows()[0]!.status).toBe("pending")
    expect(outbox.rows()[0]!.deliveryState.lastError).toContain("crash-shaped")
    // NO ack — the underlying sentinel event is never marked seen on failure.
    expect(acks).toHaveLength(0)
  })

  it("ack fires exactly once when the row reaches terminal status (delivered)", async () => {
    const { outbox, acks } = makeOutbox()
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    const row = outbox.rows()[0]!
    expect(row.status).toBe("delivered")
    expect(row.deliveryState.attempts).toBeGreaterThanOrEqual(1)
    expect(acks).toHaveLength(1)
    expect(acks[0]!.sentinelId).toBe("sen_1")
  })

  it("a final ok:false outcome (deliverEventEnvelope's bounded retry cap) is terminal: dead + ack", async () => {
    const { outbox, acks } = makeOutbox({
      deliver: async () => ({ ok: false, reason: "retries_exhausted", delivery: { attempts: 5 } }),
    })
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    const row = outbox.rows()[0]!
    expect(row.status).toBe("dead")
    expect(row.deadReason).toBe("delivered_rejected")
    expect(row.failReason).toBe("retries_exhausted")
    expect(acks).toHaveLength(1)
  })

  it("restart resume: the pending row is re-dispatched by the EXACT stored bytes (no re-serialization)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-resume-"))
    const filePath = join(dir, "sentinel-webhook-outbox.json")
    try {
      // Instance 1: dispatch throws → pending row survives on disk.
      const firstAcks: Array<{ sentinelId: string }> = []
      const outbox1 = createSentinelWebhookOutbox({
        filePath,
        deliverEvent: async () => {
          throw new Error("crash")
        },
        secretsFor: () => replayOf(),
        isExpired: () => false,
        onTerminal: sentinelId => firstAcks.push({ sentinelId }),
      })
      await outbox1.enqueue({ sentinelId: "sen_1", event: evt })
      await outbox1.dispatch()
      outbox1.flushSync()
      expect(firstAcks).toHaveLength(0)

      // Instance 2 (post-restart): re-persisted state drives the resume.
      const secondAcks: Array<{ sentinelId: string }> = []
      const resumedBytes: Array<string> = []
      const outbox2 = createSentinelWebhookOutbox({
        filePath,
        deliverEvent: async input => {
          resumedBytes.push(input.row.bodyBytes)
          return { ok: true, delivery: { attempts: 2 } }
        },
        secretsFor: () => replayOf(),
        isExpired: () => false,
        onTerminal: (sentinelId, row) => secondAcks.push({ sentinelId, row }),
      })
      await outbox2.resumeDeliveries()

      const row = outbox2.rows()[0]!
      expect(row.status).toBe("delivered")
      expect(row.requestId).toBe(webhookRequestId("sen_1", "evt_1"))
      expect(row.deliveryState.attempts).toBeGreaterThanOrEqual(2)
      expect(row.terminalAt).toBeDefined()
      // EXACT bytes — bit-for-bit vs the persisted file's stored bodyBytes.
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, { bodyBytes: string }>
      const persisted = Object.values(raw)[0]!
      expect(Buffer.from(persisted.bodyBytes, "base64")).toEqual(
        Buffer.from(serializeEnvelope(toWebhookEnvelope(evt))),
      )
      expect(resumedBytes).toHaveLength(1)
      expect(Buffer.from(resumedBytes[0]!, "base64")).toEqual(Buffer.from(persisted.bodyBytes, "base64"))
      expect(secondAcks).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("expiry gate BEFORE dispatch: an expired sentinel never delivers; the row goes dead + ack", async () => {
    let deliverCalls = 0
    const { outbox, acks } = makeOutbox({
      isExpired: () => true,
      deliver: async () => {
        deliverCalls++
        return { ok: true, delivery: { attempts: 1 } }
      },
    })
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(deliverCalls).toBe(0)
    expect(outbox.rows()[0]!.status).toBe("dead")
    expect(outbox.rows()[0]!.deadReason).toBe("sentinel_expired")
    expect(acks).toHaveLength(1)
  })

  it("a sentinel with no secrets sidecar row is dead (sentinel_removed), never lost silently", async () => {
    let deliverCalls = 0
    const { outbox, acks } = makeOutbox({
      deliver: async () => {
        deliverCalls++
        return { ok: true, delivery: { attempts: 1 } }
      },
    })
    secretMap.delete("sen_2")
    await outbox.enqueue({ sentinelId: "sen_2", event: evt })
    await outbox.dispatch()

    expect(deliverCalls).toBe(0)
    expect(outbox.rows()[0]!.status).toBe("dead")
    expect(outbox.rows()[0]!.deadReason).toBe("sentinel_removed")
    expect(acks).toHaveLength(1)
  })

  it("reaping: delivered rows are gone after 24 h; dead rows stay", async () => {
    const t0 = Date.parse("2026-09-30T00:00:00Z")
    let now = t0
    const { outbox } = makeOutbox({ nowMs: () => now })
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.enqueue({
      sentinelId: "sen_2",
      event: makeFakeEvent({ id: "evt_2", type: "fake.x", subject: "fake:x" }),
    })
    await outbox.dispatch() // sen_2: no sidecar row → dead(sentinel_removed)

    expect(outbox.rows()).toHaveLength(2)

    now = t0 + 24 * 60 * 60 * 1000
    outbox.sweep()
    const rows = outbox.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe("dead") // delivered-only reaping keeps the dead row
  })

  it("a terminal existing row re-fires the ack at enqueue (a crash-lost ack is repaired)", async () => {
    const { outbox, acks } = makeOutbox()
    secretMap.set("sen_1", replayOf())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()
    expect(acks).toHaveLength(1)

    // Simulate a lost ack: the ack log empty, but the row IS terminal.
    acks.length = 0
    const again = await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    expect(again).toBeUndefined()
    expect(acks).toHaveLength(1)
    expect(acks[0]!.row.status).toBe("delivered")
    expect(outbox.rows()).toHaveLength(1)
  })
})
