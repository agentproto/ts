/**
 * Unit tests for the `device_*` MCP tools (DEVICES-PLAN PR-A) against a fake
 * `McpServer` that just captures each registered handler, and a fake
 * `DeviceRegistry` — no real pairing machinery needed here.
 */

import { describe, it, expect, vi } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerDeviceTools } from "../device-tools.js"
import type { Device, DeviceRegistry } from "../device-registry.js"
import type { JoinTokenRegistry } from "../join-token-registry.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>

function fakeServer(): { server: McpServer; handlers: Map<string, ToolHandler> } {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { server, handlers }
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    fingerprint: "fp1",
    name: "jeremy@laptop",
    role: "client",
    kind: "cli",
    rendezvous: "wss://rdv.example/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-02T00:00:00.000Z",
    online: true,
    ...overrides,
  }
}

function fakeRegistry(
  devices: Device[],
  addImpl: DeviceRegistry["add"] = vi.fn(async () => {
    throw new Error("add not stubbed")
  }),
  forwardHttpImpl: DeviceRegistry["forwardHttp"] = vi.fn(async () => {
    throw new Error("forwardHttp not stubbed")
  }),
): DeviceRegistry {
  return {
    list: async () => devices,
    rename: vi.fn(async (target: string) => devices.some(d => d.fingerprint === target || d.name === target)),
    revoke: vi.fn(async (target: string) => devices.some(d => d.fingerprint === target || d.name === target)),
    add: addImpl,
    forwardHttp: forwardHttpImpl,
  }
}

function fakeJoinTokens(overrides: Partial<JoinTokenRegistry> = {}): JoinTokenRegistry {
  return {
    create: vi.fn(async () => {
      throw new Error("create not stubbed")
    }),
    list: vi.fn(async () => []),
    revoke: vi.fn(async () => false),
    startAutoconnect: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  }
}

async function callTool(handlers: Map<string, ToolHandler>, name: string, args: unknown): Promise<unknown> {
  const handler = handlers.get(name)
  if (!handler) throw new Error(`tool "${name}" was not registered`)
  const result = await handler(args)
  return JSON.parse(result.content[0]!.text)
}

describe("device_list / device_rename / device_revoke", () => {
  it("device_list returns the registry's devices verbatim", async () => {
    const { server, handlers } = fakeServer()
    const devices = [device()]
    registerDeviceTools(server, { registry: fakeRegistry(devices) })
    expect(await callTool(handlers, "device_list", {})).toEqual({ devices })
  })

  it("device_rename reports ok:true on a match", async () => {
    const { server, handlers } = fakeServer()
    const registry = fakeRegistry([device()])
    registerDeviceTools(server, { registry })
    expect(await callTool(handlers, "device_rename", { target: "fp1", name: "new-name" })).toEqual({
      ok: true,
      target: "fp1",
      name: "new-name",
    })
    expect(registry.rename).toHaveBeenCalledWith("fp1", "new-name")
  })

  it("device_rename reports ok:false with a message on no match", async () => {
    const { server, handlers } = fakeServer()
    registerDeviceTools(server, { registry: fakeRegistry([]) })
    expect(await callTool(handlers, "device_rename", { target: "nope", name: "x" })).toEqual({
      ok: false,
      message: 'no device matched "nope"',
    })
  })

  it("device_revoke reports ok:true on a match, ok:false otherwise", async () => {
    const { server, handlers } = fakeServer()
    const registry = fakeRegistry([device()])
    registerDeviceTools(server, { registry })
    expect(await callTool(handlers, "device_revoke", { target: "fp1" })).toEqual({ ok: true, revoked: "fp1" })
    expect(registry.revoke).toHaveBeenCalledWith("fp1")

    expect(await callTool(handlers, "device_revoke", { target: "nope" })).toEqual({
      ok: false,
      message: 'no device matched "nope"',
    })
  })

  it("device_add reports ok:true with the registered host on success", async () => {
    const { server, handlers } = fakeServer()
    const add = vi.fn(async () => ({ fingerprint: "hfp1", name: "office-mac", rendezvousUrl: "wss://rdv.example/v1" }))
    registerDeviceTools(server, { registry: fakeRegistry([], add) })
    expect(
      await callTool(handlers, "device_add", { offerUrl: "agentproto://pair?v=2&…&scope=host", name: "office-mac" }),
    ).toEqual({ ok: true, fingerprint: "hfp1", name: "office-mac", rendezvousUrl: "wss://rdv.example/v1" })
    expect(add).toHaveBeenCalledWith("agentproto://pair?v=2&…&scope=host", "office-mac")
  })

  it("device_add reports ok:false with the registry's error message on failure", async () => {
    const { server, handlers } = fakeServer()
    const add = vi.fn(async () => {
      throw new Error("this offer is not host-scoped")
    })
    registerDeviceTools(server, { registry: fakeRegistry([], add) })
    expect(await callTool(handlers, "device_add", { offerUrl: "agentproto://pair?v=2&…" })).toEqual({
      ok: false,
      message: "this offer is not host-scoped",
    })
  })
})

