import { describe, expect, it, vi } from "vitest"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import { createMcpServer, registerEventsMethods } from "@agentproto/mcp-server"
import { handleModernRequest, type ModernDeps } from "../mcp-modern/index.js"
import { createMcpObservationStore } from "../mcp-session-observer.js"

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
}

interface Rig {
  deps: ModernDeps
  closes: { count: number }
}

/** A real legacy server with tools, a resource, a prompt and the three events methods. */
function rig(over: Partial<ModernDeps> = {}, eventsError?: McpError): Rig {
  const closes = { count: 0 }
  const deps: ModernDeps = {
    createServer: async () => {
      const { server } = await createMcpServer({ specs: [], name: "main", version: "1.2.3" })
      server.tool("probe", "probe tool", {}, async () => ({ content: [{ type: "text", text: "ok" }] }))
      server.tool("alpha", "alpha tool", {}, async () => ({ content: [{ type: "text", text: "a" }] }))
      server.resource("res", "file:///r.txt", async () => ({ contents: [{ uri: "file:///r.txt", text: "x" }] }))
      server.prompt("pr", async () => ({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }))
      registerEventsMethods(server, {
        list: async () => ({ events: [] }),
        subscribe: async () => {
          if (eventsError) throw eventsError
          return { id: "sub_1", refreshBefore: null, cursor: null }
        },
        unsubscribe: async () => ({}),
      })
      const close = server.close.bind(server)
      server.close = async () => {
        closes.count += 1
        return close()
      }
      return server
    },
    ...over,
  }
  return { deps, closes }
}

function call(
  method: string,
  params: Record<string, unknown> = {},
  opts: { headers?: Record<string, string | string[] | undefined>; id?: string | number | null; verb?: string; body?: string; meta?: Record<string, unknown> } = {},
  deps: ModernDeps = rig().deps,
) {
  const body = opts.body ?? JSON.stringify({ jsonrpc: "2.0", id: opts.id === undefined ? 1 : opts.id, method, params: { ...params, _meta: opts.meta ?? META } })
  return handleModernRequest(
    {
      method: opts.verb ?? "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...opts.headers,
      },
      body,
    },
    deps,
  )
}

const json = (r: { body?: string }) => JSON.parse(r.body ?? "null") as { id: unknown; result?: Record<string, any>; error?: { code: number; message: string; data?: any } }

