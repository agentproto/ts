/**
 * `ssrf-blocks-private` — ssrfFetch resolves the callback host and rejects
 * BEFORE any outbound connect when ANY resolved address (A or AAAA) is not
 * publicly routable. One rejected address fails; unresolvable/unparseable
 * fails closed (`connect`). No request ever leaves the process here, so no
 * HTTP-boundary mock is needed — the DNS boundary is injected instead.
 */

import { describe, expect, it } from "vitest"

import { ssrfFetch, SsrfFetchError, type SsrfResolvers } from "../../webhook-egress/ssrf-fetch.js"

function resolversFor(...addresses: Array<{ address: string; family: 4 | 6 }>): { resolvers: SsrfResolvers } {
  const lookup = async (): Promise<Array<{ address: string; family: 4 | 6 }>> => addresses
  return { resolvers: { lookup } }
}

describe("ssrf-blocks-private", () => {
  const cases: Array<[string, string, Array<{ address: string; family: 4 | 6 }>, string]> = [
    ["IPv4 loopback", "https://internal.example.com/x", [{ address: "127.0.0.1", family: 4 }], "127.0.0.1"],
    ["IPv4 RFC1918 10/8", "https://internal.example.com/x", [{ address: "10.0.0.9", family: 4 }], "10.0.0.9"],
    ["IPv4 RFC1918 172.16/12", "https://internal.example.com/x", [{ address: "172.20.3.4", family: 4 }], "172.20.3.4"],
    ["IPv4 RFC1918 192.168/16", "https://internal.example.com/x", [{ address: "192.168.1.7", family: 4 }], "192.168.1.7"],
    ["IPv4 link-local 169.254", "https://metadata.example.com/x", [{ address: "169.254.169.254", family: 4 }], "169.254.169.254"],
    ["IPv4 CGNAT 100.64/10", "https://gcp-internal.example.com/x", [{ address: "100.100.1.1", family: 4 }], "100.100.1.1"],
    ["IPv6 ::1", "https://internal6.example.net/x", [{ address: "::1", family: 6 }], "::1"],
    ["IPv6 ULA fc00::/7", "https://internal6.example.net/x", [{ address: "fd12::1", family: 6 }], "fd12::1"],
    ["IPv6 link-local fe80::/10", "https://internal6.example.net/x", [{ address: "fe80::dead", family: 6 }], "fe80::dead"],
    ["IPv6 mapped malformed", "https://internal6.example.net/x", [{ address: "::ffff:127.0.0.1", family: 6 }], "127.0.0.1 (mapped)"],
  ]

  for (const [label, url, addresses, blockedNote] of cases) {
    it(`blocks private DNS result: ${label} (${blockedNote})`, async () => {
      await expect(ssrfFetch(url, { timeoutMs: 1000 }, resolversFor(...addresses))).rejects.toMatchObject({
        reason: "private_target",
      })
    })
  }

  it("one private address among many public ones fails the WHOLE host (all must pass)", async () => {
    const io = resolversFor(
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.0.1", family: 4 },
    )
    await expect(ssrfFetch("https://mixed.example.com/", { timeoutMs: 1_000 }, io)).rejects.toMatchObject({
      reason: "private_target",
    })
  })

  it("literal private hostnames are blocked without DNS", async () => {
    await expect(ssrfFetch("https://192.168.0.1/x", { timeoutMs: 1_000 })).rejects.toMatchObject({ reason: "private_target" })
    await expect(ssrfFetch("https://10.1.2.3/y", { timeoutMs: 1_000 })).rejects.toMatchObject({ reason: "private_target" })
    void 0
  })

  it("non-https scheme is rejected before any resolution", async () => {
    await expect(
      ssrfFetch("http://attack.example.com/x", { timeoutMs: 1_000 }, resolversFor({ address: "8.8.8.8", family: 4 })),
    ).rejects.toMatchObject({ reason: "non_https" })
  })

  it("a blocked private-target error is an SsrfFetchError carrying reason private_target", async () => {
    const err = await ssrfFetch("https://internal.example.com/", { timeoutMs: 1_000 }, resolversFor({ address: "10.9.9.9", family: 4 })).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(SsrfFetchError)
    expect((err as SsrfFetchError).reason).toBe("private_target")
  })
})
