/**
 * AIP-63 section 7: the browser observer seam (O1-O7).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import { registerBrowserTools } from "../browser-tools.js"
import {
  configureBrowserObservers,
  loadBrowserObserverModule,
  registerBrowserObserver,
  resetBrowserObservers,
  type BrowserObserver,
} from "../browser-observers.js"

// Attach/detach events came from the retired `start_browser`; P4b deletes
// this seam once Pygmalion's recorder moves to Bureau. The per-call hooks
// and the screenshot transform still wrap the Bureau-relayed tools.

const SHOT = { data: "AAAA", format: "png", width: 100, height: 50 }

let tmp: string
let filled: unknown[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browser-observers-test-"))
  filled = []
  configureBrowserObservers({ log: () => {} })
})

afterEach(() => {
  resetBrowserObservers()
  rmSync(tmp, { recursive: true, force: true })
})

async function setup() {
  const server = new McpServer({ name: "test-browser", version: "0.0.1" })
  registerBrowserTools(server, {
    loadProxyImport: async () => "bureau",
    mcpProxy: {
      callTool: async (_alias, toolName, args) => {
        if (toolName === "browser_fill") filled.push(args)
        const body: Record<string, unknown> = toolName === "browser_screenshot" ? { ...SHOT } : { ok: true }
        return { ok: true, result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body } }
      },
    },
  })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(ct)
  return { client, sessionId: "s" }
}

describe("O1: empty by default", () => {
  it("returns the same screenshot and fill results with no observer", async () => {
    const { client, sessionId } = await setup()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } })
    expect(shot.structuredContent).toMatchObject(SHOT)
    const fill = await client.callTool({ name: "browser_fill", arguments: { sessionId, selector: "#q", value: "x" } })
    expect(fill.isError).toBeFalsy()
  })
})

describe("O5: calls", () => {
  it("fires paired before/after hooks per call", async () => {
    const events: string[] = []
    registerBrowserObserver("t", {
      beforeCall: e => void events.push(`before:${e.tool}:${e.callId}`),
      afterCall: e => void events.push(`after:${e.tool}:${e.callId}:${e.ok}`),
    })
    const { client, sessionId } = await setup()
    await client.callTool({ name: "browser_click", arguments: { sessionId, selector: "#go" } })
    const before = events.find(e => e.startsWith("before:click"))!
    const after = events.find(e => e.startsWith("after:click"))!
    expect(before.split(":")[2]).toBe(after.split(":")[2])
    expect(after.endsWith(":true")).toBe(true)
  })
})

describe("O7: redaction before the observer is called", () => {
  it("never shows a fill value or its length, yet the tool still types it", async () => {
    const seen: unknown[] = []
    registerBrowserObserver("t", {
      beforeCall: e => void seen.push(e),
      afterCall: e => void seen.push(e),
    })
    const { client, sessionId } = await setup()
    await client.callTool({
      name: "browser_fill",
      arguments: { sessionId, selector: "input[type=password]", value: "hunter2-canary" },
    })
    await client.callTool({ name: "browser_evaluate", arguments: { sessionId, expression: "document.cookie" } })
    const dump = JSON.stringify(seen)
    expect(dump).not.toContain("hunter2-canary")
    expect(dump).not.toContain("document.cookie")
    expect(dump).not.toMatch(/"(value|expression|length)"/)
    expect(dump).toContain("input[type=password]")
    expect(filled).toEqual([{ selector: "input[type=password]", value: "hunter2-canary" }])
  })
})

describe("O4: best-effort observers", () => {
  it("a throwing observer does not change the tool result", async () => {
    registerBrowserObserver("bad", {
      beforeCall: () => {
        throw new Error("boom")
      },
      afterCall: async () => {
        throw new Error("boom")
      },
    })
    const { client, sessionId } = await setup()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } })
    expect(shot.isError).toBeFalsy()
    expect(shot.structuredContent).toMatchObject(SHOT)
  })

  it("a hung observer delays the call by at most its budget", async () => {
    configureBrowserObservers({ timeoutMs: 80 })
    registerBrowserObserver("hung", {
      beforeCall: () => new Promise<void>(() => {}),
      afterCall: () => new Promise<void>(() => {}),
    })
    const { client, sessionId } = await setup()
    const t0 = Date.now()
    const click = await client.callTool({ name: "browser_click", arguments: { sessionId, selector: "#go" } })
    const elapsed = Date.now() - t0
    expect(click.isError).toBeFalsy()
    expect(elapsed).toBeLessThan(1000)
  })
})

describe("O6: screenshot transform", () => {
  const halve: BrowserObserver = {
    transformScreenshot: (_ctx, image) => ({ ...image, data: "BBBB", width: 50, height: 25 }),
  }

  it("the caller receives only the transformed image", async () => {
    registerBrowserObserver("halve", halve)
    const { client, sessionId } = await setup()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } })
    expect(shot.structuredContent).toMatchObject({ data: "BBBB", width: 50, height: 25 })
    expect(JSON.stringify(shot)).not.toContain("AAAA")
  })

  it("a failing required transform returns browser:transform_failed and never the original", async () => {
    registerBrowserObserver(
      "strict",
      {
        transformScreenshot: () => {
          throw new Error("sharp missing")
        },
      },
      { requiredTransform: true }
    )
    const { client, sessionId } = await setup()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } })
    expect(shot.isError).toBe(true)
    expect(JSON.stringify(shot)).toContain("browser:transform_failed")
    expect(JSON.stringify(shot)).not.toContain("AAAA")
  })

  it("a failing non-required transform lets the original through", async () => {
    registerBrowserObserver("lax", {
      transformScreenshot: () => {
        throw new Error("nope")
      },
    })
    const { client, sessionId } = await setup()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } })
    expect(shot.isError).toBeFalsy()
    expect(shot.structuredContent).toMatchObject({ data: "AAAA" })
  })

  it("a transform that exceeds its budget counts as a failure", async () => {
    configureBrowserObservers({ transformTimeoutMs: 50 })
    registerBrowserObserver("slow", { transformScreenshot: () => new Promise(() => {}) }, { requiredTransform: true })
    const { client, sessionId } = await setup()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } })
    expect(shot.isError).toBe(true)
  })
})

describe("operator module loader", () => {
  const api = { log: () => {} }

  it("rejects a relative path", async () => {
    await expect(loadBrowserObserverModule("./obs.mjs", api)).rejects.toThrow(/absolute path/)
  })

  it("rejects a missing file", async () => {
    await expect(loadBrowserObserverModule(join(tmp, "nope.mjs"), api)).rejects.toThrow(/does not exist/)
  })

  it("rejects a file writable by others", async () => {
    const f = join(tmp, "open.mjs")
    writeFileSync(f, "export default () => {}")
    chmodSync(f, 0o666)
    await expect(loadBrowserObserverModule(f, api)).rejects.toThrow(/writable by group or others/)
  })

  it("rejects a module without a default function", async () => {
    const f = join(tmp, "nodefault.mjs")
    writeFileSync(f, "export const x = 1")
    chmodSync(f, 0o600)
    await expect(loadBrowserObserverModule(f, api)).rejects.toThrow(/default-export a function/)
  })

  it("loads a trusted module and lets it register an observer", async () => {
    const f = join(tmp, "good.mjs")
    writeFileSync(
      f,
      "export default ({ registerBrowserObserver }) => registerBrowserObserver('mod', { transformScreenshot: (_c, i) => ({ ...i, data: 'CCCC' }) })"
    )
    chmodSync(f, 0o600)
    await loadBrowserObserverModule(f, api)
    const { client, sessionId } = await setup()
    const shot = await client.callTool({ name: "browser_screenshot", arguments: { sessionId } })
    expect(shot.structuredContent).toMatchObject({ data: "CCCC" })
  })
})