describe("device_sessions", () => {
  function jsonBody(body: unknown): { status: number; headers: Record<string, string>; body: Uint8Array } {
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) }
  }

  it("with no sessionId, forwards a GET /sessions and returns it", async () => {
    const { server, handlers } = fakeServer()
    const forwardHttp = vi.fn(async () => jsonBody({ sessions: [{ id: "s1" }] }))
    registerDeviceTools(server, { registry: fakeRegistry([], undefined, forwardHttp) })
    expect(await callTool(handlers, "device_sessions", { target: "hfp1" })).toEqual({
      ok: true,
      sessions: [{ id: "s1" }],
    })
    expect(forwardHttp).toHaveBeenCalledWith("hfp1", { method: "GET", path: "/sessions" })
  })

  it("with a sessionId, forwards a GET /sessions/:id/output with lastN/clean in the query", async () => {
    const { server, handlers } = fakeServer()
    const forwardHttp = vi.fn(async (_target: string, _req: { method: string; path: string }) =>
      jsonBody({ lines: ["hello"] }),
    )
    registerDeviceTools(server, { registry: fakeRegistry([], undefined, forwardHttp) })
    expect(
      await callTool(handlers, "device_sessions", { target: "hfp1", sessionId: "s1", lastN: 10, clean: true }),
    ).toEqual({ ok: true, lines: ["hello"] })
    const [target, req] = forwardHttp.mock.calls[0]!
    expect(target).toBe("hfp1")
    expect(req.method).toBe("GET")
    expect(req.path).toMatch(/^\/sessions\/s1\/output\?/)
    expect(req.path).toContain("lastN=10")
    expect(req.path).toContain("clean=true")
  })

  it("reports ok:false with the registry's error message on failure", async () => {
    const { server, handlers } = fakeServer()
    const forwardHttp = vi.fn(async () => {
      throw new Error("could not reach host")
    })
    registerDeviceTools(server, { registry: fakeRegistry([], undefined, forwardHttp) })
    expect(await callTool(handlers, "device_sessions", { target: "nope" })).toEqual({
      ok: false,
      message: "could not reach host",
    })
  })

  it("a non-200 forward reports ok:false with the status and raw body", async () => {
    const { server, handlers } = fakeServer()
    const forwardHttp = vi.fn(async () => ({
      status: 502,
      headers: {},
      body: new TextEncoder().encode("bad gateway"),
    }))
    registerDeviceTools(server, { registry: fakeRegistry([], undefined, forwardHttp) })
    expect(await callTool(handlers, "device_sessions", { target: "hfp1" })).toEqual({
      ok: false,
      status: 502,
      message: "bad gateway",
    })
  })
})

describe("join_token_create / join_token_list / join_token_revoke", () => {
  it("are not registered when no JoinTokenRegistry is wired", async () => {
    const { server, handlers } = fakeServer()
    registerDeviceTools(server, { registry: fakeRegistry([]) })
    expect(handlers.has("join_token_create")).toBe(false)
    expect(handlers.has("join_token_list")).toBe(false)
    expect(handlers.has("join_token_revoke")).toBe(false)
  })

  it("join_token_create returns the minted token on success", async () => {
    const { server, handlers } = fakeServer()
    const create = vi.fn(async () => ({
      id: "abc123",
      name: "ci-reviewer",
      token: "agentproto://pair?v=2&…&scope=host",
      rendezvousUrl: "wss://rdv.example/v1",
      expiresAt: "2026-04-01T00:00:00.000Z",
    }))
    registerDeviceTools(server, { registry: fakeRegistry([]), joinTokens: fakeJoinTokens({ create }) })
    expect(await callTool(handlers, "join_token_create", { name: "ci-reviewer" })).toEqual({
      ok: true,
      id: "abc123",
      name: "ci-reviewer",
      token: "agentproto://pair?v=2&…&scope=host",
      rendezvousUrl: "wss://rdv.example/v1",
      expiresAt: "2026-04-01T00:00:00.000Z",
    })
    expect(create).toHaveBeenCalledWith({ name: "ci-reviewer" })
  })

  it("join_token_list returns the registry's tokens verbatim", async () => {
    const { server, handlers } = fakeServer()
    const tokens: Awaited<ReturnType<JoinTokenRegistry["list"]>> = [
      {
        id: "abc123",
        name: "ci-reviewer",
        rendezvousUrl: "wss://rdv.example/v1",
        createdAt: "x",
        expiresAt: "y",
        useCount: 0,
      },
    ]
    registerDeviceTools(server, { registry: fakeRegistry([]), joinTokens: fakeJoinTokens({ list: vi.fn(async () => tokens) }) })
    expect(await callTool(handlers, "join_token_list", {})).toEqual({ tokens })
  })

  it("join_token_revoke reports ok:true on a match, ok:false otherwise", async () => {
    const { server, handlers } = fakeServer()
    const revoke = vi.fn(async (target: string) => target === "abc123")
    registerDeviceTools(server, { registry: fakeRegistry([]), joinTokens: fakeJoinTokens({ revoke }) })
    expect(await callTool(handlers, "join_token_revoke", { target: "abc123" })).toEqual({
      ok: true,
      revoked: "abc123",
    })
    expect(await callTool(handlers, "join_token_revoke", { target: "nope" })).toEqual({
      ok: false,
      message: 'no join token matched "nope"',
    })
  })
})
