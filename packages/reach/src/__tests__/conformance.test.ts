import { createHmac, timingSafeEqual } from "node:crypto"
import { describe, expect, it } from "vitest"

import { buildSignedReachRequest, runReachConformance } from "../conformance.js"

const SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64")

/** The receiver side: Standard Webhooks verification, written independently. */
function verify(req: Request, body: string): boolean {
  const id = req.headers.get("webhook-id") ?? ""
  const ts = req.headers.get("webhook-timestamp") ?? ""
  const sig = req.headers.get("webhook-signature") ?? ""
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64")
  const expected = Buffer.from("v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64"))
  const got = Buffer.from(sig)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

function receiver(answer: (seen: boolean) => Response) {
  const seen = new Set<string>()
  return async (req: Request): Promise<Response> => {
    const text = await req.text()
    if (!verify(req, text)) return new Response("bad signature", { status: 401 })
    const body = JSON.parse(text) as { message: { dedupeKey: string } }
    const dup = seen.has(body.message.dedupeKey)
    seen.add(body.message.dedupeKey)
    return answer(dup)
  }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

describe("runReachConformance", () => {
  it("passes a receiver that verifies, answers a receipt and dedupes", async () => {
    const result = await runReachConformance(receiver(dup => json({ status: dup ? "deduped" : "delivered" })), { secret: SECRET })
    expect(result.checks.map(c => c.ok)).toEqual([true, true])
    expect(result.ok).toBe(true)
  })

  it("passes a receiver that answers the same receipt twice", async () => {
    const result = await runReachConformance(receiver(() => json({ status: "deferred", until: "2026-11-13T08:00:00Z" })), {
      secret: SECRET,
    })
    expect(result.ok).toBe(true)
  })

  it("passes a receiver whose receipt carries extra keys", async () => {
    const result = await runReachConformance(
      receiver(dup => json({ status: dup ? "deduped" : "delivered", messageId: "m1", traceId: "t1" })),
      { secret: SECRET },
    )
    expect(result.checks.map(c => c.ok)).toEqual([true, true])
    expect(result.ok).toBe(true)
  })

  it("fails a receiver that answers a bare 200 with no receipt", async () => {
    const result = await runReachConformance(receiver(() => new Response(null, { status: 200 })), { secret: SECRET })
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.ok).toBe(false)
    expect(result.checks[0]!.detail).toMatch(/without a valid receipt/)
  })

  it("fails a receiver that answers a different receipt the second time", async () => {
    const result = await runReachConformance(receiver(dup => json(dup ? { status: "failed", reason: "x" } : { status: "delivered" })), {
      secret: SECRET,
    })
    expect(result.ok).toBe(false)
    expect(result.checks[1]!.ok).toBe(false)
  })

  it("fails a receiver signed with another secret (non-2xx)", async () => {
    const other = "whsec_" + Buffer.alloc(32, 9).toString("base64")
    const result = await runReachConformance(receiver(() => json({ status: "delivered" })), { secret: other })
    expect(result.ok).toBe(false)
    expect(result.checks[0]!.detail).toBe("HTTP 401")
  })

  it("signs the exact body it sends", async () => {
    const req = await buildSignedReachRequest("https://r.invalid/", SECRET, { type: "close", dedupeKey: "k", outcome: "approved" })
    const text = await req.clone().text()
    expect(verify(req, text)).toBe(true)
    expect(JSON.parse(text)).toEqual({ type: "close", dedupeKey: "k", outcome: "approved" })
  })
})