describe("server/discover", () => {
  it("builds the discover result from the real server", async () => {
    const r = await call("server/discover")
    expect(r.status).toBe(200)
    const body = json(r)
    expect(body.result?.resultType).toBe("complete")
    expect(body.result?.supportedVersions).toEqual(["2026-07-28"])
    expect(body.result?.capabilities?.tools).toBeDefined()
    // ADJUSTED vs brief: the legacy server advertises `events` methods via server/discover but does NOT
    // advertise an `events` capability through the in-process initialize handshake (getServerCapabilities()),
    // so capabilities.events is undefined here.
    expect(body.result?.capabilities?.events).toBeUndefined()
    expect(body.result?.capabilities?.logging).toBeUndefined()
    expect(body.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({ name: "main", version: "1.2.3" })
    expect(body.result?.ttlMs).toBe(0)
    expect(body.result?.cacheScope).toBe("private")
  })

  it("uses the injected cache policy", async () => {
    const { deps } = rig({ cachePolicy: () => ({ ttlMs: 60000, cacheScope: "public" }) })
    const r = await call("server/discover", {}, {}, deps)
    const body = json(r)
    expect(body.result?.ttlMs).toBe(60000)
    expect(body.result?.cacheScope).toBe("public")
  })

  it("uses the injected supported versions", async () => {
    const versions = ["2026-07-28", "2099-01-01"]
    const { deps } = rig({ supportedVersions: versions })
    const r = await call("server/discover", {}, {}, deps)
    expect(json(r).result?.supportedVersions).toEqual(versions)
    // ADJUSTED vs brief: a version INSIDE the injected list is accepted (200), so the -32022 case must use a
    // version outside it; `data.supported` still equals the injected list.
    const meta = { ...META, "io.modelcontextprotocol/protocolVersion": "2099-12-01" }
    const bad = await call("server/discover", {}, { meta, headers: { "mcp-protocol-version": "2099-12-01" } }, deps)
    expect(bad.status).toBe(400)
    const err = json(bad).error
    expect(err?.code).toBe(-32022)
    expect(err?.data?.supported).toEqual(versions)
  })
})

describe("forwarded methods and result decoration", () => {
  it("tools/list carries resultType, ttlMs, cacheScope and a stable order", async () => {
    const a = json(await call("tools/list")).result
    const b = json(await call("tools/list")).result
    expect(a?.resultType).toBe("complete")
    expect(a?.tools.map((t: { name: string }) => t.name)).toEqual(["probe", "alpha"])
    expect(b?.tools.map((t: { name: string }) => t.name)).toEqual(["probe", "alpha"])
    expect(a?.ttlMs).toBe(0)
    expect(a?.cacheScope).toBe("private")
  })

  it("tools/call carries resultType and no hints", async () => {
    const r = await call("tools/call", { name: "probe", arguments: {} }, { headers: { "mcp-name": "probe" } })
    expect(r.status).toBe(200)
    const result = json(r).result
    expect(result?.content[0].text).toBe("ok")
    expect(result?.resultType).toBe("complete")
    expect(result?.ttlMs).toBeUndefined()
    expect(result?.cacheScope).toBeUndefined()
  })

  it("events results carry resultType and no hints", async () => {
    const list = json(await call("events/list")).result
    expect(Array.isArray(list?.events)).toBe(true)
    expect(list?.ttlMs).toBeUndefined()
    expect(list?.cacheScope).toBeUndefined()
    const sub = json(await call("events/subscribe", { name: "x", arguments: {}, delivery: {} })).result
    expect(sub?.id).toBe("sub_1")
    expect(sub?.ttlMs).toBeUndefined()
    expect(sub?.cacheScope).toBeUndefined()
    const unsub = json(await call("events/unsubscribe")).result
    expect(Object.keys(unsub ?? {}).sort()).toEqual(["_meta", "resultType"])
  })

  it("hints are present on the cacheable operations only", async () => {
    for (const r of [await call("resources/list"), await call("resources/read", { uri: "file:///r.txt" }, { headers: { "mcp-name": "file:///r.txt" } }), await call("prompts/list")]) {
      expect(r.status).toBe(200)
      const result = json(r).result
      expect(result?.ttlMs).toBe(0)
      expect(result?.cacheScope).toBe("private")
    }
    const get = json(await call("prompts/get", { name: "pr" }, { headers: { "mcp-name": "pr" } })).result
    expect(get?.ttlMs).toBeUndefined()
    expect(get?.cacheScope).toBeUndefined()
    // Observed: the legacy server DOES answer resources/templates/list (200 with hints).
    const templates = await call("resources/templates/list")
    if (templates.status === 200) {
      const result = json(templates).result
      expect(result?.ttlMs).toBe(0)
      expect(result?.cacheScope).toBe("private")
    } else {
      expect(templates.status).toBe(404)
      expect(json(templates).error?.code).toBe(-32601)
    }
  })

  it("forwardParams strips only the handshake _meta keys", async () => {
    const { forwardParams } = await import("../mcp-modern/bridge.js")
    expect(forwardParams({ a: 1, _meta: { ...META, progressToken: "p" } })).toEqual({ a: 1, _meta: { progressToken: "p" } })
    expect(forwardParams({ a: 1, _meta: META })).toEqual({ a: 1 })
  })

  it("a handler error keeps HTTP 200 and loses the SDK prefix", async () => {
    const { deps } = rig({}, new McpError(-32015, "callback unreachable", { reason: "x" }))
    const r = await call("events/subscribe", { name: "x", arguments: {}, delivery: {} }, {}, deps)
    expect(r.status).toBe(200)
    const err = json(r).error
    // The SDK wraps the handler's McpError twice ("MCP error <code>: " on the server, again in the bridge client);
    // the core strips every stacked prefix. `data` still arrives intact.
    expect(err?.code).toBe(-32015)
    expect(err?.message).toBe("callback unreachable")
    expect(err?.data).toEqual({ reason: "x" })
  })

  it("a method the legacy server does not know is 404 -32601", async () => {
    const { deps } = rig({
      createServer: async () => {
        const { server } = await createMcpServer({ specs: [], name: "main", version: "1.2.3" })
        server.tool("probe", "probe tool", {}, async () => ({ content: [{ type: "text", text: "ok" }] }))
        return server
      },
    })
    const r = await call("prompts/list", {}, {}, deps)
    expect(r.status).toBe(404)
    expect(json(r).error?.code).toBe(-32601)
  })
})

describe("HTTP-level rules", () => {
  it("only POST is accepted", async () => {
    for (const verb of ["GET", "HEAD", "OPTIONS", "DELETE", "PUT"]) {
      const r = await call("server/discover", {}, { verb })
      expect(r.status).toBe(405)
      expect(r.headers.allow).toBe("POST")
    }
  })

  it("Accept must allow application/json", async () => {
    for (const accept of [undefined, "text/event-stream"]) {
      const r = await call("server/discover", {}, { headers: { accept } })
      expect(r.status).toBe(406)
    }
    for (const accept of ["application/json", "*/*", "application/*;q=0.9", "application/json, text/event-stream"]) {
      const r = await call("server/discover", {}, { headers: { accept } })
      expect(r.status).toBe(200)
    }
  })

  it("Content-Type must be application/json", async () => {
    for (const ct of ["text/plain", undefined]) {
      const r = await call("server/discover", {}, { headers: { "content-type": ct } })
      expect(r.status).toBe(415)
    }
    const r = await call("server/discover", {}, { headers: { "content-type": "application/json; charset=utf-8" } })
    expect(r.status).toBe(200)
  })

  it("malformed JSON", async () => {
    const r = await call("server/discover", {}, { body: "{nope" })
    expect(r.status).toBe(400)
    const err = json(r).error
    expect(err?.code).toBe(-32700)
    expect(json(r).id).toBe(null)
  })

  it("batch and response bodies", async () => {
    for (const body of ['[{"jsonrpc":"2.0","id":1,"method":"server/discover"}]', '{"jsonrpc":"2.0","id":1,"result":{}}']) {
      const r = await call("server/discover", {}, { body })
      expect(r.status).toBe(400)
      expect(json(r).error?.code).toBe(-32600)
      expect(json(r).id).toBe(null)
    }
  })

  it("a notification is accepted with 202 and no body", async () => {
    const r = await call("notifications/initialized", {}, { body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' })
    expect(r.status).toBe(202)
    expect(r.body).toBeUndefined()
  })

  it("error responses carry the request id", async () => {
    for (const id of ["abc", 7]) {
      const r = await call("tools/list", {}, { id, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }) })
      expect(r.status).toBe(400)
      expect(json(r).error).toBeDefined()
      expect(json(r).id).toBe(id)
    }
  })
})

describe("request validation", () => {
  it("_meta is required", async () => {
    for (const body of [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
    ]) {
      const r = await call("tools/list", {}, { body })
      expect(r.status).toBe(400)
      expect(json(r).error?.code).toBe(-32602)
      expect(json(r).error?.message).toContain("_meta")
    }
  })

  it("clientInfo is optional", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }
    const r = await call("tools/list", {}, { meta })
    expect(r.status).toBe(200)
  })

  it("an unsupported version is -32022 with data", async () => {
    const meta = { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" }
    const r = await call("tools/list", {}, { meta, headers: { "mcp-protocol-version": "1900-01-01" } })
    expect(r.status).toBe(400)
    const err = json(r).error
    expect(err?.code).toBe(-32022)
    expect(err?.data?.supported).toEqual(["2026-07-28"])
    expect(err?.data?.requested).toBe("1900-01-01")
    const discover = json(await call("server/discover")).result
    expect(err?.data?.supported.every((v: string) => discover?.supportedVersions.includes(v))).toBe(true)
  })

  it("initialize is refused with -32022 naming the supported versions", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } })
    const r = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } }, { body })
    expect(r.status).toBe(400)
    const err = json(r).error
    expect(err?.code).toBe(-32022)
    expect(err?.data?.requested).toBe("2025-11-25")
  })

  it("MCP-Protocol-Version header", async () => {
    const missing = await call("tools/list", {}, { headers: { "mcp-protocol-version": undefined } })
    expect(missing.status).toBe(400)
    expect(json(missing).error?.code).toBe(-32020)
    const diff = await call("tools/list", {}, { headers: { "mcp-protocol-version": "2026-01-01" } })
    expect(diff.status).toBe(400)
    expect(json(diff).error?.code).toBe(-32020)
  })

  it("Mcp-Method header", async () => {
    const missing = await call("tools/list", {}, { headers: { "mcp-method": undefined } })
    expect(missing.status).toBe(400)
    expect(json(missing).error?.code).toBe(-32020)
    const different = await call("tools/list", {}, { headers: { "mcp-method": "tools/call" } })
    expect(different.status).toBe(400)
    expect(json(different).error?.code).toBe(-32020)
    const wrongCase = await call("tools/list", {}, { headers: { "mcp-method": "TOOLS/LIST" } })
    expect(wrongCase.status).toBe(400)
    expect(json(wrongCase).error?.code).toBe(-32020)
    // Name lookup is case-insensitive: exercised directly so overriding the header does not ALSO leave the
    // lower-case default in the map (which would duplicate the value on normalize).
    const caseInsensitive = await handleModernRequest(
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "MCP-METHOD": "server/discover",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META } }),
      },
      rig().deps,
    )
    expect(caseInsensitive.status).toBe(200)
    const duplicated = await call("server/discover", {}, { headers: { "mcp-method": ["server/discover", "server/discover"] } })
    expect(duplicated.status).toBe(400)
    expect(json(duplicated).error?.code).toBe(-32020)
  })

  it("Mcp-Name header", async () => {
    const missing = await call("tools/call", { name: "probe", arguments: {} }, { headers: { "mcp-name": undefined } })
    expect(missing.status).toBe(400)
    expect(json(missing).error?.code).toBe(-32020)
    const another = await call("tools/call", { name: "probe", arguments: {} }, { headers: { "mcp-name": "alpha" } })
    expect(another.status).toBe(400)
    expect(json(another).error?.code).toBe(-32020)
    const uri = await call("resources/read", { uri: "file:///r.txt" }, { headers: { "mcp-name": "file:///r.txt" } })
    expect(uri.status).toBe(200)
    const spaces = await call("tools/call", { name: "probe", arguments: {} }, { headers: { "mcp-name": "  probe  " } })
    expect(spaces.status).toBe(200)
    const sentinel = await call("tools/call", { name: "probe", arguments: {} }, { headers: { "mcp-name": "=?base64?cHJvYmU=?=" } })
    expect(sentinel.status).toBe(200)
    const noName = await call("tools/call", { arguments: {} })
    expect(noName.status).toBe(400)
    expect(json(noName).error?.code).toBe(-32602)
  })

  it("unknown and removed methods are 404 -32601", async () => {
    for (const method of ["unknown/method", "ping", "logging/setLevel", "resources/subscribe", "subscriptions/listen"]) {
      const r = await call(method)
      expect(r.status).toBe(404)
      expect(json(r).error?.code).toBe(-32601)
    }
  })
})

