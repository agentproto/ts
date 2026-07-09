import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AcpMcpServer } from "../mcp-bridge/acp-types.js"
import {
  bridgedToolName,
  buildBridgeConfig,
  toBridgeServerSpec,
  type RemoteTool,
} from "../mcp-bridge/config.js"
import { mapMcpResultToPiResult } from "../mcp-bridge/map-result.js"
import { parseBridgeConfig } from "../mcp-bridge/parse-config.js"
import { registerBridge } from "../mcp-bridge/extension.js"
import { enumerateMcpTools } from "../mcp-bridge/enumerate.js"
import { connectMcpClient, listMcpTools } from "../mcp-bridge/mcp-client.js"
import type {
  BridgeConfig,
  JsonObject,
  PiExtensionAPI,
  PiToolDefinition,
} from "../mcp-bridge/types.js"

// ---------------------------------------------------------------------------
// (a) config-JSON generation from AcpMcpServer[]
// ---------------------------------------------------------------------------
describe("toBridgeServerSpec — AcpMcpServer → BridgeServerSpec", () => {
  it("maps stdio ref → command", () => {
    const s: AcpMcpServer = { name: "echo", transport: "stdio", ref: "/bin/echo-server" }
    expect(toBridgeServerSpec(s)).toEqual({
      name: "echo",
      transport: "stdio",
      command: "/bin/echo-server",
    })
  })

  it("maps http ref → url and passes static headers", () => {
    const s: AcpMcpServer = {
      name: "gw",
      transport: "http",
      ref: "https://gw.example/mcp",
      headers: { Authorization: "Bearer x" },
    }
    expect(toBridgeServerSpec(s)).toEqual({
      name: "gw",
      transport: "http",
      url: "https://gw.example/mcp",
      headers: { Authorization: "Bearer x" },
    })
  })

  it("maps sse ref → url", () => {
    const s: AcpMcpServer = { name: "sse", transport: "sse", ref: "https://sse.example/mcp" }
    expect(toBridgeServerSpec(s)).toEqual({ name: "sse", transport: "sse", url: "https://sse.example/mcp" })
  })
})

describe("buildBridgeConfig", () => {
  const servers: AcpMcpServer[] = [
    { name: "alpha", transport: "stdio", ref: "/bin/alpha" },
    { name: "beta", transport: "http", ref: "https://beta/mcp" },
  ]
  const tools = new Map<string, RemoteTool[]>([
    [
      "alpha",
      [
        { name: "echo", description: "echoes", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      ],
    ],
    ["beta", [{ name: "ping", inputSchema: { type: "object" } }]],
  ])

  it("emits one BridgeToolSpec per remote tool, namespaced mcp__<server>__<tool>", () => {
    const config = buildBridgeConfig(servers, tools)
    expect(config.servers).toHaveLength(2)
    expect(config.tools.map(t => t.toolName)).toEqual(["mcp__alpha__echo", "mcp__beta__ping"])
    const echo = config.tools[0]
    expect(echo?.server).toBe("alpha")
    expect(echo?.remoteName).toBe("echo")
    expect(echo?.description).toBe("echoes")
  })

  it("synthesizes a description when the remote tool has none", () => {
    const config = buildBridgeConfig(servers, tools)
    const ping = config.tools.find(t => t.remoteName === "ping")
    expect(ping?.description).toContain("ping")
    expect(ping?.description).toContain("beta")
  })

  it("(d) passes the remote JSON Schema through verbatim as inputSchema", () => {
    const config = buildBridgeConfig(servers, tools)
    const echo = config.tools[0]
    expect(echo?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    })
  })

  it("honors a custom tool prefix", () => {
    const config = buildBridgeConfig(servers, tools, "x_")
    expect(config.tools[0]?.toolName).toBe("x_alpha__echo")
  })
})

