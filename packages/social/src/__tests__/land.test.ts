import { describe, it, expect } from "vitest"
import type {
  BatchReport,
  CorpusImporter,
  ImporterRunner,
  ImporterTarget,
} from "@agentproto/corpus"
import { footprintToSources } from "../land/footprint-to-corpus.js"
import { footprintToGraphOps } from "../land/footprint-to-graph.js"
import { landFootprint } from "../land/land-footprint.js"
import type { GraphOp, GraphSinkPort } from "../ports/graph-sink.port.js"
import type { FootprintFile } from "../model/footprint.schema.js"
import { parseFootprintFile } from "../model/footprint.schema.js"
import type { FootprintRecord } from "../model/footprint.js"

const subject = { platform: "x", handle: "romanbuildsaas", name: "Roman" }

const records: FootprintRecord[] = [
  {
    kind: "profile",
    platform: "x",
    handle: "romanbuildsaas",
    name: "Roman",
    bio: "Building in public",
    followerCount: 12000,
    verified: true,
    profileUrl: "https://x.com/romanbuildsaas",
  },
  {
    kind: "post",
    subtype: "post",
    platform: "x",
    urn: "x:1789",
    authorHandle: "romanbuildsaas",
    text: "Ship daily. Compounding beats intensity.",
    url: "https://x.com/romanbuildsaas/status/1789",
    numLikes: 340,
    numComments: 12,
  },
  {
    kind: "engagement-given",
    platform: "x",
    actorHandle: "romanbuildsaas",
    action: "reply",
    replyText: "100% — distribution is the moat.",
    target: {
      platform: "x",
      urn: "x:999",
      authorHandle: "levelsio",
      text: "Build it and they will NOT come.",
      url: "https://x.com/levelsio/status/999",
    },
    targetAuthor: { platform: "x", handle: "levelsio", name: "Pieter" },
  },
  {
    kind: "engagement-received",
    platform: "x",
    postUrn: "x:1789",
    action: "like",
    actor: { platform: "x", handle: "fan1", name: "Fan One" },
  },
  {
    kind: "connection",
    platform: "x",
    direction: "following",
    edge: "FOLLOWS",
    person: { platform: "x", handle: "levelsio", name: "Pieter" },
  },
  {
    kind: "connection",
    platform: "x",
    direction: "follower",
    edge: "FOLLOWS",
    person: { platform: "x", handle: "fan1", name: "Fan One" },
  },
]

/** A runner that drains the importer's sources so we can assert what landed. */
function fakeRunner() {
  const seen: { sources: number; tags: string[] } = { sources: 0, tags: [] }
  const target: ImporterTarget = { importerId: "social", config: {} }
  const run = async (importer: CorpusImporter): Promise<BatchReport> => {
    const slugs: string[] = []
    for await (const s of importer.enumerate(target)) {
      seen.sources++
      slugs.push(s.slug)
      for (const t of s.tags ?? []) seen.tags.push(t)
    }
    return {
      importerId: "social",
      batchId: "2026-06-11",
      archivedSlugs: slugs,
      duplicateSlugs: [],
      candidateIds: slugs,
      warnings: [],
    }
  }
  return { runner: { run } as unknown as ImporterRunner, seen }
}

function fakeGraph() {
  const ops: GraphOp[] = []
  const sink: GraphSinkPort = {
    apply: async (op) => {
      ops.push(op)
    },
  }
  return { sink, ops }
}

const file: FootprintFile = parseFootprintFile({
  schemaVersion: "1.0.0",
  capturedAt: "2026-06-11T00:00:00.000Z",
  subject: { platform: "x", handle: "romanbuildsaas" },
  profile: {
    kind: "profile",
    platform: "x",
    handle: "romanbuildsaas",
    name: "Roman",
    profileUrl: "https://x.com/romanbuildsaas",
  },
  records,
})

describe("landFootprint", () => {
  it("fans the footprint into both sinks when both are given", async () => {
    const { runner, seen } = fakeRunner()
    const { sink, ops } = fakeGraph()
    const res = await landFootprint(file, { corpus: { runner }, graph: sink })

    // corpus: the two voice units land; the platform tags the sources.
    expect(res.corpus).toEqual({
      archived: 2,
      duplicates: 0,
      candidates: 2,
      warnings: [],
    })
    expect(seen.sources).toBe(2)
    expect(seen.tags).toContain("x")

    // graph: the network merges idempotently; every op applied.
    expect(res.graph).toEqual({ applied: ops.length, failed: 0 })
    expect(ops.map((o) => o.op)).toContain("person")
    expect(res.subject).toEqual({ platform: "x", handle: "romanbuildsaas" })
  })

  it("skips the graph at zero cost when no graph port is given", async () => {
    const { runner } = fakeRunner()
    const res = await landFootprint(file, { corpus: { runner } })
    expect(res.corpus?.archived).toBe(2)
    expect(res.graph).toBeUndefined()
  })

  it("derives the subject from the profile when none is stamped", async () => {
    const { sink } = fakeGraph()
    const legacy = parseFootprintFile({ profile: file.profile, records })
    const res = await landFootprint(legacy, { graph: sink })
    expect(res.subject).toEqual({ platform: "x", handle: "romanbuildsaas" })
  })
})

