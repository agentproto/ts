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
import type { CatalogModelsResponse } from "../catalog-models.js"

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
