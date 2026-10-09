/**
 * Delivery observability: every attempt logs one concise line (sentinel, event,
 * callback HOST only, status/error, attempt, final), `deliveryStatus` is
 * derived per sentinel for `sentinel_list`, and nothing sensitive (URL path /
 * token / body / secret) reaches a log line or the status.
 */

import { describe, expect, it } from "vitest"

import { createSentinelWebhookOutbox } from "../sentinel-webhook-outbox.js"
import { callbackHost, redactUrls, type DeliveryReplay } from "../webhook-egress/delivery.js"
import { sentinelViewWithDelivery } from "../sentinel-tools.js"
import type { Sentinel } from "../sentinel-store.js"
import { makeFakeEvent } from "../sentinel-providers/fake.js"

const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
const TOKEN = "tok_SuperSecretPathToken123"
const replay: DeliveryReplay = {
  subId: "sen_1",
  callbackUrl: `https://hooks.chatgpt.example:8443/mcp/events/${TOKEN}?k=querysecret`,
  secrets: [SECRET],
}
const evt = makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:w-1", summary: "SECRETBODYTEXT" })

type Fetch = NonNullable<NonNullable<Parameters<typeof createSentinelWebhookOutbox>[0]["deliverDeps"]>["fetch"]>

function setup(fetch: Fetch) {
  const lines: string[] = []
  const outbox = createSentinelWebhookOutbox({
    persist: false,
    deliverDeps: { fetch, sleep: async () => undefined },
    secretsFor: () => replay,
    isExpired: () => false,
    onTerminal: () => undefined,
    log: l => lines.push(l),
  })
  return { outbox, lines }
}

describe("webhook delivery observability", () => {
  it("delivered: one attempt line + final line, status delivered", async () => {
    const { outbox, lines } = setup(async () => ({ status: 200, body: "" }))
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("sentinel=sen_1 event=evt_1 host=hooks.chatgpt.example:8443 attempt=1 http=200 delivered")
    expect(lines[1]).toContain("final=delivered attempts=1")
    expect(outbox.deliveryStatus("sen_1")).toMatchObject({
      active: false,
      lastStatus: "delivered",
      attempts: 1,
      dead: 0,
    })
    expect(outbox.deliveryStatus("sen_1")?.lastError).toBeUndefined()
    expect(outbox.deliveryStatus("sen_other")).toBeUndefined()
  })

  it("retried: a 400 then a 200 logs a retry line, ends delivered with attempts=2", async () => {
    let n = 0
    const { outbox, lines } = setup(async () =>
      ++n === 1 ? { status: 400, body: "Missing MCP subscription ID" } : { status: 200, body: "" },
    )
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(lines[0]).toContain("attempt=1 http=400 retry")
    expect(lines[1]).toContain("attempt=2 http=200 delivered")
    expect(lines[2]).toContain("final=delivered attempts=2")
    expect(outbox.deliveryStatus("sen_1")).toMatchObject({ lastStatus: "delivered", attempts: 2, dead: 0 })
  })

  it("dead: persistent 400 exhausts retries; status shows dead + the HTTP reason", async () => {
    const { outbox, lines } = setup(async () => ({ status: 400, body: "Missing MCP subscription ID" }))
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()

    expect(lines.filter(l => l.includes("http=400"))).toHaveLength(5)
    expect(lines.at(-2)).toContain("attempt=5 http=400 dead")
    expect(lines.at(-1)).toContain("final=dead attempts=5 reason=retries_exhausted")
    expect(outbox.deliveryStatus("sen_1")).toMatchObject({
      active: false,
      lastStatus: "dead",
      lastError: "retryable status 400",
      attempts: 5,
      dead: 1,
    })
    expect(outbox.deliveryStatus("sen_1")?.lastDeliveryAt).toEqual(expect.any(String))
  })

  it("network errors are logged with a redacted reason; terminal 410 is dead after one attempt", async () => {
    const net = setup(async () => {
      throw new Error(`connect ECONNREFUSED to ${replay.callbackUrl}`)
    })
    await net.outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await net.outbox.dispatch()
    expect(net.lines.join("\n")).toContain('error="connect ECONNREFUSED to https://hooks.chatgpt.example:8443"')
    expect(net.outbox.deliveryStatus("sen_1")?.lastError).not.toContain(TOKEN)

    const gone = setup(async () => ({ status: 410, body: "" }))
    await gone.outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await gone.outbox.dispatch()
    expect(gone.lines.at(-1)).toContain("final=dead attempts=1 reason=http_410")
  })

  it("redaction: no URL path, query, token, body or secret in any log line or status", async () => {
    const outcomes: Fetch[] = [
      async () => ({ status: 500, body: `echo ${SECRET} SECRETBODYTEXT` }),
      async () => {
        throw new Error(`fetch failed for ${replay.callbackUrl}`)
      },
    ]
    for (const f of outcomes) {
      const { outbox, lines } = setup(f)
      await outbox.enqueue({ sentinelId: "sen_1", event: evt })
      await outbox.dispatch()
      const blob = lines.join("\n") + JSON.stringify(outbox.deliveryStatus("sen_1"))
      for (const forbidden of [TOKEN, "querysecret", "/mcp/events", SECRET, "whsec_", "SECRETBODYTEXT"]) {
        expect(blob).not.toContain(forbidden)
      }
      expect(blob).toContain("hooks.chatgpt.example:8443")
    }
  })

  it("helpers: callbackHost / redactUrls", () => {
    expect(callbackHost("https://u:p@a.example/x/y?z=1")).toBe("a.example")
    expect(callbackHost("not a url")).toBe("invalid-url")
    expect(redactUrls("boom http://a.example/p?q=1 and https://b.example/z")).toBe(
      "boom http://a.example and https://b.example",
    )
  })

  it("sentinel view carries deliveryStatus only when the outbox has a row", async () => {
    const { outbox } = setup(async () => ({ status: 200, body: "" }))
    const sentinel = {
      id: "sen_1",
      provider: "webhook",
      status: "active",
      spec: { match: [], until: { kind: "never" }, target: { kind: "webhook", url: replay.callbackUrl } },
      createdTs: 1,
      eventCount: 0,
    } as unknown as Sentinel
    expect(sentinelViewWithDelivery(sentinel, outbox.deliveryStatus("sen_1"))).not.toHaveProperty("deliveryStatus")
    await outbox.enqueue({ sentinelId: "sen_1", event: evt })
    await outbox.dispatch()
    const view = sentinelViewWithDelivery(sentinel, outbox.deliveryStatus("sen_1"))
    expect(view.deliveryStatus).toMatchObject({ lastStatus: "delivered", attempts: 1, dead: 0 })
    expect(JSON.stringify(view)).not.toContain(SECRET)
  })
})
