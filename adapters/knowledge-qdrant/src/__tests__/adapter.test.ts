/**
 * Mocked-fetch unit tests for {@link QdrantKnowledgeAdapter}.
 *
 * The adapter is pure `fetch` + an OpenAI-compatible `/embeddings` call, so it
 * is fully exercisable against a mocked `globalThis.fetch` — NO live Qdrant and
 * NO real embeddings API needed (CI-safe). These assert the request SHAPES the
 * adapter sends (upsert / search / scroll / delete) + the embeddings call, the
 * result MAPPING back into `KnowledgeHit` / `KnowledgeSource`, and — the load-
 * bearing rename for this PR — that the tenant scope emits a generic `tenantId`
 * payload filter (never `guildId`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QdrantKnowledgeAdapter } from "../adapter.js"

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface MockResponseSpec {
  readonly ok?: boolean
  readonly status?: number
  readonly json?: unknown
  readonly text?: string
}

/**
 * Install a mocked `globalThis.fetch` that dispatches on the request URL,
 * records every call, and returns a canned JSON body. `route` maps a substring
 * of the URL to the response it should serve.
 */
function installFetchMock(
  route: (url: string, method: string) => MockResponseSpec,
): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const impl = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()
    const method = (init?.method ?? "GET").toUpperCase()
    const rawHeaders = init?.headers
    const headers: Record<string, string> = {}
    if (rawHeaders && typeof rawHeaders === "object") {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k] = String(v)
    }
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ url, method, headers, body })
    const spec = route(url, method)
    const response: Response = {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      statusText: "",
      json: async () => spec.json,
      text: async () => spec.text ?? "",
    } as unknown as Response
    return Promise.resolve(response)
  }
  vi.stubGlobal("fetch", vi.fn(impl))
  return { calls }
}

const ENDPOINT = "http://qdrant.test:6333"
const COLLECTION = "kb"
const EMBEDDING = [0.1, 0.2, 0.3]

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: ENDPOINT,
    collection: COLLECTION,
    embeddingApiKey: "sk-test",
    embeddingModel: "text-embedding-3-small",
    embeddingEndpoint: "https://api.openai.com/v1",
    ...overrides,
  }
}

