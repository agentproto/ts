import { describe, it, expect, vi } from "vitest"
import { ScrapeMcpFetcher } from "../scrape-mcp-fetcher.adapter.js"
import type { BrowserMcpLike } from "../browser-fetcher.adapter.js"

const fakeClient = (
  reply: { content?: unknown; structuredContent?: unknown; isError?: boolean } | Error
): BrowserMcpLike => ({
  callTool: vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return reply
  }),
})

describe("ScrapeMcpFetcher", () => {
  it("maps a purified scrape result (title + markdown) to a FetchedSource", async () => {
    const f = new ScrapeMcpFetcher({
      client: fakeClient({
        structuredContent: {
          title: "Brand Positioning 101",
          markdown: "# Brand Positioning 101\n\nPositioning is the space you own.",
          tierUsed: "camofox",
          language: "en",
        },
      }),
    })
    const out = await f.fetch("https://blog.example.com/post")
    expect(out?.kind).toBe("article")
    expect(out?.title).toBe("Brand Positioning 101")
    expect(out?.text).toContain("space you own")
    expect(out?.language).toBe("en")
    expect(out?.via).toBe("scrape:camofox") // surfaces the tier for provenance
  })

  it("reads the payload from a JSON text block when structuredContent is absent", async () => {
    const f = new ScrapeMcpFetcher({
      client: fakeClient({
        content: [
          { type: "text", text: JSON.stringify({ title: "T", markdown: "body text here" }) },
        ],
      }),
    })
    const out = await f.fetch("https://example.com/a")
    expect(out?.title).toBe("T")
    expect(out?.text).toBe("body text here")
  })

  it("strips tags as a last resort when the server returns only raw html", async () => {
    const f = new ScrapeMcpFetcher({
      client: fakeClient({
        structuredContent: { html: "<article><h1>Hi</h1><p>Body</p></article>" },
      }),
    })
    const out = await f.fetch("https://example.com/raw")
    expect(out?.text).toBe("Hi Body")
  })

  it("returns null for a video URL (transcription fetcher owns it)", async () => {
    const client = fakeClient({ structuredContent: { markdown: "x" } })
    const f = new ScrapeMcpFetcher({ client })
    expect(await f.fetch("https://www.youtube.com/watch?v=abc")).toBeNull()
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it("returns null on an empty/blocked page, isError, or a transport throw", async () => {
    expect(
      await new ScrapeMcpFetcher({
        client: fakeClient({ structuredContent: { markdown: "   " } }),
      }).fetch("https://example.com/blocked")
    ).toBeNull()
    expect(
      await new ScrapeMcpFetcher({
        client: fakeClient({ isError: true, content: [] }),
      }).fetch("https://example.com/err")
    ).toBeNull()
    expect(
      await new ScrapeMcpFetcher({
        client: fakeClient(new Error("fetch failed")),
      }).fetch("https://example.com/boom")
    ).toBeNull()
  })
})
