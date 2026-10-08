import { describe, expect, it, vi } from "vitest"
import { createDeliveryHandler, type McpEventEnvelope } from "../receiver.js"
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
