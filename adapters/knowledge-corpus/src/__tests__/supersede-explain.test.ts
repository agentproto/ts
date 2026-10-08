/**
 * `supersede()` / `explain()` on CorpusAdapterCore — the status flip, the
 * attestation it appends, and the visibility rules provenance obeys.
 */

import { CorpusWorkspaceReader, readAttestations } from "@agentproto/corpus"
import { KnowledgeNotSupportedError } from "@agentproto/knowledge-engine"
import { describe, expect, it } from "vitest"
import { CorpusAdapterCore } from "../adapter.js"
import { loadM0FixtureFs, makeStubProvider, MemoryFs } from "./_helpers.js"

const ENTRY = "contrarian-short-form-hooks"
const ENTRY_PATH = "entries/patterns/2026/contrarian-short-form-hooks.md"
const OTHER = "story-then-payoff"
const NOW = Date.parse("2026-06-01T12:00:00Z")

function build(opts: Partial<ConstructorParameters<typeof CorpusAdapterCore>[0]> = {}) {
  const fs = loadM0FixtureFs()
  const { provider: backing } = makeStubProvider()
  const adapter = new CorpusAdapterCore({
    fs,
    workspacePath: "",
    backing,
    nowMs: () => NOW,
    ...opts,
  })
  return { fs, adapter, backing }
}

async function readEntry(fs: MemoryFs, path = ENTRY_PATH) {
  const snap = await new CorpusWorkspaceReader({ fs }).read("")
  const file = snap.entries.find(e => e.path === path)!
  return { data: file.frontmatter, content: file.body }
}

describe("CorpusAdapterCore.supersede", () => {
  it("flips status to deprecated, records supersededBy and a deprecated attestation, keeps the body", async () => {
    const { fs, adapter } = build()
    const before = await readEntry(fs)

    await adapter.supersede(ENTRY, OTHER)

    const after = await readEntry(fs)
    const corpus = (after.data.metadata as { corpus: Record<string, unknown> }).corpus
    expect(corpus.status).toBe("deprecated")
    expect(corpus.supersededBy).toBe(OTHER)
    // other corpus fields survive
    expect(corpus.qualityScore).toBe(4.5)
    expect(after.data.updated_at).toBe("2026-06-01T12:00:00.000Z")
    expect(after.content.trim()).toBe(before.content.trim())

    const att = readAttestations(after.data)
    expect(att[att.length - 1]).toMatchObject({
      kind: "deprecated",
      identity: "ws://adapters/corpus",
      at: "2026-06-01T12:00:00.000Z",
      note: `superseded by ${OTHER}`,
    })
    // audit rollup line
    expect(await fs.readFile("_log.md")).toContain("corpus.entry.deprecated")
  })

  it("is idempotent for an already-superseded entry", async () => {
    const { fs, adapter } = build()
    await adapter.supersede(ENTRY, OTHER)
    const first = await fs.readFile(ENTRY_PATH)
    await adapter.supersede(ENTRY, OTHER)
    expect(await fs.readFile(ENTRY_PATH)).toBe(first)
  })

  it("works without a successor", async () => {
    const { fs, adapter } = build()
    await adapter.supersede(ENTRY)
    const corpus = ((await readEntry(fs)).data.metadata as { corpus: Record<string, unknown> }).corpus
    expect(corpus.status).toBe("deprecated")
    expect(corpus.supersededBy).toBeUndefined()
  })

  it("rejects unknown entries, unknown successors and self-supersession", async () => {
    const { adapter } = build()
    await expect(adapter.supersede("nope")).rejects.toThrow(/not found/)
    await expect(adapter.supersede(ENTRY, "nope")).rejects.toThrow(/not found/)
    await expect(adapter.supersede(ENTRY, ENTRY)).rejects.toThrow(/itself/)
  })

  it("refuses to supersede an immutable AIP-10 source with a typed error", async () => {
    const { fs, adapter } = build()
    const [src] = await adapter.listSources()
    await expect(adapter.supersede(src!.id)).rejects.toBeInstanceOf(KnowledgeNotSupportedError)
    expect(fs).toBeDefined()
  })

  it("requires the curate capability when a caller is set", async () => {
    const { adapter } = build({
      caller: { identityTree: ["ws://users/rando", "ws://guilds/g"] },
      accessContext: { homeGuild: "g" },
    })
    await expect(adapter.supersede(ENTRY, OTHER)).rejects.toThrow(/curate/)

    const { fs, adapter: curator } = build({
      caller: {
        identityTree: ["ws://users/sarah", "ws://roles/corpus-curator", "ws://guilds/g"],
      },
      accessContext: { homeGuild: "g" },
    })
    await curator.supersede(ENTRY, OTHER)
    const att = readAttestations((await readEntry(fs)).data)
    expect(att[att.length - 1]!.identity).toBe("ws://users/sarah")
  })
})

