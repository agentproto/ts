import { describe, it, expect } from "vitest"
import { ConversationImporter } from "../conversation.js"
import type {
  ConversationDoc,
  ConversationSourcePort,
} from "../../ports/conversation-source.port.js"
import type { ImportedSource, ImporterTarget } from "../types.js"

function fakeSource(
  map: Record<string, ConversationDoc | null>
): ConversationSourcePort {
  return { fetchConversation: async (ref: string) => map[ref] ?? null }
}

async function collect(
  it: AsyncIterable<ImportedSource>
): Promise<ImportedSource[]> {
  const out: ImportedSource[] = []
  for await (const s of it) out.push(s)
  return out
}

const target = (config: Record<string, unknown>): ImporterTarget => ({
  importerId: "conversation",
  config,
})

describe("ConversationImporter", () => {
  it("renders a conversation to a transcript ImportedSource", async () => {
    const importer = new ConversationImporter({
      source: fakeSource({
        "thread-1": {
          id: "thread-1-2026-06-06",
          title: "Sleep troubles",
          language: "en",
          turns: [
            { role: "user", text: "I can't sleep before 2am", at: "2026-06-06T01:00:00Z" },
            { role: "assistant", text: "How much caffeine do you have?", at: "2026-06-06T01:00:05Z" },
            { role: "user", text: "Three coffees, last one at 6pm" },
          ],
        },
      }),
    })
    const sources = await collect(
      importer.enumerate(target({ refs: ["thread-1"] }))
    )
    expect(sources).toHaveLength(1)
    const s = sources[0]!
    expect(s.slug).toBe("thread-1-2026-06-06") // slug from the windowed doc id
    expect(s.title).toBe("Sleep troubles")
    expect(s.contentHash).toMatch(/^sha256:/)
    expect(s.language).toBe("en")
    expect(s.body).toContain("User: I can't sleep before 2am")
    expect(s.body).toContain("Assistant: How much caffeine do you have?")
    expect(s.corpusMetadata?.conversationRef).toBe("thread-1")
    expect(s.corpusMetadata?.conversationId).toBe("thread-1-2026-06-06")
    expect(s.corpusMetadata?.sourceKind).toBe("conversation")
    expect(s.corpusMetadata?.turnCount).toBe(3)
    expect(s.corpusMetadata?.firstTurnAt).toBe("2026-06-06T01:00:00Z")
    expect(s.corpusMetadata?.lastTurnAt).toBe("2026-06-06T01:00:05Z")
  })

  it("skips refs the port returns null for, and docs with no usable turns", async () => {
    const importer = new ConversationImporter({
      source: fakeSource({
        a: { id: "a", turns: [{ role: "user", text: "real" }] },
        b: null,
        c: { id: "c", turns: [{ role: "user", text: "   " }] }, // all-empty text
        d: { id: "d", turns: [] }, // no turns
      }),
    })
    const sources = await collect(
      importer.enumerate(target({ refs: ["a", "b", "c", "d"] }))
    )
    expect(sources.map(s => s.corpusMetadata?.conversationId)).toEqual(["a"])
  })

  it("skips a ref whose port THROWS instead of aborting the batch", async () => {
    // A thrown fetch (store unreachable, auth) must not kill every remaining
    // ref — the importer skips it and goes on.
    const importer = new ConversationImporter({
      source: {
        fetchConversation: async (ref: string) => {
          if (ref === "boom") throw new Error("store unreachable")
          return { id: ref, turns: [{ role: "user", text: "ok" }] }
        },
      },
    })
    const sources = await collect(
      importer.enumerate(target({ refs: ["a", "boom", "b"] }))
    )
    expect(sources.map(s => s.corpusMetadata?.conversationId)).toEqual([
      "a",
      "b",
    ]) // boom skipped, batch survives
  })

  it("disambiguates slugs when two windows share a doc id", async () => {
    const importer = new ConversationImporter({
      source: fakeSource({
        r1: { id: "same", turns: [{ role: "user", text: "one" }] },
        r2: { id: "same", turns: [{ role: "user", text: "two" }] },
      }),
    })
    const sources = await collect(
      importer.enumerate(target({ refs: ["r1", "r2"] }))
    )
    const slugs = sources.map(s => s.slug)
    expect(new Set(slugs).size).toBe(2)
    expect(slugs[1]).toMatch(/-2$/)
  })

  it("honours maxRefs and applies tags + language fallback + authority", async () => {
    const importer = new ConversationImporter({
      source: fakeSource({
        a: { id: "a", turns: [{ role: "user", text: "a" }] },
        b: { id: "b", turns: [{ role: "user", text: "b" }] },
      }),
    })
    const sources = await collect(
      importer.enumerate(
        target({
          refs: ["a", "b"],
          maxRefs: 1,
          tags: ["personal", "sleep"],
          language: "fr",
          authority: "primary",
        })
      )
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]!.tags).toEqual(["personal", "sleep"])
    expect(sources[0]!.language).toBe("fr")
    expect(sources[0]!.authority).toBe("primary")
  })

  it("defaults authority to secondary", async () => {
    const importer = new ConversationImporter({
      source: fakeSource({
        a: { id: "a", turns: [{ role: "user", text: "a" }] },
      }),
    })
    const sources = await collect(importer.enumerate(target({ refs: ["a"] })))
    expect(sources[0]!.authority).toBe("secondary")
  })

  it("throws on missing refs config", async () => {
    const importer = new ConversationImporter({ source: fakeSource({}) })
    await expect(collect(importer.enumerate(target({})))).rejects.toThrow(
      /config.refs is required/
    )
  })
})
