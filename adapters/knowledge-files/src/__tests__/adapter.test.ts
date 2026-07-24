/**
 * Integration tests for {@link FilesKnowledgeAdapter} driven through a real
 * {@link LocalFs} over a temp workspace — the whole standalone path (walk →
 * index → BM25 query → frontmatter metadata) end to end. Covers query
 * ranking, source listing, ingest (both inline-text and corpus-entry modes),
 * deletion, extension filtering, and the health check.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FilesKnowledgeAdapter, FILES_CAPABILITIES } from "../adapter.js"
import { LocalFs } from "../local-fs.js"

const WS = "knowledge"

describe("FilesKnowledgeAdapter", () => {
  let root: string
  let fs: LocalFs
  let adapter: FilesKnowledgeAdapter

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "knowledge-adapter-"))
    fs = new LocalFs({ root })
    adapter = new FilesKnowledgeAdapter({ fs, workspacePath: WS })
    await fs.writeFile(
      `${WS}/pricing.md`,
      "---\ntitle: Pricing\nslug: pricing\n---\nOur pricing model is usage based and billed monthly."
    )
    await fs.writeFile(
      `${WS}/onboarding.md`,
      "---\ntitle: Onboarding\nslug: onboarding\n---\nOnboarding a new customer takes about ten minutes."
    )
    // A non-indexed extension — must be ignored by the walker's filter.
    await fs.writeFile(`${WS}/diagram.png`, "not really a png")
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("exposes the frozen files capabilities", () => {
    expect(adapter.id).toBe("files")
    expect(adapter.capabilities).toBe(FILES_CAPABILITIES)
    expect(Object.isFrozen(adapter.capabilities)).toBe(true)
    expect(adapter.capabilities.vectorSearch).toBe(false)
    expect(adapter.capabilities.citations).toBe(true)
  })

  it("queries and ranks the most relevant file first, with citation span", async () => {
    const res = await adapter.query({ query: "pricing usage billed" })
    expect(res.engine).toBe("files")
    expect(res.hits[0]!.sourceId).toBe(`${WS}/pricing.md`)
    // frontmatter surfaces as metadata; slug mirrors to entrySlug for corpus.
    expect(res.hits[0]!.metadata.title).toBe("Pricing")
    expect(res.hits[0]!.metadata.entrySlug).toBe("pricing")
    // citation span present (engine advertises citations capability).
    expect(res.hits[0]!.span).toBeDefined()
  })

  it("returns empty hits for a query that tokenizes to nothing", async () => {
    const res = await adapter.query({ query: "  a the of  " })
    expect(res.hits).toEqual([])
    expect(res.engine).toBe("files")
  })

  it("ignores non-indexed extensions when building the index", async () => {
    const sources = await adapter.listSources()
    const ids = sources.map(s => s.id)
    expect(ids).toContain(`${WS}/pricing.md`)
    expect(ids).not.toContain(`${WS}/diagram.png`)
  })

  it("lists sources with titles pulled from frontmatter", async () => {
    const sources = await adapter.listSources()
    const pricing = sources.find(s => s.id === `${WS}/pricing.md`)
    expect(pricing?.title).toBe("Pricing")
    expect(pricing?.status).toBe("ready")
    expect(pricing?.kind).toBe("file")
  })

  it("getSource returns a file by id, null for a miss", async () => {
    expect((await adapter.getSource(`${WS}/pricing.md`))?.title).toBe("Pricing")
    expect(await adapter.getSource("nope.md")).toBeNull()
  })

  it("ingests inline text, writing a source file and invalidating the index", async () => {
    const source = await adapter.ingest({
      kind: "text",
      uri: "note://alpha",
      title: "Alpha",
      content: "zebra quokka is a rare marsupial keyword",
    })
    expect(source.status).toBe("ready")
    expect(await fs.exists(`${WS}/sources/${source.id}.md`)).toBe(true)
    // The freshly ingested content is now searchable (index was invalidated).
    const res = await adapter.query({ query: "quokka marsupial" })
    expect(res.hits[0]!.text).toContain("quokka")
  })

  it("ingesting a corpus entry invalidates without writing a chunk file", async () => {
    const before = await fs.walk(WS)
    const source = await adapter.ingest({
      kind: "text",
      uri: "entry://pricing",
      content: "chunk body",
      metadata: {
        corpus: { entrySlug: "pricing", entryPath: `${WS}/pricing.md` },
      },
    })
    expect(source.id).toBe("pricing#0")
    const after = await fs.walk(WS)
    // No ghost sources/chunk-*.md file was written.
    expect([...after].sort()).toEqual([...before].sort())
  })

  it("rejects unsupported ingest kinds with a helpful message", async () => {
    await expect(
      // @ts-expect-error — exercising the runtime guard for an invalid kind.
      adapter.ingest({ kind: "pdf", uri: "x://y", content: "z" })
    ).rejects.toThrow(/not supported/)
  })

  it("deleteSource empties the file and drops it from results", async () => {
    await adapter.deleteSource(`${WS}/pricing.md`)
    expect(await fs.readFile(`${WS}/pricing.md`)).toBe("")
    const res = await adapter.query({ query: "pricing usage billed" })
    expect(res.hits.map(h => h.sourceId)).not.toContain(`${WS}/pricing.md`)
  })

  it("reports healthy when the workspace path is reachable", async () => {
    expect(await adapter.healthCheck()).toBe(true)
  })

  it("caches the index across queries until invalidated by a write", async () => {
    await adapter.query({ query: "pricing" })
    // A raw fs write is invisible until an explicit invalidate (permanent cache).
    await fs.writeFile(
      `${WS}/surprise.md`,
      "---\nslug: surprise\n---\nsurprise content"
    )
    let res = await adapter.query({ query: "surprise" })
    expect(res.hits).toEqual([])
    // ingest() invalidates → the whole workspace (incl. surprise.md) re-indexes.
    await adapter.ingest({
      kind: "text",
      uri: "note://trigger",
      content: "trigger body",
    })
    res = await adapter.query({ query: "surprise" })
    expect(res.hits.map(h => h.sourceId)).toContain(`${WS}/surprise.md`)
  })
})
