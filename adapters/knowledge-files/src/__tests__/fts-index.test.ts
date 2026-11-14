/**
 * The on-disk FTS5 index (E98): search is never refused whatever the brain
 * size, an ingest updates one row instead of invalidating the whole brain,
 * external changes are reconciled with a stat-only scan, a query during the
 * first build answers partially, and the index file survives a reopen (and
 * rebuilds when deleted or unreadable). Ranking stays the in-memory engine's.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesKnowledgeAdapter } from "../adapter.js"
import { stripFrontmatter, tokenize } from "../bm25.js"
import { openFtsIndex } from "../fts-index.js"
import { LocalFs } from "../local-fs.js"
import { CORPUS, PARITY_CASES } from "./parity-fixture.js"

const WS = "knowledge"

interface Ctx {
  root: string
  fs: LocalFs
  indexPath: string
  logs: string[]
  reads: string[]
  adapters: FilesKnowledgeAdapter[]
}

function setup(): Ctx {
  return { root: "", fs: null as unknown as LocalFs, indexPath: "", logs: [], reads: [], adapters: [] }
}

async function writeCorpus(fs: LocalFs, corpus: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(corpus)) {
    await fs.writeFile(`${WS}/${name}`, content)
  }
}

for (const worker of [true, false]) {
  describe(`on-disk FTS5 index (${worker ? "worker thread" : "inline"})`, () => {
    const ctx = setup()

    beforeEach(async () => {
      ctx.root = await mkdtemp(path.join(tmpdir(), "knowledge-fts-"))
      const fs = new LocalFs({ root: ctx.root })
      ctx.reads = []
      const realRead = fs.readFile.bind(fs)
      fs.readFile = async p => {
        ctx.reads.push(p)
        return realRead(p)
      }
      ctx.fs = fs
      ctx.indexPath = path.join(ctx.root, ".index", "fts.sqlite")
      ctx.logs = []
      ctx.adapters = []
      await writeCorpus(fs, CORPUS)
    })

    afterEach(async () => {
      for (const a of ctx.adapters) await a.dispose()
      await rm(ctx.root, { recursive: true, force: true })
    })

    function adapterFor(
      extra: Partial<ConstructorParameters<typeof FilesKnowledgeAdapter>[0]> = {}
    ): FilesKnowledgeAdapter {
      const adapter = new FilesKnowledgeAdapter({
        fs: ctx.fs,
        workspacePath: WS,
        label: "test-brain",
        indexPath: ctx.indexPath,
        indexWorker: worker,
        log: line => ctx.logs.push(line),
        ...extra,
      })
      ctx.adapters.push(adapter)
      return adapter
    }

    const builds = () => ctx.logs.filter(l => l.includes("index built"))

    it("answers a query on a brain above the in-memory ceiling", async () => {
      const adapter = adapterFor({ maxIndexDocs: 3 })
      await adapter.whenIndexSynced()
      const res = await adapter.query({ query: "heap" })
      expect(res.partial).toBeUndefined()
      expect(res.hits.map(h => h.sourceId)).toEqual(
        PARITY_CASES.find(c => c.query === "heap" && c.topK === undefined)!.hits.map(h => h.sourceId)
      )
      expect(ctx.logs.some(l => /capped|refus|unavailable/.test(l))).toBe(false)
      expect(builds()).toHaveLength(1)
      expect(builds()[0]).toMatch(
        /^\[knowledge-files:test-brain\] index built: 9 docs, \d+ bytes read, \d+ ms, heapUsed \d+ MB -> \d+ MB \(on disk, 9 files scanned in \d+ ms\)$/
      )
    })

    it("an ingest after the index exists updates one row, no rebuild, no file read", async () => {
      const adapter = adapterFor()
      await adapter.whenIndexSynced()
      ctx.reads.length = 0
      await adapter.ingest({
        kind: "text",
        uri: "notes/fresh-zeppelin",
        content: "a zeppelin crossed the brain index",
        title: "fresh",
      })
      await adapter.whenIndexSynced()
      expect(ctx.reads).toEqual([])
      const res = await adapter.query({ query: "zeppelin" })
      expect(res.hits.map(h => h.sourceId)).toEqual(["knowledge/sources/notes-fresh-zeppelin.md"])
      // The query read back its candidates only.
      expect(ctx.reads).toEqual(["knowledge/sources/notes-fresh-zeppelin.md"])
      expect(builds()).toHaveLength(1)

      // deleteSource empties the row the same way.
      await adapter.deleteSource("knowledge/sources/notes-fresh-zeppelin.md")
      expect((await adapter.query({ query: "zeppelin" })).hits).toEqual([])
      expect(builds()).toHaveLength(1)
    })

    it("does not re-index an ingested doc at the next reconcile, even with sub-ms mtimes", async () => {
      // Every write lands on a sub-ms mtime whose fraction rounds up, as on
      // filesystems with ns timestamps.
      const { utimes } = await import("node:fs/promises")
      const realWrite = ctx.fs.writeFile.bind(ctx.fs)
      ctx.fs.writeFile = async (p, content) => {
        await realWrite(p, content)
        const t = Math.floor(Date.now() / 1000) + 0.1229996
        await utimes(path.join(ctx.root, p), t, t)
      }
      const adapter = adapterFor()
      await adapter.whenIndexSynced()
      await adapter.ingest({ kind: "text", uri: "notes/sub-ms", content: "a sub millisecond mtime" })
      adapter.invalidate()
      ctx.reads.length = 0
      await adapter.query({ query: "x" }) // starts the reconcile
      await adapter.whenIndexSynced()
      const reconciled = ctx.logs.filter(l => l.includes("index reconciled"))
      expect(reconciled).toHaveLength(1)
      expect(reconciled[0]).toMatch(/ 0 re-indexed, 0 removed, 0 bytes read, /)
      expect(ctx.reads).toEqual([])
    })

    it("drops a file deleted outside the adapter after a reconcile, and picks up an edit", async () => {
      const adapter = adapterFor()
      await adapter.whenIndexSynced()
      expect((await adapter.query({ query: "needle" })).hits).toHaveLength(1)
      await rm(path.join(ctx.root, WS, "long.md"))
      await writeFile(path.join(ctx.root, WS, "tie-1.md"), "a quokka appeared")
      // Bump the mtime so a same-millisecond write still differs.
      const later = new Date(Date.now() + 5_000)
      const { utimes } = await import("node:fs/promises")
      await utimes(path.join(ctx.root, WS, "tie-1.md"), later, later)
      adapter.invalidate()
      await adapter.query({ query: "needle" }) // starts the reconcile
      await adapter.whenIndexSynced()
      expect((await adapter.query({ query: "needle" })).hits).toEqual([])
      expect((await adapter.query({ query: "quokka" })).hits.map(h => h.sourceId)).toEqual([
        "knowledge/tie-1.md",
      ])
      const reconciled = ctx.logs.filter(l => l.includes("index reconciled"))
      expect(reconciled).toHaveLength(1)
      expect(reconciled[0]).toMatch(
        /^\[knowledge-files:test-brain\] index reconciled: 8 files scanned in \d+ ms, 1 re-indexed, 1 removed, 17 bytes read, \d+ ms; 0 upserts and 0 deletes applied incrementally since the last reconcile$/
      )
    })

    it("reconciles on its own once the interval has passed", async () => {
      const adapter = adapterFor({ reconcileIntervalMs: 1 })
      await adapter.whenIndexSynced()
      await rm(path.join(ctx.root, WS, "long.md"))
      await new Promise(r => setTimeout(r, 5))
      await adapter.query({ query: "needle" })
      await adapter.whenIndexSynced()
      expect((await adapter.query({ query: "needle" })).hits).toEqual([])
    })

    it("a query during the first build answers from what is indexed, flagged partial", async () => {
      // 150 docs: the first batch of 100 lands, the second is held.
      const many: Record<string, string> = {}
      for (let i = 0; i < 150; i++) many[`bulk/doc-${String(i).padStart(3, "0")}.md`] = `bulk walrus number ${i}`
      await writeCorpus(ctx.fs, many)
      let release!: () => void
      const gate = new Promise<void>(r => (release = r))
      let held = 0
      const realRead = ctx.fs.readFile
      ctx.fs.readFile = async p => {
        const n = Number(p.match(/doc-(\d+)/)?.[1] ?? -1)
        if (n >= 100) {
          held++
          await gate
        }
        return realRead(p)
      }
      const adapter = adapterFor()
      try {
        await adapter.query({ query: "x" }) // opens the index, starts the build
        for (let i = 0; i < 200 && held === 0; i++) await new Promise(r => setTimeout(r, 10))
        expect(held).toBeGreaterThan(0)
        const res = await adapter.query({ query: "walrus", topK: 200 })
        expect(res.partial).toBe(true)
        // The first batch is in, the held docs are not.
        expect(res.hits.length).toBeGreaterThan(0)
        expect(res.hits.length).toBeLessThan(150)
        for (const h of res.hits) expect(Number(h.sourceId.match(/doc-(\d+)/)![1])).toBeLessThan(100)
        expect(
          ctx.logs.some(l =>
            /query answered from a partial index: \d+ docs indexed so far, first build running for \d+ ms/.test(l)
          )
        ).toBe(true)
      } finally {
        release()
      }
      await adapter.whenIndexSynced()
      const done = await adapter.query({ query: "walrus", topK: 200 })
      expect(done.partial).toBeUndefined()
      expect(done.hits).toHaveLength(150)
    })

    it("survives a reopen without a rebuild", async () => {
      const first = adapterFor()
      await first.whenIndexSynced()
      await first.dispose()
      ctx.reads.length = 0
      ctx.logs.length = 0
      const second = adapterFor()
      const res = await second.query({ query: "heap" })
      expect(res.partial).toBeUndefined()
      expect(res.hits.length).toBeGreaterThan(0)
      await second.whenIndexSynced()
      expect(builds()).toEqual([])
      expect(ctx.logs.some(l => /on-disk index opened: 9 docs, complete, sqlite/.test(l))).toBe(true)
      expect(ctx.logs.some(l => / 0 re-indexed, 0 removed, 0 bytes read/.test(l))).toBe(true)
      // Reads: the query's candidates only, nothing from the reconcile.
      expect(new Set(ctx.reads)).toEqual(new Set(res.hits.map(h => h.sourceId)))
    })

    it("rebuilds when the index file is deleted", async () => {
      const first = adapterFor()
      await first.whenIndexSynced()
      await first.dispose()
      for (const s of ["", "-wal", "-shm"]) await rm(ctx.indexPath + s, { force: true })
      ctx.logs.length = 0
      const second = adapterFor()
      await second.whenIndexSynced()
      expect(builds()).toHaveLength(1)
      expect(ctx.logs.some(l => /on-disk index opened: 0 docs, incomplete, new file/.test(l))).toBe(true)
      expect((await second.query({ query: "needle" })).hits).toHaveLength(1)
      expect((await stat(ctx.indexPath)).size).toBeGreaterThan(0)
    })

    it("rebuilds when the index file is not a database", async () => {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(path.dirname(ctx.indexPath), { recursive: true })
      await writeFile(ctx.indexPath, "this is not sqlite at all, just text ".repeat(200))
      const adapter = adapterFor()
      await adapter.whenIndexSynced()
      expect(ctx.logs.some(l => l.includes("on-disk index unreadable"))).toBe(true)
      expect(builds()).toHaveLength(1)
      expect((await adapter.query({ query: "needle" })).hits).toHaveLength(1)
    })

    it("keeps the index out of the walked tree", async () => {
      const adapter = adapterFor({ indexPath: path.join(ctx.root, WS, ".index", "fts.sqlite") })
      await adapter.whenIndexSynced()
      const ids = (await adapter.listSources()).map(s => s.id)
      expect(ids).toHaveLength(9)
      expect(ids.some(id => id.includes(".index"))).toBe(false)
    })

    describe("parity with the pre-E97 engine (hits captured on main)", () => {
      // Known difference: a negative minScore makes the in-memory engine pad
      // with docs that match no query term (score 0); the on-disk engine
      // only ever returns docs that match at least one term.
      for (const c of PARITY_CASES.filter(c => (c.minScore ?? 0) >= 0)) {
        it(`query ${JSON.stringify(c.query)} topK=${c.topK ?? "default"} minScore=${c.minScore ?? "default"}`, async () => {
          const adapter = adapterFor()
          await adapter.whenIndexSynced()
          const res = await adapter.query({
            query: c.query,
            ...(c.topK !== undefined ? { topK: c.topK } : {}),
            ...(c.minScore !== undefined ? { minScore: c.minScore } : {}),
          })
          expect(
            res.hits.map(h => ({
              sourceId: h.sourceId,
              score: h.score,
              text: h.text,
              span: h.span,
              metadata: h.metadata,
            }))
          ).toEqual(c.hits)
        })
      }
    })
  })
}

describe("on-disk index edges", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-fts-edge-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("falls back to the in-memory index when the index cannot be opened", async () => {
    const fs = new LocalFs({ root })
    await writeCorpus(fs, CORPUS)
    // The index's parent is a file: the directory cannot be created.
    await writeFile(path.join(root, "blocker"), "")
    const logs: string[] = []
    const adapter = new FilesKnowledgeAdapter({
      fs,
      workspacePath: WS,
      label: "test-brain",
      indexPath: path.join(root, "blocker", "fts.sqlite"),
      log: line => logs.push(line),
    })
    const res = await adapter.query({ query: "needle" })
    expect(res.hits).toHaveLength(1)
    expect(logs.filter(l => l.includes("on-disk index unavailable"))).toHaveLength(1)
    expect(logs.some(l => /index built: 9 docs, \d+ bytes read, \d+ ms, heapUsed \d+ MB -> \d+ MB$/.test(l))).toBe(true)
    await adapter.dispose()
  })

  it("the store tokenizes exactly like bm25.tokenize", async () => {
    const handle = await openFtsIndex({ path: path.join(root, "t.sqlite"), worker: true })
    const samples = [
      ...Object.values(CORPUS),
      "Q3 revenue: 42% up; the API's p99 (ms) fell. x y zz",
      `${"a".repeat(32)} ${"b".repeat(33)} I it IT is Is`,
      "---\ntitle: hidden\n---\nvisible words only",
      "---\nno closing fence, so nothing is stripped",
      "naïve café déjà-vu 東京 tokens",
    ]
    for (const text of samples) {
      expect(await handle.request("tokenize", { text })).toEqual(tokenize(stripFrontmatter(text)))
    }
    await handle.release()
  })
})

describe("on-disk vs in-memory ranking on a generated corpus", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-fts-parity-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("returns nearly the same top-10 ids", async () => {
    const fs = new LocalFs({ root })
    const words = Array.from({ length: 400 }, (_, i) => `term${i.toString(36)}`)
    // mulberry32: deterministic, no short cycles.
    let seed = 7
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    // Zipf-ish: low indices are common, the tail is rare.
    const pick = () => words[Math.floor(words.length * rnd() ** 3)]!
    const corpus: Record<string, string> = {}
    for (let d = 0; d < 400; d++) {
      const n = 20 + Math.floor(rnd() * 300)
      corpus[`gen/d${d}.md`] = Array.from({ length: n }, pick).join(" ")
    }
    await writeCorpus(fs, corpus)
    const memory = new FilesKnowledgeAdapter({ fs, workspacePath: WS, log: () => {} })
    const disk = new FilesKnowledgeAdapter({
      fs,
      workspacePath: WS,
      indexPath: path.join(root, ".index", "fts.sqlite"),
      log: () => {},
    })
    await disk.whenIndexSynced()
    let shared = 0
    let total = 0
    let identical = 0
    const QUERIES = 200
    for (let qi = 0; qi < QUERIES; qi++) {
      const query = Array.from({ length: 1 + (qi % 4) }, pick).join(" ")
      const a = (await memory.query({ query })).hits.map(h => h.sourceId)
      const b = (await disk.query({ query })).hits.map(h => h.sourceId)
      total += a.length
      shared += b.filter(id => a.includes(id)).length
      if (JSON.stringify(a) === JSON.stringify(b)) identical++
    }
    console.log(
      `[parity] top-10 overlap ${shared}/${total} (${((100 * shared) / total).toFixed(1)}%), ` +
        `identical lists ${identical}/${QUERIES}`
    )
    expect(shared / total).toBeGreaterThanOrEqual(0.99)
    await disk.dispose()
    // 400 queries over 400 files: about 1 s locally, over 5 s on CI runners.
  }, 60_000)
})
