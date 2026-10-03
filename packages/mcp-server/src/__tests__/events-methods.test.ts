/**
 * Native MCP Events transport (W-C of .plans/sentinel-mcp-events).
 *
 * `discover-exposes-events-capability` is the Contract Map §2 row: `events:{}`
 * is advertised at `initialize` on the SAME authenticated endpoint as tools
 * (`server/discover` is intentionally unregistered, see events-methods.ts).
 * The remaining cases prove the three methods dispatch as NATIVE JSON-RPC
 * methods (not `tools/call`) and that an adapter error's `code` + `data.reason`
 * cross the wire verbatim.
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerEventsMethods, type EventsMethodsHandlers } from "../events-methods.js"

const okHandlers = (overrides: Partial<EventsMethodsHandlers> = {}): EventsMethodsHandlers => ({
  list: async () => ({ events: [], nextCursor: null }),
  subscribe: async () => ({ id: "sub_x", refreshBefore: null, cursor: null }),
  unsubscribe: async () => ({}),
  ...overrides,
})

async function connect(handlers: EventsMethodsHandlers): Promise<Client> {
  const server = new McpServer({ name: "events-test", version: "0.0.0" })
  registerEventsMethods(server, handlers)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** `Client.request`'s request type is the SDK's known client→server union;
 *  these are custom methods, so the request is widened at the boundary. */
function request(client: Client, method: string, params?: Record<string, unknown>) {
  return client.request({ method, ...(params ? { params } : {}) } as never, z.looseObject({}))
}

describe("mcp events native methods", () => {
  it("discover-exposes-events-capability", async () => {
    const server = new McpServer({ name: "events-test", version: "0.0.0" })
    registerEventsMethods(server, okHandlers())
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    // Raw initialize: the SDK Client's schema strips the unknown `events` key.
    const reply = new Promise<{ result?: { capabilities?: Record<string, unknown> } }>(resolve => {
      clientTransport.onmessage = message => resolve(message as never)
    })
    await clientTransport.start()
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    })
    expect((await reply).result?.capabilities).toMatchObject({ events: {} })
    await server.close()
  })

  it("does not answer server/discover (an unserved protocol era must not be advertised)", async () => {
    const client = await connect(okHandlers())
    await expect(request(client, "server/discover")).rejects.toMatchObject({ code: -32601 })
    await client.close()
  })

  it("dispatches events/list as a native method (params reach the handler)", async () => {
    const client = await connect(
      okHandlers({
        list: async (params) => ({ events: [{ name: "github.pull_request.closed" }], nextCursor: null, echo: params }),
      }),
    )
    const result = (await request(client, "events/list", { pageSize: 1 })) as {
      events: Array<{ name: string }>
      nextCursor: null
      echo: Record<string, unknown>
    }
    expect(result.events[0]?.name).toBe("github.pull_request.closed")
    expect(result.echo).toEqual({ pageSize: 1 })
    await client.close()
  })

  it("dispatches events/subscribe and events/unsubscribe", async () => {
    const seen: string[] = []
    const client = await connect(
      okHandlers({
        subscribe: async (params) => {
          seen.push("subscribe")
          return { id: "sub_abc", refreshBefore: "2026-10-02T12:00:00.000Z", cursor: null, received: params.name }
        },
        unsubscribe: async () => {
          seen.push("unsubscribe")
          return {}
        },
      }),
    )
    const sub = (await request(client, "events/subscribe", { name: "github.pull_request.closed" })) as {
      id: string
      received: string
    }
    expect(sub.id).toBe("sub_abc")
    expect(sub.received).toBe("github.pull_request.closed")
    expect(await request(client, "events/unsubscribe", { name: "github.pull_request.closed" })).toEqual({})
    expect(seen).toEqual(["subscribe", "unsubscribe"])
    await client.close()
  })

  it("surfaces the adapter's JSON-RPC code + data.reason verbatim (-32015 CallbackEndpointError)", async () => {
    const err = Object.assign(new Error("CallbackEndpointError: boom"), {
      code: -32015,
      data: { reason: "challenge_failed" },
    })
    const client = await connect(
      okHandlers({
        subscribe: async () => {
          throw err
        },
      }),
    )
    await expect(request(client, "events/subscribe", { name: "x" })).rejects.toMatchObject({
      code: -32015,
      data: { reason: "challenge_failed" },
    })
    await client.close()
  })

  it("surfaces -32602 Invalid params verbatim", async () => {
    const client = await connect(
      okHandlers({
        list: async () => {
          throw Object.assign(new Error("Invalid params"), { code: -32602, data: { reason: "invalid_cursor" } })
        },
      }),
    )
    await expect(request(client, "events/list", { cursor: "bad" })).rejects.toMatchObject({
      code: -32602,
      data: { reason: "invalid_cursor" },
    })
    await client.close()
  })
})
