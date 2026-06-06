import { describe, it, expect } from "vitest"
import { WebImporter } from "../web.js"
import type { FetcherPort, FetchedSource } from "../../ports/fetcher.port.js"
import type { ImportedSource, ImporterTarget } from "../types.js"

function fakeFetcher(map: Record<string, FetchedSource | null>): FetcherPort {
  return { fetch: async (url: string) => map[url] ?? null }
}

async function collect(it: AsyncIterable<ImportedSource>): Promise<ImportedSource[]> {
  const out: ImportedSource[] = []
  for await (const s of it) out.push(s)
  return out
}

const target = (config: Record<string, unknown>): ImporterTarget => ({
  importerId: "web",
  config,
})

describe("WebImporter", () => {
  it("reduces URLs to ImportedSource via the fetcher", async () => {
    const importer = new WebImporter({
      fetcher: fakeFetcher({
        "https://youtu.be/abc": {
          title: "How To Read A Job Description",
          text: "transcript body…",
          kind: "video",
          language: "en",
          via: "captions",
        },
      }),
    })
    const sources = await collect(
      importer.enumerate(target({ urls: ["https://youtu.be/abc"] }))
    )
    expect(sources).toHaveLength(1)
    const s = sources[0]!
    expect(s.originalUrl).toBe("https://youtu.be/abc")
    expect(s.title).toBe("How To Read A Job Description")
    expect(s.contentHash).toMatch(/^sha256:/)
    expect(s.language).toBe("en")
    expect(s.corpusMetadata?.fetchKind).toBe("video")
    expect(s.corpusMetadata?.fetchedVia).toBe("captions")
  })

  it("skips URLs the fetcher cannot reduce (null) and empty text", async () => {
    const importer = new WebImporter({
      fetcher: fakeFetcher({
        "https://a.com": { title: "A", text: "real", kind: "article" },
        "https://b.com": null,
        "https://c.com": { title: "C", text: "   ", kind: "article" },
      }),
    })
    const sources = await collect(
      importer.enumerate(
        target({ urls: ["https://a.com", "https://b.com", "https://c.com"] })
      )
    )
    expect(sources.map(s => s.originalUrl)).toEqual(["https://a.com"])
  })

  it("normalizes the fetched language tag to the AIP-10 shape", async () => {
    const importer = new WebImporter({
      fetcher: fakeFetcher({
        "https://us.com": { title: "US", text: "body", kind: "article", language: "en-us" },
        "https://gb.com": { title: "GB", text: "body", kind: "article", language: "EN-gb" },
        "https://name.com": { title: "Name", text: "body", kind: "article", language: "english" },
        "https://junk.com": { title: "Junk", text: "body", kind: "article", language: "c++" },
      }),
    })
    const byUrl = Object.fromEntries(
      (
        await collect(
          importer.enumerate(
            target({
              urls: [
                "https://us.com",
                "https://gb.com",
                "https://name.com",
                "https://junk.com",
              ],
            })
          )
        )
      ).map(s => [s.originalUrl, s.language])
    )
    expect(byUrl["https://us.com"]).toBe("en-US") // lowercase region → uppercase
    expect(byUrl["https://gb.com"]).toBe("en-GB") // mixed case → canonical
    expect(byUrl["https://name.com"]).toBe("en") // full name → code (Whisper path too)
    expect(byUrl["https://junk.com"]).toBeUndefined() // unparseable → omitted
  })

  it("skips a URL whose fetcher THROWS instead of aborting the whole batch", async () => {
    // A thrown fetch (transient network failure, browser-MCP disconnect)
    // must not kill every remaining URL — the importer skips it and goes on.
    const importer = new WebImporter({
      fetcher: {
        fetch: async (url: string) => {
          if (url === "https://boom.com") throw new Error("fetch failed")
          return { title: url, text: "ok", kind: "article" as const }
        },
      },
    })
    const sources = await collect(
      importer.enumerate(
        target({ urls: ["https://a.com", "https://boom.com", "https://b.com"] })
      )
    )
    expect(sources.map(s => s.originalUrl)).toEqual([
      "https://a.com",
      "https://b.com",
    ]) // boom.com skipped, batch survives
  })

  it("dedupes slugs derived from identical titles", async () => {
    const importer = new WebImporter({
      fetcher: fakeFetcher({
        "https://x.com/1": { title: "Same Title", text: "one", kind: "article" },
        "https://x.com/2": { title: "Same Title", text: "two", kind: "article" },
      }),
    })
    const sources = await collect(
      importer.enumerate(target({ urls: ["https://x.com/1", "https://x.com/2"] }))
    )
    const slugs = sources.map(s => s.slug)
    expect(new Set(slugs).size).toBe(2)
    expect(slugs[1]).toMatch(/-2$/)
  })

  it("honours maxUrls and applied tags/language fallback", async () => {
    const importer = new WebImporter({
      fetcher: fakeFetcher({
        "https://a.com": { title: "A", text: "a", kind: "article" },
        "https://b.com": { title: "B", text: "b", kind: "article" },
      }),
    })
    const sources = await collect(
      importer.enumerate(
        target({
          urls: ["https://a.com", "https://b.com"],
          maxUrls: 1,
          tags: ["recruiting"],
          language: "fr",
        })
      )
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]!.tags).toEqual(["recruiting"])
    expect(sources[0]!.language).toBe("fr")
  })

  it("throws on missing urls config", async () => {
    const importer = new WebImporter({ fetcher: fakeFetcher({}) })
    await expect(collect(importer.enumerate(target({})))).rejects.toThrow(
      /config.urls is required/
    )
  })
})
