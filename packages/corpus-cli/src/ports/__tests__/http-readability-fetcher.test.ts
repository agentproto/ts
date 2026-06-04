import { describe, it, expect, vi, afterEach } from "vitest"
import { HttpReadabilityFetcher } from "../http-readability-fetcher.adapter.js"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(opts: { status?: number; ct?: string; body?: string }) {
  globalThis.fetch = vi.fn<typeof fetch>(async () =>
    new Response(opts.body ?? "", {
      status: opts.status ?? 200,
      headers: { "content-type": opts.ct ?? "text/html; charset=utf-8" },
    })
  )
}

describe("HttpReadabilityFetcher", () => {
  it("extracts title + article text from HTML", async () => {
    mockFetch({
      body: `<html lang="en"><head><title>23 Recruiting Metrics &amp; KPIs</title></head>
        <body><nav>menu junk</nav><article><h1>Metrics</h1><p>Time to hire matters.</p>
        <script>tracking()</script></article><footer>foot junk</footer></body></html>`,
    })
    const out = await new HttpReadabilityFetcher().fetch("https://www.aihr.com/blog/recruiting-metrics/")
    expect(out?.kind).toBe("article")
    expect(out?.via).toBe("readability")
    expect(out?.title).toBe("23 Recruiting Metrics & KPIs")
    expect(out?.language).toBe("en")
    expect(out?.text).toContain("Time to hire matters.")
    expect(out?.text).not.toContain("tracking()") // scripts stripped
    expect(out?.text).not.toContain("menu junk") // nav stripped (article-scoped)
  })

  it("returns null for non-HTML content", async () => {
    mockFetch({ ct: "application/json", body: "{}" })
    expect(await new HttpReadabilityFetcher().fetch("https://x.com/data.json")).toBeNull()
  })

  it("returns null on non-OK responses", async () => {
    mockFetch({ status: 403, body: "denied" })
    expect(await new HttpReadabilityFetcher().fetch("https://x.com")).toBeNull()
  })

  it("refuses video-host URLs (never scrape a watch page) without fetching", async () => {
    const spy = vi.fn<typeof fetch>()
    globalThis.fetch = spy
    expect(
      await new HttpReadabilityFetcher().fetch("https://www.youtube.com/watch?v=abc")
    ).toBeNull()
    expect(spy).not.toHaveBeenCalled() // short-circuits before any network
  })
})
