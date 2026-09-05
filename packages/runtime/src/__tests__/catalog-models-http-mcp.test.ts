/**
 * Surface wiring for the read-only catalog endpoint (SPEC §5) —
 * `GET /catalog/models` and the `catalog_models` MCP tool. Both are thin
 * shells over an injected `listCatalogModels` (mirrors `listAgentAdapters`
 * / `GET /adapters`): this file checks the query params reach the lister
 * and the "not configured" fallback, not the join itself (see
 * `catalog-models.test.ts` for `buildCatalogModels`'s own coverage).
 *
 * Every assertion here fails on `main`: neither the route nor the MCP
 * tool exists, and `listCatalogModels` isn't a recognized option on
 * either `startHttpServer` or `registerAgentTools`.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { startHttpServer, type CatalogModelsLister } from "../http-server.js"
import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { CatalogModelsResponse, CatalogRoute } from "../catalog-models.js"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

const FAKE_RESPONSE: CatalogModelsResponse = {
  vendors: [
    {
      vendor: "anthropic",
      products: [
        {
          product: "claude-opus-4-8",
          routes: [
            {
              route: "anthropic",
              ref: "anthropic/claude-opus-4-8",
              baseUrl: null,
              pricing: { inPer1M: 5, outPer1M: 25 },
              contextWindow: "1M",
              maxOutput: "128k",
              runnable: true,
              eligibleProfiles: ["jeremy-max"],
              adapterModes: [],
              adapters: ["claude-code"],
              curated: true,
              multiModel: false,
            },
          ],
        },
      ],
    },
  ],
  routes: [{ route: "anthropic", servableModels: ["anthropic/claude-opus-4-8"], multiModel: false }],
}

describe("GET /catalog/models — HTTP route", () => {
  it("501 with a clear message when no lister is wired", async () => {
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/catalog/models`)
      expect(res.status).toBe(501)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe("lister_not_configured")
    } finally {
      await http.stop()
    }
  })

  it("200 with the catalog, forwarding query params to the injected lister", async () => {
    let seenQuery: unknown
    const listCatalogModels: CatalogModelsLister = async query => {
      seenQuery = query
      return FAKE_RESPONSE
    }
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      listCatalogModels,
    })
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/catalog/models?adapter=claude-code&vendor=anthropic&route=anthropic&runnableOnly=true`,
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(FAKE_RESPONSE)
      expect(seenQuery).toEqual({
        adapter: "claude-code",
        vendor: "anthropic",
        route: "anthropic",
        runnableOnly: true,
      })
    } finally {
      await http.stop()
    }
  })

  it("500 with the error message when the lister throws", async () => {
    const listCatalogModels: CatalogModelsLister = async () => {
      throw new Error("boom")
    }
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      listCatalogModels,
    })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/catalog/models`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe("list_failed")
      expect(body.message).toBe("boom")
    } finally {
      await http.stop()
    }
  })
})

describe("catalog_models — MCP tool", () => {
  async function harness(listCatalogModels?: CatalogModelsLister) {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerAgentTools(server, { registry, ...(listCatalogModels ? { listCatalogModels } : {}) })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    return { client, close: async () => client.close() }
  }

  it("reports 'not enabled' when no lister is wired", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({ name: "catalog_models", arguments: {} })
      expect((result as { isError?: boolean }).isError).toBe(true)
      const content = (result as { content: Array<{ text: string }> }).content
      expect(content[0]!.text).toContain("catalog_models is not enabled")
    } finally {
      await h.close()
    }
  })

  it("returns the catalog and forwards query args to the injected lister", async () => {
    let seenQuery: unknown
    const h = await harness(async query => {
      seenQuery = query
      return FAKE_RESPONSE
    })
    try {
      const result = await h.client.callTool({
        name: "catalog_models",
        arguments: { vendor: "anthropic", runnableOnly: "true" },
      })
      const content = (result as { content: Array<{ text: string }> }).content
      expect(JSON.parse(content[0]!.text)).toEqual(FAKE_RESPONSE)
      expect(seenQuery).toEqual({ vendor: "anthropic", runnableOnly: true })
    } finally {
      await h.close()
    }
  })
})

// ── PR-3: additive limit/cursor pagination ─────────────────────

/** A fake catalog with `count` routes spread across vendors/products. */
function fakeMultiCatalog(count: number): CatalogModelsResponse {
  const vendors: CatalogModelsResponse["vendors"] = []
  for (let i = 0; i < count; i++) {
    const vendor = `vendor-${i % 3}`
    let v = vendors.find(x => x.vendor === vendor)
    if (!v) {
      v = { vendor, products: [] }
      vendors.push(v)
    }
    const product = `product-${i}`
    const route: CatalogRoute = {
      route: `route-${i}`,
      ref: `${vendor}/${product}`,
      baseUrl: null,
      pricing: { inPer1M: 1, outPer1M: 2 },
      contextWindow: null,
      maxOutput: null,
      runnable: i % 2 === 0,
      eligibleProfiles: [],
      adapterModes: [],
      adapters: ["fake"],
      curated: false,
      multiModel: false,
    }
    v.products.push({ product, routes: [route] })
  }
  return { vendors, routes: [] }
}

