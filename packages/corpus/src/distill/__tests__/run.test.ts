import { describe, it, expect, vi } from "vitest"
import { MemFs } from "../../knowledge/mem-fs.js"
import { ConversationImporter } from "../../importers/conversation.js"
import type { ConversationDoc } from "../../ports/conversation-source.port.js"
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
      enumerate: distilled => enumerateWindowRefs(source, distilled),
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
