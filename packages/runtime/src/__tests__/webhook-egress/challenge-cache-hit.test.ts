/**
 * `challenge-cache-hit` — a verified (principal, normalized URL, secret)
 * pair is served from the bounded 10-min cache: the second verify issues NO
 * outbound POST and still resolves ok.
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  verifyCallback,
  challengeCacheSize,
  challengeCacheHits,
  resetChallengeCacheForTests,
  type SsrfFetchArgs,
  type SsrfFetchView,
} from "../../webhook-egress/challenge.js"
import { encodeWhsecSecret } from "../../webhook-egress/signing.js"

afterEach(() => {
  resetChallengeCacheForTests()
})

describe("challenge-cache-hit", () => {
  const secret = encodeWhsecSecret(new TextEncoder().encode("cache-hit-key-0123456789abcdef01"))

  it("second identical verify resolves from cache — one network call total", async () => {
    let httpCalls = 0
    const fetcher = async (_url: string, init: SsrfFetchArgs): Promise<SsrfFetchView> => {
      httpCalls += 1
      return { status: 200, body: JSON.stringify({ challenge: (JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array())) as { challenge: string }).challenge }) }
    }
    const input = { principal: "daemon-bearer", url: "https://subscriber.example.com/hook", subscriptionId: "sub_c", secret }

    const first = await verifyCallback(input, { fetch: fetcher })
    expect(first.ok).toBe(true)
    expect(httpCalls).toBe(1)
    expect(challengeCacheSize()).toBe(1)
    const stats = challengeCacheHits()
    expect(stats.hits).toBe(0)
    expect(stats.missed).toBe(1)

    const second = await verifyCallback(input, { fetch: fetcher })
    expect(second.ok).toBe(true)
    expect(httpCalls).toBe(1) // no second HTTP hop
    // the cached verificationBytes are the SAME bytes (stable, I2)
    expect(Buffer.from(second.ok ? second.verificationBytes : new Uint8Array()).equals(Buffer.from(first.ok ? first.verificationBytes : new Uint8Array()))).toBe(true)
    expect(challengeCacheHits().hits).toBe(1)
  })

  it("cache key honors the URL normalization: default-port and case variants hit the same entry", async () => {
    let httpCalls = 0
    const fetcher = async (_url: string, init: SsrfFetchArgs): Promise<SsrfFetchView> => {
      httpCalls += 1
      return { status: 200, body: JSON.stringify({ challenge: (JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array())) as { challenge: string }).challenge }) }
    }
    const base = { principal: "p", subscriptionId: "sub_c", secret }
    await verifyCallback({ ...base, url: "https://SUB.Example.com:443/hook?x=1" }, { fetch: fetcher })
    await verifyCallback({ ...base, url: "https://sub.example.com/hook?x=1" }, { fetch: fetcher })
    expect(httpCalls).toBe(1)
    expect(challengeCacheSize()).toBe(1)
  })

  it("a DIFFERENT principal does NOT share the cache entry (two http calls)", async () => {
    let httpCalls = 0
    const fetcher = async (_url: string, init: SsrfFetchArgs): Promise<SsrfFetchView> => {
      httpCalls += 1
      return { status: 200, body: JSON.stringify({ challenge: (JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array())) as { challenge: string }).challenge }) }
    }
    const base = { subscriptionId: "sub_c", secret }
    await verifyCallback({ ...base, principal: "p1", url: "https://shared.example.com/h" }, { fetch: fetcher })
    await verifyCallback({ ...base, principal: "p2", url: "https://shared.example.com/h" }, { fetch: fetcher })
    expect(httpCalls).toBe(2)
  })

  it("FAILURES are never cached — a failing verify re-issues HTTP every time", async () => {
    let httpCalls = 0
    const fetcher = async (): Promise<SsrfFetchView> => {
      httpCalls += 1
      return { status: 500, body: "" }
    }
    const input = { principal: "p", url: "https://fail.example.com/h", subscriptionId: "sub_c", secret }
    await verifyCallback(input, { fetch: fetcher })
    await verifyCallback(input, { fetch: fetcher })
    expect(httpCalls).toBe(2)
    expect(challengeCacheSize()).toBe(0)
  })
})
