import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { runTool } from "@agentproto/driver"
import {
  defineHttpDriver,
  expandEndpoint,
  extractResponse,
  safeHttpCollector,
  isPrivateOrReservedIp,
  redactSecrets,
} from "../index.js"

const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }]

describe("endpoint interpolation, snake_case metadata and prototype guard", () => {
  it("interpolates path params in endpoint and supports snake_case query_template/response_extract", async () => {
    const tool = defineTool({
      id: "site.stats",
      description: "Read site stats.",
      inputSchema: z.object({ siteId: z.string(), from: z.number() }),
      outputSchema: z.number(),
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      expect(url).toBe("https://stats.example.com/api/sites/site_42/stats?start_at=1700000000")
      expect(init?.method).toBe("GET")
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer secret-tok-123",
      })
      return new Response(JSON.stringify({ summary: { visits: 321 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const driver = defineHttpDriver({
      id: "stats-http",
      name: "Stats",
      description: "Read-only stats driver.",
      baseUrl: "https://stats.example.com",
      auth: { state: { env: ["STATS_TOKEN"] } } as never,
      metadata: {
        metricSource: {
          readOnly: true,
          auth: { headerName: "Authorization", prefix: "Bearer " },
        },
      },
      implements: [
        {
          tool: "site.stats",
          version: "1.0.0",
          metadata: {
            http: {
              endpoint: "/api/sites/${input.siteId}/stats",
              method: "GET",
              query_template: { start_at: "${input.from}" },
              response_extract: "$.summary.visits",
            },
          },
        },
      ],
    })

    const wrapped = safeHttpCollector(driver, {
      fetch: fetchMock,
      dnsLookup: PUBLIC_DNS,
    })

    const out = await runTool({
      tool,
      candidates: [wrapped],
      input: { siteId: "site_42", from: 1700000000 },
      secrets: { STATS_TOKEN: "secret-tok-123" },
    })
    expect(out).toBe(321)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("blocks path traversal in expandEndpoint", () => {
    expect(() =>
      expandEndpoint("/api/sites/${input.siteId}/stats", {
        input: { siteId: "../admin" },
        secrets: {},
        context: {},
      }),
    ).toThrow(/unsafe path segment/i)
  })

  it("blocks __proto__, constructor, and prototype in extractResponse", () => {
    const body = { data: { value: 42 } }
    expect(extractResponse(body, "$.__proto__")).toBeUndefined()
    expect(extractResponse(body, "$.constructor")).toBeUndefined()
    expect(extractResponse(body, "$.data.prototype")).toBeUndefined()
    expect(extractResponse(body, "$.data.value")).toBe(42)
  })
})

describe("safeHttpCollector — guarded execution through the real driver", () => {
  const readTool = defineTool({
    id: "metrics.read",
    description: "Read metric rows.",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
  })

  it("refuses a manifest targeting 169.254.169.254 (cloud metadata) via runTool without calling fetch", async () => {
    const fetchMock = vi.fn()
    const driver = defineHttpDriver({
      id: "ssrf-meta-http",
      name: "Metadata SSRF",
      description: "Points at metadata endpoint.",
      baseUrl: "http://169.254.169.254",
      implements: [
        {
          tool: "metrics.read",
          version: "1.0.0",
          metadata: { http: { endpoint: "/latest/meta-data/", method: "GET" } },
        },
      ],
    })
    const wrapped = safeHttpCollector(driver, {
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      allowHttp: true,
    })

    await expect(
      runTool({ tool: readTool, candidates: [wrapped], input: {} }),
    ).rejects.toThrow(/private, loopback, link-local, or reserved|not allowed/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses DNS resolution to private or IPv4-mapped IPv6 addresses", async () => {
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true)
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true)
    expect(isPrivateOrReservedIp("10.0.0.5")).toBe(true)
    expect(isPrivateOrReservedIp("172.16.1.2")).toBe(true)
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true)
    expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true)
    expect(isPrivateOrReservedIp("::1")).toBe(true)
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true)
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true)
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true)
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false)

    const fetchMock = vi.fn()
    const driver = defineHttpDriver({
      id: "dns-rebind-http",
      name: "DNS Rebind",
      description: "Resolves to private IP.",
      baseUrl: "https://internal.example.com",
      implements: [
        {
          tool: "metrics.read",
          version: "1.0.0",
          metadata: { http: { endpoint: "/v1/metrics", method: "GET" } },
        },
      ],
    })
    const wrapped = safeHttpCollector(driver, {
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      dnsLookup: async () => [{ address: "10.0.0.42", family: 4 }],
    })

    await expect(
      runTool({ tool: readTool, candidates: [wrapped], input: {} }),
    ).rejects.toThrow(/resolved to blocked address/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses non-GET methods (POST/DELETE)", async () => {
    const fetchMock = vi.fn()
    const driver = defineHttpDriver({
      id: "mutating-http",
      name: "Mutating",
      description: "Attempts POST.",
      baseUrl: "https://api.example.com",
      implements: [
        {
          tool: "metrics.read",
          version: "1.0.0",
          metadata: { http: { endpoint: "/v1/write", method: "POST" } },
        },
      ],
    })
    const wrapped = safeHttpCollector(driver, {
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      dnsLookup: PUBLIC_DNS,
    })

    await expect(
      runTool({ tool: readTool, candidates: [wrapped], input: {} }),
    ).rejects.toThrow(/only allows GET/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses redirects, oversized responses (> cap), and non-JSON content-type", async () => {
    const baseDriver = defineHttpDriver({
      id: "guard-http",
      name: "Guard",
      description: "Test guards.",
      baseUrl: "https://api.example.com",
      implements: [
        {
          tool: "metrics.read",
          version: "1.0.0",
          metadata: { http: { endpoint: "/v1/data", method: "GET" } },
        },
      ],
    })

    // Redirect
    const redirectWrapped = safeHttpCollector(baseDriver, {
      dnsLookup: PUBLIC_DNS,
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("error")
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
      }) as typeof globalThis.fetch,
    })
    await expect(
      runTool({ tool: readTool, candidates: [redirectWrapped], input: {} }),
    ).rejects.toThrow(/redirect/i)

    // Oversized response
    const oversizedWrapped = safeHttpCollector(baseDriver, {
      dnsLookup: PUBLIC_DNS,
      maxResponseBytes: 64,
      fetch: (async () =>
        new Response(JSON.stringify({ pad: "x".repeat(200) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    })
    await expect(
      runTool({ tool: readTool, candidates: [oversizedWrapped], input: {} }),
    ).rejects.toThrow(/exceeded ceiling|exceeds ceiling/i)

    // Non-JSON content-type
    const htmlWrapped = safeHttpCollector(baseDriver, {
      dnsLookup: PUBLIC_DNS,
      fetch: (async () =>
        new Response("<html>login</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as typeof globalThis.fetch,
    })
    await expect(
      runTool({ tool: readTool, candidates: [htmlWrapped], input: {} }),
    ).rejects.toThrow(/Expected JSON content-type/)
  })

  it("redacts secrets echoed in upstream error bodies and fails clearly when required secret is absent", async () => {
    const secretVal = "rk_live_super_secret_token_987654"
    expect(redactSecrets(`echo ${secretVal} failed`, { KEY: secretVal })).toBe(
      "echo [REDACTED] failed",
    )

    const driver = defineHttpDriver({
      id: "redact-http",
      name: "Redact",
      description: "Test secret redaction.",
      baseUrl: "https://api.example.com",
      auth: { state: { env: ["API_KEY"] } } as never,
      metadata: {
        metricSource: {
          readOnly: true,
          auth: { headerName: "Authorization", prefix: "Bearer " },
        },
      },
      implements: [
        {
          tool: "metrics.read",
          version: "1.0.0",
          metadata: { http: { endpoint: "/v1/data", method: "GET" } },
        },
      ],
    })

    const wrapped = safeHttpCollector(driver, {
      dnsLookup: PUBLIC_DNS,
      fetch: (async () =>
        new Response(`Invalid token: ${secretVal}`, {
          status: 401,
          headers: { "content-type": "text/plain" },
        })) as typeof globalThis.fetch,
    })

    // Missing secret
    await expect(
      runTool({ tool: readTool, candidates: [wrapped], input: {}, secrets: {} }),
    ).rejects.toThrow(/missing required secret 'API_KEY'/)

    // Secret echoed in 401 body must be scrubbed
    try {
      await runTool({
        tool: readTool,
        candidates: [wrapped],
        input: {},
        secrets: { API_KEY: secretVal },
      })
      expect.unreachable("should have thrown")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(secretVal)
      expect(msg).toContain("[REDACTED]")
    }
  })
})