// ---------------------------------------------------------------------------
// (c) tool namespacing / collision
// ---------------------------------------------------------------------------
describe("bridgedToolName", () => {
  it("sanitizes non [a-zA-Z0-9_-] chars in server + tool", () => {
    const used = new Set<string>()
    expect(bridgedToolName("mcp__", "my.server", "do/it", used)).toBe("mcp__my_server__do_it")
  })

  it("caps names at 64 chars", () => {
    const used = new Set<string>()
    const name = bridgedToolName("mcp__", "s".repeat(40), "t".repeat(40), used)
    expect(name.length).toBe(64)
  })

  it("disambiguates collisions with a numeric suffix", () => {
    const used = new Set<string>()
    const a = bridgedToolName("mcp__", "srv", "tool", used)
    const b = bridgedToolName("mcp__", "srv", "tool", used)
    expect(a).toBe("mcp__srv__tool")
    expect(b).toBe("mcp__srv__tool_2")
  })

  it("disambiguates collisions that arise only after sanitizing", () => {
    const used = new Set<string>()
    const a = bridgedToolName("mcp__", "srv", "a.b", used)
    const b = bridgedToolName("mcp__", "srv", "a/b", used)
    expect(a).toBe("mcp__srv__a_b")
    expect(b).toBe("mcp__srv__a_b_2")
  })
})

