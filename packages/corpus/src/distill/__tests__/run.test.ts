import { describe, it, expect, vi } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { ConversationImporter } from "../../importers/conversation.js"
import { WebImporter } from "../../importers/web.js"
import type { ConversationDoc } from "../../ports/conversation-source.port.js"
import type { FetchedSource } from "../../ports/fetcher.port.js"
import { runDistill } from "../run.js"
import type { DistillDescriptor, DistillScope } from "../registry.js"
import type { DistilledItem, DistillPort } from "../types.js"
import {
  enumerateWindowRefs,
  parseWindowRef,
  windowSlug,
  type ConversationWindowSource,
} from "../windows.js"

const clock = {
  now: () => new Date("2026-06-07T00:00:00Z"),
  nowMs: () => new Date("2026-06-07T00:00:00Z").getTime(),
}

/** A windowed source over canned (thread, day) turns — no DB, no chat store. */
class FakeWindowSource implements ConversationWindowSource {
  async listThreads() {
    return [{ id: "t1" }]
  }
  async listWindows() {
    return ["2026-06-05"]
  }
  async fetchConversation(ref: string): Promise<ConversationDoc | null> {
    const parsed = parseWindowRef(ref)
    if (!parsed) return null
    return {
      id: windowSlug(parsed.threadId, parsed.day),
      title: `Conversation — ${parsed.day}`,
      turns: [
        { role: "user", text: "How do I read a job description?" },
        { role: "assistant", text: "Focus on the day-in-the-life section." },
      ],
    }
  }
}

function fakeDistiller(items: DistilledItem[]): DistillPort {
  return { distill: vi.fn(async () => items) }
}

/** Build a conversation descriptor over a fixed fs + source (shared across runs). */
function descriptorOver(
  fs: MemFs,
  source: ConversationWindowSource,
  distiller: DistillPort
): DistillDescriptor {
  return {
    id: "conversation",
    jobType: "distill:conversation",
    label: "Conversation",
    tags: ["personal", "conversation"],
    bind: () => ({
      importer: new ConversationImporter({ source }),
      async prepare(distilled) {
        const refs = await enumerateWindowRefs(source, distilled)
        return refs.length
          ? { refs, tags: ["personal", "conversation"], authority: "primary" }
          : null
      },
      provenanceId: imported =>
        (imported.corpusMetadata as { conversationId?: string } | undefined)
          ?.conversationId ?? imported.slug,
    }),
    distiller: () => distiller,
    target: async () => ({ fs, clock }),
    scopes: async () => [{ id: "u1", userId: "u1" }],
    resolveScope: async (id): Promise<DistillScope> => ({ id, userId: id }),
  }
}

describe("runDistill", () => {
  it("distills fresh windows into refined entries with provenance", async () => {
    const fs = new MemFs({})
    const distiller = fakeDistiller([
      {
        kind: "principle",
        title: "Read the day-in-the-life section first",
        body: "It reveals what the role actually does day to day.",
        confidence: 0.9,
        tags: ["recruiting"],
      },
    ])
    const descriptor = descriptorOver(fs, new FakeWindowSource(), distiller)

    const report = await runDistill(descriptor, { id: "u1", userId: "u1" })

    expect(report.descriptorId).toBe("conversation")
    expect(report.unitsConsidered).toBe(1)
    expect(report.unitsDistilled).toBe(1)
    expect(report.entriesWritten).toBe(1)
    expect(distiller.distill).toHaveBeenCalledTimes(1)

    // The entry carries the window slug as its `sources:` provenance edge.
    const written = await fs.walk("entries")
    expect(written).toHaveLength(1)
    const body = await fs.readFile(`entries/${written[0]!}`)
    expect(body).toContain("sources:")
    expect(body).toContain("t1-2026-06-05")
  })

  it("is idempotent — a re-run over the same corpus distills nothing new", async () => {
    const fs = new MemFs({})
    const distiller = fakeDistiller([
      {
        kind: "principle",
        title: "Read the day-in-the-life section first",
        body: "It reveals what the role actually does day to day.",
      },
    ])
    const descriptor = descriptorOver(fs, new FakeWindowSource(), distiller)

    await runDistill(descriptor, { id: "u1", userId: "u1" })
    const second = await runDistill(descriptor, { id: "u1", userId: "u1" })

    expect(second.unitsConsidered).toBe(0)
    expect(second.entriesWritten).toBe(0)
    expect(distiller.distill).toHaveBeenCalledTimes(1) // not called again
  })

  it("reports zero when the source has no fresh windows", async () => {
    const fs = new MemFs({})
    const empty: ConversationWindowSource = {
      listThreads: async () => [],
      listWindows: async () => [],
      fetchConversation: async () => null,
    }
    const distiller = fakeDistiller([])
    const descriptor = descriptorOver(fs, empty, distiller)

    const report = await runDistill(descriptor, { id: "u1", userId: "u1" })
    expect(report.unitsConsidered).toBe(0)
    expect(distiller.distill).not.toHaveBeenCalled()
  })
})

