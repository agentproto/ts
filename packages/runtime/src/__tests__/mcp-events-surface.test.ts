import { describe, expect, it, vi } from "vitest"
import { handleModernRequest } from "../mcp-modern/index.js"
import { createEventsSurfaceServer, isSubscriptionPermitted } from "../mcp-events-surface.js"

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
}

function stubs() {
  return {
    list: vi.fn(async () => ({ events: [] })),
    subscribe: vi.fn(async () => ({ id: "sub_1", refreshBefore: null, cursor: null })),
    unsubscribe: vi.fn(async () => ({})),
  }
}

async function call(
  handlers: ReturnType<typeof stubs>,
  repoAllowlist: readonly string[],
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
) {
  const out = await handleModernRequest(
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    },
    { createServer: async () => createEventsSurfaceServer({ version: "0", handlers, repoAllowlist }) },
  )
  return JSON.parse(out.body ?? "null") as {
    result?: Record<string, any>
    error?: { code: number; message: string }
  }
}

const FORBIDDEN = ["command", "fs_", "file_", "terminal", "agent_", "approval", "imported", "session"]

describe("events surface: registered surface", () => {
  it("lists exactly one tool, events_ping, and no dangerous names", async () => {
    const body = await call(stubs(), [], "tools/list")
    const names = (body.result?.tools as { name: string }[]).map(t => t.name)
    expect(names).toEqual(["events_ping"])
    for (const name of names) for (const bad of FORBIDDEN) expect(name).not.toContain(bad)
  })

  it("exposes no resources and no prompts", async () => {
    for (const method of ["resources/list", "prompts/list"]) {
      const body = await call(stubs(), [], method)
      const list = body.result?.resources ?? body.result?.prompts
      if (body.error) expect(body.error.code).toBeLessThan(0)
      else expect(list).toEqual([])
    }
  })

  it("server/discover advertises events and tools only", async () => {
    const body = await call(stubs(), [], "server/discover")
    const caps = body.result?.capabilities as Record<string, unknown>
    expect(caps.events).toBeDefined()
    expect(caps.tools).toBeDefined()
    expect(caps.resources).toBeUndefined()
    expect(caps.prompts).toBeUndefined()
    expect(caps.logging).toBeUndefined()
  })

  it("events_ping answers ok", async () => {
    const body = await call(stubs(), [], "tools/call", { name: "events_ping", arguments: {} }, { "mcp-name": "events_ping" })
    expect(body.result?.content).toEqual([{ type: "text", text: "ok" }])
  })
})

describe("events surface: subscription allowlist", () => {
  it("refuses a repo outside the allowlist without calling the handler", async () => {
    const h = stubs()
    const body = await call(h, ["acme/ok"], "events/subscribe", { name: "n", arguments: { repo: "acme/other" } })
    expect(body.error?.code).toBe(-32602)
    expect(body.error?.message).toContain("subscription not permitted")
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it("passes an allowed repo through to the handler once", async () => {
    const h = stubs()
    const body = await call(h, ["acme/ok"], "events/subscribe", { name: "n", arguments: { repo: "acme/ok" } })
    expect(body.error).toBeUndefined()
    expect(body.result?.id).toBe("sub_1")
    expect(h.subscribe).toHaveBeenCalledTimes(1)
  })

  it("refuses every subscribe when the allowlist is empty", async () => {
    const h = stubs()
    const body = await call(h, [], "events/subscribe", { name: "n", arguments: { repo: "acme/ok" } })
    expect(body.error?.code).toBe(-32602)
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it("refuses when arguments is missing or not an object", async () => {
    const h = stubs()
    for (const params of [{ name: "n" }, { name: "n", arguments: "acme/ok" }, { name: "n", arguments: ["acme/ok"] }]) {
      const body = await call(h, ["acme/ok"], "events/subscribe", params)
      expect(body.error?.code).toBe(-32602)
    }
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it("leaves events/list and events/unsubscribe unrestricted", async () => {
    const h = stubs()
    const list = await call(h, [], "events/list")
    const unsub = await call(h, [], "events/unsubscribe", { id: "sub_1" })
    expect(list.error).toBeUndefined()
    expect(unsub.error).toBeUndefined()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe("events surface: isSubscriptionPermitted", () => {
  const allow = ["acme/ok"]
  it("accepts only a string repo in the allowlist", () => {
    expect(isSubscriptionPermitted({ arguments: { repo: "acme/ok" } }, allow)).toBe(true)
    expect(isSubscriptionPermitted({ arguments: { repo: "acme/no" } }, allow)).toBe(false)
  })
  it("rejects non-string repos and malformed arguments", () => {
    expect(isSubscriptionPermitted({ arguments: { repo: 1 } }, allow)).toBe(false)
    expect(isSubscriptionPermitted({ arguments: { repo: ["acme/ok"] } }, allow)).toBe(false)
    expect(isSubscriptionPermitted({ arguments: { repo: { name: "acme/ok" } } }, allow)).toBe(false)
    expect(isSubscriptionPermitted({ arguments: null }, allow)).toBe(false)
    expect(isSubscriptionPermitted({ arguments: ["acme/ok"] }, allow)).toBe(false)
    expect(isSubscriptionPermitted({}, allow)).toBe(false)
    expect(isSubscriptionPermitted({ arguments: { repo: "acme/ok" } }, [])).toBe(false)
  })
})
