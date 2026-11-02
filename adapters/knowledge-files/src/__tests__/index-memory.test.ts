/**
 * The resident BM25 index must stay lean (E97): no doc text kept in memory,
 * snippets cut from disk for the top-K hits only, one build at a time across
 * the whole process, a doc-count ceiling that caps (not refuses) the build, and one log
 * line per build. The parity block pins hits captured from the pre-E97
 * engine (text kept in the index) on a fixed corpus, so the lean shape is
 * checked to return the very same ids, order, scores, spans, and snippets.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesKnowledgeAdapter } from "../adapter.js"
import { buildIndex } from "../bm25.js"
import { LocalFs } from "../local-fs.js"
import { CORPUS, PARITY_CASES } from "./parity-fixture.js"

const WS = "knowledge"

/** Every string reachable from `value` (objects, arrays, Maps, Sets). */
function reachableStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value]
  if (value === null || typeof value !== "object" || seen.has(value)) return []
  seen.add(value)
  if (ArrayBuffer.isView(value)) return []
  const out: string[] = []
  if (value instanceof Map) {
    for (const [k, v] of value) out.push(...reachableStrings(k, seen), ...reachableStrings(v, seen))
    return out
  }
  if (value instanceof Set) {
    for (const v of value) out.push(...reachableStrings(v, seen))
    return out
  }
  for (const v of Object.values(value)) out.push(...reachableStrings(v, seen))
  return out
}


async function writeCorpus(fs: LocalFs): Promise<void> {
  for (const [name, content] of Object.entries(CORPUS)) {
    await fs.writeFile(`${WS}/${name}`, content)
  }
}