/** One embedding vector per input text — mirrors the real API's 1:1 shape. */
function embeddingsFor(inputs: string[]): { data: { embedding: number[] }[] } {
  return { data: inputs.map(() => ({ embedding: EMBEDDING })) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("query()", () => {
  let calls: RecordedCall[]

  const searchBody = {
    result: [
      {
        id: "point-uuid-1",
        score: 0.87,
        payload: {
          source_id: "src-1",
          chunk_index: 2,
          kind: "text",
          uri: "doc://a",
          title: "Doc A",
          text: "the matching chunk text",
          bytes: 23,
          indexed_at: "2026-01-01T00:00:00.000Z",
          metadata: { corpus: { entryPath: "entries/a.md" } },
        },
      },
    ],
  }

  beforeEach(() => {
    ;({ calls } = installFetchMock((url) => {
      if (url.endsWith("/embeddings")) return { json: embeddingsFor(["q"]) }
      if (url.includes("/points/search")) return { json: searchBody }
      return { json: {} }
    }))
  })

  it("embeds the query then searches, mapping points into KnowledgeHit", async () => {
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    const result = await adapter.query({ query: "how do I ship", topK: 5 })

    // embeddings call shape
    const embedCall = calls.find((c) => c.url.endsWith("/embeddings"))!
    expect(embedCall.method).toBe("POST")
    expect(embedCall.headers.authorization).toBe("Bearer sk-test")
    expect(embedCall.body).toEqual({
      model: "text-embedding-3-small",
      input: ["how do I ship"],
    })

    // search call shape
    const searchCall = calls.find((c) => c.url.includes("/points/search"))!
    expect(searchCall.url).toBe(
      `${ENDPOINT}/collections/${COLLECTION}/points/search`,
    )
    expect(searchCall.body).toMatchObject({
      vector: EMBEDDING,
      limit: 5,
      with_payload: true,
    })

    // result mapping
    expect(result.engine).toBe("qdrant")
    expect(result.modeUsed).toBe("vector")
    expect(result.hits).toHaveLength(1)
    const hit = result.hits[0]!
    expect(hit.sourceId).toBe("src-1")
    expect(hit.chunkId).toBe("point-uuid-1")
    expect(hit.score).toBe(0.87)
    expect(hit.text).toBe("the matching chunk text")
    expect(hit.metadata).toEqual({
      title: "Doc A",
      uri: "doc://a",
      chunkIndex: 2,
      corpus: { entryPath: "entries/a.md" },
    })
  })

  it("defaults topK to 8 when unset", async () => {
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    await adapter.query({ query: "q" })
    const searchCall = calls.find((c) => c.url.includes("/points/search"))!
    expect(searchCall.body).toMatchObject({ limit: 8 })
  })

  it("sends NO filter when single-tenant and no caller filter", async () => {
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    await adapter.query({ query: "q" })
    const searchCall = calls.find((c) => c.url.includes("/points/search"))!
    expect((searchCall.body as Record<string, unknown>).filter).toBeUndefined()
  })
})

describe("tenant scope (renamed from studio guildId → tenantId)", () => {
  it("forces a tenantId must-clause on query when tenant-scoped", async () => {
    const { calls } = installFetchMock((url) => {
      if (url.endsWith("/embeddings")) return { json: embeddingsFor(["q"]) }
      return { json: { result: [] } }
    })
    const adapter = new QdrantKnowledgeAdapter(
      baseConfig({ tenantId: "tenant-42" }),
    )
    await adapter.query({ query: "q" })
    const searchCall = calls.find((c) => c.url.includes("/points/search"))!
    expect((searchCall.body as Record<string, unknown>).filter).toEqual({
      must: [{ key: "tenantId", match: { value: "tenant-42" } }],
    })
  })

  it("ANDs the tenant clause with a translated caller filter", async () => {
    const { calls } = installFetchMock((url) => {
      if (url.endsWith("/embeddings")) return { json: embeddingsFor(["q"]) }
      return { json: { result: [] } }
    })
    const adapter = new QdrantKnowledgeAdapter(
      baseConfig({ tenantId: "tenant-42" }),
    )
    await adapter.query({ query: "q", filter: { status: "active" } })
    const searchCall = calls.find((c) => c.url.includes("/points/search"))!
    expect((searchCall.body as Record<string, unknown>).filter).toEqual({
      must: [
        { key: "tenantId", match: { value: "tenant-42" } },
        {
          must: [
            { key: "metadata.corpus.status", match: { value: "active" } },
          ],
        },
      ],
    })
  })

  it("NEVER emits a `guildId` key (no guild coupling survives the lift)", async () => {
    const { calls } = installFetchMock((url) => {
      if (url.endsWith("/embeddings")) return { json: embeddingsFor(["q"]) }
      return { json: { result: [] } }
    })
    const adapter = new QdrantKnowledgeAdapter(
      baseConfig({ tenantId: "tenant-42" }),
    )
    await adapter.query({ query: "q" })
    await adapter.deleteSource("src-1")
    const bodies = JSON.stringify(calls.map((c) => c.body))
    expect(bodies).not.toContain("guildId")
    expect(bodies).toContain("tenantId")
  })
})

describe("ingest()", () => {
  it("embeds + upserts a text source, tagging the tenant on every point", async () => {
    const { calls } = installFetchMock((url) => {
      if (url.endsWith("/embeddings"))
        return { json: embeddingsFor(["ignored"]) }
      return { json: { result: { operation_id: 1, status: "acknowledged" } } }
    })
    const adapter = new QdrantKnowledgeAdapter(
      baseConfig({ tenantId: "tenant-7" }),
    )
    const source = await adapter.ingest({
      kind: "text",
      uri: "doc://hello",
      title: "Hello",
      content: "a short body",
      metadata: { corpus: { entrySlug: "hello" } },
    })

    // one upsert (PUT with wait=true)
    const upsert = calls.find((c) => c.method === "PUT")!
    expect(upsert.url).toBe(
      `${ENDPOINT}/collections/${COLLECTION}/points?wait=true`,
    )
    const points = (upsert.body as { points: Record<string, unknown>[] }).points
    expect(points).toHaveLength(1)
    const payload = points[0]!.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      source_id: source.id,
      chunk_index: 0,
      tenantId: "tenant-7",
      kind: "text",
      uri: "doc://hello",
      title: "Hello",
      text: "a short body",
      metadata: { corpus: { entrySlug: "hello" } },
    })
    expect(points[0]!.vector).toEqual(EMBEDDING)

    // returned source
    expect(source.kind).toBe("text")
    expect(source.status).toBe("ready")
    expect(source.metadata).toEqual({ chunks: 1 })
  })

  it("omits tenantId from the payload in single-tenant mode", async () => {
    const { calls } = installFetchMock((url) => {
      if (url.endsWith("/embeddings")) return { json: embeddingsFor(["x"]) }
      return { json: {} }
    })
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    await adapter.ingest({ kind: "text", uri: "doc://x", content: "body" })
    const upsert = calls.find((c) => c.method === "PUT")!
    const payload = (upsert.body as { points: { payload: Record<string, unknown> }[] })
      .points[0]!.payload
    expect(payload).not.toHaveProperty("tenantId")
  })

  it("rejects kind=file with a clean error (adapter stays narrow)", async () => {
    installFetchMock(() => ({ json: {} }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    await expect(
      adapter.ingest({ kind: "file", uri: "file://x" }),
    ).rejects.toThrow(/not supported/)
  })

  it("rejects empty text content", async () => {
    installFetchMock(() => ({ json: {} }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    await expect(
      adapter.ingest({ kind: "text", uri: "doc://x", content: "" }),
    ).rejects.toThrow(/non-empty content/)
  })
})

describe("listSources() + getSource() + deleteSource()", () => {
  const scrollBody = {
    result: {
      points: [
        {
          id: "p1",
          payload: {
            source_id: "src-1",
            chunk_index: 0,
            kind: "text",
            uri: "doc://a",
            title: "A",
            text: "chunk 0",
            bytes: 7,
            indexed_at: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          id: "p2",
          payload: {
            source_id: "src-1",
            chunk_index: 1,
            kind: "text",
            uri: "doc://a",
            text: "chunk 1",
            bytes: 7,
            indexed_at: "2026-01-01T00:00:00.000Z",
          },
        },
        {
          id: "p3",
          payload: {
            source_id: "src-2",
            chunk_index: 0,
            kind: "url",
            uri: "https://b",
            text: "chunk 0 b",
            bytes: 9,
            indexed_at: "2026-01-02T00:00:00.000Z",
          },
        },
      ],
      next_page_offset: null,
    },
  }

  it("dedupes by source_id, collapsing to the first chunk per source", async () => {
    installFetchMock(() => ({ json: scrollBody }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    const sources = await adapter.listSources()
    expect(sources.map((s) => s.id)).toEqual(["src-1", "src-2"])
    expect(sources[0]!.title).toBe("A")
    expect(sources[1]!.kind).toBe("url")
  })

  it("applies the client-side kind filter after dedupe", async () => {
    installFetchMock(() => ({ json: scrollBody }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    const sources = await adapter.listSources({ kind: "url" })
    expect(sources.map((s) => s.id)).toEqual(["src-2"])
  })

  it("getSource returns null when the scroll yields no point", async () => {
    installFetchMock(() => ({ json: { result: { points: [] } } }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    expect(await adapter.getSource("missing")).toBeNull()
  })

  it("deleteSource posts a source_id + tenantId must-filter", async () => {
    const { calls } = installFetchMock(() => ({ json: {} }))
    const adapter = new QdrantKnowledgeAdapter(
      baseConfig({ tenantId: "tenant-9" }),
    )
    await adapter.deleteSource("src-1")
    const del = calls.find((c) => c.url.includes("/points/delete"))!
    expect(del.url).toBe(
      `${ENDPOINT}/collections/${COLLECTION}/points/delete?wait=true`,
    )
    expect(del.body).toEqual({
      filter: {
        must: [
          { key: "source_id", match: { value: "src-1" } },
          { key: "tenantId", match: { value: "tenant-9" } },
        ],
      },
    })
  })
})

describe("healthCheck()", () => {
  it("returns true when GET /collections/{name} is ok", async () => {
    const { calls } = installFetchMock(() => ({ ok: true, json: {} }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    expect(await adapter.healthCheck()).toBe(true)
    expect(calls[0]!.url).toBe(`${ENDPOINT}/collections/${COLLECTION}`)
  })

  it("returns false when the collection GET is not ok", async () => {
    installFetchMock(() => ({ ok: false, status: 404, text: "not found" }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    expect(await adapter.healthCheck()).toBe(false)
  })
})

describe("error surfacing", () => {
  it("throws a labelled error when a Qdrant call fails", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/embeddings")) return { json: embeddingsFor(["q"]) }
      return { ok: false, status: 500, text: "boom" }
    })
    const adapter = new QdrantKnowledgeAdapter(baseConfig({ label: "prod" }))
    await expect(adapter.query({ query: "q" })).rejects.toThrow(
      /QdrantKnowledgeAdapter \(prod\).*500/,
    )
  })

  it("throws when the embeddings call fails", async () => {
    installFetchMock(() => ({ ok: false, status: 401, text: "bad key" }))
    const adapter = new QdrantKnowledgeAdapter(baseConfig())
    await expect(adapter.query({ query: "q" })).rejects.toThrow(
      /embeddings call failed 401/,
    )
  })
})
