/**
 * Tests for the chrome-live tools added for multi-tab + file-input work:
 * browser_upload_file (CDP DOM.setFileInputFiles + upload-allowlist security),
 * browser_new_tab and browser_list_tabs (the agent's OWN windows/tabs only).
 * Dispatch through the same module-scope `liveInstances` map as browser_scroll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import {
  registerBrowserTools,
  setLiveBrowserInstance,
  defaultBrowserUploadAllowDirs,
  BROWSER_UPLOAD_ALLOW_DIRS_ENV,
} from "../browser-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

let tmp: string
let registry: SessionsRegistry
const allowDir: { current: string } = { current: "" }

beforeEach(() => {
  // realpath-resolved: on macOS `tmpdir()` sits under the `/var` symlink to
  // `/private/var`, but `checkUploadPaths` realpaths every candidate before
  // comparing it to the allowlist (collapsing symlinks is the whole point —
  // the check is on the REAL target). Resolving once here keeps every path
  // built from `tmp` in this file matching what the tool actually returns.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "browser-upload-newtab-test-")))
  allowDir.current = join(tmp, "uploads")
  mkdirSync(allowDir.current, { recursive: true })
  registry = createSessionsRegistry({ persistPath: join(tmp, "sessions.json") })
})

afterEach(() => {
  registry.shutdown()
  rmSync(tmp, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function makeClient(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "test-browser", version: "0.0.1" })
  registerBrowserTools(server, { registry, uploadAllowDirs: [allowDir.current] })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return { client, cleanup: () => client.close() }
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  const text = content.find((c) => c.type === "text")?.text
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function textOf(result: unknown): string | undefined {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return content.find((c) => c.type === "text")?.text
}

function registerChromeLiveSession(): string {
  const desc = registry.registerBrowser({
    adapterId: "chrome-live",
    port: 9222,
    baseUrl: "http://127.0.0.1:9222",
    wasAlreadyRunning: false,
    stop: async () => {},
  })
  return desc.id
}

const baseInstance = () => ({
  id: "chrome-live",
  port: 9222,
  baseUrl: "http://127.0.0.1:9222",
  wasAlreadyRunning: true,
  healthy: true,
  stop: async () => {},
})

// ── browser_upload_file ──────────────────────────────────────────────────────

describe("browser_upload_file", () => {
  it("dispatches to the instance's uploadFileOntoFileInput with the absolute path inside the allowlist kept as-is", async () => {
    const sessionId = registerChromeLiveSession()
    const file = join(allowDir.current, "cv.pdf")
    writeFileSync(file, "pdf")
    let captured: [unknown, string | undefined] | undefined
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      uploadFileOntoFileInput: async (options, tabId) => {
        captured = [options, tabId]
        return { targetId: "agent-target-1", files: options.paths }
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId, selector: "input[type=file]", paths: [file] },
    })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ targetId: "agent-target-1", files: [file] })
    expect(captured).toEqual([{ selector: "input[type=file]", paths: [file] }, undefined])
    await cleanup()
  })

  it("refuses a relative path", async () => {
    const sessionId = registerChromeLiveSession()
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      uploadFileOntoFileInput: vi.fn() as never,
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId, selector: "input[type=file]", paths: ["cv.pdf"] },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/not absolute/)
    await cleanup()
  })

  it("refuses a path outside the upload allowlist (equality check on the REAL path)", async () => {
    const sessionId = registerChromeLiveSession()
    const file = join(tmp, "imports", "cv.pdf")
    mkdirSync(join(tmp, "imports"), { recursive: true })
    writeFileSync(file, "pdf")
    const spy = vi.fn()
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      uploadFileOntoFileInput: spy as never,
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId, selector: "input[type=file]", paths: [file] },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/outside the upload allowlist/)
    expect(spy).not.toHaveBeenCalled()
    await cleanup()
  })

  it("merges opts.uploadAllowDirs OVER the defaults: env-listed dirs still accept files when a host dir is set", async () => {
    vi.stubEnv("HOME", tmp)
    const dataDir = join(tmp, ".pygmalion", "data")
    mkdirSync(dataDir, { recursive: true })
    vi.stubEnv(BROWSER_UPLOAD_ALLOW_DIRS_ENV, dataDir)
    const sessionId = registerChromeLiveSession()
    const file = join(dataDir, "cv.pdf")
    writeFileSync(file, "pdf")
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      uploadFileOntoFileInput: async (options) => ({ targetId: "t", files: options.paths }),
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId, selector: "input[type=file]", paths: [file] },
    })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ files: [file] })
    await cleanup()
  })

  it("merges opts.uploadAllowDirs OVER the defaults: the ~/.pygmalion/data baseline still accepts files when a host dir is set", async () => {
    vi.stubEnv("HOME", tmp)
    const dataDir = join(tmp, ".pygmalion", "data")
    mkdirSync(dataDir, { recursive: true })
    const sessionId = registerChromeLiveSession()
    const file = join(dataDir, "cv.pdf")
    writeFileSync(file, "pdf")
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      uploadFileOntoFileInput: async (options) => ({ targetId: "t", files: options.paths }),
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId, selector: "input[type=file]", paths: [file] },
    })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ files: [file] })
    await cleanup()
  })

  it("never calls the instance when any path is rejected (protect-then-dispatch)", async () => {
    const sessionId = registerChromeLiveSession()
    const spy = vi.fn(async () => ({ targetId: "t", files: [] }))
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      uploadFileOntoFileInput: spy as never,
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId, selector: "#cv", paths: [join(allowDir.current, "missing.pdf")] },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/cannot read/)
    expect(spy).not.toHaveBeenCalled()
    await cleanup()
  })

  it("propagates a no-file-input error from the instance", async () => {
    const sessionId = registerChromeLiveSession()
    const file = join(allowDir.current, "cv.pdf")
    writeFileSync(file, "pdf")
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      uploadFileOntoFileInput: async () => {
        throw new Error("no <input type=file> matches selector #missing")
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId, selector: "#missing", paths: [file] },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/no <input type=file> matches/)
    await cleanup()
  })

  it("rejects a non-chrome-live adapter", async () => {
    const desc = registry.registerBrowser({
      adapterId: "camofox",
      port: 9377,
      baseUrl: "http://127.0.0.1:9377",
      wasAlreadyRunning: true,
      stop: async () => {},
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_upload_file",
      arguments: { sessionId: desc.id, selector: "input[type=file]", paths: [tmp] },
    })
    expect(result.isError).toBe(true)
    await cleanup()
  })
})

// ── defaultBrowserUploadAllowDirs ────────────────────────────────────────────

describe("defaultBrowserUploadAllowDirs", () => {
  it("starts with ~/.pygmalion/data", () => {
    vi.stubEnv("HOME", "/home/fake-home")
    expect(defaultBrowserUploadAllowDirs()).toContain("/home/fake-home/.pygmalion/data")
  })

  it("appends the env list, colon-separated", () => {
    vi.stubEnv("HOME", "/home/fake-home")
    vi.stubEnv(BROWSER_UPLOAD_ALLOW_DIRS_ENV, "/srv/shared:/opt/more")
    const dirs = defaultBrowserUploadAllowDirs()
    expect(dirs).toContain("/srv/shared")
    expect(dirs).toContain("/opt/more")
    expect(dirs).toHaveLength(3)
  })
})

// ── browser_new_tab ──────────────────────────────────────────────────────────

describe("browser_new_tab", () => {
  it("opens a FRESH tab and returns its targetId", async () => {
    const sessionId = registerChromeLiveSession()
    let capturedUrl: string | undefined
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      openNewTab: async (url) => {
        capturedUrl = url
        return { targetId: "agent-tab-2", url: url ?? "about:blank" }
      },
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({
      name: "browser_new_tab",
      arguments: { sessionId, url: "https://example.test/second" },
    })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toMatchObject({ targetId: "agent-tab-2", url: "https://example.test/second" })
    expect(capturedUrl).toBe("https://example.test/second")
    await cleanup()
  })

  it("errors clearly when the chrome-live instance is unavailable", async () => {
    const sessionId = registerChromeLiveSession()
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_new_tab", arguments: { sessionId, url: "https://example.test" } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/provider instance is unavailable/)
    await cleanup()
  })

  it("rejects a non-chrome-live adapter", async () => {
    const desc = registry.registerBrowser({
      adapterId: "bureau",
      port: 8830,
      baseUrl: "http://127.0.0.1:8830",
      wasAlreadyRunning: true,
      stop: async () => {},
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_new_tab", arguments: { sessionId: desc.id } })
    expect(result.isError).toBe(true)
    await cleanup()
  })
})

// ── browser_list_tabs ────────────────────────────────────────────────────────

describe("browser_list_tabs", () => {
  it("returns the owned tabs", async () => {
    const sessionId = registerChromeLiveSession()
    setLiveBrowserInstance(sessionId, {
      ...baseInstance(),
      listOwnedTabs: async () => [
        { targetId: "agent-tab-1", url: "https://example.test/one", windowId: 7 },
      ],
    })
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_list_tabs", arguments: { sessionId } })
    expect(result.isError).toBeFalsy()
    expect(parse(result)).toEqual({ tabs: [{ targetId: "agent-tab-1", url: "https://example.test/one", windowId: 7 }] })
    await cleanup()
  })

  it("errors when the session is unknown", async () => {
    const { client, cleanup } = await makeClient()
    const result = await client.callTool({ name: "browser_list_tabs", arguments: { sessionId: "nope" } })
    expect(result.isError).toBe(true)
    await cleanup()
  })
})
