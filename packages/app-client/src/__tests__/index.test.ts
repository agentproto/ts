/**
 * Tests for `@agentproto/app-client` (`../index.ts`): envelope unwrapping,
 * host passthrough, bridge→standalone downgrade on the first `callTool`
 * (network failure and 404/non-JSON), a confirmed bridge staying a bridge,
 * and standalone handler dispatch. Every case is hermetic — `fetch` and
 * `window.McpApp` are stubbed/removed per test, no network or daemon
 * involved.
 */

import { afterEach, describe, expect, it, vi } from "vitest"

import { connectMcpApp, McpToolError, type McpAppBridge } from "../index.js"

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.McpApp
})

describe("host mode", () => {
  function stubHost(bridge: Partial<McpAppBridge>): void {
    window.McpApp = {
      connect: () => Promise.resolve(bridge as McpAppBridge),
    }
  }

  it("uses window.McpApp directly and reports mode 'host'", async () => {
    stubHost({ callTool: () => Promise.resolve({ structuredContent: { ok: true } }) })
    const conn = await connectMcpApp()
    expect(conn.mode).toBe("host")
  })

  it("unwraps structuredContent", async () => {
    stubHost({ callTool: () => Promise.resolve({ structuredContent: { count: 3 } }) })
    const conn = await connectMcpApp()
    const result = await conn.callTool<{ count: number }>("get-count")
    expect(result).toEqual({ count: 3 })
  })

  it("JSON-parses a single text content block when parseable", async () => {
    stubHost({
      callTool: () => Promise.resolve({ content: [{ type: "text", text: '{"a":1}' }] }),
    })
    const conn = await connectMcpApp()
    const result = await conn.callTool<{ a: number }>("get-a")
    expect(result).toEqual({ a: 1 })
  })

  it("falls back to the raw text when the text content isn't JSON", async () => {
    stubHost({
      callTool: () => Promise.resolve({ content: [{ type: "text", text: "plain text" }] }),
    })
    const conn = await connectMcpApp()
    const result = await conn.callTool<string>("get-text")
    expect(result).toBe("plain text")
  })

  it("resolves {} when there's no content at all", async () => {
    stubHost({ callTool: () => Promise.resolve({}) })
    const conn = await connectMcpApp()
    const result = await conn.callTool<Record<string, unknown>>("noop")
    expect(result).toEqual({})
  })

  it("rejects with McpToolError carrying the concatenated text detail on isError", async () => {
    stubHost({
      callTool: () =>
        Promise.resolve({
          isError: true,
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        }),
    })
    const conn = await connectMcpApp()
    await expect(conn.callTool("boom")).rejects.toMatchObject({
      name: "McpToolError",
      toolName: "boom",
      mode: "host",
      detail: "line one\nline two",
    })
  })

  it("delegates updateModelContext/openLink/onTeardown to the host bridge", async () => {
    const updateModelContext = vi.fn().mockResolvedValue(undefined)
    const openLink = vi.fn().mockResolvedValue(undefined)
    const onTeardown = vi.fn()
    stubHost({ callTool: () => Promise.resolve({}), updateModelContext, openLink, onTeardown })
    const conn = await connectMcpApp()

    await conn.updateModelContext({ foo: "bar" })
    await conn.openLink("https://example.com")
    const cb = () => {}
    conn.onTeardown(cb)

    expect(updateModelContext).toHaveBeenCalledWith({ foo: "bar" })
    expect(openLink).toHaveBeenCalledWith("https://example.com")
    expect(onTeardown).toHaveBeenCalledWith(cb)
  })
})

describe("bridge → standalone downgrade", () => {
  it("starts in bridge mode when window.McpApp is absent", async () => {
    const conn = await connectMcpApp()
    expect(conn.mode).toBe("bridge")
  })

  it("downgrades to standalone on a network failure and replays the call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")))
    const handler = vi.fn().mockResolvedValue({ ok: true })
    const modeChanges: string[] = []

    const conn = await connectMcpApp({ standaloneTools: { "do-thing": handler } })
    conn.onModeChange((mode) => modeChanges.push(mode))

    const result = await conn.callTool("do-thing", { x: 1 })

    expect(result).toEqual({ ok: true })
    expect(handler).toHaveBeenCalledWith({ x: 1 })
    expect(conn.mode).toBe("standalone")
    expect(modeChanges).toEqual(["standalone"])
  })

  it("downgrades to standalone on a 404 from the bridge route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })))
    const handler = vi.fn().mockResolvedValue("fallback")
    const conn = await connectMcpApp({ standaloneTools: { "do-thing": handler } })

    const result = await conn.callTool("do-thing")

    expect(result).toBe("fallback")
    expect(conn.mode).toBe("standalone")
  })

  it("downgrades to standalone on a non-JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>not the bridge</html>", { status: 200 })),
    )
    const handler = vi.fn().mockResolvedValue("fallback")
    const conn = await connectMcpApp({ standaloneTools: { "do-thing": handler } })

    const result = await conn.callTool("do-thing")

    expect(result).toBe("fallback")
    expect(conn.mode).toBe("standalone")
  })

  it("rejects with McpToolError when no standalone handler is registered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")))
    const conn = await connectMcpApp()

    await expect(conn.callTool("missing-tool")).rejects.toMatchObject({
      name: "McpToolError",
      toolName: "missing-tool",
      mode: "standalone",
    })
  })

  it("stays in bridge mode after a successful first call, and unwraps the envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ structuredContent: { count: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const conn = await connectMcpApp()

    const result = await conn.callTool<{ count: number }>("get-count")

    expect(result).toEqual({ count: 5 })
    expect(conn.mode).toBe("bridge")
    expect(fetchMock).toHaveBeenCalledWith(
      "/__agentproto/tool-call",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "get-count", args: {} }),
      }),
    )
  })

  it("uses a custom bridgeRoute when given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const conn = await connectMcpApp({ bridgeRoute: "/custom/route" })

    await conn.callTool("noop")

    expect(fetchMock).toHaveBeenCalledWith("/custom/route", expect.anything())
  })

  it("throws (does not re-downgrade) when a confirmed bridge later 404s", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)
    const conn = await connectMcpApp()

    await conn.callTool("first")
    expect(conn.mode).toBe("bridge")

    await expect(conn.callTool("second")).rejects.toMatchObject({ name: "McpToolError", mode: "bridge" })
    expect(conn.mode).toBe("bridge")
  })

  it("throws McpToolError for a real bridge failure (non-404 error status) without downgrading", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "daemon_unreachable", message: "could not reach daemon" }), {
        status: 502,
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const conn = await connectMcpApp()

    await expect(conn.callTool("some-tool")).rejects.toMatchObject({
      name: "McpToolError",
      mode: "bridge",
      detail: "could not reach daemon",
    })
    expect(conn.mode).toBe("bridge")
  })

  it("openLink/onTeardown work without a host (no-op-safe), updateModelContext resolves with no host", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")))
    const conn = await connectMcpApp()

    await expect(conn.updateModelContext({ a: 1 })).resolves.toBeUndefined()
    await expect(conn.openLink("https://example.com")).resolves.toBeUndefined()
    expect(() => conn.onTeardown(() => {})).not.toThrow()
  })
})

describe("McpToolError", () => {
  it("carries toolName, mode, and an optional detail", () => {
    const err = new McpToolError("my-tool", "standalone", "no handler")
    expect(err).toBeInstanceOf(Error)
    expect(err.toolName).toBe("my-tool")
    expect(err.mode).toBe("standalone")
    expect(err.detail).toBe("no handler")
    expect(err.message).toContain("my-tool")
  })
})
