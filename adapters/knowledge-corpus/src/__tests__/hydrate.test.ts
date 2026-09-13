/**
 * hydrateHit — legal validity window on the temporal block.
 *
 * `inForceFrom`/`inForceTo`/`abrogated`/`versionedAt` are provenance about
 * when a norm is legally in force, distinct from `halfLifeDays` (marketing-
 * style relevance decay, already covered by the temporalScore/decay math
 * elsewhere). This file proves the pass-through is verbatim and additive:
 * present when declared, absent (not `undefined`-valued) when not, and
 * `computeTemporalScore`'s own fields are untouched either way.
 */

import { describe, expect, it } from "vitest"
import type { CorpusWorkspaceSnapshot, ParsedFile } from "@agentproto/corpus"
import type { KnowledgeHit } from "@agentproto/knowledge-engine"
import { buildCorpusIndex, hydrateHit } from "../hydrate.js"

function makeEntry(metadata: Record<string, unknown>): ParsedFile {
  return {
    path: "entries/foo.md",
    kind: "knowledge-entry",
    frontmatter: {
      slug: "foo",
      updated_at: "2026-01-01T00:00:00.000Z",
      metadata,
    },
    body: "",
    versionToken: "test-token",
  }
}

function makeSnapshot(entry: ParsedFile): CorpusWorkspaceSnapshot {
  return {
    root: "/fixtures",
    workspace: null,
    sources: [],
    entries: [entry],
    collections: [],
    collectionItems: [],
    playbooks: [],
    operators: [],
    workflows: [],
    routines: [],
    unknown: [],
  }
}

function makeHit(slug: string): KnowledgeHit {
  return {
    sourceId: "src-1",
    chunkId: "chunk-1",
    text: "hit text",
    score: 1,
    metadata: { corpus: { entrySlug: slug } },
  }
}

describe("hydrateHit — legal validity window (temporal, distinct from half-life decay)", () => {
  it("surfaces inForceFrom/inForceTo/abrogated/versionedAt when declared", () => {
    const entry = makeEntry({
      corpus: {
        entrySlug: "foo",
        temporal: {
          lastSeen: "2026-01-01T00:00:00.000Z",
          inForceFrom: "1992-01-01",
          inForceTo: "2025-10-01",
          abrogated: true,
          versionedAt: "2026-06-01",
        },
      },
    })
    const index = buildCorpusIndex(makeSnapshot(entry))
    const hydrated = hydrateHit(makeHit("foo"), index, Date.parse("2026-08-13"))
    const temporal = (hydrated.metadata as Record<string, unknown>).temporal as Record<
      string,
      unknown
    >

    expect(temporal).toMatchObject({
      inForceFrom: "1992-01-01",
      inForceTo: "2025-10-01",
      abrogated: true,
      versionedAt: "2026-06-01",
    })
    // No scoring change: these fields ride alongside the existing block.
    expect(temporal.lastSeen).toBe("2026-01-01T00:00:00.000Z")
    expect(temporal.mentionCount).toBe(0)
  })

  it("omits the legal-validity fields entirely when the entry declares no validity window", () => {
    const entry = makeEntry({
      corpus: {
        entrySlug: "foo",
        temporal: { lastSeen: "2026-01-01T00:00:00.000Z" },
      },
    })
    const index = buildCorpusIndex(makeSnapshot(entry))
    const hydrated = hydrateHit(makeHit("foo"), index, Date.parse("2026-08-13"))
    const temporal = (hydrated.metadata as Record<string, unknown>).temporal as Record<
      string,
      unknown
    >

    expect(Object.keys(temporal).sort()).toEqual(
      ["lastSeen", "mentionCount", "temporalScore"].sort()
    )
  })
})
