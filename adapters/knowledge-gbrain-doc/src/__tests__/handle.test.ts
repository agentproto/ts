/**
 * Tests for the provider-kit family wiring: the catalog, the slug→handle
 * resolver (including the unknown-slug → null fold), the secret-free `info()`
 * descriptor, the setup/auth flags, and the env-guarded `check()` / `provider()`
 * lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GBRAIN_DOC_SLUG, KNOWLEDGE_GBRAIN_DOC_CATALOG } from "../catalog.js"
import {
  makeKnowledgeGbrainDocResolver,
  resolveKnowledgeBackend,
} from "../handle.js"

describe("catalog", () => {
  it("advertises the single gbrain-doc backend under this package", () => {
    expect(KNOWLEDGE_GBRAIN_DOC_CATALOG).toHaveLength(1)
    const entry = KNOWLEDGE_GBRAIN_DOC_CATALOG[0]!
    expect(entry.slug).toBe(GBRAIN_DOC_SLUG)
    expect(entry.packageName).toBe("@agentproto/adapter-knowledge-gbrain-doc")
  })
})

describe("resolveKnowledgeBackend", () => {
  it("resolves the gbrain-doc slug to a setup-required, auth-required handle", () => {
    const handle = resolveKnowledgeBackend(GBRAIN_DOC_SLUG)
    expect(handle.slug).toBe("gbrain-doc")
    expect(handle.requiresSetup).toBe(true)
    expect(handle.authRequired).toBe(true)
    expect(handle.version).toBe("0.1.0")
  })

  it("returns a secret-free descriptor from info()", () => {
    const info = resolveKnowledgeBackend(GBRAIN_DOC_SLUG).info()
    expect(info).toEqual({
      slug: "gbrain-doc",
      engine: "gbrain-doc",
      capabilities: { hybridSearch: true, needsCreds: true },
    })
  })

  it("throws for an unknown slug", () => {
    expect(() => resolveKnowledgeBackend("qdrant")).toThrow(/unknown/)
  })
})

describe("makeKnowledgeGbrainDocResolver", () => {
  it("resolves a known slug and folds an unknown slug to null", async () => {
    const resolver = makeKnowledgeGbrainDocResolver()
    expect((await resolver(GBRAIN_DOC_SLUG))?.slug).toBe("gbrain-doc")
    expect(await resolver("qdrant")).toBeNull()
  })
})

describe("env-guarded lifecycle", () => {
  const saved = process.env.GBRAIN_BEARER_TOKEN

  beforeEach(() => {
    delete process.env.GBRAIN_BEARER_TOKEN
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.GBRAIN_BEARER_TOKEN
    else process.env.GBRAIN_BEARER_TOKEN = saved
  })

  it("check() folds a missing-env construction failure to false", async () => {
    const handle = resolveKnowledgeBackend(GBRAIN_DOC_SLUG)
    expect(await handle.check()).toBe(false)
  })

  it("provider() throws when GBRAIN_BEARER_TOKEN is absent", () => {
    const handle = resolveKnowledgeBackend(GBRAIN_DOC_SLUG)
    expect(() => handle.provider()).toThrow(/GBRAIN_BEARER_TOKEN is required/)
  })

  it("provider() builds an adapter once the token is present", () => {
    process.env.GBRAIN_BEARER_TOKEN = "gbrain_at_test"
    const handle = resolveKnowledgeBackend(GBRAIN_DOC_SLUG)
    expect(handle.provider().id).toBe("gbrain-doc")
  })
})
