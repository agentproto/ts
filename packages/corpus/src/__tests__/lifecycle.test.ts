/**
 * Lifecycle end-to-end: sidecar + state machine + gate + indexer +
 * promote.
 *
 * Append a candidate row to _candidates.yaml, transition it to
 * analyzed, run the gate, promote, verify entry file written +
 * _index.md updated + _log.md has the promotion event + the
 * WriterPort received the chunked entry.
 */

import { describe, expect, it } from "vitest"
import {
  CandidatesSidecar,
  SidecarDuplicateError,
  SidecarNotFoundError,
} from "../workspace/sidecar.js"
import {
  canTransition,
  DEFAULT_TRANSITIONS,
  IllegalTransitionError,
  assertTransition,
  transitionGraphFromCollection,
} from "../lifecycle/candidate.js"
import {
  evaluateGate,
  extractAutoPromoteConfig,
} from "../lifecycle/gate.js"
import { CorpusPromoter, PromoteRejectedError } from "../lifecycle/promote.js"
import { CorpusIndexer } from "../index/indexer.js"
import { chunkText } from "../index/chunker.js"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import type { WriterPort, PushChunksInput } from "../ports/writer.port.js"
import { MemoryFs, loadM0FixtureFs } from "./_helpers/memory-fs.js"

// ── Sidecar ─────────────────────────────────────────────────────────

describe("CandidatesSidecar (M3)", () => {
  it("load returns [] when the file doesn't exist", async () => {
    const fs = new MemoryFs()
    const sidecar = new CandidatesSidecar({
      fs,
      path: "collections/corpus-candidate/_candidates.yaml",
    })
    expect(await sidecar.load()).toEqual([])
  })

  it("append + load round-trips YAML", async () => {
    const fs = new MemoryFs()
    const sidecar = new CandidatesSidecar({
      fs,
      path: "_candidates.yaml",
    })
    await sidecar.append({
      id: "tiktok-hook-2026-05",
      status: "discovered",
      sourceUrl: "https://example.com",
      contentHash: "sha256:abc",
      discoveredAt: "2026-05-22T14:30:00Z",
      discoveredBy: "ws://operators/source-scout",
    })
    await sidecar.append({
      id: "linkedin-cta-pattern",
      status: "discovered",
      sourceUrl: "https://example.com/2",
      contentHash: "sha256:def",
    })
    const all = await sidecar.load()
    expect(all.length).toBe(2)
    expect(all[0]?.id).toBe("tiktok-hook-2026-05")
    expect(all[0]?.status).toBe("discovered")
  })

  it("append refuses duplicates", async () => {
    const fs = new MemoryFs()
    const sidecar = new CandidatesSidecar({ fs, path: "_c.yaml" })
    await sidecar.append({ id: "a", status: "discovered" })
    await expect(
      sidecar.append({ id: "a", status: "discovered" })
    ).rejects.toBeInstanceOf(SidecarDuplicateError)
  })

  it("update mutates a row in-place", async () => {
    const fs = new MemoryFs()
    const sidecar = new CandidatesSidecar({ fs, path: "_c.yaml" })
    await sidecar.append({ id: "a", status: "discovered", note: "first" })
    const updated = await sidecar.update("a", { note: "second" })
    expect(updated.note).toBe("second")
    expect(updated.status).toBe("discovered")
  })

  it("take removes and returns the row", async () => {
    const fs = new MemoryFs()
    const sidecar = new CandidatesSidecar({ fs, path: "_c.yaml" })
    await sidecar.append({ id: "a", status: "discovered" })
    await sidecar.append({ id: "b", status: "discovered" })
    const removed = await sidecar.take("a")
    expect(removed.id).toBe("a")
    const rest = await sidecar.load()
    expect(rest.length).toBe(1)
    expect(rest[0]?.id).toBe("b")
  })

  it("take on missing id throws SidecarNotFoundError", async () => {
    const fs = new MemoryFs()
    const sidecar = new CandidatesSidecar({ fs, path: "_c.yaml" })
    await expect(sidecar.take("ghost")).rejects.toBeInstanceOf(
      SidecarNotFoundError
    )
  })
})

// ── State machine ──────────────────────────────────────────────────

