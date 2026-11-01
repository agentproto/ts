/**
 * The resident BM25 index must stay lean (E97): no doc text kept in memory,
 * snippets cut from disk for the top-K hits only, one build at a time across
 * the whole process, a doc-count ceiling that refuses to build, and one log
 * line per build. The parity block pins hits captured from the pre-E97
 * engine (text kept in the index) on a fixed corpus, so the lean shape is
 * checked to return the very same ids, order, scores, spans, and snippets.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesKnowledgeAdapter, FilesIndexTooLargeError } from "../adapter.js"
import { buildIndex } from "../bm25.js"
import { LocalFs } from "../local-fs.js"

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

/** Corpus with frontmatter, repeated terms, a score tie, a doc whose only
 *  match sits in the frontmatter, a non-ASCII body, and a long body so the
 *  snippet window has to move. */
const CORPUS: Record<string, string> = {
  "alpha.md":
    "---\ntitle: Alpha notes\nslug: alpha\n---\nThe brain index keeps postings for every session. Index index index.",
  "beta.md":
    "---\ntitle: Beta\nsessionId: sess-beta\n---\nA session about the daemon heap and the brain query route.",
  "gamma.md": "No frontmatter here: daemon daemon heap growth after a federated query.",
  "tie-1.md": "tie breaker words",
  "tie-2.md": "tie breaker words",
  "front-only.md": "---\ntitle: zebra\nslug: front\n---\nnothing that matches the body",
  "unicode.md": "Résumé \u2014 café heap naïve query déjà vu daemon",
  "long.md": `${"filler words go here ".repeat(40)}the needle sits deep inside ${"more filler text ".repeat(40)}`,
  "nested/deep.txt": "nested session heap index text",
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

  it("refuses to build above the doc ceiling, with the reason, without reading files", async () => {
    let reads = 0
    const realRead = fs.readFile.bind(fs)
    fs.readFile = async p => {
      reads++
      return realRead(p)
    }
    const adapter = adapterFor({ maxIndexDocs: 3 })
    const err = await adapter.query({ query: "heap" }).catch(e => e)
    expect(err).toBeInstanceOf(FilesIndexTooLargeError)
    expect(err.name).toBe("FilesIndexTooLargeError")
    expect(err.message).toMatch(
      /files engine \(test-brain\): refusing to build the in-process index: 9 indexable files exceed the ceiling of 3/
    )
    expect(reads).toBe(0)
    const refused = logs.filter(l => l.includes("index build refused"))
    expect(refused).toEqual([
      "[knowledge-files:test-brain] index build refused: 9 indexable files exceed the ceiling of 3",
    ])
    // The refusal is remembered: a second query neither re-walks nor re-logs.
    await expect(adapter.listSources()).rejects.toThrow(/exceed the ceiling of 3/)
    expect(logs.filter(l => l.includes("index build refused"))).toHaveLength(1)
  })
})

interface ParityCase {
  readonly query: string
  readonly topK?: number
  readonly minScore?: number
  readonly hits: ReadonlyArray<Record<string, unknown>>
}

const PARITY_CASES: readonly ParityCase[] = [
  {
    "query": "heap",
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.2324833175475982,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "daemon heap",
    "hits": [
      {
        "sourceId": "knowledge/gamma.md",
        "score": 3.1902093262880395,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 2.9077812293590535,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 2.8528662655963855,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "index index",
    "hits": [
      {
        "sourceId": "knowledge/alpha.md",
        "score": 5.962169024273949,
        "text": "\nThe brain index keeps postings for every session. Index index index.",
        "span": {
          "start": 38,
          "end": 107
        },
        "metadata": {
          "title": "Alpha notes",
          "slug": "alpha",
          "entrySlug": "alpha"
        }
      },
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 4.5364649879454655,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "tie breaker",
    "hits": [
      {
        "sourceId": "knowledge/tie-1.md",
        "score": 4.725679027092521,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/tie-2.md",
        "score": 4.725679027092521,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "zebra",
    "hits": []
  },
  {
    "query": "needle",
    "hits": [
      {
        "sourceId": "knowledge/long.md",
        "score": 0.4713430024374004,
        "text": "iller words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here the needle sits deep inside more filler text more filler text more filler text more filler text more filler text more filler text more filler text more fi",
        "span": {
          "start": 694,
          "end": 994
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "session",
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.7177020425559189,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.651573779510753,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/alpha.md",
        "score": 1.5903483899728255,
        "text": "\nThe brain index keeps postings for every session. Index index index.",
        "span": {
          "start": 38,
          "end": 107
        },
        "metadata": {
          "title": "Alpha notes",
          "slug": "alpha",
          "entrySlug": "alpha"
        }
      }
    ]
  },
  {
    "query": "café heap",
    "hits": [
      {
        "sourceId": "knowledge/unicode.md",
        "score": 4.160656388180504,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "query",
    "topK": 3,
    "hits": [
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.651573779510753,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.620382948048787,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.5903483899728255,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "heap",
    "minScore": 1,
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.2324833175475982,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "heap",
    "minScore": -1,
    "hits": [
      {
        "sourceId": "knowledge/nested/deep.txt",
        "score": 1.3065054248545844,
        "text": "nested session heap index text",
        "span": {
          "start": 0,
          "end": 30
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/beta.md",
        "score": 1.2562074498483007,
        "text": "\nA session about the daemon heap and the brain query route.",
        "span": {
          "start": 40,
          "end": 99
        },
        "metadata": {
          "title": "Beta",
          "sessionId": "sess-beta"
        }
      },
      {
        "sourceId": "knowledge/unicode.md",
        "score": 1.2324833175475982,
        "text": "Résumé \u2014 café heap naïve query déjà vu daemon",
        "span": {
          "start": 0,
          "end": 45
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/gamma.md",
        "score": 1.209638661089622,
        "text": "No frontmatter here: daemon daemon heap growth after a federated query.",
        "span": {
          "start": 0,
          "end": 71
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/alpha.md",
        "score": 0,
        "text": "\nThe brain index keeps postings for every session. Index index index.",
        "span": {
          "start": 38,
          "end": 107
        },
        "metadata": {
          "title": "Alpha notes",
          "slug": "alpha",
          "entrySlug": "alpha"
        }
      },
      {
        "sourceId": "knowledge/front-only.md",
        "score": 0,
        "text": "\nnothing that matches the body",
        "span": {
          "start": 32,
          "end": 62
        },
        "metadata": {
          "title": "zebra",
          "slug": "front",
          "entrySlug": "front"
        }
      },
      {
        "sourceId": "knowledge/long.md",
        "score": 0,
        "text": "filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler",
        "span": {
          "start": 0,
          "end": 300
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/tie-1.md",
        "score": 0,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      },
      {
        "sourceId": "knowledge/tie-2.md",
        "score": 0,
        "text": "tie breaker words",
        "span": {
          "start": 0,
          "end": 17
        },
        "metadata": {}
      }
    ]
  },
  {
    "query": "words",
    "topK": 1,
    "hits": [
      {
        "sourceId": "knowledge/long.md",
        "score": 2.1397730748651056,
        "text": "filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler words go here filler",
        "span": {
          "start": 0,
          "end": 300
        },
        "metadata": {}
      }
    ]
  }
]