describe("lean BM25 index", () => {
  let root: string
  let fs: LocalFs
  let logs: string[]

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-index-memory-"))
    fs = new LocalFs({ root })
    logs = []
    await writeCorpus(fs)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function adapterFor(
    extra: Partial<ConstructorParameters<typeof FilesKnowledgeAdapter>[0]> = {}
  ): FilesKnowledgeAdapter {
    return new FilesKnowledgeAdapter({
      fs,
      workspacePath: WS,
      label: "test-brain",
      log: line => logs.push(line),
      ...extra,
    })
  }

  it("buildIndex keeps no doc text, only ids and short terms", () => {
    const index = buildIndex(
      Object.entries(CORPUS).map(([id, content]) => ({ id, content }))
    )
    for (const doc of index.docs) expect(Object.keys(doc).sort()).toEqual(["id", "length"])
    const ids = new Set(Object.keys(CORPUS))
    for (const s of reachableStrings(index)) {
      // Anything that is not a doc id is a vocabulary term (<= 32 chars).
      if (!ids.has(s)) expect(s.length).toBeLessThanOrEqual(32)
    }
  })

  it("the adapter's resident index holds no doc text after a query", async () => {
    const adapter = adapterFor()
    await adapter.query({ query: "heap" })
    const resident = (adapter as unknown as { cachedIndex: unknown }).cachedIndex
    expect(resident).not.toBeNull()
    const strings = reachableStrings(resident)
    for (const content of Object.values(CORPUS)) expect(strings).not.toContain(content)
    expect(strings.some(s => s.includes("needle sits deep"))).toBe(false)
  })

  it("reads files back for the top-K hits only", async () => {
    const adapter = adapterFor()
    await adapter.query({ query: "heap" }) // warm the index
    const reads: string[] = []
    const realRead = fs.readFile.bind(fs)
    fs.readFile = async p => {
      reads.push(p)
      return realRead(p)
    }
    const res = await adapter.query({ query: "heap", topK: 2 })
    expect(res.hits).toHaveLength(2)
    expect(reads.sort()).toEqual(res.hits.map(h => h.sourceId).sort())
  })

  describe("parity with the pre-E97 engine (hits captured on main)", () => {
    const CASES = PARITY_CASES

    for (const c of CASES) {
      it(`query ${JSON.stringify(c.query)} topK=${c.topK ?? "default"} minScore=${c.minScore ?? "default"}`, async () => {
        const adapter = adapterFor()
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

  it("logs one line per build: brain, docs, bytes read, duration, heap", async () => {
    const adapter = adapterFor()
    await adapter.query({ query: "heap" })
    await adapter.query({ query: "daemon" }) // cached: no second build
    const built = logs.filter(l => l.includes("index built"))
    expect(built).toHaveLength(1)
    const bytes = Object.values(CORPUS).reduce((n, c) => n + Buffer.byteLength(c), 0)
    expect(built[0]).toMatch(
      new RegExp(
        `^\\[knowledge-files:test-brain\\] index built: ${Object.keys(CORPUS).length} docs, ` +
          `${bytes} bytes read, \\d+ ms, heapUsed \\d+ MB -> \\d+ MB$`
      )
    )
  })

  it("logs when a query times out while the build keeps going", async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const realWalk = fs.walk.bind(fs)
    fs.walk = async p => {
      await gate
      return realWalk(p)
    }
    const adapter = adapterFor({ queryTimeoutMs: 20 })
    const res = await adapter.query({ query: "heap" })
    expect(res.hits).toEqual([])
    expect(res.partial).toBe(true)
    expect(logs.some(l => /^\[knowledge-files:test-brain\] query timed out after 20 ms .*the build keeps going$/.test(l))).toBe(true)
    release()
    // The build finishes in the background; the next query is served by it.
    for (let i = 0; i < 50 && !logs.some(l => l.includes("index built")); i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    const warm = await adapter.query({ query: "heap" })
    expect(warm.hits.length).toBeGreaterThan(0)
  })

  it("never runs two index builds at once, across adapters", async () => {
    // A build spans its walk to its own "index built" log line.
    let running = 0
    let maxRunning = 0
    const adapters = [0, 1, 2].map(i => {
      const slow = Object.create(fs) as LocalFs
      slow.walk = async p => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise(r => setTimeout(r, 30))
        return fs.walk(p)
      }
      return adapterFor({
        fs: slow,
        label: `brain-${i}`,
        log: line => {
          logs.push(line)
          if (line.includes("index built")) running--
        },
      })
    })
    await Promise.all(adapters.map(a => a.listSources()))
    expect(maxRunning).toBe(1)
    expect(logs.filter(l => l.includes("index built"))).toHaveLength(3)
  })

  it("above the doc ceiling, indexes the most recent files and flags results partial", async () => {
    const { utimes } = await import("node:fs/promises")
    // Make the three "tie"/"gamma" docs the most recent ones.
    const old = new Date("2020-01-01T00:00:00Z")
    for (const name of Object.keys(CORPUS)) {
      await utimes(path.join(root, WS, name), old, old)
    }
    const recent = new Date("2026-01-01T00:00:00Z")
    for (const name of ["gamma.md", "tie-1.md", "tie-2.md"]) {
      await utimes(path.join(root, WS, name), recent, recent)
    }
    const adapter = adapterFor({ maxIndexDocs: 3 })
    const res = await adapter.query({ query: "daemon heap tie" })
    expect(res.partial).toBe(true)
    expect(res.hits.map(h => h.sourceId).sort()).toEqual([
      "knowledge/gamma.md",
      "knowledge/tie-1.md",
      "knowledge/tie-2.md",
    ])
    expect(logs.filter(l => l.includes("index capped"))).toEqual([
      "[knowledge-files:test-brain] index capped: 9 indexable files exceed the in-memory ceiling of 3; " +
        "indexing the 3 most recent, results flagged partial",
    ])
    expect((await adapter.listSources()).map(s => s.id).sort()).toEqual([
      "knowledge/gamma.md",
      "knowledge/tie-1.md",
      "knowledge/tie-2.md",
    ])
  })

  it("a complete in-memory index does not flag results partial", async () => {
    const res = await adapterFor().query({ query: "heap" })
    expect(res.partial).toBeUndefined()
  })
})