describe("Candidate state machine (M3)", () => {
  it("permits discovered → analyzed", () => {
    expect(canTransition("discovered", "analyzed").allowed).toBe(true)
  })
  it("permits analyzed → approved | rejected | needs-work", () => {
    for (const to of ["approved", "rejected", "needs-work"] as const) {
      expect(canTransition("analyzed", to).allowed).toBe(true)
    }
  })
  it("rejects approved → anything (terminal)", () => {
    const r = canTransition("approved", "analyzed")
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/terminal/)
  })
  it("rejects same-status no-ops", () => {
    expect(canTransition("discovered", "discovered").allowed).toBe(false)
  })
  it("assertTransition throws IllegalTransitionError on disallowed", () => {
    expect(() => assertTransition("approved", "rejected")).toThrow(
      IllegalTransitionError
    )
  })
  it("transitionGraphFromCollection reads COLLECTION.md statuses", () => {
    const graph = transitionGraphFromCollection({
      statuses: [
        { id: "open", transitionsTo: ["closed"] },
        { id: "closed", terminal: true },
      ],
    })
    expect(graph.open).toEqual(["closed"])
    expect(graph.closed).toEqual([])
  })
  it("transitionGraphFromCollection falls back to defaults when no statuses", () => {
    const graph = transitionGraphFromCollection({})
    expect(graph).toBe(DEFAULT_TRANSITIONS)
  })
})

// ── Gate ────────────────────────────────────────────────────────────

describe("Auto-promote gate (M3)", () => {
  const ENABLED_CONFIG = {
    enabled: true,
    requires: {
      qualityScore: { min: 4.2 },
      riskScore: { max: 1.5 },
      hasArchiveHash: true,
      requiredFields: ["why_it_works", "transferable_pattern", "use_when"],
      notRestricted: true,
    },
  }

  it("passes when every requirement holds", () => {
    const r = evaluateGate(
      {
        frontmatter: {
          metadata: {
            corpus: {
              qualityScore: 4.5,
              riskScore: 1.0,
              contentHash: "sha256:abc",
              access: { classification: "internal" },
            },
          },
        },
        body: "## Why it works\nfoo\n## Transferable pattern\nbar\n## Use when\nbaz",
      },
      ENABLED_CONFIG
    )
    expect(r.passed).toBe(true)
    expect(r.failures.length).toBe(0)
    expect(r.disabled).toBe(false)
  })

  it("fails when qualityScore is below min", () => {
    const r = evaluateGate(
      {
        frontmatter: {
          metadata: {
            corpus: {
              qualityScore: 3.0,
              riskScore: 1.0,
              contentHash: "sha256:abc",
            },
          },
        },
        body: "## Why it works\n## Transferable pattern\n## Use when",
      },
      ENABLED_CONFIG
    )
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.rule === "qualityScore")).toBe(true)
  })

  it("fails when riskScore is above max", () => {
    const r = evaluateGate(
      {
        frontmatter: {
          metadata: {
            corpus: {
              qualityScore: 4.5,
              riskScore: 2.0,
              contentHash: "sha256:abc",
            },
          },
        },
        body: "## Why it works\n## Transferable pattern\n## Use when",
      },
      ENABLED_CONFIG
    )
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.rule === "riskScore")).toBe(true)
  })

  it("fails when hasArchiveHash is required but missing", () => {
    const r = evaluateGate(
      {
        frontmatter: {
          metadata: { corpus: { qualityScore: 4.5, riskScore: 1.0 } },
        },
        body: "## Why it works\n## Transferable pattern\n## Use when",
      },
      ENABLED_CONFIG
    )
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.rule === "hasArchiveHash")).toBe(true)
  })

  it("fails when required-fields aren't present in body or analysis", () => {
    const r = evaluateGate(
      {
        frontmatter: {
          metadata: {
            corpus: {
              qualityScore: 4.5,
              riskScore: 1.0,
              contentHash: "sha256:abc",
            },
          },
        },
        body: "## Why it works\nfoo",  // missing transferable_pattern + use_when
      },
      ENABLED_CONFIG
    )
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.rule === "requiredFields")).toBe(true)
  })

  it("fails when access.classification is restricted", () => {
    const r = evaluateGate(
      {
        frontmatter: {
          metadata: {
            corpus: {
              qualityScore: 4.5,
              riskScore: 1.0,
              contentHash: "sha256:abc",
              access: { classification: "restricted" },
            },
          },
        },
        body: "## Why it works\n## Transferable pattern\n## Use when",
      },
      ENABLED_CONFIG
    )
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.rule === "notRestricted")).toBe(true)
  })

  it("returns disabled=true when workspace doesn't declare autoPromote", () => {
    const r = evaluateGate(
      { frontmatter: {}, body: "" },
      { enabled: false }
    )
    expect(r.disabled).toBe(true)
    expect(r.passed).toBe(false)
  })

  it("extractAutoPromoteConfig reads from snapshot.workspace.metadata.corpus.autoPromote", async () => {
    const fs = await loadM0FixtureFs()
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const config = extractAutoPromoteConfig(snapshot)
    expect(config.enabled).toBe(true)
    expect(config.requires?.qualityScore?.min).toBe(4.2)
  })
})

