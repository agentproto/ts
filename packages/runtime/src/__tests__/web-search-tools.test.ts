/**
 * `web.search` tool + Brave/Serper AIP-30 drivers.
 *
 * Unit tests: injected `env` + stub `fetch` — NO network. The registration
 * is key-gated, so each scenario re-registers against a capture server.
 *
 * Live e2e: gated on BOTH provider keys being present in the process env;
 * hits the real Brave + Serper APIs (skipped otherwise).
 */

import { describe, it, expect } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerWebSearchTools } from "../web-search-tools.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

type ToolCall = [name: string, description: string, shape: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>]

function captureServer(): { server: McpServer; calls: ToolCall[] } {
  const calls: ToolCall[] = []
  const server = {
    tool: (...args: ToolCall) => {
      calls.push(args)
    },
  } as unknown as McpServer
  return { server, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function makeFetch(
  respond: (req: CapturedRequest) => Response
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : (input as unknown as { url: string; method?: string })
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const rawBody = typeof init?.body === "string" ? init.body : undefined
    requests.push({
      url: typeof req === "string" ? req : req.url,
      method: init?.method ?? "GET",
      headers,
      ...(rawBody !== undefined ? { body: JSON.parse(rawBody) } : {}),
    })
    return respond(requests[requests.length - 1]!)
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

const parse = (res: { content: Array<{ text: string }>; isError?: boolean }) =>
  JSON.parse(res.content[0]!.text)

const BRAVE_BODY = {
  web: {
    results: [
      { title: "First", url: "https://example.com/1", description: "first snippet" },
      { title: "Second", url: "https://example.com/2", description: "second snippet" },
    ],
  },
}

const SERPER_BODY = {
  organic: [
    { title: "Alpha", link: "https://example.com/a", snippet: "alpha snippet" },
    { title: "Beta", link: "https://example.com/b", snippet: "beta snippet" },
  ],
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe("registerWebSearchTools", () => {
  it("both keys present → resolves to brave (cost 0 wins), brave-shaped response normalized", async () => {
    const { fetchImpl, requests } = makeFetch(() => json(BRAVE_BODY))
    const { server, calls } = captureServer()
    registerWebSearchTools(server, {
      env: { BRAVE_SEARCH_API_KEY: "brave-key", SERPER_API_KEY: "serper-key" },
      fetch: fetchImpl,
    })
    expect(calls).toHaveLength(1)
    const [name, , , handler] = calls[0]!
    expect(name).toBe("web_search")

    const res = (await handler({ query: "agentproto", count: 2 })) as {
      content: Array<{ text: string }>
    }
    const out = parse(res)
    expect(out).toEqual({
      provider: "brave",
      results: [
        { title: "First", url: "https://example.com/1", snippet: "first snippet", position: 1 },
        { title: "Second", url: "https://example.com/2", snippet: "second snippet", position: 2 },
      ],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain("https://api.search.brave.com/res/v1/web/search")
    expect(requests[0]!.url).toContain("q=agentproto")
    expect(requests[0]!.url).toContain("count=2")
    expect(requests[0]!.headers["x-subscription-token"]).toBe("brave-key")
  })

  it("only serper key → serper serves the call; serper-shaped response normalized", async () => {
    const { fetchImpl, requests } = makeFetch(() => json(SERPER_BODY))
    const { server, calls } = captureServer()
    registerWebSearchTools(server, {
      env: { SERPER_API_KEY: "serper-key" },
      fetch: fetchImpl,
    })
    expect(calls).toHaveLength(1)

    const res = (await calls[0]![3]({ query: "hello", count: 3 })) as {
      content: Array<{ text: string }>
    }
    const out = parse(res)
    expect(out).toEqual({
      provider: "serper",
      results: [
        { title: "Alpha", url: "https://example.com/a", snippet: "alpha snippet", position: 1 },
        { title: "Beta", url: "https://example.com/b", snippet: "beta snippet", position: 2 },
      ],
    })
    expect(requests[0]!.url).toBe("https://google.serper.dev/search")
    expect(requests[0]!.method).toBe("POST")
    expect(requests[0]!.headers["x-api-key"]).toBe("serper-key")
    expect(requests[0]!.body).toEqual({ q: "hello", num: 3 })
  })

  it("freshness + only serper key → resolver Phase-1 rejects (input_unsupported:freshness), no silent drop", async () => {
    const { fetchImpl, requests } = makeFetch(() => json(SERPER_BODY))
    const { server, calls } = captureServer()
    registerWebSearchTools(server, {
      env: { SERPER_API_KEY: "serper-key" },
      fetch: fetchImpl,
    })
    const res = (await calls[0]![3]({
      query: "hello",
      freshness: "pw",
    })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("input_unsupported:freshness")
    expect(requests).toHaveLength(0)
  })

  it("freshness + both keys → still brave", async () => {
    const { fetchImpl, requests } = makeFetch(() => json(BRAVE_BODY))
    const { server, calls } = captureServer()
    registerWebSearchTools(server, {
      env: { BRAVE_SEARCH_API_KEY: "brave-key", SERPER_API_KEY: "serper-key" },
      fetch: fetchImpl,
    })
    const res = (await calls[0]![3]({
      query: "hello",
      freshness: "pd",
      safesearch: "strict",
      country: "fr",
      language: "fr",
    })) as { content: Array<{ text: string }> }
    expect(parse(res).provider).toBe("brave")
    expect(requests[0]!.url).toContain("freshness=pd")
    expect(requests[0]!.url).toContain("safesearch=strict")
    expect(requests[0]!.url).toContain("country=fr")
    expect(requests[0]!.url).toContain("search_lang=fr")
  })

  it("no keys → no tool registered", () => {
    const { server, calls } = captureServer()
    registerWebSearchTools(server, { env: {} })
    expect(calls).toHaveLength(0)
  })

  it("malformed provider response (missing url) → ToolError via output validation", async () => {
    const { fetchImpl } = makeFetch(() =>
      json({ web: { results: [{ title: "No url here" }] } })
    )
    const { server, calls } = captureServer()
    registerWebSearchTools(server, {
      env: { BRAVE_SEARCH_API_KEY: "brave-key" },
      fetch: fetchImpl,
    })
    const res = (await calls[0]![3]({ query: "hello" })) as {
      content: Array<{ text: string }>; isError?: boolean
    }
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("outputSchema")
  })

  it("401 from provider → error surfaced through catchErrors() with auth message", async () => {
    const { fetchImpl } = makeFetch(() => json({}, 401))
    const { server, calls } = captureServer()
    registerWebSearchTools(server, {
      env: { BRAVE_SEARCH_API_KEY: "bad-key" },
      fetch: fetchImpl,
    })
    const res = (await calls[0]![3]({ query: "hello" })) as {
      content: Array<{ text: string }>; isError?: boolean
    }
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toContain("401")
    expect(res.content[0]!.text).toContain("API key")
  })
})

// ── Live e2e (real APIs — skipped unless both keys are exported) ──────────────

const hasKeys = !!(
  process.env.BRAVE_SEARCH_API_KEY && process.env.SERPER_API_KEY
)

describe.skipIf(!hasKeys)("live: web.search against real providers", () => {
  it("brave serves a real query", { timeout: 30_000 }, async () => {
    const { server, calls } = captureServer()
    registerWebSearchTools(server, { env: process.env })
    expect(calls).toHaveLength(1)
    const res = (await calls[0]![3]({ query: "agentproto AIP-30", count: 5 })) as {
      content: Array<{ text: string }>; isError?: boolean
    }
    expect(res.isError).toBeUndefined()
    const out = parse(res)
    expect(out.provider).toBe("brave")
    expect(out.results.length).toBeGreaterThanOrEqual(1)
    expect(out.results[0].url).toMatch(/^https?:\/\//)
  })

  it("serper serves a real query", { timeout: 30_000 }, async () => {
    // Pin to serper via resolverContext is not exposed by registerWebSearchTools;
    // instead build the serper driver directly through the registered tool by
    // registering with ONLY the serper key.
    const env = { SERPER_API_KEY: process.env.SERPER_API_KEY }
    const { server, calls } = captureServer()
    registerWebSearchTools(server, { env })
    expect(calls).toHaveLength(1)
    const res = (await calls[0]![3]({ query: "agentproto AIP-30", count: 5 })) as {
      content: Array<{ text: string }>; isError?: boolean
    }
    expect(res.isError).toBeUndefined()
    const out = parse(res)
    expect(out.provider).toBe("serper")
    expect(out.results.length).toBeGreaterThanOrEqual(1)
    expect(out.results[0].url).toMatch(/^https?:\/\//)
  })
})
