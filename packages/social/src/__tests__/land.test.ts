import { describe, it, expect } from "vitest"
import { footprintToSources } from "../land/footprint-to-corpus.js"
import { footprintToGraphOps } from "../land/footprint-to-graph.js"
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
        handle: "mathilde",
        name: "Mathilde Dugué",
        experience: [
          { company: "ANINE BING", title: "Group Manager", start: "2025", current: true },
          { company: "The Kooples", title: "Chef de Groupe", start: "2019", end: "2020" },
          { company: "the kooples", title: "Chef de Produit", start: "2017", end: "2019" },
        ],
      },
    ]
    const ops = footprintToGraphOps(withExp, {
      platform: "linkedin",
      handle: "mathilde",
      name: "Mathilde Dugué",
    })
    const emp = ops.filter((o): o is Extract<typeof o, { op: "employment" }> => o.op === "employment")
    // two distinct companies (the two Kooples stints collapse by normalized name)
    expect(emp).toHaveLength(2)
    const anine = emp.find((e) => e.company.name === "ANINE BING")
    expect(anine?.current).toBe(true)
    expect(anine?.person.handle).toBe("mathilde")
    // the most-recent Kooples role wins the single edge
    expect(emp.find((e) => /kooples/i.test(e.company.name))?.title).toBe("Chef de Groupe")
  })
})