// ── Chunker ─────────────────────────────────────────────────────────

describe("chunkText (M3)", () => {
  it("returns a single chunk when text fits in target", () => {
    const chunks = chunkText("Hello world.")
    expect(chunks).toEqual(["Hello world."])
  })
  it("splits long text into chunks with overlap", () => {
    const long = "x".repeat(5000)
    const chunks = chunkText(long, { targetChars: 1000, overlapChars: 100 })
    expect(chunks.length).toBeGreaterThan(1)
    // Each chunk size at most targetChars
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000)
  })
  it("empty text → empty array", () => {
    expect(chunkText("")).toEqual([])
    expect(chunkText("   ")).toEqual([])
  })
})

// ── Indexer + Promote (end-to-end) ────────────────────────────────

describe("CorpusPromoter end-to-end (M3)", () => {
  function makeStubWriter(): { writer: WriterPort; pushed: PushChunksInput[]; removed: string[] } {
    const pushed: PushChunksInput[] = []
    const removed: string[] = []
    const writer: WriterPort = {
      pushChunks: async (input) => {
        pushed.push(input)
        return input.chunks.map((_, i) => `stub-${pushed.length}-${i}`)
      },
      removeEntry: async (slug) => {
        removed.push(slug)
        return { removed: 1 }
      },
    }
    return { writer, pushed, removed }
  }

  const fixedClock: ClockPort = {
    now: () => new Date("2026-05-22T14:30:00.000Z"),
    nowMs: () => Date.parse("2026-05-22T14:30:00.000Z"),
  }
  const stubIdentity: IdentityPort = {
    resolve: async () => ({
      principal: "ws://operators/corpus-curator",
      identityTree: ["ws://operators/corpus-curator"],
    }),
  }

  it("auto-promote happy path: writes entry, regen index, syncs writer, emits event", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: t",
        "title: T",
        "description: t",
        'version: "1.0.0"',
        "metadata:",
        "  corpus:",
        "    autoPromote:",
        "      enabled: true",
        "      requires:",
        "        qualityScore: { min: 4.0 }",
        "---",
      ].join("\n"),
    })
    const { writer, pushed } = makeStubWriter()
    const indexer = new CorpusIndexer({ writer })
    const promoter = new CorpusPromoter({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      indexer,
    })
    const result = await promoter.promote({
      workspacePath: "",
      entrySlug: "foo",
      entryKind: "principle",
      entryPath: "entries/principles/2026/foo.md",
      frontmatter: {
        schema: "knowledge.entry/v1",
        slug: "foo",
        kind: "principle",
        title: "Foo principle",
        updated_at: "2026-05-22T14:30:00Z",
        metadata: { corpus: { status: "active", qualityScore: 4.5 } },
      },
      body: "## Summary\nfoo body content.",
    })
    expect(result.gatePassed).toBe(true)
    expect(result.bypassed).toBe(false)
    expect(result.chunkCount).toBe(1) // one short body → one chunk

    // Entry written
    expect(await fs.exists("entries/principles/2026/foo.md")).toBe(true)

    // _index.md regenerated with this entry listed
    const index = await fs.readFile("_index.md")
    expect(index).toContain("# Corpus index")
    expect(index).toContain("[[foo]]")

    // Writer received the chunk
    expect(pushed.length).toBe(1)
    expect(pushed[0]?.entrySlug).toBe("foo")
    expect(pushed[0]?.entryMetadata?.kind).toBe("principle")

    // _log.md has the promotion event
    const log = await fs.readFile("_log.md")
    expect(log).toMatch(/corpus\.entry\.promoted/)
    expect(log).toMatch(/"slug":"foo"/)
  })

  it("rejects promotion when gate fails (and no bypass)", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: t",
        "title: T",
        "description: t",
        'version: "1.0.0"',
        "metadata:",
        "  corpus:",
        "    autoPromote:",
        "      enabled: true",
        "      requires:",
        "        qualityScore: { min: 4.5 }",
        "---",
      ].join("\n"),
    })
    const { writer } = makeStubWriter()
    const promoter = new CorpusPromoter({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      indexer: new CorpusIndexer({ writer }),
    })
    await expect(
      promoter.promote({
        workspacePath: "",
        entrySlug: "low-quality",
        entryKind: "principle",
        entryPath: "entries/principles/2026/lq.md",
        frontmatter: {
          schema: "knowledge.entry/v1",
          slug: "low-quality",
          kind: "principle",
          title: "LQ",
          updated_at: "2026-05-22T14:30:00Z",
          metadata: { corpus: { status: "active", qualityScore: 3.0 } },
        },
        body: "## Summary\nshort",
      })
    ).rejects.toBeInstanceOf(PromoteRejectedError)

    // Entry NOT written
    expect(await fs.exists("entries/principles/2026/lq.md")).toBe(false)
  })

  it("bypassGate=true forces promotion with bypassed flag in event payload", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: t",
        "title: T",
        "description: t",
        'version: "1.0.0"',
        "metadata:",
        "  corpus:",
        "    autoPromote:",
        "      enabled: true",
        "      requires: { qualityScore: { min: 4.5 } }",
        "---",
      ].join("\n"),
    })
    const { writer } = makeStubWriter()
    const promoter = new CorpusPromoter({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      indexer: new CorpusIndexer({ writer }),
    })
    const result = await promoter.promote({
      workspacePath: "",
      entrySlug: "bypassed",
      entryKind: "principle",
      entryPath: "entries/principles/2026/b.md",
      frontmatter: {
        schema: "knowledge.entry/v1",
        slug: "bypassed",
        kind: "principle",
        title: "B",
        updated_at: "2026-05-22T14:30:00Z",
        metadata: { corpus: { status: "active", qualityScore: 3.0 } },
      },
      body: "## Summary\nshort",
      bypassGate: true,
    })
    expect(result.bypassed).toBe(true)
    const log = await fs.readFile("_log.md")
    expect(log).toMatch(/"bypassed":true/)
  })

  it("consumes the sidecar row on success", async () => {
    const fs = new MemoryFs({
      "KNOWLEDGE.md": [
        "---",
        "schema: knowledge.workspace/v1",
        "name: t",
        "title: T",
        "description: t",
        'version: "1.0.0"',
        "metadata: { corpus: { autoPromote: { enabled: false } } }",
        "---",
      ].join("\n"),
    })
    const sidecar = new CandidatesSidecar({
      fs,
      path: "collections/corpus-candidate/_candidates.yaml",
    })
    await sidecar.append({ id: "candA", status: "discovered" })

    const { writer } = makeStubWriter()
    const promoter = new CorpusPromoter({
      fs,
      clock: fixedClock,
      identity: stubIdentity,
      indexer: new CorpusIndexer({ writer }),
    })
    await promoter.promote({
      workspacePath: "",
      entrySlug: "cand-a",
      entryKind: "principle",
      entryPath: "entries/principles/2026/cand-a.md",
      frontmatter: {
        schema: "knowledge.entry/v1",
        slug: "cand-a",
        kind: "principle",
        title: "Cand A",
        updated_at: "2026-05-22T14:30:00Z",
      },
      body: "## Summary\nx",
      candidateId: "candA",
      candidateSidecarPath: "collections/corpus-candidate/_candidates.yaml",
    })

    const rest = await sidecar.load()
    expect(rest.length).toBe(0)
  })

  it("removes deprecated entries from the backing engine on reindex", async () => {
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
        "title: F",
        'updated_at: "2026-01-01T00:00:00Z"',
        "metadata: { corpus: { status: deprecated } }",
        "---",
        "body",
      ].join("\n"),
      "entries/bar.md": [
        "---",
        "schema: knowledge.entry/v1",
        "slug: bar",
        "kind: principle",
        "title: B",
        'updated_at: "2026-01-01T00:00:00Z"',
        "metadata: { corpus: { status: active } }",
        "---",
        "body",
      ].join("\n"),
    })
    const { writer, pushed, removed } = makeStubWriter()
    const indexer = new CorpusIndexer({ writer })
    const snapshot = await new CorpusWorkspaceReader({ fs }).read("")
    const report = await indexer.reindex(snapshot)
    expect(report.pushed).toBe(1)
    expect(report.removed).toBe(1)
    expect(pushed[0]?.entrySlug).toBe("bar")
    expect(removed).toContain("foo")
  })
})
