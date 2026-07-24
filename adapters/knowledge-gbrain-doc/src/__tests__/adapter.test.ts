/**
 * Mocked-fetch unit tests for {@link GbrainDocKnowledgeAdapter}.
 *
 * The adapter is pure `fetch` against gbrain's JSON-RPC `/mcp` endpoint, so it
 * is fully exercisable against a mocked `globalThis.fetch` — NO live gbrain
 * (CI-safe). gbrain serves `/mcp` as Streamable HTTP, so the mock frames every
 * tool result as an SSE `data:` line (exercising {@link extractJsonRpcPayload}
 * too). These assert the request SHAPES the adapter sends (`put_page` /
 * `search` / `get_page` / `list_pages` / `delete_page`) and the result MAPPING
 * back into `KnowledgeHit` / `KnowledgeSource`, plus the client-side `minScore`
 * floor, the `mode: "none"` short-circuit, and page-not-found folding.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  GbrainDocKnowledgeAdapter,
  extractJsonRpcPayload,
} from "../adapter.js"

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface ToolCall {
  name: string
  args: Record<string, unknown>
}

/** Wrap a tool-result JSON value as gbrain's MCP `tools/call` envelope, framed
 *  as a Streamable-HTTP SSE `data:` line — exactly what the live server emits. */
function sseEnvelope(
  toolResultText: unknown,
  opts: { isError?: boolean } = {},
): string {
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(toolResultText) }],
      ...(opts.isError ? { isError: true } : {}),
    },
  }
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`
}

/**
 * Install a mocked `globalThis.fetch`. `onTool` dispatches on the parsed
 * `tools/call` (name + arguments) and returns the tool-result JSON to frame;
 * throw `{ isError: true, body }` to simulate a gbrain tool error. GET /health
 * is short-circuited to an ok response.
 */
function installFetchMock(
  onTool: (call: ToolCall) => unknown,
  opts: { healthOk?: boolean } = {},
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
    const parsedBody =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ url, method, headers, body: parsedBody })

    if (url.endsWith("/health")) {
      return Promise.resolve(mkResponse(opts.healthOk ?? true, 200, ""))
    }

    const name = parsedBody?.params?.name
    const args = parsedBody?.params?.arguments ?? {}
    const result = onTool({ name, args })
    if (isToolError(result)) {
      return Promise.resolve(
        mkResponse(true, 200, sseEnvelope(result.body, { isError: true })),
      )
    }
    return Promise.resolve(mkResponse(true, 200, sseEnvelope(result)))
  }
  vi.stubGlobal("fetch", vi.fn(impl))
  return { calls }
}

function mkResponse(ok: boolean, status: number, body: string): Response {
  const response: Response = {
    ok,
    status,
    statusText: "",
    headers: { get: () => "text/event-stream" },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response
  return response
}

interface ToolError {
  __isError: true
  body: unknown
}

function toolError(body: unknown): ToolError {
  return { __isError: true, body }
}

function isToolError(v: unknown): v is ToolError {
  return typeof v === "object" && v !== null && "__isError" in v
}

const ENDPOINT = "http://gbrain.test:3132"
const TOKEN = "gbrain_at_test"

function baseConfig(overrides: Record<string, unknown> = {}) {
  return { endpoint: ENDPOINT, bearerToken: TOKEN, timeoutMs: 45_000, ...overrides }
}

/** The parsed `tools/call` params for the first call to a named tool. */
function toolCallOf(calls: RecordedCall[], name: string): ToolCall {
  const call = calls.find(
    (c) =>
      c.url.endsWith("/mcp") &&
      typeof c.body === "object" &&
      c.body !== null &&
      (c.body as { params?: { name?: string } }).params?.name === name,
  )
  if (!call) throw new Error(`no ${name} call recorded`)
  const body = call.body
  if (typeof body !== "object" || body === null || !("params" in body)) {
    throw new Error(`malformed ${name} call body`)
  }
  const params = (body as { params: { name: string; arguments?: Record<string, unknown> } }).params
  return { name: params.name, args: params.arguments ?? {} }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("extractJsonRpcPayload", () => {
  it("pulls the last data: line out of an SSE body", () => {
    const body = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`
    expect(JSON.parse(extractJsonRpcPayload(body))).toMatchObject({
      jsonrpc: "2.0",
    })
  })

  it("returns a plain-JSON body whole (no SSE framing)", () => {
    const body = `{"jsonrpc":"2.0","id":1,"result":{}}`
    expect(extractJsonRpcPayload(body)).toBe(body)
  })
})

