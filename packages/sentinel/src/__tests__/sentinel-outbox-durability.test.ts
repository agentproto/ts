/**
 * Phase 0a — the webhook outbox enqueue is crash-durable and awaited.
 *
 * `enqueue` resolves only after the row is on disk (tmp → fsync → rename →
 * dir fsync); callers ack Agentpush / answer push 2xx on that resolve. A
 * persistence failure rejects, rolls the row back, and leaves nothing for a
 * later dispatch to act on.
 */

import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSentinelWebhookOutbox, type PersistedOutboxRow } from "../sentinel-webhook-outbox.js"
import { writeFileDurable } from "../durable-file.js"
import { makeFakeEvent } from "../sentinel-providers/fake.js"
import type { DeliveryOutcome, DeliveryReplay } from "../webhook-egress/delivery.js"

const whsec = "whsec_" + Buffer.from(new Uint8Array(32).fill(5)).toString("base64")
const replay = (): DeliveryReplay => ({ subId: "sub_x", callbackUrl: "https://cb.example/hook", secrets: [whsec] })

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "outbox-dur-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const event = (id: string) => makeFakeEvent({ id, type: "fake.widget.created", subject: "fake:w-1" })

function mk(filePath: string, over: { deliver?: () => Promise<DeliveryOutcome> } = {}) {
  const dispatched: string[] = []
  const outbox = createSentinelWebhookOutbox({
    filePath,
    // A debounce far longer than the test: any durability observed below can
    // only come from the awaited enqueue itself.
    debounceMs: 60_000,
    log: () => {},
    deliverEvent: async ({ row }) => {
      dispatched.push(row.eventId)
      return (
        (await over.deliver?.()) ?? { ok: true, delivery: { attempts: 1, lastAt: new Date().toISOString() } }
      )
    },
    secretsFor: () => replay(),
    isExpired: () => false,
    onTerminal: () => {},
  })
  return { outbox, dispatched }
}

describe("outbox enqueue durability", () => {
  it("the row is on disk by the time enqueue resolves (no debounce wait)", async () => {
    const file = join(tmp(), "outbox.json")
    const { outbox } = mk(file, { deliver: () => new Promise(() => {}) })
    await outbox.enqueue({ sentinelId: "sen_1", event: event("evt_1") })

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, PersistedOutboxRow>
    const rows = Object.values(onDisk)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ eventId: "evt_1", status: "pending" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("crash right after enqueue (before any debounced flush) loses nothing: a fresh outbox resumes the row", async () => {
    const file = join(tmp(), "outbox.json")
    const first = mk(file, { deliver: () => new Promise(() => {}) })
    await first.outbox.enqueue({ sentinelId: "sen_1", event: event("evt_crash") })
    // "Crash": the first instance is abandoned — no flushSync, no timer fired.

    const second = mk(file)
    await second.outbox.dispatch()
    expect(second.dispatched).toEqual(["evt_crash"])
  })

  it("leaves no tmp files behind", async () => {
    const dir = tmp()
    const { outbox } = mk(join(dir, "outbox.json"), { deliver: () => new Promise(() => {}) })
    await outbox.enqueue({ sentinelId: "sen_1", event: event("evt_1") })
    await outbox.enqueue({ sentinelId: "sen_1", event: event("evt_2") })
    expect(readdirSync(dir).filter(f => f.includes(".tmp."))).toEqual([])
  })

  it("a persistence failure rejects enqueue, rolls the row back and dispatches nothing", async () => {
    const dir = tmp()
    // The parent "directory" is a regular file, so mkdir/rename must fail.
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x")
    const { outbox, dispatched } = mk(join(blocker, "outbox.json"))

    await expect(outbox.enqueue({ sentinelId: "sen_1", event: event("evt_1") })).rejects.toThrow()
    await outbox.dispatch()
    expect(dispatched).toEqual([])
    // Rolled back: the same event can be enqueued again once storage recovers.
    rmSync(blocker)
    expect(await outbox.enqueue({ sentinelId: "sen_1", event: event("evt_1") })).toBeDefined()
  })

  it("a duplicate enqueue of a pending event waits for the original write before resolving", async () => {
    const file = join(tmp(), "outbox.json")
    const { outbox } = mk(file, { deliver: () => new Promise(() => {}) })
    const a = outbox.enqueue({ sentinelId: "sen_1", event: event("evt_dup") })
    const b = outbox.enqueue({ sentinelId: "sen_1", event: event("evt_dup") })
    await expect(b).resolves.toBeUndefined()
    // By the time the duplicate resolves the row is already on disk.
    expect(Object.values(JSON.parse(readFileSync(file, "utf8")) as object)).toHaveLength(1)
    await expect(a).resolves.toMatchObject({ eventId: "evt_dup" })
  })

  it("flushSync still wins over an in-flight async write (newer snapshot is never overwritten)", async () => {
    const file = join(tmp(), "outbox.json")
    const { outbox } = mk(file, { deliver: () => new Promise(() => {}) })
    await outbox.enqueue({ sentinelId: "sen_1", event: event("evt_1") })
    outbox.flushSync()
    expect(Object.values(JSON.parse(readFileSync(file, "utf8")) as object)).toHaveLength(1)
  })
})

describe("writeFileDurable", () => {
  it("abandons the write when commitIf says no, leaving the target untouched", async () => {
    const dir = tmp()
    const file = join(dir, "f.json")
    writeFileSync(file, "old")
    await writeFileDurable(file, "new", { commitIf: () => false })
    expect(readFileSync(file, "utf8")).toBe("old")
    expect(existsSync(`${file}.tmp.${process.pid}.1`)).toBe(false)
    expect(readdirSync(dir).filter(f => f.includes(".tmp."))).toEqual([])
  })
})
