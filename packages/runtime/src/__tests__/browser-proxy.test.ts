/**
 * Tests for the daemon `browser_*` → Bureau proxy and the built-in `browser`
 * capability bundle.
 *
 * Fakes only: an in-memory MCP client/transport for the tool surface and a
 * structural `mcpProxy.callTool` double for the imported-MCP registry. No
 * browser, no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { registerBrowserTools, setLiveBrowserInstance } from "../browser-tools.js"
import { resolveBrowserBuiltin } from "../browser-proxy.js"
import { createSessionsRegistry } from "../sessions.js"
import { builtinBrowserBundle, effectiveBundles, type Bundle } from "../bundles.js"
import type { ImportedMcpsConfig } from "../mcp-imports.js"

const CALLER = "sess-caller"

const OK_RESULT = {
  content: [{ type: "text" as const, text: '{"ok":true}' }],
  structuredContent: { ok: true },
}

function fakeProxy(result: unknown = OK_RESULT) {
  return {
    callTool: vi.fn(async () => ({ ok: true as const, result })),
  }
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browser-proxy-test-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

async function makeSetup(opts: {
  proxyImport: string | undefined
  builtin?: "off" | "proxy" | "on"
  proxy?: { callTool: ReturnType<typeof vi.fn> }
  extra?: Record<string, unknown>
}) {
  const registry = createSessionsRegistry({ persistPath: join(tmp, "sessions.json") })
  const server = new McpServer({ name: "test-browser-proxy", version: "0.0.1" })
  const proxy = opts.proxy ?? fakeProxy()

  registerBrowserTools(server, {
    registry,
    mcpProxy: proxy,
    callerSessionId: CALLER,
    loadProxyImport: async () => opts.proxyImport,
    ...(opts.builtin ? { builtin: opts.builtin } : {}),
    ...(opts.extra ?? {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)

  return {
    client,
    proxy,
    registry,
    cleanup: async () => {
      await client.close()
      registry.shutdown()
    },
  }
}

function textOf(result: unknown): string | undefined {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return content.find(c => c.type === "text")?.text
}

describe("browser builtin = off", () => {
  it("registers only fetch_page and makes browser_navigate an unknown tool", async () => {
    const { client, proxy, cleanup } = await makeSetup({ proxyImport: "bureau", builtin: "off" })
    try {
      const names = (await client.listTools()).tools.map(t => t.name)
      expect(names).toContain("fetch_page")
      for (const name of [
        "browser_navigate",
        "browser_screenshot",
        "browser_list_tabs",
        "browser_adapter_list",
        "start_browser",
        "list_browsers",
      ]) {
        expect(names).not.toContain(name)
      }

      const res = await client.callTool({
        name: "browser_navigate",
        arguments: { sessionId: "s", url: "https://example.com" },
      })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain("browser_navigate")
      expect(proxy.callTool).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })
})

describe("browser builtin resolves", () => {
  it("keeps a legacy proxyImport-only config on the old on path", async () => {
    expect(resolveBrowserBuiltin({ proxyImport: "bureau" })).toBe("on")
    expect(resolveBrowserBuiltin({ builtin: "proxy", proxyImport: "bureau" })).toBe("proxy")
    expect(resolveBrowserBuiltin({ builtin: "off", proxyImport: "bureau" })).toBe("off")
    expect(resolveBrowserBuiltin({ builtin: "on" })).toBe("on")
    expect(resolveBrowserBuiltin(undefined)).toBe("on")

    const builtin = resolveBrowserBuiltin({ proxyImport: "bureau" })
    const { client, proxy, cleanup } = await makeSetup({ proxyImport: "bureau", builtin })
    try {
      // The six legacy tools still proxy, exactly as on main.
      const proxied = await client.callTool({
        name: "browser_navigate",
        arguments: { sessionId: "s", url: "https://example.com" },
      })
      expect(proxied.isError).toBeFalsy()
      expect(proxy.callTool).toHaveBeenCalledWith(
        "bureau",
        "browser_navigate",
        { url: "https://example.com" },
        { callerSessionId: CALLER },
      )

      // Everything else keeps its local path: no browser:use_bureau refusal.
      const local = await client.callTool({
        name: "browser_extract_text",
        arguments: { sessionId: "s" },
      })
      expect(local.isError).toBe(true)
      expect(textOf(local)).toContain('session "s" not found')
      expect(textOf(local)).not.toContain("browser:use_bureau")
    } finally {
      await cleanup()
    }
  })
})

describe("browser proxy - proxied tools", () => {
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
    it(`${c.tool} → Bureau ${c.target}, forwarding tabId and instance`, async () => {
      const { client, proxy, cleanup } = await makeSetup({
        proxyImport: "bureau",
        builtin: "proxy",
      })
      try {
        const res = await client.callTool({ name: c.tool, arguments: c.input })
        expect(res.isError).toBeFalsy()
        expect(proxy.callTool).toHaveBeenCalledWith("bureau", c.target, c.expectedArgs, {
          callerSessionId: CALLER,
        })
        expect(res.structuredContent).toMatchObject({
          deprecated:
            'The daemon browser_* tools proxy to Bureau; "off" (defaults.browser.builtin) is the end state: mount the Bureau MCP and call its tools directly.',
        })
        expect((res.structuredContent as { notes?: string[] }).notes ?? []).toEqual(c.expectedNotes)
      } finally {
        await cleanup()
      }
    })
  }
})

describe("browser proxy - a missing import fails loudly", () => {
  it("never falls back to chrome-live when proxyImport names no imported alias", async () => {
    const navigate = vi.fn(async () => {
      throw new Error("chrome-live navigate must not be reached")
    })
    const instance = {
      id: "chrome-live",
      port: 9222,
      baseUrl: "http://127.0.0.1:9222",
      wasAlreadyRunning: true,
      healthy: true,
      stop: async () => {},
      navigate,
    }
    const proxy = {
      callTool: vi.fn(async () => ({ ok: false as const, error: 'unknown alias "bureau"' })),
    }
    const { client, registry, cleanup } = await makeSetup({
      proxyImport: "bureau",
      builtin: "proxy",
      proxy,
    })
    try {
      const id = registry.registerBrowser({
        adapterId: "chrome-live",
        port: 9222,
        baseUrl: "http://127.0.0.1:9222",
        wasAlreadyRunning: false,
        stop: async () => {},
      }).id
      setLiveBrowserInstance(id, instance as never)

      const res = await client.callTool({
        name: "browser_navigate",
        arguments: { sessionId: id, url: "https://example.com" },
      })
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('unknown alias "bureau"')
      expect(navigate).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })
})

describe("browser proxy - tools with no Bureau twin", () => {
  const cases: Array<{ tool: string; input: Record<string, unknown>; target: string }> = [
    { tool: "browser_adapter_list", input: {}, target: "browser_list_instances" },
    { tool: "browser_extract_text", input: { sessionId: "browser-session" }, target: "browser_evaluate" },
    { tool: "browser_new_tab", input: { sessionId: "browser-session" }, target: "browser_navigate" },
    { tool: "browser_scroll", input: { sessionId: "browser-session" }, target: "browser_evaluate" },
    {
      tool: "browser_select",
      input: { sessionId: "browser-session", selector: "#s", value: "v" },
      target: "browser_evaluate",
    },
    { tool: "browser_screencast_start", input: { sessionId: "browser-session" }, target: "browser_screenshot" },
    { tool: "browser_screencast_frame", input: { sessionId: "browser-session" }, target: "browser_screenshot" },
    { tool: "browser_screencast_stop", input: { sessionId: "browser-session" }, target: "browser_screenshot" },
    {
      tool: "browser_upload_file",
      input: { sessionId: "browser-session", selector: "#f", paths: ["/tmp/does-not-matter"] },
      target: "browser_act",
    },
    { tool: "browser_wait_for", input: { sessionId: "browser-session", selector: "#x" }, target: "browser_evaluate" },
    { tool: "browser_status", input: { sessionId: "browser-session" }, target: "browser_list_instances" },
    { tool: "start_browser", input: { adapter: "chrome-live" }, target: "browser_list_instances" },
    { tool: "stop_browser", input: { sessionId: "browser-session" }, target: "browser_close_tab" },
  ]

  for (const c of cases) {
    it(`${c.tool} answers browser:use_bureau (${c.target}) and never touches the chrome-live adapter`, async () => {
      const touches: string[] = []
      const spy = (name: string) =>
        vi.fn(async () => {
          touches.push(name)
          return {} as never
        })
      const instance = {
        id: "chrome-live",
        port: 9222,
        baseUrl: "http://127.0.0.1:9222",
        wasAlreadyRunning: true,
        healthy: true,
        stop: async () => {},
        navigate: spy("navigate"),
        getDom: spy("getDom"),
        click: spy("click"),
        fill: spy("fill"),
        evaluate: spy("evaluate"),
        scroll: spy("scroll"),
        pressKey: spy("pressKey"),
        selectOption: spy("selectOption"),
        waitFor: spy("waitFor"),
        uploadFileOntoFileInput: spy("uploadFileOntoFileInput"),
        openNewTab: spy("openNewTab"),
        listOwnedTabs: spy("listOwnedTabs"),
        screencastStart: spy("screencastStart"),
        screencastFrame: spy("screencastFrame"),
        screencastStop: spy("screencastStop"),
      }
      const resolveBrowserAdapter = vi.fn(() => instance)
      const listBrowserAdapters = vi.fn(() => [])
      const { client, proxy, registry, cleanup } = await makeSetup({
        proxyImport: "bureau",
        builtin: "proxy",
        extra: { resolveBrowserAdapter, listBrowserAdapters },
      })
      try {
        const id = registry.registerBrowser({
          adapterId: "chrome-live",
          port: 9222,
          baseUrl: "http://127.0.0.1:9222",
          wasAlreadyRunning: false,
          stop: async () => {},
        }).id
        setLiveBrowserInstance(id, instance as never)
        const input = { ...c.input }
        if (input.sessionId === "browser-session") input.sessionId = id

        const res = await client.callTool({ name: c.tool, arguments: input })
        expect(res.isError).toBe(true)
        expect(textOf(res)).toContain("browser:use_bureau")
        expect(textOf(res)).toContain(c.target)
        expect(proxy.callTool).not.toHaveBeenCalled()
        expect(resolveBrowserAdapter).not.toHaveBeenCalled()
        expect(listBrowserAdapters).not.toHaveBeenCalled()
        expect(touches).toEqual([])
      } finally {
        await cleanup()
      }
    })
  }
})

describe("browser proxy - error passthrough", () => {
  it("returns a Bureau tool error unchanged (no deprecated marker added)", async () => {
    const bureauError = {
      content: [{ type: "text" as const, text: "browser:not_owner" }],
      isError: true,
    }
    const { client, cleanup } = await makeSetup({
      proxyImport: "bureau",
      builtin: "proxy",
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
