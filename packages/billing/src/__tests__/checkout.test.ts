import { describe, expect, it } from "vitest"
import { assertReturnUrl } from "../return-url.js"
import { FakeSettlementProvider } from "../testing/index.js"

const req = (successUrl: string, cancelUrl = "https://app.example.com/cancel") => ({
  offerId: "pack-20",
  owner: { orgId: "acme" },
  accountId: "acme",
  successUrl,
  cancelUrl,
})

describe("SET-10: return URLs of checkout and portal", () => {
  it("a checkout with a return URL outside the list is refused before any call", async () => {
    const p = new FakeSettlementProvider("whsec-test", "fake", { allowedReturnOrigins: ["https://app.example.com"] })
    await expect(p.createCheckout!(req("https://evil.example.net/ok"))).rejects.toThrow(/return URL/)
    await expect(p.createCheckout!(req("https://app.example.com/ok", "https://app.example.com.evil.example.net/"))).rejects.toThrow(/return URL/)
    expect(p.checkouts).toHaveLength(0)
    const ok = await p.createCheckout!(req("https://app.example.com/ok"))
    expect(ok.outcome).toBe("redirect")
    expect(p.checkouts).toHaveLength(1)
  })

  it("a portal session with a return URL outside the list is refused before any call", async () => {
    const p = new FakeSettlementProvider("whsec-test", "fake", { allowedReturnOrigins: ["https://app.example.com"] })
    await expect(p.createPortalSession!({ owner: { orgId: "acme" }, accountId: "acme", returnUrl: "javascript:alert(1)" })).rejects.toThrow(/return URL/)
    expect(p.portals).toHaveLength(0)
    expect((await p.createPortalSession!({ owner: { orgId: "acme" }, accountId: "acme", returnUrl: "https://app.example.com/account" })).url).toMatch(/^https:/)
  })
})

describe("assertReturnUrl", () => {
  const allowed = ["https://app.example.com", "http://localhost:3000"]
  it("accepts an URL whose origin is listed, exactly", () => {
    expect(assertReturnUrl("https://app.example.com/a?b=1", allowed)).toBe("https://app.example.com/a?b=1")
    expect(assertReturnUrl("http://localhost:3000/x", allowed)).toBe("http://localhost:3000/x")
  })
  it("refuses another origin, a look-alike host, another scheme or port, a relative or unparsable URL", () => {
    for (const bad of [
      "https://evil.example.net/",
      "https://app.example.com.evil.example.net/",
      "https://user@evil.example.net/",
      "http://app.example.com/",
      "https://app.example.com:8443/",
      "/relative",
      "javascript:alert(1)",
      "not a url",
    ]) expect(() => assertReturnUrl(bad, allowed), bad).toThrow(/return URL/)
  })
  it("refuses everything when the list is empty", () => {
    expect(() => assertReturnUrl("https://app.example.com/", [])).toThrow(/return URL/)
  })
})
