/**
 * `challenge-new-secret-bypasses-cache` — the cache key embeds
 * sha256(secret): during rotation a NEW secret can NEVER resolve a cached
 * entry from the old one — a fresh challenge POST is always issued, and the
 * old entry stays independent. The cache can never bless an unverified
 * secret.
 */

import { afterEach, describe, expect, it } from "vitest"

import {
  verifyCallback,
  challengeCacheSize,
  resetChallengeCacheForTests,
  type SsrfFetchArgs,
  type SsrfFetchView,
} from "../../webhook-egress/challenge.js"
import { encodeWhsecSecret } from "../../webhook-egress/signing.js"

afterEach(() => {
  resetChallengeCacheForTests()
})


function hdr(h: Record<string, string>, key: string): string {
  const v = h[key]
  if (v === undefined) throw new Error(`missing ${key} header`)
  return v
}

describe("challenge-new-secret-bypasses-cache", () => {
  const secrets = {
    old: encodeWhsecSecret(new TextEncoder().encode("rotation-old-key-0123456789abcd")),
    fresh: encodeWhsecSecret(new TextEncoder().encode("rotation-new-key-0123456789abcd")),
  }

  it("a new secret forces a fresh challenge POST even though the old one is cached for the same URL", async () => {
    let httpCalls = 0
    const fetcher = async (_url: string, init: SsrfFetchArgs): Promise<SsrfFetchView> => {
      httpCalls += 1
      return { status: 200, body: JSON.stringify({ challenge: (JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array())) as { challenge: string }).challenge }) }
    }
    const base = { principal: "p", url: "https://sub.example.com/hook", subscriptionId: "sub_rot" }

    const first = await verifyCallback({ ...base, secret: secrets.old }, { fetch: fetcher })
    expect(first.ok).toBe(true)
    expect(httpCalls).toBe(1)

    // NEW secret during rotation — no cache blessing, fresh POST.
    const second = await verifyCallback({ ...base, secret: secrets.fresh }, { fetch: fetcher })
    expect(second.ok).toBe(true)
    expect(httpCalls).toBe(2)
    expect(challengeCacheSize()).toBe(2) // both entries coexist

    // And the old secret still hits ITS cache entry — no new POST.
    const third = await verifyCallback({ ...base, secret: secrets.old }, { fetch: fetcher })
    expect(third.ok).toBe(true)
    expect(httpCalls).toBe(2)
    expect(challengeCacheSize()).toBe(2)
  })

  it("the fresh POST for the new secret is signed with THE NEW secret — the cache stays structurally un-blessing", async () => {
    const signatures: string[] = []
    const fetcher = async (_url: string, init: SsrfFetchArgs): Promise<SsrfFetchView> => {
      signatures.push(hdr(init.headers as Record<string, string>, "webhook-signature"))
      return { status: 200, body: JSON.stringify(JSON.parse(new TextDecoder().decode(init.body ?? new Uint8Array()))) }
    }
    const base = { principal: "p", url: "https://sub.example.com/hook2", subscriptionId: "sub_rot2" }
    await verifyCallback({ ...base, secret: secrets.old }, { fetch: fetcher })
    const second = await verifyCallback({ ...base, secret: secrets.fresh }, { fetch: fetcher })
    expect(second.ok).toBe(true)
    expect(signatures).toHaveLength(2) // the second verify REACHED the wire (cache bypassed)
    if (signatures[0] === undefined || signatures[1] === undefined) throw new Error("expected two signatures")
    expect(signatures[0]).not.toBe(signatures[1]) // re-signed with the NEW key material
    expect(challengeCacheSize()).toBe(2)
  })
})
