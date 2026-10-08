import { describe, it, expect } from "vitest"
import { createFakeKnowledgeProvider } from "../testing/fake-knowledge-provider.js"
import { knowledgeProvenanceSchema } from "../types.js"
import { KnowledgeNotSupportedError } from "../errors.js"

describe("supersede / explain on the fake provider", () => {
  it("explain returns null for an unknown id", async () => {
    const kb = createFakeKnowledgeProvider()
    expect(await kb.explain("nope")).toBeNull()
  })

  it("supersede is reflected in explain and survives (not a delete)", async () => {
    const kb = createFakeKnowledgeProvider()
    const a = await kb.ingest({ kind: "text", uri: "u://a", content: "old" })
    const b = await kb.ingest({ kind: "text", uri: "u://b", content: "new" })
    await kb.supersede(a.id, b.id)
    expect(await kb.getSource(a.id)).not.toBeNull()
    const prov = await kb.explain(a.id)
    expect(prov?.supersededBy).toBe(b.id)
    expect(knowledgeProvenanceSchema.safeParse(prov).success).toBe(true)
  })

  it("supersede on an unknown id rejects", async () => {
    const kb = createFakeKnowledgeProvider()
    await expect(kb.supersede("nope")).rejects.toThrow(/unknown source/)
  })
})

describe("KnowledgeNotSupportedError", () => {
  it("carries engine + operation", () => {
    const err = new KnowledgeNotSupportedError("qdrant", "supersede")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("KnowledgeNotSupportedError")
    expect(err.engine).toBe("qdrant")
    expect(err.operation).toBe("supersede")
    expect(err.message).toContain("supersede() is not supported")
  })
})
