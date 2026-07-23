import { describe, it, expect } from "vitest"
import { PrReviewImporter } from "../pr-review.js"
import { ImporterRunner } from "../runner.js"
import { CorpusWorkspaceReader } from "../../workspace/reader.js"
import { MemoryFs } from "../../__tests__/_helpers/memory-fs.js"
import type { PrDoc, PrQuery, PrSourcePort } from "../../ports/pr-source.port.js"
import type { ImportedSource, ImporterTarget } from "../types.js"
import type { ClockPort } from "../../ports/clock.port.js"
import type { IdentityPort } from "../../ports/identity.port.js"

/** A fake port that yields a fixed PrDoc list for any query. */
function fakeSource(docs: readonly PrDoc[]): PrSourcePort {
  return {
    async *listPullRequests(_query: PrQuery) {
      for (const d of docs) yield d
    },
  }
}

async function collect(
  it: AsyncIterable<ImportedSource>
): Promise<ImportedSource[]> {
  const out: ImportedSource[] = []
  for await (const s of it) out.push(s)
  return out
}

const target = (config: Record<string, unknown>): ImporterTarget => ({
  importerId: "pr-review",
  config,
})

const fixedClock: ClockPort = {
  now: () => new Date("2026-07-24T12:00:00.000Z"),
  nowMs: () => Date.parse("2026-07-24T12:00:00.000Z"),
}
const stubIdentity: IdentityPort = {
  resolve: async () => ({
    principal: "ws://operators/importer",
    identityTree: ["ws://operators/importer"],
  }),
}

function freshWorkspace(): MemoryFs {
  return new MemoryFs({
    "KNOWLEDGE.md": [
      "---",
      "schema: knowledge.workspace/v1",
      "name: t",
      "title: T",
      "description: t",
      'version: "1.0.0"',
      "---",
    ].join("\n"),
  })
}

describe("PrReviewImporter", () => {
  it("renders a PR (description + review discussion + diff) to one ImportedSource", async () => {
    const importer = new PrReviewImporter({
      source: fakeSource([
        {
          number: 655,
          title: "live session-story overlay",
          body: "Adds a webview that renders the session story.",
          author: "octocat",
          url: "https://github.com/agentproto/ts/pull/655",
          state: "merged",
          mergedAt: "2026-07-20T09:00:00Z",
          reviewers: ["maintainer-a", "maintainer-b"],
          reviewComments: [
            {
              author: "maintainer-a",
              body: "Prefer a discriminated union here.",
              path: "packages/vscode/src/story.ts",
            },
            { author: "octocat", body: "Done — pushed a fixup." },
          ],
          diffSummary: "packages/vscode/src/story.ts | 42 +++++",
        },
      ]),
    })
    const sources = await collect(
      importer.enumerate(target({ repo: "agentproto/ts", includeDiffSummary: true }))
    )
    expect(sources).toHaveLength(1)
    const s = sources[0]!
    expect(s.slug).toBe("agentproto-ts-pr-655")
    expect(s.title).toBe("live session-story overlay")
    expect(s.contentHash).toMatch(/^sha256:/)
    expect(s.authority).toBe("secondary")
    expect(s.originalUrl).toBe("https://github.com/agentproto/ts/pull/655")
    expect(s.body).toContain("# live session-story overlay")
    expect(s.body).toContain("Adds a webview")
    expect(s.body).toContain("## Review discussion")
    expect(s.body).toContain(
      "maintainer-a [packages/vscode/src/story.ts]: Prefer a discriminated union"
    )
    expect(s.body).toContain("## Diff summary")
    expect(s.corpusMetadata?.provenanceKind).toBe("imported-from-pr")
    expect(s.corpusMetadata?.repo).toBe("agentproto/ts")
    expect(s.corpusMetadata?.prNumber).toBe(655)
    expect(s.corpusMetadata?.author).toBe("octocat")
    expect(s.corpusMetadata?.mergedAt).toBe("2026-07-20T09:00:00Z")
    expect(s.corpusMetadata?.reviewers).toEqual(["maintainer-a", "maintainer-b"])
  })

  it("skips a PR with no reviewable content", async () => {
    const importer = new PrReviewImporter({
      source: fakeSource([
        { number: 1, title: "   ", body: "  " },
        { number: 2, title: "real", body: "has a body" },
      ]),
    })
    const sources = await collect(
      importer.enumerate(target({ repo: "o/r" }))
    )
    expect(sources.map(s => s.corpusMetadata?.prNumber)).toEqual([2])
  })

  it("contains a mid-stream throw — PRs streamed before it survive the batch", async () => {
    // A thrown fetch (auth, forge unreachable) must not lose what was already
    // streamed. The importer is resumable, so a re-run retries the rest.
    const source: PrSourcePort = {
      async *listPullRequests(_query: PrQuery) {
        yield { number: 10, title: "first", body: "one" }
        throw new Error("forge unreachable")
      },
    }
    const importer = new PrReviewImporter({ source })
    const sources = await collect(importer.enumerate(target({ repo: "o/r" })))
    expect(sources.map(s => s.corpusMetadata?.prNumber)).toEqual([10])
  })

  it("honours maxPRs and applies tags + language fallback", async () => {
    const importer = new PrReviewImporter({
      source: fakeSource([
        { number: 1, title: "a", body: "a" },
        { number: 2, title: "b", body: "b" },
      ]),
    })
    const sources = await collect(
      importer.enumerate(
        target({ repo: "o/r", maxPRs: 1, tags: ["reviews", "ts"], language: "en" })
      )
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]!.tags).toEqual(["reviews", "ts"])
    expect(sources[0]!.language).toBe("en")
  })

  it("throws on missing repo config", async () => {
    const importer = new PrReviewImporter({ source: fakeSource([]) })
    await expect(collect(importer.enumerate(target({})))).rejects.toThrow(
      /config.repo is required/
    )
  })

  it("dedups across reruns by content_hash via the runner", async () => {
    const fs = freshWorkspace()
    const docs: PrDoc[] = [
      { number: 7, title: "stable pr", body: "unchanged body" },
    ]
    const importer = new PrReviewImporter({ source: fakeSource(docs) })
    const runner = new ImporterRunner({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      workspacePath: "",
    })
    const first = await runner.run(importer, {
      importerId: "pr-review",
      batchId: "batch1",
      config: { repo: "agentproto/ts" },
    })
    expect(first.archivedSlugs).toEqual(["agentproto-ts-pr-7"])

    // Archived source carries AIP-10 frontmatter stamped by the runner.
    const archived = await fs.readFile(
      "sources/pr-review/batch1/agentproto-ts-pr-7.md"
    )
    expect(archived).toMatch(/schema: knowledge\.source\/v1/)
    expect(archived).toMatch(/authority: secondary/)
    expect(archived).toMatch(/provenanceKind: imported-from-pr/)

    // Second run, same PR body → dedup hit, nothing re-archived.
    const second = await runner.run(importer, {
      importerId: "pr-review",
      batchId: "batch2",
      config: { repo: "agentproto/ts" },
    })
    expect(second.archivedSlugs.length).toBe(0)
    expect(second.duplicateSlugs).toEqual(["agentproto-ts-pr-7"])

    // Sanity: exactly one source landed across both runs.
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    expect(snapshot.sources.length).toBe(1)
  })
})