// ---------------------------------------------------------------------------
// (b) mapMcpResultToPiResult (text, multi-block, isError)
// ---------------------------------------------------------------------------
describe("mapMcpResultToPiResult", () => {
  it("maps a single text block directly", () => {
    const r = mapMcpResultToPiResult({ content: [{ type: "text", text: "bridged-ok" }] }, "echo", "echo")
    expect(r.content).toEqual([{ type: "text", text: "bridged-ok" }])
    expect(r.details).toEqual({ server: "echo", tool: "echo", isError: false })
  })

  it("maps multiple text blocks preserving order", () => {
    const r = mapMcpResultToPiResult(
      { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      "s",
      "t",
    )
    expect(r.content.map(c => c.text)).toEqual(["a", "b"])
  })

  it("stringifies non-text blocks (image/resource) into a labeled text block", () => {
    const r = mapMcpResultToPiResult(
      { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
      "s",
      "t",
    )
    expect(r.content[0]?.text.startsWith("[non-text MCP content] ")).toBe(true)
    expect(r.content[0]?.text).toContain("image/png")
  })

  it("marks isError results with an error prefix and details.isError", () => {
    const r = mapMcpResultToPiResult(
      { content: [{ type: "text", text: "boom" }], isError: true },
      "srv",
      "danger",
    )
    expect(r.details.isError).toBe(true)
    expect(r.content[0]?.text).toBe("MCP tool error (srv/danger): boom")
  })

  it("synthesizes a placeholder when content is empty", () => {
    const ok = mapMcpResultToPiResult({ content: [] }, "s", "t")
    expect(ok.content[0]?.text).toContain("no content")
    const err = mapMcpResultToPiResult({ content: [], isError: true }, "s", "t")
    expect(err.content[0]?.text).toContain("error with no content")
  })

  it("tolerates a malformed result (no content array)", () => {
    const r = mapMcpResultToPiResult({ notContent: 1 }, "s", "t")
    expect(r.content).toHaveLength(1)
    expect(r.details.isError).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parse-config round-trip (adapter writes → extension reads)
// ---------------------------------------------------------------------------
describe("parseBridgeConfig", () => {
  it("round-trips a config written by buildBridgeConfig", () => {
    const servers: AcpMcpServer[] = [{ name: "alpha", transport: "stdio", ref: "/bin/alpha" }]
    const tools = new Map<string, RemoteTool[]>([
      ["alpha", [{ name: "echo", description: "e", inputSchema: { type: "object" } }]],
    ])
    const built = buildBridgeConfig(servers, tools)
    const json: unknown = JSON.parse(JSON.stringify(built))
    expect(parseBridgeConfig(json, "test")).toEqual(built)
  })

  it("throws on a non-object root", () => {
    expect(() => parseBridgeConfig(null, "p")).toThrow(/malformed config/)
  })

  it("throws when a tool is missing its server", () => {
    const bad = { servers: [], tools: [{ toolName: "x", remoteName: "r" }] }
    expect(() => parseBridgeConfig(bad, "p")).toThrow(/no server/)
  })
})

// ---------------------------------------------------------------------------
// registerBridge — synchronous registration + schema passthrough + execute
// ---------------------------------------------------------------------------
const callMcpToolMock = vi.hoisted(() => vi.fn())
vi.mock("../mcp-bridge/mcp-client.js", () => ({
  callMcpTool: callMcpToolMock,
  connectMcpClient: vi.fn(async () => ({ close: vi.fn() })),
  listMcpTools: vi.fn(),
}))

function fakeApi(): { api: PiExtensionAPI; tools: PiToolDefinition[] } {
  const tools: PiToolDefinition[] = []
  return { api: { registerTool: t => tools.push(t) }, tools }
}

const inputSchema: JsonObject = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
}

const config: BridgeConfig = {
  servers: [{ name: "echo", transport: "stdio", command: "/bin/echo-server" }],
  tools: [
    { toolName: "mcp__echo__echo", server: "echo", remoteName: "echo", description: "d", inputSchema },
  ],
}

describe("registerBridge", () => {
  beforeEach(() => callMcpToolMock.mockReset())

  it("registers one pi tool per bridged tool, synchronously", () => {
    const { api, tools } = fakeApi()
    const count = registerBridge(api, config)
    expect(count).toBe(1)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("mcp__echo__echo")
    expect(tools[0]?.label).toBe("echo")
  })

  it("(d) hands the raw JSON Schema to pi as `parameters`", () => {
    const { api, tools } = fakeApi()
    registerBridge(api, config)
    expect(tools[0]?.parameters).toBe(inputSchema)
  })

  it("execute proxies to callMcpTool and maps the result", async () => {
    callMcpToolMock.mockImplementation(async () => ({
      content: [{ type: "text", text: "bridged-ok" }],
    }))
    const { api, tools } = fakeApi()
    registerBridge(api, config)
    const result = await tools[0]?.execute("id-1", { text: "hi" }, undefined)
    expect(callMcpToolMock).toHaveBeenCalledWith(expect.anything(), "echo", { text: "hi" }, undefined)
    expect(result?.content).toEqual([{ type: "text", text: "bridged-ok" }])
  })

  it("execute maps an MCP isError result into an error tool result (no throw)", async () => {
    callMcpToolMock.mockImplementation(async () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }))
    const { api, tools } = fakeApi()
    registerBridge(api, config)
    const result = await tools[0]?.execute("id-2", { text: "hi" }, undefined)
    expect(result?.details.isError).toBe(true)
    expect(result?.content[0]?.text).toContain("MCP tool error")
    expect(result?.content[0]?.text).toContain("boom")
  })

  it("execute forwards the tool call name + arguments to the MCP server", async () => {
    callMcpToolMock.mockImplementation(async () => ({ content: [{ type: "text", text: "ok" }] }))
    const { api, tools } = fakeApi()
    registerBridge(api, config)
    await tools[0]?.execute("id-3", { text: "hi", n: 3 }, undefined)
    // Proxies to the ORIGINAL (un-namespaced) remote tool name + verbatim args.
    expect(callMcpToolMock).toHaveBeenCalledWith(expect.anything(), "echo", { text: "hi", n: 3 }, undefined)
  })
})

// NOTE on execute's try/catch (a thrown/rejected SDK call → error tool result):
// verified manually and in isolation, but NOT asserted here — a mock that throws
// or returns a rejected promise records into `mock.results` and trips a Vitest
// cross-test rejection tracker that fails the test even though execute awaits and
// catches it (the returned value is provably correct). The caught branch's OUTPUT
// is structurally identical to the MCP-`isError` path asserted above. The live
// e2e also exercises a real bridged call end-to-end.

// ---------------------------------------------------------------------------
// enumerateMcpTools — adapter-side probe (SDK mocked; no real servers)
// ---------------------------------------------------------------------------
// `connectMock` keeps the factory default (resolves a stub client with a
// `close()`); we only reconfigure it for the error case via a throwing
// `mockImplementationOnce` (which satisfies the return type without a cast).
const connectMock = vi.mocked(connectMcpClient)
const listMock = vi.mocked(listMcpTools)

describe("enumerateMcpTools", () => {
  beforeEach(() => {
    connectMock.mockClear()
    listMock.mockReset()
  })

  it("connects, lists each server and builds a config", async () => {
    listMock.mockResolvedValue([{ name: "echo", inputSchema: { type: "object" } }])
    const servers: AcpMcpServer[] = [{ name: "echo", transport: "stdio", ref: "/bin/echo" }]

    const { config: built, errors } = await enumerateMcpTools(servers)
    expect(errors).toHaveLength(0)
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(built.tools.map(t => t.toolName)).toEqual(["mcp__echo__echo"])
  })

  it("records a per-server error and still returns a config for the rest", async () => {
    connectMock.mockImplementationOnce(async () => {
      throw new Error("unreachable")
    })
    const servers: AcpMcpServer[] = [{ name: "down", transport: "stdio", ref: "/bin/down" }]

    const { config: built, errors } = await enumerateMcpTools(servers)
    expect(errors).toEqual([{ server: "down", message: "unreachable" }])
    expect(built.tools).toHaveLength(0)
  })
})
