/**
 * Tests for `agentproto mcp-app <appId>` (`commands/mcp-app.ts`).
 *
 * `runMcpApp`'s happy path parks forever (`StdioServerTransport` stays
 * connected until stdin closes), so it's exercised only up to the point
 * where tools are registered (mocking the MCP SDK's `McpServer` +
 * `StdioServerTransport`) without awaiting completion. The actual dispatch
 * logic (`callScopedTool`) is a plain exported async function and is
 * tested directly against a mocked `fetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { findInstalledAppDirMock, readDeclaredUIToolsMock, loadConfigMock, toolMock, connectMock, mcpServerCtor } =
  vi.hoisted(() => ({
    findInstalledAppDirMock: vi.fn(),
    readDeclaredUIToolsMock: vi.fn(),
    loadConfigMock: vi.fn(),
    toolMock: vi.fn(),
    connectMock: vi.fn(async (..._args: unknown[]) => {}),
    mcpServerCtor: vi.fn(),
  }))

vi.mock("../app-serve.js", () => ({
  findInstalledAppDir: findInstalledAppDirMock,
  readDeclaredUITools: readDeclaredUIToolsMock,
}))

vi.mock("@agentproto/runtime/config", () => ({
  loadConfig: loadConfigMock,
}))

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    constructor(...args: unknown[]) {
      mcpServerCtor(...args)
    }
    tool(...args: unknown[]) {
      toolMock(...args)
    }
    connect(...args: unknown[]) {
      return connectMock(...args)
    }
  },
}))

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}))

import { runMcpApp, callScopedTool } from "../commands/mcp-app.js"

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

beforeEach(() => {
  findInstalledAppDirMock.mockReset()
  readDeclaredUIToolsMock.mockReset()
  loadConfigMock.mockReset().mockResolvedValue({})
  toolMock.mockReset()
  connectMock.mockReset().mockResolvedValue(undefined)
  mcpServerCtor.mockReset()
  delete process.env.AGENTPROTO_DAEMON_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("runMcpApp — argument handling", () => {
  it("prints usage and exits 0 for --help", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const code = await runMcpApp(["--help"])
    expect(code).toBe(0)
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("agentproto mcp-app <appId>"))
    writeSpy.mockRestore()
  })

  it("exits 2 with usage on stderr when no appId is given", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const code = await runMcpApp([])
    expect(code).toBe(2)
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"))
    writeSpy.mockRestore()
  })
})

describe("runMcpApp — app resolution errors", () => {
  it("exits 1 when the app is not installed", async () => {
    findInstalledAppDirMock.mockReturnValue(undefined)
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const code = await runMcpApp(["missing-app"])
    expect(code).toBe(1)
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('no installed app "missing-app"'))
    writeSpy.mockRestore()
  })

  it("exits 1 when the app declares no ui.tools allowlist", async () => {
    findInstalledAppDirMock.mockReturnValue("/apps/book1")
    readDeclaredUIToolsMock.mockResolvedValue(undefined)
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const code = await runMcpApp(["book1"])
    expect(code).toBe(1)
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("no `ui.tools` allowlist declared"))
    writeSpy.mockRestore()
  })
})

describe("runMcpApp — tool registration", () => {
  it("registers one MCP tool per ui.tools entry and connects stdio", async () => {
    findInstalledAppDirMock.mockReturnValue("/apps/book1")
    readDeclaredUIToolsMock.mockResolvedValue(["app_run", "app_status"])
    loadConfigMock.mockResolvedValue({ daemon: { port: 18790 } })
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    // Fire and forget — the success path parks forever.
    void runMcpApp(["book1"])
    await flushMicrotasks()
    await flushMicrotasks()

    expect(mcpServerCtor).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringContaining("book1") }),
    )
    expect(toolMock).toHaveBeenCalledTimes(2)
    expect(toolMock.mock.calls[0]?.[0]).toBe("app_run")
    expect(toolMock.mock.calls[1]?.[0]).toBe("app_status")
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("serving 2 tool(s) for app \"book1\""))

    errSpy.mockRestore()
  })

  it("registers zero tools for an explicitly empty ui.tools allowlist", async () => {
    findInstalledAppDirMock.mockReturnValue("/apps/book1")
    readDeclaredUIToolsMock.mockResolvedValue([])
    loadConfigMock.mockResolvedValue({ daemon: { port: 18790 } })
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    void runMcpApp(["book1"])
    await flushMicrotasks()
    await flushMicrotasks()

    expect(toolMock).not.toHaveBeenCalled()
    expect(connectMock).toHaveBeenCalledTimes(1)

    errSpy.mockRestore()
  })
})

describe("callScopedTool", () => {
  it("returns the daemon's MCP envelope verbatim on success", async () => {
    const envelope = { content: [{ type: "text", text: "ok" }] }
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => envelope,
    }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await callScopedTool("http://127.0.0.1:18790/apps/book1/tool-call", "app_run", { foo: "bar" })

    expect(result).toEqual(envelope)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/apps/book1/tool-call",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tool: "app_run", args: { foo: "bar" } }),
      }),
    )
  })

  it("passes through an isError envelope (allowlist rejection etc.) unchanged", async () => {
    const envelope = { content: [{ type: "text", text: "not allowed" }], isError: true }
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => envelope })))

    const result = await callScopedTool("http://x/apps/a/tool-call", "denied_tool", {})
    expect(result).toEqual(envelope)
  })

  it("returns a daemon-unreachable error result when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )

    const result = await callScopedTool("http://127.0.0.1:18790/apps/book1/tool-call", "app_run", {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("could not reach the daemon")
    expect(result.content[0]?.text).toContain("agentproto serve")
  })

  it("returns an error result for a non-JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json")
        },
      })),
    )

    const result = await callScopedTool("http://x/apps/a/tool-call", "t", {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("non-JSON response")
  })

  it("surfaces the body's message on a non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "bad_request", message: "body must be an object" }),
      })),
    )

    const result = await callScopedTool("http://x/apps/a/tool-call", "t", {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("body must be an object")
  })

  it("falls back to an HTTP status message when the error body has no message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })),
    )

    const result = await callScopedTool("http://x/apps/a/tool-call", "t", {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe("HTTP 500")
  })

  it("wraps a non-envelope success body as JSON text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: "shape" }),
      })),
    )

    const result = await callScopedTool("http://x/apps/a/tool-call", "t", {})
    expect(result.isError).toBeUndefined()
    expect(result.content[0]?.text).toBe(JSON.stringify({ unexpected: "shape" }))
  })
})
