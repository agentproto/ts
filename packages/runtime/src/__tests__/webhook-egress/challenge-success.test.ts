/**
 * `challenge-success` — verifyCallback issues the frozen POST: body
 * `{"type":"verification","challenge":"<fresh 64-hex>"}`, headers
 * `webhook-id: msg_verification_<rand>`, `webhook-timestamp`,
 * `webhook-signature` (signed with the CANDIDATE secret),
 * `X-MCP-Subscription-Id`; 2xx + echo → ok:true with the exact bytes.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"

import { verifyCallback, resetChallengeCacheForTests, type SsrfFetchArgs, type SsrfFetchView } from "../../webhook-egress/challenge.js"
import { decodeWhsecSecret } from "../../webhook-egress/signing.js"

afterEach(() => {
  resetChallengeCacheForTests()
})

describe("challenge-success", () => {
  const secret = "whsec_" + Buffer.from("ch-success-key-0123456789abcd012", "utf8").toString("base64")

  it("2xx + echo → ok:true with verificationBytes", async () => {
    let seenBody: string = ""
    const outcome = await verifyCallback(
      { principal: "p", url: "https://chatgpt.example.com/hooks", subscriptionId: "sub_1", secret },
      {
        fetch: async (_url: string, init: SsrfFetchArgs): Promise<SsrfFetchView> => {
          seenBody = new TextDecoder().decode(init.body ?? new Uint8Array())
          return { status: 200, body: JSON.stringify({ challenge: (JSON.parse(seenBody) as { challenge: string }).challenge }) }
        },
      },
    )
    expect(outcome.ok).toBe(true)
    const body = JSON.parse(new TextDecoder().decode(outcome.ok ? outcome.verificationBytes : new Uint8Array())) as {
      type: string
      challenge: string
    }
    expect(body.type).toBe("verification")
    expect(body.challenge).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(seenBody).challenge).toBe(body.challenge)
  })

  it("carries all the frozen headers, including X-MCP-Subscription-Id, signed with the CANDIDATE secret", async () => {
    let captured: SsrfFetchArgs | undefined
    const outcome = await verifyCallback(
      { principal: "p", url: "https://echo.example.com/c", subscriptionId: "sub_headers", secret },
      {
        fetch: async (_url, init) => {
          captured = init
          return { status: 200, body: JSON.stringify({ challenge: (JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array())) as { challenge: string }).challenge }) }
        },
      },
    )
    expect(outcome.ok).toBe(true)
    expect(captured).toBeDefined()
    const headers = (captured as SsrfFetchArgs).headers as Record<string, string>
    expect(headers["webhook-id"]).toMatch(/^msg_verification_[0-9a-f]+$/)
    expect(headers["webhook-timestamp"]).toMatch(/^\d+$/)
    expect(headers["X-MCP-Subscription-Id"]).toBe("sub_headers")
    // recompute the candidate-secret signature independently
    const key = decodeWhsecSecret(secret) as Buffer
    const bodyBytes = Buffer.from((captured as SsrfFetchArgs).body ?? new Uint8Array())
    const expected = `v1,${createHmac("sha256", key).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.`, "utf8").update(bodyBytes).digest("base64")}`
    expect(headers["webhook-signature"]).toBe(expected)
  })

  it("each call produces a FRESH 64-hex challenge (no reuse)", async () => {
    const seen: string[] = []
    const outcome = await verifyCallback(
      { principal: "p", url: "https://fresh.example.com/", subscriptionId: "s", secret },
      {
        fetch: async (_url, init) => {
          seen.push((JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array())) as { challenge: string }).challenge)
          return { status: 500, body: "" } // fail both, we only read the fresh challenge
        },
      },
    )
    expect(outcome.ok).toBe(false)
    // second attempt (cache never stores failures → another fetch)
    await verifyCallback(
      { principal: "p", url: "https://fresh.example.com/", subscriptionId: "s", secret },
      {
        fetch: async (_url, init) => {
          seen.push((JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array())) as { challenge: string }).challenge)
          return { status: 500, body: "" }
        },
      },
    )
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    for (const c of seen) expect(c).toMatch(/^[0-9a-f]{64}$/)
  })
})
