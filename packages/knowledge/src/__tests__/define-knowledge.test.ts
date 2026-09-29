import { describe, it, expect } from "vitest"
import { defineKnowledge } from "../define-knowledge.js"
import type { KnowledgeDefinition } from "../types.js"

const entry = {
  schema: "knowledge.entry/v1",
  slug: "alex-park",
  kind: "entity",
  title: "Alex Park",
  updated_at: "2026-04-27T17:00:00Z",
} as unknown as KnowledgeDefinition

const source = {
  schema: "knowledge.source/v1",
  id: "2026-04-27-investor-call",
  path: "sources/2026-04-27-investor-call.md",
  title: "Investor call",
  captured_at: "2026-04-27T17:00:00Z",
  content_hash: "sha256:abc123",
} as unknown as KnowledgeDefinition

const workspace = {
  schema: "knowledge.workspace/v1",
  name: "research-wiki",
  title: "Research wiki",
  description: "A research wiki.",
  version: "1.0.0",
} as unknown as KnowledgeDefinition

const rejects = (def: unknown, re: RegExp) =>
  expect(() => defineKnowledge(def as KnowledgeDefinition)).toThrow(re)

describe("defineKnowledge (AIP-10)", () => {
  it("accepts a minimal entry (no description field in this branch)", () => {
    const h = defineKnowledge(entry)
    expect(h.schema).toBe("knowledge.entry/v1")
    expect(Object.isFrozen(h)).toBe(true)
  })

  it("accepts a minimal source (no description field in this branch)", () => {
    expect(defineKnowledge(source).schema).toBe("knowledge.source/v1")
  })

  it("accepts a minimal workspace", () => {
    expect(defineKnowledge(workspace).schema).toBe("knowledge.workspace/v1")
  })

  it("accepts identities up to the schema's 96-char maximum", () => {
    const long = `a${"b".repeat(94)}c`
    expect(long).toHaveLength(96)
    expect(defineKnowledge({ ...entry, slug: long } as never).schema).toBe("knowledge.entry/v1")
    expect(defineKnowledge({ ...source, id: long } as never).schema).toBe("knowledge.source/v1")
    expect(defineKnowledge({ ...workspace, name: long } as never).schema).toBe(
      "knowledge.workspace/v1",
    )
  })

  it("accepts native Dates for timestamps (YAML parses unquoted ISO to Date)", () => {
    const h = defineKnowledge({ ...entry, updated_at: new Date("2026-04-27T17:00:00Z") } as never)
    expect((h as { updated_at: string }).updated_at).toBe("2026-04-27T17:00:00.000Z")
  })

  it("rejects an unknown discriminator", () => {
    rejects({ ...entry, schema: "knowledge.nope/v1" }, /defineKnowledge/)
  })

  it("rejects a missing identity per branch", () => {
    rejects({ ...entry, slug: undefined }, /invalid id/)
    rejects({ ...source, id: undefined }, /invalid id/)
    rejects({ ...workspace, name: undefined }, /invalid id/)
  })

  it("rejects an over-long identity", () => {
    rejects({ ...entry, slug: `a${"b".repeat(96)}c` }, /defineKnowledge/)
  })

  it("rejects an unknown top-level key (strict)", () => {
    rejects({ ...entry, bogus: 1 }, /defineKnowledge \(AIP-10\)/)
  })

  it("rejects confidence out of range", () => {
    rejects({ ...entry, confidence: 2 }, /confidence/)
  })

  it("rejects a source path outside sources/", () => {
    rejects({ ...source, path: "elsewhere/x.md" }, /path/)
  })

  it("rejects a workspace without a description", () => {
    rejects({ ...workspace, description: undefined }, /description/)
  })

  it("applies schema defaults to the handle", () => {
    const h = defineKnowledge(entry) as unknown as { sources: string[]; confidence: number }
    expect(h.sources).toEqual([])
    expect(h.confidence).toBe(1)
  })

  it("requires extends when appliesTo is non-empty (view rule)", () => {
    rejects({ ...workspace, appliesTo: ["ws://operators/x"] }, /extends MUST be set/)
    expect(
      defineKnowledge({
        ...workspace,
        appliesTo: ["ws://operators/x"],
        extends: "../base/KNOWLEDGE.md",
      } as never).schema,
    ).toBe("knowledge.workspace/v1")
  })
})
