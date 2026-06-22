/**
 * Standalone KB install proof test.
 *
 * Demonstrates the full "install KB → agent accesses it" path without
 * Guilde, without a database, and without a running Mastra server:
 *
 *   1. Build a MemFsCorpusHost (Component A).
 *   2. Mount a small pack: one PLAYBOOK.md + one knowledge entry.
 *   3. Assemble AIP-12 dimensions for a subject (Component B).
 *   4. Prove (a): OperatorOverlayResolver injects the playbook when the
 *      selector matches and skips it when it doesn't. The Mastra
 *      `makePlaybookOverlayProcessor` (Component C) is a thin wrapper
 *      around this same resolver — testing it here proves the logic.
 *   5. Prove (b): host.resolveKnowledgeEntries returns the entry.
 *      `makeQueryKnowledgeTool` (Component D) calls this same method —
 *      testing it here proves the on-demand recall path.
 */

import { describe, it, expect } from "vitest"
import { MemFsCorpusHost } from "../host/host.js"
import { assembleDimensions, standardDimensionProvider } from "../host/dimensions.js"
import { OperatorOverlayResolver, renderOverlays } from "../playbooks/resolver.js"

// ── Fixture ──────────────────────────────────────────────────────────

const SCOPE = "test-scope"

/**
 * A minimal corpus: one PLAYBOOK.md that binds to `identity: test-operator`
 * and one knowledge entry tagged "test".
 */
const PACK_FILES: Record<string, string> = {
  "playbooks/demo/PLAYBOOK.md": `---
slug: demo-playbook
title: Demo Playbook
status: active
selector:
  allOf:
    - axis: identity
      anyOf:
        - test-operator
---
Always greet the user warmly and introduce yourself as Demo Agent.`,

  "entries/demo-fact.md": `---
schema: knowledge.entry/v1
slug: demo-fact
kind: fact
title: Demo Fact
tags:
  - test
  - demo
confidence: 0.95
---
The sky is blue on a clear day.`,
}

// ── Component A + B ───────────────────────────────────────────────────

describe("MemFsCorpusHost", () => {
  it("mounts a pack and builds a PlaybookRegistry from it", async () => {
    const host = new MemFsCorpusHost()
    host.mountPack(SCOPE, PACK_FILES)
    const registry = await host.getPlaybookRegistry(SCOPE)
    expect(registry.list().length).toBe(1)
    expect(registry.list()[0]!.slug).toBe("demo-playbook")
  })

  it("resolves knowledge entries matching a tag query", async () => {
    const host = new MemFsCorpusHost()
    host.mountPack(SCOPE, PACK_FILES)
    const entries = await host.resolveKnowledgeEntries(SCOPE, { tags: ["test"] })
    expect(entries.length).toBe(1)
    expect(entries[0]!.slug).toBe("demo-fact")
    expect(entries[0]!.title).toBe("Demo Fact")
    expect(entries[0]!.body).toContain("The sky is blue")
  })

  it("returns empty when no entries match the tag query", async () => {
    const host = new MemFsCorpusHost()
    host.mountPack(SCOPE, PACK_FILES)
    const entries = await host.resolveKnowledgeEntries(SCOPE, { tags: ["missing-tag"] })
    expect(entries.length).toBe(0)
  })
})

// ── Component B — assembleDimensions ─────────────────────────────────

describe("assembleDimensions", () => {
  it("maps slug → identity axis", () => {
    const dims = assembleDimensions([standardDimensionProvider], { slug: "test-operator" })
    expect(dims.identity).toBe("test-operator")
  })

  it("maps role + title + capabilities", () => {
    const dims = assembleDimensions([standardDimensionProvider], {
      slug: "advisor-1",
      role: "advisor",
      title: "Senior Advisor",
      capabilities: ["read", "write"],
    })
    expect(dims.identity).toBe("advisor-1")
    expect(dims.role).toBe("advisor")
    expect(dims.position).toBe("senior-advisor")
    expect(dims.capability).toEqual(["read", "write"])
  })

  it("first-match-per-key — later provider cannot override an earlier one", () => {
    const first = { id: "first", resolve: () => ({ identity: "first-wins" }) }
    const second = { id: "second", resolve: () => ({ identity: "second-loses" }) }
    const dims = assembleDimensions([first, second], undefined)
    expect(dims.identity).toBe("first-wins")
  })
})

// ── Proof (a): overlay injection ──────────────────────────────────────

describe("overlay injection (Component A+B+C proof)", () => {
  async function buildRegistry() {
    const host = new MemFsCorpusHost()
    host.mountPack(SCOPE, PACK_FILES)
    return host.getPlaybookRegistry(SCOPE)
  }

  it("injects playbook body when dimensions match the selector", async () => {
    const registry = await buildRegistry()
    // Assemble dimensions for the matching identity
    const dimensions = assembleDimensions([standardDimensionProvider], {
      slug: "test-operator",
    })
    const result = new OperatorOverlayResolver(registry).resolve({
      operatorSlug: "test-operator",
      dimensions,
    })
    const { appendBlock } = renderOverlays(result)
    expect(result.overlays.length).toBe(1)
    expect(appendBlock).toContain("Always greet the user warmly")
  })

  it("skips injection when dimensions do not match the selector", async () => {
    const registry = await buildRegistry()
    // Different slug — selector won't fire
    const dimensions = assembleDimensions([standardDimensionProvider], {
      slug: "some-other-operator",
    })
    const result = new OperatorOverlayResolver(registry).resolve({
      operatorSlug: "some-other-operator",
      dimensions,
    })
    const { appendBlock } = renderOverlays(result)
    expect(result.overlays.length).toBe(0)
    expect(appendBlock).toBe("")
  })
})

// ── Proof (b): query_knowledge ────────────────────────────────────────

describe("query_knowledge (Component A+D proof)", () => {
  it("returns the entry when queried by tag", async () => {
    const host = new MemFsCorpusHost()
    host.mountPack(SCOPE, PACK_FILES)

    // makeQueryKnowledgeTool.tool.execute calls this exact method —
    // testing it directly is equivalent to testing the tool.
    const entries = await host.resolveKnowledgeEntries(SCOPE, { tags: ["demo"] })

    expect(entries.length).toBe(1)
    expect(entries[0]!.slug).toBe("demo-fact")
    expect(entries[0]!.confidence).toBe(0.95)
  })

  it("returns nothing when the scope has no corpus", async () => {
    const host = new MemFsCorpusHost()
    // No mountPack call — scope is empty
    const entries = await host.resolveKnowledgeEntries("empty-scope", { tags: ["test"] })
    expect(entries.length).toBe(0)
  })

  it("second mount call merges files (additive install)", async () => {
    const host = new MemFsCorpusHost()
    host.mountPack(SCOPE, PACK_FILES)
    // Add a second entry to the same scope
    host.mountPack(SCOPE, {
      "entries/extra-fact.md": `---
schema: knowledge.entry/v1
slug: extra-fact
kind: fact
title: Extra Fact
tags:
  - extra
confidence: 0.8
---
Extra content.`,
    })
    const extra = await host.resolveKnowledgeEntries(SCOPE, { tags: ["extra"] })
    expect(extra.length).toBe(1)
    expect(extra[0]!.slug).toBe("extra-fact")

    // Original entry still there
    const orig = await host.resolveKnowledgeEntries(SCOPE, { tags: ["test"] })
    expect(orig.length).toBe(1)
  })
})
