import { describe, expect, it, vi } from "vitest"
import { Readable } from "node:stream"
import { BodyTooLargeError, createDeliveryHandler, readCappedBody, type McpEventEnvelope } from "../receiver.js"
import { generateSecret, signWebhook } from "../webhook.js"

const secret = generateSecret()
const NOW = 1_800_000_000

function signed(payload: unknown, opts: { id?: string; subscription?: string; sign?: string } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload)
  const id = opts.id ?? "evt_1"
  const headers: Record<string, string> = {
    "webhook-id": id,
    "webhook-timestamp": String(NOW),
    "webhook-signature": signWebhook(opts.sign ?? secret, id, String(NOW), body),
    "x-mcp-subscription-id": opts.subscription ?? "sub_1",
  }
  return { headers, body }
}

const event = (eventId: string): McpEventEnvelope => ({ eventId, name: "github.pull_request.closed", data: { summary: "PR closed" } })

function setup() {
  const onEvent = vi.fn<(e: McpEventEnvelope, sub: string) => Promise<void>>(async () => {})
  const handle = createDeliveryHandler({ secret, onEvent, nowSeconds: () => NOW })
  return { onEvent, handle }
}

describe("delivery handler", () => {
  it("answers the subscribe-time challenge with the same value", async () => {
    const { handle, onEvent } = setup()
    const result = await handle(signed({ challenge: "abc123" }))
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body ?? "{}")).toEqual({ challenge: "abc123" })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("rejects unsigned, wrongly signed and stale traffic before it can reach the session", async () => {
    const { handle, onEvent } = setup()
    expect((await handle({ headers: {}, body: JSON.stringify(event("evt_1")) })).status).toBe(401)
    expect((await handle(signed(event("evt_1"), { sign: generateSecret() }))).status).toBe(401)
    const stale = createDeliveryHandler({ secret, onEvent, nowSeconds: () => NOW + 10_000 })
    expect((await stale(signed(event("evt_1")))).status).toBe(401)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("rejects a signed body that is not an event envelope", async () => {
    const { handle, onEvent } = setup()
    expect((await handle(signed("not json"))).status).toBe(400)
    expect((await handle(signed([1, 2]))).status).toBe(400)
    expect((await handle(signed({ name: "x" }))).status).toBe(400)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("pushes a new event once with its subscription id", async () => {
    const { handle, onEvent } = setup()
    const result = await handle(signed(event("evt_1"), { subscription: "sub_9" }))
    expect(result.status).toBe(200)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0]?.[1]).toBe("sub_9")
  })

  it("acks a redelivery without pushing the event to the session again", async () => {
    const { handle, onEvent } = setup()
    await handle(signed(event("evt_1")))
    const again = await handle(signed(event("evt_1")))
    expect(again.status).toBe(200)
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it("returns 500 when the push fails so the daemon retries, and accepts the retry", async () => {
    const { handle, onEvent } = setup()
    onEvent.mockRejectedValueOnce(new Error("transport closed"))
    expect((await handle(signed(event("evt_1")))).status).toBe(500)
    expect((await handle(signed(event("evt_1")))).status).toBe(200)
    expect(onEvent).toHaveBeenCalledTimes(2)
  })
})

describe("delivery handler: concurrency and bounds", () => {
  it("pushes once when two copies of the same event arrive while the first is still being pushed", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const onEvent = vi.fn<(e: McpEventEnvelope, sub: string) => Promise<void>>(() => gate)
    const handle = createDeliveryHandler({ secret, onEvent, nowSeconds: () => NOW })
    const first = handle(signed(event("evt_1")))
    const second = handle(signed(event("evt_1")))
    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it("a concurrent duplicate shares the first copy's failure, and the retry then succeeds", async () => {
    const onEvent = vi.fn<(e: McpEventEnvelope, sub: string) => Promise<void>>()
    onEvent.mockRejectedValueOnce(new Error("transport closed"))
    const handle = createDeliveryHandler({ secret, onEvent, nowSeconds: () => NOW })
    const [a, b] = await Promise.all([handle(signed(event("evt_1"))), handle(signed(event("evt_1")))])
    expect([a.status, b.status]).toEqual([500, 500])
    expect((await handle(signed(event("evt_1")))).status).toBe(200)
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it("remembers only the most recent event ids (bounded memory)", async () => {
    const onEvent = vi.fn<(e: McpEventEnvelope, sub: string) => Promise<void>>(async () => {})
    const handle = createDeliveryHandler({ secret, onEvent, nowSeconds: () => NOW, maxSeen: 2 })
    for (const id of ["evt_1", "evt_2", "evt_3"]) await handle(signed(event(id)))
    expect(onEvent).toHaveBeenCalledTimes(3)
    await handle(signed(event("evt_3")))
    expect(onEvent).toHaveBeenCalledTimes(3) // recent id still deduped
    await handle(signed(event("evt_1")))
    expect(onEvent).toHaveBeenCalledTimes(4) // evicted id is no longer remembered
  })
})

describe("readCappedBody", () => {
  it("returns the body when it is within the limit, whatever the chunking", async () => {
    expect(await readCappedBody(Readable.from([Buffer.from("he"), "llo"]), 5)).toBe("hello")
  })

  it("fails as soon as the limit is exceeded", async () => {
    await expect(readCappedBody(Readable.from([Buffer.alloc(4), Buffer.alloc(4)]), 5)).rejects.toBeInstanceOf(BodyTooLargeError)
  })
})