describe("ingest() → put_page", () => {
  it("puts a page with { slug, content } derived from the title, mapping the result", async () => {
    const { calls } = installFetchMock(() => ({
      slug: "hello-world",
      status: "created_or_updated",
      chunks: 1,
    }))
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const source = await adapter.ingest({
      kind: "text",
      uri: "doc://hello",
      title: "Hello World",
      content: "a short body",
      metadata: { origin: "unit-test" },
    })

    const put = toolCallOf(calls, "put_page")
    expect(put.args).toEqual({ slug: "hello-world", content: "a short body" })
    // never sends a `source` field (studio drift) — gbrain stamps source_uri
    expect(put.args).not.toHaveProperty("source")
    expect(put.args).not.toHaveProperty("source_uri")

    expect(source.id).toBe("hello-world")
    expect(source.kind).toBe("text")
    expect(source.uri).toBe("doc://hello")
    expect(source.title).toBe("Hello World")
    expect(source.status).toBe("ready")
    expect(source.bytes).toBe(12)
    expect(source.metadata).toMatchObject({
      origin: "unit-test",
      gbrainStatus: "created_or_updated",
      chunks: 1,
    })
  })

  it("derives the slug from the uri tail when no title is given", async () => {
    const { calls } = installFetchMock(() => ({ slug: "guide", status: "ok" }))
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    await adapter.ingest({
      kind: "text",
      uri: "https://example.com/docs/Guide.md?x=1",
      content: "body",
    })
    expect(toolCallOf(calls, "put_page").args.slug).toBe("guide-md")
  })

  it("sends the bearer token + streamable-http Accept header", async () => {
    const { calls } = installFetchMock(() => ({ status: "ok" }))
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    await adapter.ingest({ kind: "text", uri: "doc://x", content: "body" })
    const put = calls.find((c) => c.url.endsWith("/mcp"))!
    expect(put.url).toBe(`${ENDPOINT}/mcp`)
    expect(put.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(put.headers.Accept).toContain("text/event-stream")
  })

  it("rejects empty content with a clean error", async () => {
    installFetchMock(() => ({}))
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    await expect(
      adapter.ingest({ kind: "text", uri: "doc://x", content: "   " }),
    ).rejects.toThrow(/payload is empty/)
  })
})

describe("query() → search", () => {
  const hitRows = [
    {
      slug: "agentproto-doc-probe",
      page_id: 14280,
      title: "Agentproto Doc Probe",
      type: "note",
      chunk_text: "the matching chunk text",
      chunk_source: "compiled_truth",
      chunk_id: 90670,
      chunk_index: 0,
      score: 0.77,
      evidence: "keyword_exact",
    },
    {
      slug: "other-page",
      chunk_text: "weaker match",
      chunk_index: 3,
      score: 0.21,
      evidence: "weak_semantic",
    },
  ]

  it("searches with { query, limit } and maps a bare-array result into KnowledgeHit", async () => {
    const { calls } = installFetchMock(() => hitRows)
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const result = await adapter.query({ query: "turquoise meadows", topK: 5 })

    const search = toolCallOf(calls, "search")
    expect(search.args).toEqual({ query: "turquoise meadows", limit: 5 })

    expect(result.engine).toBe("gbrain-doc")
    expect(result.modeUsed).toBe("hybrid")
    expect(result.hits).toHaveLength(2)
    const hit = result.hits[0]!
    expect(hit.sourceId).toBe("agentproto-doc-probe")
    expect(hit.chunkId).toBe("agentproto-doc-probe#90670")
    expect(hit.text).toBe("the matching chunk text")
    expect(hit.score).toBe(0.77)
    // known-mapped fields are stripped from metadata; the rest round-trips
    expect(hit.metadata).toMatchObject({
      chunkIndex: 0,
      title: "Agentproto Doc Probe",
      type: "note",
      page_id: 14280,
      evidence: "keyword_exact",
    })
    expect(hit.metadata).not.toHaveProperty("chunk_text")
    expect(hit.metadata).not.toHaveProperty("score")
  })

  it("accepts a { results: [...] } wrapper too", async () => {
    installFetchMock(() => ({ results: hitRows }))
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const result = await adapter.query({ query: "q" })
    expect(result.hits.map((h) => h.sourceId)).toEqual([
      "agentproto-doc-probe",
      "other-page",
    ])
  })

  it("applies minScore as a client-side floor (gbrain search has none)", async () => {
    installFetchMock(() => hitRows)
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const result = await adapter.query({ query: "q", minScore: 0.5 })
    expect(result.hits.map((h) => h.sourceId)).toEqual(["agentproto-doc-probe"])
  })

  it("falls back score → base_score → 0 and chunkId → index", async () => {
    installFetchMock(() => [
      { slug: "p", base_score: 0.4 },
      { slug: "q" },
    ])
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const result = await adapter.query({ query: "q" })
    expect(result.hits[0]!.score).toBe(0.4)
    expect(result.hits[0]!.chunkId).toBe("p#0")
    expect(result.hits[1]!.score).toBe(0)
    expect(result.hits[1]!.chunkId).toBe("q#1")
  })

  it("short-circuits mode:'none' with zero hits and no fetch", async () => {
    const { calls } = installFetchMock(() => [])
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const result = await adapter.query({ query: "q", mode: "none" })
    expect(result.modeUsed).toBe("none")
    expect(result.hits).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})

describe("listSources() → list_pages", () => {
  const pages = [
    { slug: "agentproto-doc-probe", type: "note", title: "Probe", updated_at: "2026-07-24T10:11:18.122Z" },
    { slug: "tsconfig-json", type: "code", title: "tsconfig.json", updated_at: "2026-07-23T01:08:36.863Z" },
  ]

  it("lists pages, mapping a bare array into KnowledgeSource", async () => {
    installFetchMock(() => pages)
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const sources = await adapter.listSources()
    expect(sources.map((s) => s.id)).toEqual(["agentproto-doc-probe", "tsconfig-json"])
    expect(sources[0]!.kind).toBe("text") // note → text
    expect(sources[1]!.kind).toBe("file") // code → file
    expect(sources[0]!.title).toBe("Probe")
  })

  it("passes a gbrain type filter derived from the kind filter", async () => {
    const { calls } = installFetchMock(() => [])
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    await adapter.listSources({ kind: "url" })
    expect(toolCallOf(calls, "list_pages").args).toEqual({ type: "url" })
  })
})

describe("getSource() + deleteSource()", () => {
  const page = {
    id: 14280,
    slug: "agentproto-doc-probe",
    type: "note",
    title: "Agentproto Doc Probe",
    compiled_truth: "the compiled doc body",
    source_uri: null,
    updated_at: "2026-07-24T10:11:18.122Z",
  }

  it("getSource maps a get_page envelope into a KnowledgeSource", async () => {
    const { calls } = installFetchMock(() => page)
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    const source = await adapter.getSource("agentproto-doc-probe")
    expect(toolCallOf(calls, "get_page").args).toEqual({ slug: "agentproto-doc-probe" })
    expect(source).not.toBeNull()
    expect(source!.id).toBe("agentproto-doc-probe")
    expect(source!.uri).toBe("agentproto-doc-probe") // source_uri null → slug
    expect(source!.bytes).toBe(21)
    expect(source!.indexedAt?.toISOString()).toBe("2026-07-24T10:11:18.122Z")
  })

  it("getSource folds a page_not_found tool-error to null", async () => {
    installFetchMock(() =>
      toolError({ error: "page_not_found", message: "Page not found: nope" }),
    )
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    expect(await adapter.getSource("nope")).toBeNull()
  })

  it("deleteSource posts a { slug } and treats not-found as a no-op", async () => {
    const { calls } = installFetchMock(({ name }) =>
      name === "delete_page"
        ? toolError({ error: "page_not_found", message: "Page not found: gone" })
        : {},
    )
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    await expect(adapter.deleteSource("gone")).resolves.toBeUndefined()
    expect(toolCallOf(calls, "delete_page").args).toEqual({ slug: "gone" })
  })
})

describe("healthCheck()", () => {
  it("returns true when GET /health is ok", async () => {
    const { calls } = installFetchMock(() => ({}), { healthOk: true })
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    expect(await adapter.healthCheck()).toBe(true)
    expect(calls[0]!.url).toBe(`${ENDPOINT}/health`)
    expect(calls[0]!.method).toBe("GET")
  })

  it("returns false when GET /health is not ok", async () => {
    installFetchMock(() => ({}), { healthOk: false })
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    expect(await adapter.healthCheck()).toBe(false)
  })
})

describe("error surfacing", () => {
  it("throws a labelled error when a gbrain tool call HTTP-fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mkResponse(false, 500, "boom")),
    )
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig({ label: "prod" }))
    await expect(adapter.query({ query: "q" })).rejects.toThrow(
      /GbrainDocKnowledgeAdapter \(prod\).*500/,
    )
  })

  it("throws when a tool sets isError (not a not-found)", async () => {
    installFetchMock(() =>
      toolError({ error: "rate_limited", message: "slow down" }),
    )
    const adapter = new GbrainDocKnowledgeAdapter(baseConfig())
    await expect(adapter.query({ query: "q" })).rejects.toThrow(/slow down/)
  })
})