describe("footprintToSources", () => {
  it("emits one source per voice unit (post + reply), skips non-voice", () => {
    const sources = footprintToSources(records, {
      handle: "romanbuildsaas",
      profileUrl: "https://x.com/romanbuildsaas",
    })
    expect(sources).toHaveLength(2)
    expect(sources.every((s) => s.authority === "primary")).toBe(true)
    // stable slug from urn id
    expect(sources[0]!.slug).toContain("1789")
    expect(sources[0]!.body).toContain("Compounding beats intensity")
    expect(sources[1]!.body).toContain("distribution is the moat")
    // tags carry platform + handle + slice subtype
    expect(sources[0]!.tags).toContain("romanbuildsaas")
    expect(sources[0]!.tags).toContain("x")
  })

  it("is deterministic — same input, same hashes", () => {
    const a = footprintToSources(records, { handle: "romanbuildsaas" })
    const b = footprintToSources(records, { handle: "romanbuildsaas" })
    expect(a.map((s) => s.contentHash)).toEqual(b.map((s) => s.contentHash))
  })

  it("renders attached media (image inline, video linked)", () => {
    const withMedia: FootprintRecord[] = [
      {
        kind: "post",
        subtype: "post",
        platform: "x",
        urn: "x:2001",
        authorHandle: "romanbuildsaas",
        text: "launch day",
        url: "https://x.com/romanbuildsaas/status/2001",
        media: [
          { type: "image", url: "https://pbs.twimg.com/a.jpg", alt: "the dashboard" },
          { type: "video", url: "https://video.twimg.com/b.mp4", durationMs: 30000 },
        ],
      },
    ]
    const [src] = footprintToSources(withMedia, { handle: "romanbuildsaas" })
    expect(src!.body).toContain("![the dashboard](https://pbs.twimg.com/a.jpg)")
    expect(src!.body).toContain("https://video.twimg.com/b.mp4")
    expect(src!.body).toMatch(/video \(30s\)/)
  })

  it("embeds the quoted post inside a quote-tweet source", () => {
    const withQuote: FootprintRecord[] = [
      {
        kind: "post",
        subtype: "quote",
        platform: "x",
        urn: "x:3001",
        authorHandle: "romanbuildsaas",
        text: "this is the way",
        url: "https://x.com/romanbuildsaas/status/3001",
        quotedUrn: "x:3000",
        quoted: {
          platform: "x",
          urn: "x:3000",
          authorHandle: "levelsio",
          text: "distribution > product",
          url: "https://x.com/levelsio/status/3000",
        },
      },
    ]
    const [src] = footprintToSources(withQuote, { handle: "romanbuildsaas" })
    expect(src!.body).toContain("this is the way")
    expect(src!.body).toContain("Quoting @levelsio:")
    expect(src!.body).toContain("distribution > product")
  })
})

describe("footprintToGraphOps", () => {
  it("maps every slice to idempotent ops", () => {
    const ops = footprintToGraphOps(records, subject)
    const kinds = ops.map((o) => o.op)
    expect(kinds).toContain("person")
    expect(kinds).toContain("post")
    expect(kinds).toContain("engagement")
    expect(kinds.filter((k) => k === "edge")).toHaveLength(2)
  })

  it("orients connection edges relative to the subject", () => {
    const ops = footprintToGraphOps(records, subject)
    const edges = ops.filter((o): o is Extract<typeof o, { op: "edge" }> => o.op === "edge")
    const following = edges.find((e) => e.to.handle === "levelsio")
    const follower = edges.find((e) => e.from.handle === "fan1")
    expect(following?.from.handle).toBe("romanbuildsaas") // subject FOLLOWS levelsio
    expect(follower?.to.handle).toBe("romanbuildsaas") // fan1 FOLLOWS subject
  })

  it("records the subject's reply as a comment on the target post", () => {
    const ops = footprintToGraphOps(records, subject)
    const eng = ops.filter((o): o is Extract<typeof o, { op: "engagement" }> => o.op === "engagement")
    const replyEng = eng.find((e) => e.engagement.post.urn === "x:999")
    expect(replyEng?.engagement.comments?.[0]?.handle).toBe("romanbuildsaas")
    expect(replyEng?.engagement.comments?.[0]?.text).toContain("distribution is the moat")
  })

  it("projects profile experience into WORKS_AT employment ops, deduped per company", () => {
    const withExp = [
      {
        kind: "profile" as const,
        platform: "linkedin",
        handle: "alex",
        name: "Alex Rivera",
        experience: [
          { company: "Stripe", title: "Staff Engineer", start: "2025", current: true },
          { company: "Google", title: "Senior Engineer", start: "2019", end: "2020" },
          { company: "google", title: "Engineer", start: "2017", end: "2019" },
        ],
      },
    ]
    const ops = footprintToGraphOps(withExp, {
      platform: "linkedin",
      handle: "alex",
      name: "Alex Rivera",
    })
    const emp = ops.filter((o): o is Extract<typeof o, { op: "employment" }> => o.op === "employment")
    // two distinct companies (the two Google stints collapse by normalized name)
    expect(emp).toHaveLength(2)
    const current = emp.find((e) => e.company.name === "Stripe")
    expect(current?.current).toBe(true)
    expect(current?.person.handle).toBe("alex")
    // the most-recent Google role wins the single collapsed edge
    expect(emp.find((e) => /google/i.test(e.company.name))?.title).toBe("Senior Engineer")
  })
})