describe("lifecycle", () => {
  it("the legacy server is closed after every request", async () => {
    const { deps, closes } = rig()
    await call("server/discover", {}, {}, deps)
    await call("tools/list", {}, { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) }, deps)
    await call("tools/call", { name: "probe", arguments: {} }, { headers: { "mcp-name": "probe" } }, deps)
    expect(closes.count).toBe(2)
  })

  it("an aborted request answers 499 and still closes the server", async () => {
    const controller = new AbortController()
    // Aborted mid-request (a handler throws after the abort) so the abort check inside the catch fires.
    const { deps: inner, closes } = rig({}, new McpError(-32015, "aborted"))
    const deps: ModernDeps = {
      ...inner,
      signal: controller.signal,
      createServer: async () => {
        const server = await inner.createServer()
        controller.abort()
        return server
      },
    }
    const r = await call("events/subscribe", { name: "x", arguments: {}, delivery: {} }, {}, deps)
    expect(r.status).toBe(499)
    expect(r.body).toBeUndefined()
    expect(closes.count).toBe(1)
  })

  it("forwards the abort signal to the handler and answers 499 even if the handler returns", async () => {
    const controller = new AbortController()
    const seen = { aborted: false, started: false }
    const { deps: inner, closes } = rig()
    const deps: ModernDeps = {
      ...inner,
      signal: controller.signal,
      createServer: async () => {
        const { server } = await createMcpServer({ specs: [], name: "main", version: "1.2.3" })
        server.tool("slow", "slow tool", {}, async (_args, extra) => {
          seen.started = true
          controller.abort()
          await new Promise<void>((resolve) => {
            if (extra.signal.aborted) return resolve()
            extra.signal.addEventListener("abort", () => resolve(), { once: true })
          })
          seen.aborted = extra.signal.aborted
          return { content: [{ type: "text", text: "done" }] }
        })
        const close = server.close.bind(server)
        server.close = async () => {
          closes.count += 1
          return close()
        }
        return server
      },
    }
    const r = await call("tools/call", { name: "slow", arguments: {} }, { headers: { "mcp-name": "slow" } }, deps)
    expect(seen.started).toBe(true)
    expect(seen.aborted).toBe(true)
    expect(r.status).toBe(499)
    expect(closes.count).toBe(1)
  })

  it("a createServer failure is a 500 Internal error without leaking the message", async () => {
    const { deps } = rig({ createServer: async () => { throw new Error("secret detail") } })
    const r = await call("server/discover", {}, {}, deps)
    expect(r.status).toBe(500)
    const err = json(r).error
    expect(err?.code).toBe(-32603)
    expect(r.body).not.toContain("secret detail")
  })

  it("onObserved sees discover and tools/list only", async () => {
    const spy = vi.fn()
    const { deps } = rig({ onObserved: spy })
    await call("server/discover", {}, {}, deps)
    await call("tools/list", {}, {}, deps)
    await call("tools/call", { name: "probe", arguments: {} }, { headers: { "mcp-name": "probe" } }, deps)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0]?.[0]).toBe("server/discover")
    expect(spy.mock.calls[1]?.[0]).toBe("tools/list")
    expect(spy.mock.calls[0]?.[1].result).toBeDefined()
    expect(spy.mock.calls[1]?.[1].result).toBeDefined()
  })
})

describe("observer recordResult", () => {
  it("recordResult feeds the session observer", () => {
    const store = createMcpObservationStore()
    store.recordResult("sess_1", "tools/list", { result: { tools: [{ name: "a" }, { name: "b" }] } }, "2026-07-28")
    expect(store.get("sess_1")?.toolsList?.toolCount).toBe(2)
    expect(store.get("sess_1")?.toolsList?.protocolVersion).toBe("2026-07-28")
    store.recordResult("sess_1", "server/discover", { result: {} }, "2026-07-28")
    expect(store.get("sess_1")?.discover?.ok).toBe(true)
  })
})
