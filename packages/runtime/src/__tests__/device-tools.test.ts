/**
 * Unit tests for the `device_*` MCP tools (DEVICES-PLAN PR-A) against a fake
 * `McpServer` that just captures each registered handler, and a fake
 * `DeviceRegistry` — no real pairing machinery needed here.
 */

import { describe, it, expect, vi } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerDeviceTools } from "../device-tools.js"
import type { Device, DeviceRegistry } from "../device-registry.js"

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

function fakeRegistry(devices: Device[]): DeviceRegistry {
  return {
    list: async () => devices,
    rename: vi.fn(async (target: string) => devices.some(d => d.fingerprint === target || d.name === target)),
    revoke: vi.fn(async (target: string) => devices.some(d => d.fingerprint === target || d.name === target)),
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
})
