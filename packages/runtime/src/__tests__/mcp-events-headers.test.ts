/** SEP-3415: `Mcp-Name` carries `params.name` on every events method except `events/list`. */

import { describe, expect, it } from "vitest"
import { createMcpServer, registerEventsMethods } from "@agentproto/mcp-server"
import { handleModernRequest } from "../mcp-modern/index.js"

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
}

async function call(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  const out = await handleModernRequest(
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    },
    {
      createServer: async () => {
        const { server } = await createMcpServer({ specs: [], name: "main", version: "1" })
        registerEventsMethods(server, {
          list: async () => ({ events: [] }),
          subscribe: async () => ({ id: "sub_1", refreshBefore: null, cursor: null }),
          unsubscribe: async () => ({}),
          poll: async () => ({ events: [], cursor: "c", truncated: false, hasMore: false, nextPollMs: 1000 }),
        })
        return server
      },
    },
  )
  return { status: out.status, body: JSON.parse(out.body ?? "null") as { result?: unknown; error?: { code: number } } }
}

const PARAMS = { name: "github.pull_request.closed", arguments: { repo: "o/r", number: 1 }, cursor: null }

describe("events methods: Mcp-Name", () => {
  for (const method of ["events/poll", "events/subscribe", "events/unsubscribe"]) {
    it(`${method}: a missing Mcp-Name is -32020 (HTTP 400)`, async () => {
      const r = await call(method, PARAMS)
      expect(r.status).toBe(400)
      expect(r.body.error?.code).toBe(-32020)
    })

    it(`${method}: an Mcp-Name that differs from params.name is -32020`, async () => {
      const r = await call(method, PARAMS, { "mcp-name": "github.other" })
      expect(r.status).toBe(400)
      expect(r.body.error?.code).toBe(-32020)
    })

    it(`${method}: a matching Mcp-Name is served`, async () => {
      const r = await call(method, PARAMS, { "mcp-name": PARAMS.name })
      expect(r.status).toBe(200)
      expect(r.body.error).toBeUndefined()
    })
  }

  it("events/list needs no Mcp-Name", async () => {
    const r = await call("events/list", {})
    expect(r.status).toBe(200)
    expect(r.body.error).toBeUndefined()
  })
})
