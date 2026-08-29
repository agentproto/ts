/**
 * Unit + MCP-transport coverage for the read-only external filesystem plane
 * (app-external.ts). Mirrors app-data.test.ts's real-McpServer +
 * InMemoryTransport + parseToolJson pattern, plus the root-must-be-granted
 * checks that plane doesn't have.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  registerAppExternalTools,
  resolveExternalPath,
  ExternalPathTraversalError,
} from "../app-external.js"
import { createAppRegistry } from "../app-registry.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string; isError?: boolean }> })
    .content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

const APP_ID = "@test/external-app"

async function setup(sandboxDir: string, externalReadRoots: string[]) {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: APP_ID,
    dir: sandboxDir,
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
    externalReadRoots,
  })
  const server = new McpServer({ name: "app-external-test-server", version: "0.0.0" })
  registerAppExternalTools(server, { appRegistry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-external-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, appRegistry }
}

let sandboxDir: string
let externalDir: string
beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), "app-external-sandbox-"))
  externalDir = await mkdtemp(join(tmpdir(), "app-external-root-"))
})
afterEach(async () => {
  await rm(sandboxDir, { recursive: true, force: true })
  await rm(externalDir, { recursive: true, force: true })
})

describe("resolveExternalPath traversal guard", () => {
  it("accepts paths inside the granted root", () => {
    expect(resolveExternalPath(externalDir, "sub/file.json")).toBe(join(externalDir, "sub", "file.json"))
    expect(resolveExternalPath(externalDir, "")).toBe(externalDir)
    expect(resolveExternalPath(externalDir, ".")).toBe(externalDir)
  })

  it("rejects `..`, absolute paths, and nested escapes", () => {
    expect(() => resolveExternalPath(externalDir, "../escape.json")).toThrow(ExternalPathTraversalError)
    expect(() => resolveExternalPath(externalDir, join(tmpdir(), "escape.json"))).toThrow(
      ExternalPathTraversalError,
    )
    expect(() => resolveExternalPath(externalDir, "a/../../b")).toThrow(ExternalPathTraversalError)
    expect(() => resolveExternalPath(externalDir, "/etc/passwd")).toThrow(ExternalPathTraversalError)
    expect(() => resolveExternalPath(externalDir, "C:\\windows\\x")).toThrow(ExternalPathTraversalError)
  })
})

describe("app_external_list", () => {
  it("lists entries with isDirectory + size for files", async () => {
    await mkdir(join(externalDir, "sub"), { recursive: true })
    await writeFile(join(externalDir, "sub", "a.json"), "{}", "utf8")
    await writeFile(join(externalDir, "top.txt"), "x", "utf8")

    const { client } = await setup(sandboxDir, [externalDir])
    const r = parseToolJson(
      await client.callTool({
        name: "app_external_list",
        arguments: { appId: APP_ID, root: externalDir },
      }),
    )
    expect(r.entries).toEqual([
      { name: "sub", isDirectory: true },
      { name: "top.txt", isDirectory: false, size: 1 },
    ])
  })

  it("lists a nested `path` under the granted root", async () => {
    await mkdir(join(externalDir, "sub"), { recursive: true })
    await writeFile(join(externalDir, "sub", "a.json"), "{}", "utf8")

    const { client } = await setup(sandboxDir, [externalDir])
    const r = parseToolJson(
      await client.callTool({
        name: "app_external_list",
        arguments: { appId: APP_ID, root: externalDir, path: "sub" },
      }),
    )
    expect(r.entries).toEqual([{ name: "a.json", isDirectory: false, size: 2 }])
  })

  it("rejects a root that isn't an exact match to a granted entry", async () => {
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_list",
      arguments: { appId: APP_ID, root: join(externalDir, "sub"), path: "" },
    })
    expect(isError(r)).toBe(true)
    expect(parseToolJson(r).error).toContain("not granted")
  })

  it("rejects a root that is a prefix but not an exact match", async () => {
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_list",
      arguments: { appId: APP_ID, root: externalDir + "-evil-sibling" },
    })
    expect(isError(r)).toBe(true)
    expect(parseToolJson(r).error).toContain("not granted")
  })

  it("rejects traversal in `path`", async () => {
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_list",
      arguments: { appId: APP_ID, root: externalDir, path: "../escape" },
    })
    expect(isError(r)).toBe(true)
    expect(parseToolJson(r).error).toContain("traversal")
  })

  it("errors for an app that isn't installed", async () => {
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_list",
      arguments: { appId: "@test/nope", root: externalDir },
    })
    expect(isError(r)).toBe(true)
  })
})

describe("app_external_read", () => {
  it("reads a .json file as parsed content", async () => {
    await writeFile(join(externalDir, "job.json"), JSON.stringify({ a: 1 }), "utf8")
    const { client } = await setup(sandboxDir, [externalDir])
    const r = parseToolJson(
      await client.callTool({
        name: "app_external_read",
        arguments: { appId: APP_ID, root: externalDir, path: "job.json" },
      }),
    )
    expect(r.content).toEqual({ a: 1 })
  })

  it("reads a .md file as raw text", async () => {
    await writeFile(join(externalDir, "notes.md"), "# hello", "utf8")
    const { client } = await setup(sandboxDir, [externalDir])
    const r = parseToolJson(
      await client.callTool({
        name: "app_external_read",
        arguments: { appId: APP_ID, root: externalDir, path: "notes.md" },
      }),
    )
    expect(r.content).toBe("# hello")
  })

  it("rejects a root that isn't an exact match to a granted entry", async () => {
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_read",
      arguments: { appId: APP_ID, root: "/tmp/some-other-dir", path: "job.json" },
    })
    expect(isError(r)).toBe(true)
    expect(parseToolJson(r).error).toContain("not granted")
  })

  it("rejects traversal in `path`", async () => {
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_read",
      arguments: { appId: APP_ID, root: externalDir, path: "../../etc/passwd" },
    })
    expect(isError(r)).toBe(true)
  })

  it("rejects a non-text-ish extension (pdf) and points at the blob route", async () => {
    await writeFile(join(externalDir, "cv.pdf"), "%PDF-1.4 fake", "utf8")
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_read",
      arguments: { appId: APP_ID, root: externalDir, path: "cv.pdf" },
    })
    expect(isError(r)).toBe(true)
    const err = parseToolJson(r).error
    expect(err).toContain("not")
    expect(err).toContain("external-blob")
  })

  it("rejects a non-text-ish extension (png)", async () => {
    await writeFile(join(externalDir, "photo.png"), "fake bytes", "utf8")
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_read",
      arguments: { appId: APP_ID, root: externalDir, path: "photo.png" },
    })
    expect(isError(r)).toBe(true)
  })

  it("rejects a file over the size cap", async () => {
    await writeFile(join(externalDir, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 1), "utf8")
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_read",
      arguments: { appId: APP_ID, root: externalDir, path: "huge.txt" },
    })
    expect(isError(r)).toBe(true)
    expect(parseToolJson(r).error).toContain("cap")
  })

  it("rejects reading a directory", async () => {
    await mkdir(join(externalDir, "sub"), { recursive: true })
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_read",
      arguments: { appId: APP_ID, root: externalDir, path: "sub" },
    })
    expect(isError(r)).toBe(true)
  })

  it("errors for a missing file", async () => {
    const { client } = await setup(sandboxDir, [externalDir])
    const r = await client.callTool({
      name: "app_external_read",
      arguments: { appId: APP_ID, root: externalDir, path: "missing.txt" },
    })
    expect(isError(r)).toBe(true)
  })
})
