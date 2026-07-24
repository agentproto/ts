/**
 * Access policy middleware in CorpusAdapterCore.
 *
 * Proves the adapter silently filters hits + sources based on the
 * caller's identity tree, when a caller is supplied at construction.
 *
 * Ported verbatim from the studio corpus provider's
 * `__tests__/access-policy.test.ts` — only the adapter import path changes
 * (now `../adapter.js`).
 */

import { describe, expect, it } from "vitest"
import { CorpusAdapterCore } from "../adapter.js"
import { loadM0FixtureFs, makeStubProvider, MemoryFs } from "./_helpers.js"

describe("CorpusAdapterCore access-policy middleware", () => {
  it("no caller supplied → admin-style passthrough (no filtering)", async () => {
    const fs = await loadM0FixtureFs()
    const { provider: backing } = makeStubProvider({
      hitsForQuery: () => [
        {
          sourceId: "x",
          chunkId: "x-0",
          text: "hit",
          score: 0.9,
          metadata: {
            corpus: { entrySlug: "contrarian-short-form-hooks" },
          },
        },
      ],
    })
    const adapter = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      // caller intentionally omitted
    })
    const r = await adapter.query({ query: "x" })
    expect(r.hits.length).toBe(1)
  })

  it("caller scoped to a different guild → hit filtered when access=internal", async () => {
    // Build a tiny synthetic workspace where the one entry has
    // metadata.corpus.access.classification = "internal" + allowedGuilds=["acme"].
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
    const { provider: backing } = makeStubProvider({
      hitsForQuery: () => [
        {
          sourceId: "x",
          chunkId: "x-0",
          text: "hit",
          score: 0.9,
          metadata: { corpus: { entrySlug: "foo" } },
        },
      ],
    })

    // Outsider caller — no allowed-list match, restricted ≠ permitted.
    const outsider = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      caller: { identityTree: ["ws://users/outsider"] },
    })
    const r1 = await outsider.query({ query: "x" })
    expect(r1.hits.length).toBe(0) // silent filter

    // Acme caller — guild matches the allowed-list, permitted.
    const insider = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      caller: {
        identityTree: ["ws://operators/sarah", "ws://guilds/acme"],
      },
    })
    const r2 = await insider.query({ query: "x" })
    expect(r2.hits.length).toBe(1)
  })

  it("listSources filters by access spec on each source", async () => {
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
      "sources/public/a.md": [
        "---",
        "schema: knowledge.source/v1",
        "id: pub",
        "path: sources/public/a.md",
        "title: Public",
        'captured_at: "2026-01-01T00:00:00Z"',
        "content_hash: sha256:aaaa",
        "metadata:",
        "  corpus:",
        "    access:",
        "      classification: public",
        "---",
      ].join("\n"),
      "sources/restricted/b.md": [
        "---",
        "schema: knowledge.source/v1",
        "id: priv",
        "path: sources/restricted/b.md",
        "title: Private",
        'captured_at: "2026-01-01T00:00:00Z"',
        "content_hash: sha256:bbbb",
        "metadata:",
        "  corpus:",
        "    access:",
        "      classification: restricted",
        "      allowedRoles: [legal-counsel]",
        "---",
      ].join("\n"),
    })
    const { provider: backing } = makeStubProvider()
    const operator = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      caller: {
        identityTree: [
          "ws://operators/sarah",
          "ws://roles/marketing-analyst",
          "ws://guilds/acme",
        ],
      },
    })
    const sources = await operator.listSources()
    expect(sources.map(s => s.id)).toEqual(["pub"])
    // getSource on the restricted one returns null (silent)
    expect(await operator.getSource("priv")).toBeNull()
    expect(await operator.getSource("pub")).not.toBeNull()

    // Legal counsel sees both
    const counsel = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      caller: {
        identityTree: [
          "ws://operators/legal-bot",
          "ws://roles/legal-counsel",
          "ws://guilds/acme",
        ],
      },
    })
    const sourcesC = await counsel.listSources()
    expect(sourcesC.map(s => s.id).sort()).toEqual(["priv", "pub"])
  })

  it("fails closed on non-corpus hits when a caller is set", async () => {
    // Defense in depth: a chunk in the backing engine that lacks a
    // corpus.entrySlug has no verifiable access spec, so the adapter
    // hides it from any non-admin caller. (Admin = no `caller` set;
    // tested separately.) This prevents an attacker who removed an
    // entry's file — or chunks lingering from a deleted entry — from
    // being harvested through the corpus engine.
    const fs = await loadM0FixtureFs()
    const { provider: backing } = makeStubProvider({
      hitsForQuery: () => [
        {
          sourceId: "x",
          chunkId: "x-0",
          text: "hit",
          score: 0.9,
          metadata: { title: "Random" }, // no corpus.entrySlug
        },
      ],
    })
    const adapter = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      caller: { identityTree: ["ws://users/outsider"] },
    })
    const r = await adapter.query({ query: "x" })
    expect(r.hits.length).toBe(0)
  })

  it("fails closed when entry referenced by chunk is missing from workspace", async () => {
    // Stale chunk: backing engine still has chunks pointing at an
    // entry slug, but the entry file is gone (deleted out of band, or
    // the indexer hasn't caught up). With a caller present, we hide
    // the hit because there's no canonical frontmatter to evaluate
    // access against.
    const fs = await loadM0FixtureFs()
    const { provider: backing } = makeStubProvider({
      hitsForQuery: () => [
        {
          sourceId: "x",
          chunkId: "x-0",
          text: "hit",
          score: 0.9,
          metadata: { corpus: { entrySlug: "nonexistent-slug" } },
        },
      ],
    })
    const adapter = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      caller: { identityTree: ["ws://users/outsider"] },
    })
    const r = await adapter.query({ query: "x" })
    expect(r.hits.length).toBe(0)
  })

  it("admin path (no caller) still sees non-corpus and unindexed hits", async () => {
    // Admin / indexer construction: no `caller` supplied. Fail-closed
    // doesn't apply — every hit reaches the consumer. Required for the
    // drift-detector and indexer paths that need to see the full
    // backing-engine state.
    const fs = await loadM0FixtureFs()
    const { provider: backing } = makeStubProvider({
      hitsForQuery: () => [
        {
          sourceId: "x",
          chunkId: "x-0",
          text: "hit",
          score: 0.9,
          metadata: { title: "Random" },
        },
        {
          sourceId: "y",
          chunkId: "y-0",
          text: "stale",
          score: 0.8,
          metadata: { corpus: { entrySlug: "nonexistent-slug" } },
        },
      ],
    })
    const adapter = new CorpusAdapterCore({
      fs,
      workspacePath: "",
      backing,
      // no caller → admin/indexer path
    })
    const r = await adapter.query({ query: "x" })
    expect(r.hits.length).toBe(2)
  })
})
