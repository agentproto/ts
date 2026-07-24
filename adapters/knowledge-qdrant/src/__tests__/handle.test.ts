/**
 * Tests for the provider-kit family wiring: the catalog, the slug→handle
 * resolver (including the unknown-slug → null fold), the secret-free `info()`
 * descriptor, the setup/auth flags, and the env-guarded `check()` /
 * `provider()` lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { KNOWLEDGE_QDRANT_CATALOG, QDRANT_SLUG } from "../catalog.js"
import {
  makeKnowledgeQdrantResolver,
  resolveKnowledgeBackend,
} from "../handle.js"

describe("catalog", () => {
  it("advertises the single qdrant backend under this package", () => {
    expect(KNOWLEDGE_QDRANT_CATALOG).toHaveLength(1)
    const entry = KNOWLEDGE_QDRANT_CATALOG[0]!
    expect(entry.slug).toBe(QDRANT_SLUG)
    expect(entry.packageName).toBe("@agentproto/adapter-knowledge-qdrant")
  })
})

describe("resolveKnowledgeBackend", () => {
  it("resolves the qdrant slug to a setup-required, auth-required handle", () => {
    const handle = resolveKnowledgeBackend(QDRANT_SLUG)
    expect(handle.slug).toBe("qdrant")
    expect(handle.requiresSetup).toBe(true)
    expect(handle.authRequired).toBe(true)
    expect(handle.version).toBe("0.1.0")
  })

  it("returns a secret-free descriptor from info()", () => {
    const info = resolveKnowledgeBackend(QDRANT_SLUG).info()
    expect(info).toEqual({
      slug: "qdrant",
      engine: "qdrant",
      capabilities: { vectorSearch: true, needsCreds: true },
    })
  })

  it("throws for an unknown slug", () => {
    expect(() => resolveKnowledgeBackend("files")).toThrow(/unknown/)
  })
})

describe("makeKnowledgeQdrantResolver", () => {
  it("resolves a known slug and folds an unknown slug to null", async () => {
    const resolver = makeKnowledgeQdrantResolver()
    expect((await resolver(QDRANT_SLUG))?.slug).toBe("qdrant")
    expect(await resolver("files")).toBeNull()
  })
})

describe("env-guarded lifecycle", () => {
  const saved = {
    url: process.env.QDRANT_URL,
    key: process.env.OPENAI_API_KEY,
  }

  beforeEach(() => {
    delete process.env.QDRANT_URL
    delete process.env.OPENAI_API_KEY
  })

  afterEach(() => {
    if (saved.url === undefined) delete process.env.QDRANT_URL
    else process.env.QDRANT_URL = saved.url
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.key
  })

  it("check() folds a missing-env construction failure to false", async () => {
    const handle = resolveKnowledgeBackend(QDRANT_SLUG)
    expect(await handle.check()).toBe(false)
  })

  it("provider() throws when the required env is absent", () => {
    const handle = resolveKnowledgeBackend(QDRANT_SLUG)
    expect(() => handle.provider()).toThrow(/QDRANT_URL is required/)
  })

  it("provider() builds an adapter once the env is present", () => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333"
    process.env.OPENAI_API_KEY = "sk-test"
    const handle = resolveKnowledgeBackend(QDRANT_SLUG)
    expect(handle.provider().id).toBe("qdrant")
  })
})
