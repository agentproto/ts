/**
 * Tests for the one-version daemon `browser_*` → Bureau proxy and the
 * built-in `browser` capability bundle.
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

import { registerBrowserTools } from "../browser-tools.js"
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
  proxy?: ReturnType<typeof fakeProxy>
}) {
  const registry = createSessionsRegistry({ persistPath: join(tmp, "sessions.json") })
  const server = new McpServer({ name: "test-browser-proxy", version: "0.0.1" })
  const proxy = opts.proxy ?? fakeProxy()

  registerBrowserTools(server, {
    registry,
    mcpProxy: proxy,
    callerSessionId: CALLER,
    loadProxyImport: async () => opts.proxyImport,
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
      registry.shutdown()
    },
  }
}

describe("browser proxy - off by default", () => {
  it("takes the old path and never calls the imported-MCP proxy when proxyImport is unset", async () => {
    const { client, proxy, cleanup } = await makeSetup({ proxyImport: undefined })
    try {
      const res = await client.callTool({
        name: "browser_navigate",
        arguments: { sessionId: "no-such-session", url: "https://example.com" },
      })
      expect(res.isError).toBe(true)
      expect(proxy.callTool).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })
})

describe("browser proxy - the six proxied tools", () => {
  const cases: Array<{
    tool: string
    input: Record<string, unknown>
    expectedArgs: Record<string, unknown>
    dropped: string
  }> = [
    {
      tool: "browser_navigate",
      input: { sessionId: "s", url: "https://example.com", tabId: "t1" },
      expectedArgs: { url: "https://example.com" },
      dropped: "tabId",
    },
    {
      tool: "browser_click",
      input: { sessionId: "s", tabId: "t1", selector: "#go", button: "left", clickCount: 2 },
      expectedArgs: { selector: "#go", button: "left", clickCount: 2 },
      dropped: "tabId",
    },
    {
      tool: "browser_fill",
      input: { sessionId: "s", tabId: "t1", selector: "#q", value: "hello", clear: false },
      expectedArgs: { selector: "#q", value: "hello", clear: false },
      dropped: "tabId",
    },
    {
      tool: "browser_evaluate",
      input: {
        sessionId: "s",
        tabId: "t1",
        expression: "document.title",
        awaitPromise: false,
        returnByValue: true,
        maxResultBytes: 1024,
      },
      expectedArgs: {
        expression: "document.title",
        awaitPromise: false,
        returnByValue: true,
        maxResultBytes: 1024,
      },
      dropped: "tabId",
    },
    {
      tool: "browser_get_dom",
      input: { sessionId: "s", tabId: "t1" },
      expectedArgs: {},
      dropped: "tabId",
    },
    {
      tool: "browser_screenshot",
      input: { sessionId: "s", tabId: "t1" },
      expectedArgs: {},
      dropped: "tabId",
    },
  ]

  for (const c of cases) {
    it(`${c.tool} → Bureau ${c.tool}, with deprecated and a note for the dropped argument`, async () => {
      const { client, proxy, cleanup } = await makeSetup({ proxyImport: "bureau" })
      try {
        const res = await client.callTool({ name: c.tool, arguments: c.input })
        expect(res.isError).toBeFalsy()
        expect(proxy.callTool).toHaveBeenCalledWith("bureau", c.tool, c.expectedArgs, {
          callerSessionId: CALLER,
        })
        expect(res.structuredContent).toMatchObject({
          deprecated:
            "The daemon browser_* tools proxy to Bureau for one version; mount the Bureau MCP and call its tools directly.",
        })
        expect((res.structuredContent as { notes?: string[] }).notes ?? []).toEqual([
          `dropped "${c.dropped}" (no Bureau equivalent)`,
        ])
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
