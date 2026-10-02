/**
 * Native MCP Events transport (W-C of .plans/sentinel-mcp-events).
 *
 * `discover-exposes-events-capability` is the Contract Map §2 row: the
 * `server/discover` response advertises `events:{}` on the SAME authenticated
 * endpoint as tools. The remaining cases prove the three methods dispatch as
 * NATIVE JSON-RPC methods (not `tools/call`) and that an adapter error's
 * `code` + `data.reason` cross the wire verbatim.
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { MCP_EVENTS_PROTOCOL_VERSION, registerEventsMethods, type EventsMethodsHandlers } from "../events-methods.js"

const DiscoverResult = z.object({
  resultType: z.string(),
  supportedVersions: z.array(z.string()),
  capabilities: z.object({
    tools: z.record(z.string(), z.unknown()).optional(),
    events: z.record(z.string(), z.unknown()).optional(),
  }),
})

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
    const client = await connect(okHandlers())
    const result = await client.request({ method: "server/discover" } as never, DiscoverResult)
    expect(result.resultType).toBe("complete")
    expect(result.supportedVersions).toContain(MCP_EVENTS_PROTOCOL_VERSION)
    expect(result.capabilities.events).toBeDefined()
    expect(result.capabilities.tools).toBeDefined()
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
