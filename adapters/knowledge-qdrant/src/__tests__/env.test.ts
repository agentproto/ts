/**
 * Tests for the typed env module — the ONE place `process.env` is read. Covers
 * the required-var guards, the defaults, and the tenant-scope env
 * (`KNOWLEDGE_QDRANT_TENANT_ID`, the app-neutral successor to the studio
 * original's guild coupling).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadQdrantKnowledgeEnv, qdrantEnvToConfig } from "../env.js"

const KEYS = [
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "QDRANT_COLLECTION",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_BASE_URL",
  "KNOWLEDGE_QDRANT_TENANT_ID",
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("loadQdrantKnowledgeEnv", () => {
  it("throws when QDRANT_URL is absent", () => {
    process.env.OPENAI_API_KEY = "sk-test"
    expect(() => loadQdrantKnowledgeEnv()).toThrow(/QDRANT_URL is required/)
  })

  it("throws when OPENAI_API_KEY is absent", () => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333"
    expect(() => loadQdrantKnowledgeEnv()).toThrow(/OPENAI_API_KEY is required/)
  })

  it("applies defaults for collection / model / embedding endpoint", () => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333"
    process.env.OPENAI_API_KEY = "sk-test"
    const env = loadQdrantKnowledgeEnv()
    expect(env).toEqual({
      endpoint: "http://127.0.0.1:6333",
      collection: "knowledge",
      apiKey: undefined,
      embeddingApiKey: "sk-test",
      embeddingModel: "text-embedding-3-small",
      embeddingEndpoint: "https://api.openai.com/v1",
      tenantId: undefined,
    })
  })

  it("reads every override, including the tenant scope", () => {
    process.env.QDRANT_URL = "https://qdrant.example:6333"
    process.env.QDRANT_API_KEY = "qkey"
    process.env.QDRANT_COLLECTION = "docs"
    process.env.OPENAI_API_KEY = "sk-live"
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-large"
    process.env.OPENAI_BASE_URL = "https://proxy.local/v1"
    process.env.KNOWLEDGE_QDRANT_TENANT_ID = "tenant-1"
    const env = loadQdrantKnowledgeEnv()
    expect(env).toEqual({
      endpoint: "https://qdrant.example:6333",
      collection: "docs",
      apiKey: "qkey",
      embeddingApiKey: "sk-live",
      embeddingModel: "text-embedding-3-large",
      embeddingEndpoint: "https://proxy.local/v1",
      tenantId: "tenant-1",
    })
  })

  it("treats blank/whitespace vars as unset (falls back to defaults)", () => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333"
    process.env.OPENAI_API_KEY = "sk-test"
    process.env.QDRANT_COLLECTION = "   "
    process.env.KNOWLEDGE_QDRANT_TENANT_ID = ""
    const env = loadQdrantKnowledgeEnv()
    expect(env.collection).toBe("knowledge")
    expect(env.tenantId).toBeUndefined()
  })
})

describe("qdrantEnvToConfig", () => {
  it("projects the env verbatim into an adapter config", () => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333"
    process.env.OPENAI_API_KEY = "sk-test"
    process.env.KNOWLEDGE_QDRANT_TENANT_ID = "tenant-x"
    const config = qdrantEnvToConfig(loadQdrantKnowledgeEnv())
    expect(config.endpoint).toBe("http://127.0.0.1:6333")
    expect(config.tenantId).toBe("tenant-x")
    expect(config.embeddingModel).toBe("text-embedding-3-small")
  })
})