/**
 * Importer-agnostic check: a DIFFERENT importer (WebImporter) plugs into the
 * SAME runDistill via the binding's importer-native config (`{urls}`, not
 * `{refs}`) and a different provenance field (`originalUrl`). This is the
 * generalization the registry exists for — no per-kind code in the runner.
 */
describe("runDistill — web-style importer (urls / originalUrl provenance)", () => {
  const fakeFetcher = (pages: Record<string, FetchedSource>) => ({
    fetch: vi.fn(async (url: string) => pages[url] ?? null),
  })

  function webDescriptorOver(
    fs: MemFs,
    fetcher: { fetch: (u: string) => Promise<FetchedSource | null> },
    distiller: DistillPort,
    queue: string[]
  ): DistillDescriptor {
    return {
      id: "web",
      jobType: "distill:web",
      label: "Web",
      tags: ["web"],
      bind: () => ({
        importer: new WebImporter({ fetcher }),
        async prepare(distilled) {
          const fresh = queue.filter(u => !distilled.has(u))
          return fresh.length ? { urls: fresh, tags: ["web"] } : null
        },
        // WebImporter sets originalUrl — the stable dedup key, not the slug.
        provenanceId: imported => imported.originalUrl ?? imported.slug,
      }),
      distiller: () => distiller,
      target: async () => ({ fs, clock }),
      scopes: async () => [{ id: "g1", userId: "owner1" }],
      resolveScope: async (id): Promise<DistillScope> => ({
        id,
        userId: "owner1",
      }),
    }
  }

  it("distills queued URLs and dedups by URL on re-run", async () => {
    const fs = new MemFs({})
    const fetcher = fakeFetcher({
      "https://example.com/a": {
        title: "Pricing power",
        text: "Charge for the value delivered, not the cost incurred.",
        kind: "article",
      },
    })
    const distiller = fakeDistiller([
      {
        kind: "principle",
        title: "Price on value, not cost",
        body: "Anchor price to the buyer's outcome.",
      },
    ])
    const descriptor = webDescriptorOver(fs, fetcher, distiller, [
      "https://example.com/a",
    ])

    const first = await runDistill(descriptor, { id: "g1", userId: "owner1" })
    expect(first.entriesWritten).toBe(1)
    expect(fetcher.fetch).toHaveBeenCalledTimes(1)
    // The entry's provenance backlink is the URL.
    const written = await fs.walk("entries")
    const body = await fs.readFile(`entries/${written[0]!}`)
    expect(body).toContain("https://example.com/a")

    // Re-run: the URL is already distilled ⇒ prepare returns null, no re-fetch.
    const second = await runDistill(descriptor, { id: "g1", userId: "owner1" })
    expect(second.unitsConsidered).toBe(0)
    expect(second.entriesWritten).toBe(0)
    expect(distiller.distill).toHaveBeenCalledTimes(1)
  })
})
