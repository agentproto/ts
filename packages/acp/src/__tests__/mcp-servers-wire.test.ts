import { describe, it, expect } from "vitest"
import { toAcpMcpServers } from "../client/index.js"
import type { AcpMcpServer } from "../types.js"

describe("toAcpMcpServers — AcpMcpServer → ACP session/new wire shape", () => {
  it("maps the orchestrator-injected http entry to { type:'http', url, headers }", () => {
    // This is exactly the entry createOrchestratorInjector builds for a
    // scoped sub-gateway. The bug: it reached `session/new` verbatim as
    // `{ transport:'http', ref }` and the agent rejected with
    // "Invalid params". It must become `{ type:'http', url, headers:[] }`.
    const injected: AcpMcpServer = {
      name: "agentproto",
      transport: "http",
      ref: "http://127.0.0.1:8765/mcp/orchestrator?scope=tok_abc",
    }

    const [wire] = toAcpMcpServers([injected])

    expect(wire).toEqual({
      type: "http",
      name: "agentproto",
      url: "http://127.0.0.1:8765/mcp/orchestrator?scope=tok_abc",
      headers: [],
    })
    // Crucially: the compact internal fields must NOT survive onto the wire.
    expect(wire).not.toHaveProperty("transport")
    expect(wire).not.toHaveProperty("ref")
  })

  it("maps an sse entry to { type:'sse', url, headers }", () => {
    const [wire] = toAcpMcpServers([
      { name: "events", transport: "sse", ref: "http://host/sse" },
    ])
    expect(wire).toEqual({
      type: "sse",
      name: "events",
      url: "http://host/sse",
      headers: [],
    })
  })

  it("maps a stdio entry to the untagged { command, args, env } variant", () => {
    const [wire] = toAcpMcpServers([
      { name: "local", transport: "stdio", ref: "/usr/bin/mcp-tool" },
    ])
    expect(wire).toEqual({
      name: "local",
      command: "/usr/bin/mcp-tool",
      args: [],
      env: [],
    })
    expect(wire).not.toHaveProperty("type")
  })

  it("passes ACP-native entries through untouched (retro-compat)", () => {
    const native = {
      type: "http",
      name: "preshaped",
      url: "http://host/mcp",
      headers: [{ name: "X-Key", value: "v" }],
    }
    const [wire] = toAcpMcpServers([native])
    expect(wire).toBe(native)
  })

  it("is a no-op on an empty list", () => {
    expect(toAcpMcpServers([])).toEqual([])
  })
})