describe("CorpusAdapterCore.explain", () => {
  it("returns provenance for a real entry: sources + attestation chain", async () => {
    const { adapter } = build()
    const prov = await adapter.explain(ENTRY)
    expect(prov).not.toBeNull()
    expect(prov!.sourceId).toBe(ENTRY)
    expect(prov!.derivedFrom).toContain("tiktok-hook-2026-05")
    expect(prov!.supersededBy).toBeUndefined()
    expect(prov!.metadata).toMatchObject({ type: "entry", entryPath: ENTRY_PATH, status: "active" })
  })

  it("reflects a prior supersede", async () => {
    const { adapter } = build()
    await adapter.supersede(ENTRY, OTHER)
    const prov = await adapter.explain(ENTRY)
    expect(prov!.supersededBy).toBe(OTHER)
    expect(prov!.metadata).toMatchObject({ status: "deprecated" })
    expect(prov!.attestations!.at(-1)).toMatchObject({ kind: "deprecated" })
  })

  it("returns null for an unknown id", async () => {
    const { adapter } = build()
    expect(await adapter.explain("does-not-exist")).toBeNull()
  })

  it("explains an AIP-10 source", async () => {
    const { adapter } = build()
    const [src] = await adapter.listSources()
    const prov = await adapter.explain(src!.id)
    expect(prov?.metadata).toMatchObject({ type: "source" })
    expect(prov?.sourceId).toBe(src!.id)
  })

  it("resolves a backing-engine source id to its entry", async () => {
    const { adapter, backing } = build()
    const ingested = await backing.ingest({
      kind: "text",
      uri: "x",
      content: "c",
      metadata: { corpus: { entrySlug: ENTRY } },
    })
    const prov = await adapter.explain(ingested.id)
    expect(prov?.sourceId).toBe(ENTRY)
  })

  it("filters provenance the caller may not see (null, not an error)", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: t",
        "title: T",
        "description: t",
        'version: "1.0.0"',
        "---",
      ].join("\n"),
      "entries/foo.md": [
        "---",
        "schema: knowledge.entry/v1",
        "slug: foo",
        "kind: principle",
        "title: Foo",
        'updated_at: "2026-01-01T00:00:00Z"',
        "sources: [secret-source]",
        "metadata:",
        "  corpus:",
        "    status: active",
        "    access:",
        "      classification: restricted",
        "      allowedGuilds: [acme]",
        "---",
        "body",
      ].join("\n"),
    })
    const { provider: backing } = makeStubProvider()
    const make = (identityTree: string[]) =>
      new CorpusAdapterCore({ fs, workspacePath: "", backing, caller: { identityTree } })

    expect(await make(["ws://users/outsider"]).explain("foo")).toBeNull()
    const insider = await make(["ws://operators/sarah", "ws://guilds/acme"]).explain("foo")
    expect(insider?.derivedFrom).toEqual(["secret-source"])

    // an invisible entry can't be superseded either, and reads as not found
    await expect(make(["ws://users/outsider"]).supersede("foo")).rejects.toThrow(/not found/)
  })
})