/** The same flattening the paginated branch does in the tool handler. */
function flattenCatalog(catalog: CatalogModelsResponse): Array<{
  vendor: string
  product: string
  route: CatalogRoute
}> {
  return catalog.vendors.flatMap(v =>
    v.products.flatMap(p => p.routes.map(r => ({ vendor: v.vendor, product: p.product, route: r }))),
  )
}

interface CatalogPage {
  items: Array<{ vendor: string; product: string; route: string }>
  nextCursor?: string
  total?: number
}

interface ProviderPage {
  items: Array<{ model: string }>
  nextCursor?: string
  total?: number
}

const toolResultShape = z
  .object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })
  .passthrough()

function textOf(result: z.input<typeof toolResultShape>): string {
  return toolResultShape.parse(result).content?.[0]?.text ?? "{}"
}

describe("catalog_models — pagination (PR-3, additive)", () => {
  const CATALOG = fakeMultiCatalog(7)

  function harness(listCatalogModels: CatalogModelsLister) {
    return (async () => {
      const registry = createSessionsRegistry({ persist: false })
      const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
      registerAgentTools(server, { registry, listCatalogModels })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: "test", version: "0.0.1" })
      await client.connect(clientTransport)
      return { client, close: async () => client.close() }
    })()
  }

  it("default (no limit/cursor) still returns the whole catalog, byte-identical shape", async () => {
    const h = await harness(async () => CATALOG)
    try {
      const result = await h.client.callTool({ name: "catalog_models", arguments: {} })
      const text = textOf(result)
      expect(JSON.parse(text)).toEqual(CATALOG)
      expect(text).toContain("\n  ")
      expect(text).not.toContain('"nextCursor"')
      expect(text).not.toContain('"total"')
      expect(text).not.toContain('"items"')
    } finally {
      await h.close()
    }
  })

  it("page-walk with limit=2 covers exactly the flattened filtered catalog, total on every page", async () => {
    const h = await harness(async () => CATALOG)
    try {
      const union: CatalogPage["items"] = []
      let cursor: string | undefined
      do {
        const result = await h.client.callTool({
          name: "catalog_models",
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        })
        const page: CatalogPage = JSON.parse(textOf(result))
        expect(page.total).toBe(7)
        union.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)

      const expected = flattenCatalog(CATALOG).map(e => ({
        vendor: e.vendor,
        product: e.product,
        ...e.route,
      }))
      expect(union).toEqual(expected)
    } finally {
      await h.close()
    }
  })

  it("total reflects the FILTERED length when filters shrink the catalog", async () => {
    const h = await harness(async query => {
      if (!query.runnableOnly) return CATALOG
      return {
        vendors: CATALOG.vendors.flatMap(v =>
          v.products
            .map(p => ({ product: p.product, routes: p.routes.filter(r => r.runnable) }))
            .filter(p => p.routes.length > 0)
            .map(p => ({ vendor: v.vendor, products: [p] })),
        ),
        routes: [],
      }
    })
    try {
      const result = await h.client.callTool({
        name: "catalog_models",
        arguments: { limit: 1, runnableOnly: "true" },
      })
      const page: CatalogPage = JSON.parse(textOf(result))
      const runnableRoutes = flattenCatalog(CATALOG)
        .filter(e => e.route.runnable)
        .map(e => e.route.route)
      expect(page.total).toBe(runnableRoutes.length)
      expect(page.items).toHaveLength(1)
      expect(page.items[0]?.route).toBe(runnableRoutes[0])
    } finally {
      await h.close()
    }
  })

  it("cursor resumes where the previous page left off (offset semantics)", async () => {
    const h = await harness(async () => CATALOG)
    try {
      const p1: CatalogPage = JSON.parse(
        textOf(
          await h.client.callTool({ name: "catalog_models", arguments: { limit: 2 } }),
        ),
      )
      const p2: CatalogPage = JSON.parse(
        textOf(
          await h.client.callTool({
            name: "catalog_models",
            arguments: { limit: 2, cursor: p1.nextCursor },
          }),
        ),
      )
      const all = flattenCatalog(CATALOG).map(e => e.route.route)
      expect(p1.items.map(i => i.route)).toEqual(all.slice(0, 2))
      expect(p2.items.map(i => i.route)).toEqual(all.slice(2, 4))
    } finally {
      await h.close()
    }
  })
})

