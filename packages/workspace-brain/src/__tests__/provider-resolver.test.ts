/**
 * Tests for the provider resolver — the config → live-adapter factory
 * (`/knowledge.json` entries onto `IKnowledgeProvider` instances).
 *
 * Adapters that would do network I/O on method calls (gbrain-doc, qdrant)
 * are exercised only for the not-throwing construction + mapping logic; the
 * endpoint-strip / secret-resolution / key-mapping behavior is asserted
 * against the exported PURE `*OptionsFromEntry` helpers instead.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  KNOWLEDGE_PROVIDER_ADAPTERS,
  gbrainDocOptionsFromEntry,
  knowledgeConfigSchema,
  parseKnowledgeConfig,
  qdrantOptionsFromEntry,
  resolveKnowledgeProvider,
  resolveKnowledgeProviders,
  resolveSecret,
} from "../provider-resolver.js"
import type { KnowledgeProviderConfig } from "../types.js"

const ENV_KEYS = [
  "WB_TEST_SECRET",
  "WB_TEST_MISSING",
  "WB_MISSING_KEY",
  "GBRAIN_BEARER",
  "OPENAI_API_KEY",
]

async function makeBrainDir(label: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `wb-resolver-${label}-`))
}

describe("resolveSecret", () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })

  it("passes a plain (non-env) string through as-is", () => {
    expect(resolveSecret("tok-123")).toBe("tok-123")
  })

  it("resolves env:NAME from process.env", () => {
    process.env.WB_TEST_SECRET = "s3cret"
    expect(resolveSecret("env:WB_TEST_SECRET")).toBe("s3cret")
  })

  it("throws a clear error when the env var is unset or empty", () => {
    delete process.env.WB_TEST_MISSING
    expect(() => resolveSecret("env:WB_TEST_MISSING")).toThrow(/unset or empty/)
  })

  it("throws a clear error when the value is not a string", () => {
    expect(() => resolveSecret(42)).toThrow(/must be a string/)
    expect(() => resolveSecret(undefined)).toThrow(/must be a string/)
  })
})

describe("files adapter", () => {
  let brainDir: string

  beforeEach(async () => {
    brainDir = await makeBrainDir("files")
  })

  afterEach(async () => {
    await rm(brainDir, { recursive: true, force: true })
  })

  it("resolves to a live FilesKnowledgeAdapter rooted at brainDir/knowledge", async () => {
    const resolved = resolveKnowledgeProvider(
      { id: "local", adapter: "files", auto: true },
      { brainDir },
    )
    expect(resolved.id).toBe("local")
    expect(resolved.provider.id).toBe("files")

    const source = await resolved.provider.ingest({
      kind: "text",
      uri: "sess-wb",
      title: "Hello",
      content: "hello federated world",
      mimeType: "text/markdown",
    })
    expect(source.id).toMatch(/^sess-wb/)

    // The source file lands under <brainDir>/knowledge/sources/<id>.md.
    const written = await readFile(
      path.join(brainDir, "knowledge", "sources", `${source.id}.md`),
      "utf8",
    )
    expect(written).toContain("hello federated world")

    // And it round-trips through query on the same instance.
    const q = await resolved.provider.query({ query: "federated", topK: 5 })
    expect(q.hits.length).toBeGreaterThan(0)
    expect(q.hits[0]!.text).toContain("federated")
  })

  it("honours an explicit workspacePath override", async () => {
    const resolved = resolveKnowledgeProvider(
      { id: "local", adapter: "files", workspacePath: "kb" },
      { brainDir },
    )
    const source = await resolved.provider.ingest({
      kind: "text",
      uri: "sess-x",
      content: "index me",
    })
    const written = await readFile(
      path.join(brainDir, "kb", "sources", `${source.id}.md`),
      "utf8",
    )
    expect(written).toBe("index me")
  })
})

describe("gbrain-doc adapter", () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })

  it("maps endpoint/bearer and strips a trailing /mcp suffix (pure)", () => {
    const opts = gbrainDocOptionsFromEntry({
      adapter: "gbrain-doc",
      endpoint: "http://localhost:3131/gbrain/mcp",
      bearer: "bearer-tok",
    })
    expect(opts.endpoint).toBe("http://localhost:3131/gbrain")
    expect(opts.bearerToken).toBe("bearer-tok")
  })

  it("accepts a bare /mcp on the host root and falls back to url", () => {
    expect(
      gbrainDocOptionsFromEntry({ endpoint: "http://localhost:3131/mcp", bearer: "x" }).endpoint,
    ).toBe("http://localhost:3131")
    expect(gbrainDocOptionsFromEntry({ url: "http://h:9000/mcp", bearer: "x" }).endpoint).toBe(
      "http://h:9000",
    )
  })

  it("resolves env:GBRAIN_BEARER and constructs a live adapter", () => {
    process.env.GBRAIN_BEARER = "tok"
    const resolved = resolveKnowledgeProvider(
      { id: "gb", adapter: "gbrain-doc", endpoint: "http://localhost:3131/mcp", bearer: "env:GBRAIN_BEARER" },
      { brainDir: "/tmp" },
    )
    expect(resolved.id).toBe("gb")
    expect(resolved.provider.id).toBe("gbrain-doc")
    expect(resolved.provider.capabilities.vectorSearch).toBe(true)
  })

  it("throws a clear error when endpoint is missing", () => {
    expect(() =>
      resolveKnowledgeProvider(
        { id: "gb", adapter: "gbrain-doc", bearer: "x" },
        { brainDir: "/tmp" },
      ),
    ).toThrow(/endpoint/)
  })

  it("throws a clear error when bearer is missing", () => {
    expect(() =>
      resolveKnowledgeProvider(
        { id: "gb", adapter: "gbrain-doc", endpoint: "http://localhost:3131/mcp" },
        { brainDir: "/tmp" },
      ),
    ).toThrow(/must be a string/)
  })
})

describe("qdrant adapter", () => {
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })

  it("maps url→endpoint and resolves embeddingApiKey (pure)", () => {
    process.env.OPENAI_API_KEY = "sk-test"
    const opts = qdrantOptionsFromEntry({
      url: "http://localhost:6333",
      collection: "ws-x",
      embeddingApiKey: "env:OPENAI_API_KEY",
    })
    expect(opts.endpoint).toBe("http://localhost:6333")
    expect(opts.collection).toBe("ws-x")
    expect(opts.embeddingApiKey).toBe("sk-test")
  })

  it("accepts endpoint as the qdrant key and carries optional fields", () => {
    const opts = qdrantOptionsFromEntry({
      endpoint: "http://localhost:6333",
      collection: "c",
      embeddingApiKey: "k",
      apiKey: "qd-key",
      tenantId: "t1",
      label: "prod",
    })
    expect(opts.endpoint).toBe("http://localhost:6333")
    expect(opts.apiKey).toBe("qd-key")
    expect(opts.tenantId).toBe("t1")
    expect(opts.label).toBe("prod")
  })

  it("constructs a live adapter (no I/O) with zod defaults filling embedding fields", () => {
    process.env.OPENAI_API_KEY = "sk-test"
    const resolved = resolveKnowledgeProvider(
      { id: "qd", adapter: "qdrant", url: "http://localhost:6333", collection: "ws-x", embeddingApiKey: "env:OPENAI_API_KEY" },
      { brainDir: "/tmp" },
    )
    expect(resolved.id).toBe("qd")
    expect(resolved.provider.id).toBe("qdrant")
  })

  it("throws a clear error when collection is missing", () => {
    expect(() =>
      resolveKnowledgeProvider(
        { id: "qd", adapter: "qdrant", url: "http://localhost:6333", embeddingApiKey: "k" },
        { brainDir: "/tmp" },
      ),
    ).toThrow(/collection/)
  })

  it("throws a clear error when the embedding key env var is missing (end-to-end)", () => {
    delete process.env.WB_MISSING_KEY
    expect(() =>
      resolveKnowledgeProvider(
        { id: "qd", adapter: "qdrant", url: "http://localhost:6333", collection: "c", embeddingApiKey: "env:WB_MISSING_KEY" },
        { brainDir: "/tmp" },
      ),
    ).toThrow(/WB_MISSING_KEY/)
  })
})

describe("unsupported adapters", () => {
  it("throws for an unknown adapter, listing the supported ids", () => {
    expect(() =>
      resolveKnowledgeProvider(
        { id: "x", adapter: "wat" } as unknown as KnowledgeProviderConfig,
        { brainDir: "/tmp" },
      ),
    ).toThrow(/supported: files, gbrain-doc, qdrant, corpus/)
  })

  it("throws for the not-yet-implemented corpus adapter", () => {
    expect(() =>
      resolveKnowledgeProvider({ id: "c", adapter: "corpus" }, { brainDir: "/tmp" }),
    ).toThrow(/not implemented yet/)
  })

  it("lists every adapter id in KNOWLEDGE_PROVIDER_ADAPTERS", () => {
    expect([...KNOWLEDGE_PROVIDER_ADAPTERS]).toEqual(["files", "gbrain-doc", "qdrant", "corpus"])
  })
})

describe("resolveKnowledgeProviders", () => {
  it("returns an empty array for undefined or empty providers", () => {
    expect(resolveKnowledgeProviders(undefined, { brainDir: "/tmp" })).toEqual([])
    expect(resolveKnowledgeProviders({ providers: [] }, { brainDir: "/tmp" })).toEqual([])
  })

  it("throws on duplicate provider ids", () => {
    expect(() =>
      resolveKnowledgeProviders(
        { providers: [{ id: "a", adapter: "files" }, { id: "a", adapter: "files" }] },
        { brainDir: "/tmp" },
      ),
    ).toThrow(/duplicate knowledge provider id "a"/)
  })

  it("defaults auto→true and weight→1", () => {
    const provs = resolveKnowledgeProviders(
      { providers: [{ id: "a", adapter: "files" }] },
      { brainDir: "/tmp" },
    )
    expect(provs).toHaveLength(1)
    expect(provs[0]!.auto).toBe(true)
    expect(provs[0]!.weight).toBe(1)
  })
})

describe("knowledgeConfigSchema / parseKnowledgeConfig", () => {
  it("parses a config, carrying flat adapter options through passthrough", () => {
    const cfg = parseKnowledgeConfig({
      providers: [
        { id: "local", adapter: "files", auto: true },
        { id: "gb", adapter: "gbrain-doc", endpoint: "http://h:1/mcp", bearer: "tok", weight: 2 },
      ],
      defaultQueryProviders: ["local"],
    })
    expect(cfg.providers).toHaveLength(2)
    expect(cfg.providers[1]!.endpoint).toBe("http://h:1/mcp")
    expect(cfg.providers[1]!.weight).toBe(2)
    expect(cfg.defaultQueryProviders).toEqual(["local"])
  })

  it("is a ZodType<KnowledgeConfig> that rejects unknown adapter ids", () => {
    expect(knowledgeConfigSchema.safeParse({ providers: [{ id: "x", adapter: "wat" }] }).success).toBe(false)
  })
})
