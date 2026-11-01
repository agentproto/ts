/**
 * The pure claim-source labeler behind the `[identity]` observation of a
 * claim-only caller (ts#2165 follow-up). No I/O, no config.
 */

import { describe, expect, it } from "vitest"

import {
  bumpClaimSource,
  claimSourceKey,
  claimSourceOf,
  CLAIM_SOURCE_KEYS_MAX,
  type ClaimSource,
} from "../identity-claim-source.js"

function source(input: {
  method?: string
  userAgent?: string | string[]
  hasQueryClaim?: boolean
  hasHeaderClaim?: boolean
}): ClaimSource {
  return claimSourceOf({
    method: input.method,
    userAgent: input.userAgent,
    hasQueryClaim: input.hasQueryClaim ?? true,
    hasHeaderClaim: input.hasHeaderClaim ?? false,
  })
}

describe("claimSourceOf", () => {
  it("labels the client, verb and carrier of a claim-only request", () => {
    expect(source({ method: "GET", userAgent: "curl/8.4.0" })).toEqual({
      client: "curl",
      verb: "GET",
      carrier: "query",
    })
    expect(source({ method: "POST", userAgent: "node", hasQueryClaim: false, hasHeaderClaim: true })).toEqual({
      client: "node",
      verb: "POST",
      carrier: "header",
    })
    expect(source({ method: "POST", userAgent: "Mozilla/5.0 (X11; Linux)" })).toEqual({
      client: "mozilla",
      verb: "POST",
      carrier: "query",
    })
    expect(source({ method: "POST", userAgent: "Claude-Code/1.2 (cli)" })).toEqual({
      client: "claude-code",
      verb: "POST",
      carrier: "query",
    })
  })

  it("reads none for an absent or empty User-Agent, and the first element of an array", () => {
    expect(source({ method: "POST", userAgent: undefined })).toMatchObject({ client: "none" })
    expect(source({ method: "POST", userAgent: "" })).toMatchObject({ client: "none" })
    expect(source({ method: "POST", userAgent: ["", "curl/8.4.0"] })).toMatchObject({ client: "none" })
    expect(source({ method: "POST", userAgent: ["Claude-Code/1.2 (cli)", "curl/8.4.0"] })).toMatchObject({
      client: "claude-code",
    })
  })

  it("cleans the token and truncates it to 32 characters", () => {
    expect(source({ method: "POST", userAgent: "!!!None" })).toMatchObject({ client: "none" })
    expect(source({ method: "POST", userAgent: "!!!" })).toMatchObject({ client: "other" })
    expect(source({ method: "POST", userAgent: "a".repeat(60) })).toMatchObject({ client: "a".repeat(32) })
    expect(source({ method: "POST", userAgent: "My Agent/1.0" })).toMatchObject({ client: "my" })
  })

  it("uppercases a known method and reads other for TRACE and an absent method", () => {
    for (const verb of ["GET", "POST", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"]) {
      expect(source({ method: verb.toLowerCase(), userAgent: "curl/8.4.0" }).verb).toBe(verb)
    }
    expect(source({ method: "TRACE", userAgent: "curl/8.4.0" }).verb).toBe("other")
    expect(source({ method: undefined, userAgent: "curl/8.4.0" }).verb).toBe("other")
  })

  it("reports both carriers, the query alone and the header alone", () => {
    expect(source({ method: "GET", userAgent: "curl/8.4.0", hasQueryClaim: true, hasHeaderClaim: true }).carrier).toBe(
      "both",
    )
    expect(source({ method: "GET", userAgent: "curl/8.4.0", hasQueryClaim: true, hasHeaderClaim: false }).carrier).toBe(
      "query",
    )
    expect(source({ method: "GET", userAgent: "curl/8.4.0", hasQueryClaim: false, hasHeaderClaim: true }).carrier).toBe(
      "header",
    )
  })

  it("keys a source as '<client> <verb> <carrier>'", () => {
    expect(claimSourceKey({ client: "probe-agent", verb: "POST", carrier: "query" })).toBe(
      "probe-agent POST query",
    )
  })
})

describe("bumpClaimSource", () => {
  const make = (client: string): ClaimSource => ({ client, verb: "POST", carrier: "query" })

  it("counts per key", () => {
    const counts: Record<string, number> = {}
    bumpClaimSource(counts, make("curl"))
    bumpClaimSource(counts, make("curl"))
    bumpClaimSource(counts, make("node"))
    expect(counts).toEqual({ "curl POST query": 2, "node POST query": 1 })
  })

  it("sends the 33rd distinct key to other, keeps counting an existing key, and keeps counting other", () => {
    const counts: Record<string, number> = {}
    for (let i = 0; i < CLAIM_SOURCE_KEYS_MAX; i++) bumpClaimSource(counts, make(`client-${i}`))
    expect(Object.keys(counts)).toHaveLength(CLAIM_SOURCE_KEYS_MAX)
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(CLAIM_SOURCE_KEYS_MAX)

    bumpClaimSource(counts, make("overflow-a"))
    bumpClaimSource(counts, make("overflow-b"))
    expect(Object.keys(counts)).toHaveLength(CLAIM_SOURCE_KEYS_MAX + 1)
    expect(counts.other).toBe(2)

    bumpClaimSource(counts, make("client-0"))
    expect(counts["client-0 POST query"]).toBe(2)

    bumpClaimSource(counts, make("overflow-c"))
    expect(counts.other).toBe(3)
  })
})
