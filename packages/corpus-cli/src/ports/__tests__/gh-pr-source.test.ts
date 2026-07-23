import { describe, it, expect } from "vitest"
import {
  GhPrSourceAdapter,
  buildDiffSummary,
  toReviewComments,
  type GhRunner,
} from "../gh-pr-source.adapter.js"
import type { PrDoc, PrQuery } from "@agentproto/corpus"

/**
 * A scripted `gh` runner: matches on the subcommand shape and returns canned
 * JSON. Records every argv for assertion. No binary, no network.
 */
function fakeGh(
  responses: {
    list?: unknown
    view?: Record<number, unknown>
  }
): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: GhRunner = async (args) => {
    calls.push([...args])
    if (args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(responses.list ?? [])
    }
    if (args[0] === "pr" && args[1] === "view") {
      const n = Number(args[2])
      const doc = responses.view?.[n]
      if (doc === undefined) throw new Error(`no fake view for #${n}`)
      return JSON.stringify(doc)
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  return { run, calls }
}

async function collect(adapter: GhPrSourceAdapter, query: PrQuery): Promise<PrDoc[]> {
  const out: PrDoc[] = []
  for await (const d of adapter.listPullRequests(query)) out.push(d)
  return out
}

describe("GhPrSourceAdapter", () => {
  it("lists then views PRs, shaping full PrDocs", async () => {
    const { run, calls } = fakeGh({
      list: [{ number: 42 }, { number: 7 }],
      view: {
        7: {
          number: 7,
          title: "older pr",
          body: "first change",
          author: { login: "alice" },
          url: "https://github.com/o/r/pull/7",
          state: "MERGED",
          mergedAt: "2026-05-01T00:00:00Z",
          reviews: [{ author: { login: "bob" }, body: "nit: rename", submittedAt: "2026-05-01T01:00:00Z" }],
          comments: [{ author: { login: "alice" }, body: "fixed", createdAt: "2026-05-01T02:00:00Z" }],
          reviewRequests: [{ login: "carol" }],
        },
        42: {
          number: 42,
          title: "newer pr",
          body: "second change",
          author: { login: "alice" },
          state: "OPEN",
        },
      },
    })
    const adapter = new GhPrSourceAdapter({ run })
    const docs = await collect(adapter, { repo: "o/r" })

    // Listed newest-first by gh; adapter imports oldest-first.
    expect(docs.map(d => d.number)).toEqual([7, 42])
    const seven = docs[0]!
    expect(seven.title).toBe("older pr")
    expect(seven.author).toBe("alice")
    expect(seven.state).toBe("merged")
    expect(seven.mergedAt).toBe("2026-05-01T00:00:00Z")
    expect(seven.reviewers).toEqual(["bob", "carol"])
    expect(seven.reviewComments).toEqual([
      { author: "bob", body: "nit: rename", at: "2026-05-01T01:00:00Z" },
      { author: "alice", body: "fixed", at: "2026-05-01T02:00:00Z" },
    ])
    // A `gh pr list` happened, then one `gh pr view` per PR.
    expect(calls[0]!.slice(0, 2)).toEqual(["pr", "list"])
    expect(calls.filter(c => c[1] === "view").length).toBe(2)
  })

  it("uses explicit prNumbers without listing", async () => {
    const { run, calls } = fakeGh({
      view: { 3: { number: 3, title: "t", body: "b" } },
    })
    const adapter = new GhPrSourceAdapter({ run })
    const docs = await collect(adapter, { repo: "o/r", prNumbers: [3] })
    expect(docs.map(d => d.number)).toEqual([3])
    expect(calls.some(c => c[1] === "list")).toBe(false)
  })

  it("passes --search when since is set", async () => {
    const { run, calls } = fakeGh({ list: [] })
    const adapter = new GhPrSourceAdapter({ run })
    await collect(adapter, { repo: "o/r", since: "2026-06-01" })
    const listCall = calls.find(c => c[1] === "list")!
    expect(listCall).toContain("--search")
    expect(listCall).toContain("updated:>=2026-06-01")
  })

  it("skips a PR whose view throws, keeping the batch alive", async () => {
    const { run } = fakeGh({
      list: [{ number: 1 }, { number: 2 }],
      view: { 2: { number: 2, title: "ok", body: "b" } }, // #1 missing → throws
    })
    const adapter = new GhPrSourceAdapter({ run })
    const docs = await collect(adapter, { repo: "o/r" })
    expect(docs.map(d => d.number)).toEqual([2])
  })

  it("includes a diff summary only when requested", async () => {
    const view = {
      number: 5,
      title: "t",
      body: "b",
      additions: 40,
      deletions: 2,
      changedFiles: 1,
      files: [{ path: "src/x.ts", additions: 40, deletions: 2 }],
    }
    const withDiff = new GhPrSourceAdapter({
      run: fakeGh({ view: { 5: view } }).run,
    })
    const [d1] = await collect(withDiff, { repo: "o/r", prNumbers: [5], includeDiffSummary: true })
    expect(d1!.diffSummary).toContain("1 files changed, +40 -2")
    expect(d1!.diffSummary).toContain("src/x.ts | +40 -2")

    const noDiff = new GhPrSourceAdapter({
      run: fakeGh({ view: { 5: view } }).run,
    })
    const [d2] = await collect(noDiff, { repo: "o/r", prNumbers: [5] })
    expect(d2!.diffSummary).toBeUndefined()
  })

  it("toReviewComments drops empty bodies and prefers submittedAt", () => {
    expect(
      toReviewComments([
        { author: { login: "a" }, body: "  ", createdAt: "x" },
        { author: { login: "b" }, body: "real", submittedAt: "s", createdAt: "c", path: "f.ts" },
      ])
    ).toEqual([{ author: "b", body: "real", path: "f.ts", at: "s" }])
  })

  it("buildDiffSummary handles a PR with no files", () => {
    expect(buildDiffSummary({ number: 1, changedFiles: 0, additions: 0, deletions: 0 })).toBe(
      "0 files changed, +0 -0"
    )
  })
})