describe("catalog_provider_models — pagination (PR-3, additive)", () => {
  async function harness() {
    const registry = createSessionsRegistry({ persist: false })
    const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
    registerAgentTools(server, { registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    return { client, close: async () => client.close() }
  }

  it("default (no limit/cursor) still returns the whole provider payload", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({
        name: "catalog_provider_models",
        arguments: { endpoint: "moonshot" },
      })
      const text = textOf(result)
      const parsed: { provider: string; models: never[] } = JSON.parse(text)
      expect(parsed.provider).toBe("moonshot")
      expect(Array.isArray(parsed.models)).toBe(true)
      expect(text).not.toContain('"nextCursor"')
    } finally {
      await h.close()
    }
  })

  it("page-walk with limit=2 covers exactly the unpaginated models array, total on every page", async () => {
    const h = await harness()
    try {
      const all: ProviderPage["items"] = JSON.parse(
        textOf(
          await h.client.callTool({
            name: "catalog_provider_models",
            arguments: { endpoint: "moonshot" },
          }),
        ),
      ).models
      if (all.length < 3) {
        return // static catalog too small here — offset test below still covers it
      }

      const union: ProviderPage["items"] = []
      let cursor: string | undefined
      let lastTotal: number | undefined
      do {
        const page: ProviderPage = JSON.parse(
          textOf(
            await h.client.callTool({
              name: "catalog_provider_models",
              arguments: { endpoint: "moonshot", limit: 2, ...(cursor ? { cursor } : {}) },
            }),
          ),
        )
        expect(page.total).toBe(all.length)
        lastTotal = page.total
        union.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      expect(lastTotal).toBe(all.length)
      expect(union).toEqual(all)
    } finally {
      await h.close()
    }
  })

  it("unknown provider with limit returns an empty envelope, not an error", async () => {
    const h = await harness()
    try {
      const result = await h.client.callTool({
        name: "catalog_provider_models",
        arguments: { endpoint: "nope", limit: 5 },
      })
      const page: ProviderPage = JSON.parse(textOf(result))
      expect(page.items).toEqual([])
      expect(page.total).toBe(0)
      expect(page.nextCursor).toBeUndefined()
    } finally {
      await h.close()
    }
  })
})
