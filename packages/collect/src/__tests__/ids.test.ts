import { describe, expect, it } from "vitest"
import { canonicalUrl, itemId, sha256Hex, itemIdFromUrl, normalizeText, textFingerprint } from "../ids"

describe("canonicalUrl", () => {
  it("drops tracking params, keeps real ones sorted", () => {
    expect(canonicalUrl("https://Example.com/a?utm_source=x&b=2&fbclid=z&a=1&gclid=q&ref=hn&si=9")).toBe(
      "https://example.com/a?a=1&b=2&ref=hn",
    )
  })
  it("drops mailing and social tracking ids", () => {
    expect(canonicalUrl("https://example.com/p?mc_cid=1&mc_eid=2&ref_src=tw&igshid=3&id=7")).toBe(
      "https://example.com/p?id=7",
    )
  })
  it("drops the fragment", () => {
    expect(canonicalUrl("https://example.com/a#section-2")).toBe("https://example.com/a")
  })
  it("strips default ports only", () => {
    expect(canonicalUrl("https://example.com:443/a")).toBe("https://example.com/a")
    expect(canonicalUrl("http://example.com:80/a")).toBe("http://example.com/a")
    expect(canonicalUrl("https://example.com:8443/a")).toBe("https://example.com:8443/a")
  })
  it("treats trailing slash consistently", () => {
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com")
    expect(canonicalUrl("https://example.com")).toBe("https://example.com")
    expect(canonicalUrl("https://example.com/a/")).toBe("https://example.com/a")
    expect(canonicalUrl("https://example.com/a/?b=1")).toBe("https://example.com/a?b=1")
  })
  it("is idempotent", () => {
    const once = canonicalUrl("HTTPS://Example.com:443/a/?utm_medium=m&z=1&y=2#f")
    expect(canonicalUrl(once)).toBe(once)
  })
  it("keeps ref (it can carry meaning) but drops ref_src and ref_url", () => {
    expect(canonicalUrl("https://example.com/tree?ref=main&ref_src=tw&ref_url=u")).toBe(
      "https://example.com/tree?ref=main",
    )
  })
  it("lowercases scheme and host only, never the path", () => {
    expect(canonicalUrl("HTTPS://Example.COM/Some/Mixed/Path?Q=Val")).toBe("https://example.com/Some/Mixed/Path?Q=Val")
  })
  it("normalises IDN hosts to punycode", () => {
    expect(canonicalUrl("https://BÜCHER.example/a")).toBe("https://xn--bcher-kva.example/a")
  })
  it("strips an explicit :80 on http", () => {
    expect(canonicalUrl("http://example.com:80/a")).toBe("http://example.com/a")
  })
  it("ignores parameter order", () => {
    expect(canonicalUrl("https://example.com/a?b=2&a=1")).toBe(canonicalUrl("https://example.com/a?a=1&b=2"))
  })
  it("keeps the order of repeated keys, so different value orders differ", () => {
    expect(canonicalUrl("https://example.com/a?a=2&a=1")).toBe("https://example.com/a?a=2&a=1")
    expect(canonicalUrl("https://example.com/a?a=2&a=1")).not.toBe(canonicalUrl("https://example.com/a?a=1&a=2"))
    expect(canonicalUrl("https://example.com/a?z=1&a=2&a=1&b=0")).toBe("https://example.com/a?a=2&a=1&b=0&z=1")
  })
  it("leaves non-http(s) schemes and malformed input trimmed and unchanged", () => {
    expect(canonicalUrl(" mailto:Someone@Example.com?subject=Hi#x ")).toBe("mailto:Someone@Example.com?subject=Hi#x")
    expect(canonicalUrl("urn:isbn:0451450523")).toBe("urn:isbn:0451450523")
    expect(canonicalUrl("data:text/plain;base64,SGk=")).toBe("data:text/plain;base64,SGk=")
    expect(canonicalUrl("//example.com/a")).toBe("//example.com/a")
  })
  it("returns non-URLs trimmed", () => {
    expect(canonicalUrl("  not a url ")).toBe("not a url")
  })
})

describe("ids", () => {
  it("builds source:nativeId", () => {
    expect(itemId("hackernews", "41234567")).toBe("hackernews:41234567")
    expect(itemId("x", 2121375309287301360n.toString())).toBe("x:2121375309287301360")
  })
  it("hashes the canonical URL when there is no native id", async () => {
    const a = await itemIdFromUrl("web", "https://example.com/a?utm_source=x#top")
    const b = await itemIdFromUrl("web", "https://EXAMPLE.com/a/")
    expect(a).toBe(b)
    expect(a).toMatch(/^web:[0-9a-f]{64}$/)
    expect(a).not.toBe(await itemIdFromUrl("web", "https://example.com/b"))
    // sha256("https://example.com/a")
    expect(a).toBe(`web:${await sha256Hex("https://example.com/a")}`)
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
  it("rejects unsafe numeric native ids and keeps strings as given", () => {
    expect(() => itemId("x", 2121375309287301360)).toThrow(RangeError)
    expect(() => itemId("x", 1.5)).toThrow(RangeError)
    expect(itemId("x", 42)).toBe("x:42")
    expect(itemId("x", "2121375309287301360")).toBe("x:2121375309287301360")
  })
})

describe("textFingerprint", () => {
  it("ignores case, whitespace and punctuation", async () => {
    const a = await textFingerprint("Hello,   World!\n")
    const b = await textFingerprint("hello world")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
  it("gives no content id to text that normalises to nothing", async () => {
    expect(await textFingerprint("")).toBeUndefined()
    expect(await textFingerprint("  ... !!! \n")).toBeUndefined()
  })
  it("differs for different words", async () => {
    expect(await textFingerprint("hello world")).not.toBe(await textFingerprint("hello there"))
  })
  it("matches a known SHA-256", async () => {
    // sha256("abc")
    expect(await textFingerprint("ABC")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(normalizeText("A  b\tC.")).toBe("a b c")
  })
})
