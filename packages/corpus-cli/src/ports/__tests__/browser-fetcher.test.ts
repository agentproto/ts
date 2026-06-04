import { describe, it, expect, vi } from "vitest"
import {
  BrowserMcpFetcher,
  type BrowserMcpLike,
} from "../browser-fetcher.adapter.js"

/** Fake browser MCP: records calls, returns canned evaluate results. */
function fakeBrowser(evaluateReturn: {
  content?: unknown
  structuredContent?: unknown
}): { browser: BrowserMcpLike; calls: Array<{ name: string; arguments: Record<string, unknown> }> } {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const browser: BrowserMcpLike = {
    callTool: vi.fn(async args => {
      calls.push(args)
      if (args.name === "navigate_page") return { content: "ok" }
      return evaluateReturn
    }),
  }
  return { browser, calls }
}

describe("BrowserMcpFetcher (readability-only)", () => {
  it("navigates then evaluates readability, parsing structuredContent", async () => {
    const { browser, calls } = fakeBrowser({
      structuredContent: {
        title: "An Article",
        text: "the readable body",
        kind: "article",
        language: "en",
        via: "readability",
      },
    })
    const out = await new BrowserMcpFetcher({ browser }).fetch(
      "https://www.aihr.com/blog/recruiting-metrics/"
    )
    expect(calls[0]!.name).toBe("navigate_page")
    expect(calls[1]!.name).toBe("evaluate_script")
    // always the readability function — no YouTube/captions branch anymore
    expect(String(calls[1]!.arguments.function)).toContain("innerText")
    expect(out?.kind).toBe("article")
    expect(out?.text).toBe("the readable body")
    expect(out?.via).toBe("readability")
  })

  it("parses a JSON-string content block too", async () => {
    const { browser } = fakeBrowser({
      content: [
        { type: "text", text: JSON.stringify({ title: "X", text: "y", kind: "article" }) },
      ],
    })
    const out = await new BrowserMcpFetcher({ browser }).fetch("https://example.com/post")
    expect(out?.title).toBe("X")
    expect(out?.text).toBe("y")
  })

  it("returns null when the page yields empty text", async () => {
    const { browser } = fakeBrowser({
      structuredContent: { title: "Empty", text: "", kind: "article" },
    })
    const out = await new BrowserMcpFetcher({ browser }).fetch("https://example.com/empty")
    expect(out).toBeNull()
  })
})
