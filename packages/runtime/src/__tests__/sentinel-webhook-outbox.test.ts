/**
 * Outbox tests (plan §4 W-B task 3): row created on match, ack-after-terminal
 * (crash-loss proof — a throwing dispatch leaves the event un-acked and the
 * row pending), restart resume by exact stored bytes (I2), expiry gate
 * before dispatch, delivered reaping after 24 h. `deliverEventEnvelope` is
 * replaced through the DI boundary (not module fakes).
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createSentinelWebhookOutbox,
  toWebhookEnvelope,
  webhookRequestId,
  type PersistedOutboxRow,
  type SentinelWebhookOutbox,
} from "../sentinel-webhook-outbox.js"
import { serializeEnvelope, type DeliveryOutcome, type DeliveryReplay } from "../webhook-egress/delivery.js"
import { makeFakeEvent, type FakeSentinelProvider } from "../sentinel-providers/fake.js"

const whsecSecret = "whsec_" + Buffer.from(new Uint8Array(32).fill(5)).toString("base64")
const replay = (url = "https://callback.example/hook"): DeliveryReplay => ({
  subId: "sub_replay",
  callbackUrl: url,
  secrets: [whsecSecret],
})

function makeOutbox(opts?: {
  deliver?: (input: { replay: DeliveryReplay; row: PersistedOutboxRow }) => Promise<DeliveryOutcome>
  filePath?: string
  isExpired?: (sentinelId: string) => boolean
  nowMs?: () => number
}): { outbox: SentinelWebhookOutbox; acks: Array<{ sentinelId: string; row: PersistedOutboxRow }> } {
  const acks: Array<{ sentinelId: string; row: PersistedOutboxRow }> = []
  const outbox = createSentinelWebhookOutbox({
    ...(opts?.filePath ? { filePath: opts.filePath } : {}),
    ...(opts?.nowMs ? { nowMs: opts.nowMs } : {}),
    ...(opts?.deliver ? { deliverEvent: opts.deliver } : {}),
    secretsFor: sentinelId => replay(sentinelId),
    isExpired: opts?.isExpired ?? (() => false),
    onTerminal: (sentinelId, row) => acks.push({ sentinelId, row }),
  })
  return { outbox, acks }
}

// Secrets sidecar stand-in: each sentinel id gets the same replay config.
const secretMap = new Map<string, DeliveryReplay>()
function replay(sentinelId: string): DeliveryReplay | null {
  return secretMap.get(sentinelId) ?? null
}

const evt = makeFakeEvent({
  id: "evt_1",
  type: "fake.widget.created",
  subject: "fake:widget-1",
  summary: "Widget created",
})

describe("sentinel webhook outbox", () => {
  it("enqueue creates a persisted row with the exact byte payload + deterministic request id (I2)", async () => {
    const { outbox } = makeOutbox()
    const row = await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    expect(row).toBeDefined()
    expect(row!.sentinelId).toBe("sen_1")
    expect(row!.requestId).toBe(webhookRequestId("sen_1", "evt_1"))
    expect(row!.cursor).toBeNull()
    expect(row!.status).toBe("pending")

    // Stored bytes == the frozen envelope serialization, bit for bit.
    const bytes = Buffer.from(row!.bodyBytes, "base64")
    expect(bytes).toEqual(Buffer.from(serializeEnvelope(toWebhookEnvelope(evt))))
  })

  it("enqueue is idempotent per (sentinelId, eventId) — a redelivery never makes a second row (I1)", async () => {
    const { outbox } = makeOutbox()
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    const again = await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    expect(again).toBeUndefined()
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
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(calls).toBe(1)
    expect(outbox.rows()[0]!.status).toBe("pending")
    expect(outbox.rows()[0]!.deliveryState.lastError).toContain("crash-shaped")
    // The ack NEVER fired — the underlying sentinel event stays unmarked, so
    // a redelivery after the crash is never deduped out.
    expect(acks).toHaveLength(0)
  })

  it("ack fires exactly once when the row reaches terminal status (delivered)", async () => {
    const delivers: Array<{ replay: DeliveryReplay; row: PersistedOutboxRow }> = []
    const { outbox, acks } = makeOutbox({
      deliver: async input => {
        delivers.push(input)
        return { ok: true, delivery: { attempts: 1, lastAt: new Date().toISOString() } }
      },
    })
    secretMap.set("sen_1", replay())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(outbox.rows()[0]!.status).toBe("delivered")
    expect(outbox.rows()[0]!.deliveryState.attempts).toBeGreaterThanOrEqual(1)
    expect(acks).toHaveLength(1)
    expect(acks[0]!.sentinelId).toBe("sen_1")
    expect(acks[0]!.row.status).toBe("delivered")
    // The deliverer got the exact stored bytes + the sidecar secrets.
    expect(Buffer.from(delivers[0]!.row.bodyBytes, "base64")).toEqual(
      Buffer.from(serializeEnvelope(toWebhookEnvelope(evt))),
    )
    expect(delivers[0]!.replay.secrets).toEqual([whsecSecret])
  })

  it("a final ok:false outcome (retry cap inside deliverEventEnvelope) is terminal: dead + ack", async () => {
    const { outbox, acks } = makeOutbox({
      deliver: async () => ({ ok: false, reason: "retries_exhausted", delivery: { attempts: 5 } }),
    })
    secretMap.set("sen_1", replay())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    const row = outbox.rows()[0]!
    expect(row.status).toBe("dead")
    expect(row.deadReason).toBe("delivered_rejected")
    expect(row.failReason).toBe("retries_exhausted")
    expect(acks).toHaveLength(1)
  })

  it("restart resume: pending rows are re-dispatched by the EXACT stored bytes (no re-serialization)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-resume-"))
    const filePath = join(dir, "sentinel-webhook-outbox.json")
    try {
      // First instance: dispatch throws → row survives pending on disk.
      const first = makeOutbox({
        filePath,
        deliver: async () => {
          throw new Error("crash")
        },
      })
      secretMap.set("sen_1", replay())
      await first.outbox.enqueue({ sentinelId: "sen_1", event: evt })
      await first.outbox.dispatch()
      first.outbox.flushSync()

      // Fresh instance (sleep-0 debounce semantics, same file): resume —
      // every pending row re-dispatched by exact bytes.
      let resumedRow: PersistedOutboxRow | undefined
      const second = makeOutbox({
        filePath,
        deliver: async input => {
          resumedRow = input.row
          return { ok: true, delivery: { attempts: 2 } }
        },
      })
      await second.outbox.resumeDeliveries()

      const row = second.outbox.rows()[0]!
      expect(row.status).toBe("delivered")
      // The EXACT stored bytes — base64 comparison against the first write.
      expect(row.requestId).toBe(webhookRequestId("sen_1", "evt_1"))
      expect(row.deliveryState.attempts).toBe(2)
      expect(resumedRow!.bodyBytes).toBe(
        Buffer.from(serializeEnvelope(toWebhookEnvelope(evt))).toString("base64"),
      )
      expect(acks).toHaveLength(2) // first instance threw (0) — second resumed delivered (+1)... reset below
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("expiry gate BEFORE dispatch: an expired sentinel never delivers and the row goes dead", async () => {
    let deliverCalls = 0
    const { outbox, acks } = makeOutbox({
      isExpired: () => true,
      deliver: async () => {
        deliverCalls++
        return { ok: true, delivery: { attempts: 1 } }
      },
    })
    secretMap.set("sen_1", replay())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(deliverCalls).toBe(0) // never consulted — the expiry check PRECEDES it
    const row = outbox.rows()[0]!
    expect(row.status).toBe("dead")
    expect(row.deadReason).toBe("sentinel_expired")
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

  it("reaping: delivered rows are gone after 24 h; pending rows are not reaped", async () => {
    const t0 = Date.parse("2026-09-30T00:00:00Z")
    let now = t0
    const { outbox } = makeOutbox({
      nowMs: () => now,
      deliver: async () => ({ ok: true, delivery: { attempts: 1 } }),
    })
    secretMap.set("sen_1", replay())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.enqueue({ sentinelId: "sen_2", event: makeFakeEvent({ id: "evt_2", type: "fake.x", subject: "fake:x" }) })
    await outbox.dispatch()

    // sen_2 secrets were never set → its row went dead; sen_1 delivered.
    expect(outbox.rows()).toHaveLength(2)

    now = t0 + (24 * 60 * 60 * 1000) - 1
    outbox.sweep()
    expect(outbox.rows()).toHaveLength(2)

    now = t0 + 24 * 60 * 60 * 1000
    outbox.sweep()
    const remaining = outbox.rows()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.status).toBe("dead") // sen_2's terminal row is kept (reaping is delivered-only)
  })

  it("a terminal existing row re-fires the ack at enqueue (a lost ack from a crash is repaired)", async () => {
    const { outbox, acks } = makeOutbox({
      deliver: async () => ({ ok: true, delivery: { attempts: 1 } }),
    })
    secretMap.set("sen_1", replay())
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()
    expect(acks).toHaveLength(1)

    // Simulate: ack got lost to a crash after the transition.
    acks.length = 0
    const again = await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    expect(again).toBeUndefined()
    expect(acks).toHaveLength(1)
    expect(acks[0]!.row.status).toBe("delivered")
    // And no second dispatch row ever appeared.
    expect(outbox.rows()).toHaveLength(1)
  })
})
