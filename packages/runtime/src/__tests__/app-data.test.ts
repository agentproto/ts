/**
 * Unit + MCP-transport coverage for the app-scoped data plane (app-data.ts).
 * Mirrors app-tools.test.ts's real-McpServer + InMemoryTransport +
 * parseToolJson pattern — no heavy mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerAppDataTools, resolveAppDataPath, AppPathTraversalError } from "../app-data.js"
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

const APP_ID = "@test/data-app"

async function setup(dir: string) {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: APP_ID,
    dir,
    agents: [],
    workflows: [],
    unvalidatedAgentTools: [],
  })
  const server = new McpServer({ name: "app-data-test-server", version: "0.0.0" })
  registerAppDataTools(server, { appRegistry })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-data-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "app-data-test-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("resolveAppDataPath traversal guard", () => {
  it("accepts paths inside the app dir", () => {
    expect(resolveAppDataPath(dir, "data/jobs/j1.json")).toBe(join(dir, "data", "jobs", "j1.json"))
    expect(resolveAppDataPath(dir, ".")).toBe(dir)
  })

  it("rejects `..`, absolute paths, and nested escapes", () => {
    expect(() => resolveAppDataPath(dir, "../escape.json")).toThrow(AppPathTraversalError)
    expect(() => resolveAppDataPath(dir, join(tmpdir(), "escape.json"))).toThrow(AppPathTraversalError)
    expect(() => resolveAppDataPath(dir, "a/../../b")).toThrow(AppPathTraversalError)
    expect(() => resolveAppDataPath(dir, "/etc/passwd")).toThrow(AppPathTraversalError)
    expect(() => resolveAppDataPath(dir, "C:\\windows\\x")).toThrow(AppPathTraversalError)
  })
})

describe("app_data_write / app_data_read round-trip", () => {
  it("round-trips a JSON object", async () => {
    const { client } = await setup(dir)
    const obj = { jobId: "j1", title: "Engineer", score: 0.91, nested: { a: 1 } }
    const w = parseToolJson(
      await client.callTool({
        name: "app_data_write",
        arguments: { appId: APP_ID, path: "data/jobs/j1.json", content: obj },
      }),
    )
    expect(w.path).toBe("data/jobs/j1.json")
    expect(typeof w.size).toBe("number")

    const r = parseToolJson(
      await client.callTool({
        name: "app_data_read",
        arguments: { appId: APP_ID, path: "data/jobs/j1.json" },
      }),
    )
    expect(r.exists).toBe(true)
    expect(r.content).toEqual(obj)
  })

  it("round-trips a raw text file", async () => {
    const { client } = await setup(dir)
    const w = parseToolJson(
      await client.callTool({
        name: "app_data_write",
        arguments: { appId: APP_ID, path: "notes.txt", content: { text: "hello world" } },
      }),
    )
    expect(w.size).toBe("hello world".length)

    const r = parseToolJson(
      await client.callTool({
        name: "app_data_read",
        arguments: { appId: APP_ID, path: "notes.txt" },
      }),
    )
    expect(r.exists).toBe(true)
    expect(r.content).toBe("hello world")
  })

  it("read of a missing file returns exists:false", async () => {
    const { client } = await setup(dir)
    const r = parseToolJson(
      await client.callTool({
        name: "app_data_read",
        arguments: { appId: APP_ID, path: "missing.txt" },
      }),
    )
    expect(r.exists).toBe(false)
    expect(r.path).toBe("missing.txt")
  })
})

describe("app_data_list", () => {
  it("lists entries with correct type", async () => {
    const { client } = await setup(dir)
    await mkdir(join(dir, "data"), { recursive: true })
    await writeFile(join(dir, "data", "a.json"), "{}", "utf8")
    await writeFile(join(dir, "top.txt"), "x", "utf8")

    const r = parseToolJson(
      await client.callTool({
        name: "app_data_list",
        arguments: { appId: APP_ID, dir: "." },
      }),
    )
    expect(r.entries).toEqual([
      { name: "data", type: "directory", size: 0 },
      { name: "top.txt", type: "file", size: 1 },
    ])
  })

  it("missing dir returns empty entries, not an error", async () => {
    const { client } = await setup(dir)
    const r = parseToolJson(
      await client.callTool({
        name: "app_data_list",
        arguments: { appId: APP_ID, dir: "nope" },
      }),
    )
    expect(r.entries).toEqual([])
  })
})

describe("app_data_* traversal rejection", () => {
  it("rejects traversal paths with an error result", async () => {
    const { client } = await setup(dir)
    for (const path of ["../escape.json", join(tmpdir(), "abs.json"), "a/../../b"]) {
      const w = await client.callTool({
        name: "app_data_write",
        arguments: { appId: APP_ID, path, content: { text: "x" } },
      })
      expect(isError(w)).toBe(true)
      expect(parseToolJson(w).error).toContain("traversal")

      const r = await client.callTool({
        name: "app_data_read",
        arguments: { appId: APP_ID, path },
      })
      expect(isError(r)).toBe(true)
      expect(parseToolJson(r).error).toContain("traversal")
    }
  })
})

describe("app_data_migrate", () => {
  async function seedLegacy(appDir: string) {
    const ranked = [
      {
        jobId: "job-a",
        title: "Role A",
        company: "Acme",
        location: "Paris",
        description: "desc",
        score: 0.9,
        tier: "A",
        rationale: "good",
        fitSignals: ["x"],
        concerns: [],
        url: "https://example.com/jobs/a",
      },
      {
        jobId: "job-c",
        title: "Role C",
        company: "Beta",
        location: "Lyon",
        description: "desc",
        score: 0.5,
        tier: "C",
        rationale: "meh",
        fitSignals: [],
        concerns: ["y"],
        url: "https://example.com/jobs/c",
      },
    ]
    await writeFile(join(appDir, "ranked-jobs.json"), JSON.stringify(ranked), "utf8")

    const matched = join(appDir, "dossiers", "folder-a")
    await mkdir(matched, { recursive: true })
    await writeFile(join(matched, "job.json"), JSON.stringify({ jobId: "job-a" }), "utf8")
    await writeFile(join(matched, "cv.json"), JSON.stringify({ summary: "cv" }), "utf8")
    await writeFile(join(matched, "cover.md"), "# Cover for A", "utf8")

    const unmatched = join(appDir, "dossiers", "folder-orphan")
    await mkdir(unmatched, { recursive: true })
    await writeFile(join(unmatched, "job.json"), JSON.stringify({ jobId: "ghost-job" }), "utf8")
  }

  it("migrates legacy data into the durable shape", async () => {
    await seedLegacy(dir)
    const { client } = await setup(dir)

    const res = parseToolJson(
      await client.callTool({ name: "app_data_migrate", arguments: { appId: APP_ID } }),
    )
    expect(res.migrated).toBe(true)
    expect(res.jobCount).toBe(2)
    expect(res.dossierCount).toBe(1)
    expect(res.skippedFolders).toEqual(["folder-orphan"])

    const jobA = JSON.parse(await readFile(join(dir, "data", "jobs", "job-a.json"), "utf8"))
    expect(jobA.id).toBe("job-a")
    expect(jobA.jobId).toBe("job-a")
    expect(jobA.applyUrl).toBe("https://example.com/jobs/a")
    expect(jobA.url).toBe("https://example.com/jobs/a")

    expect(existsSync(join(dir, "data", "jobs", "job-c.json"))).toBe(true)
    expect(existsSync(join(dir, "data", "rankings", "latest.json"))).toBe(true)
    expect(existsSync(join(dir, "data", "rankings", "job-a.json"))).toBe(true)

    const state = JSON.parse(await readFile(join(dir, "data", "state.json"), "utf8"))
    expect(typeof state.migratedAt).toBe("string")
    expect(state.jobCount).toBe(2)
    expect(state.dossierCount).toBe(1)

    const cover = await readFile(join(dir, "applications", "job-a", "cover.md"), "utf8")
    expect(cover).toBe("# Cover for A")
    expect(existsSync(join(dir, "applications", "job-a", "job.json"))).toBe(true)
    expect(existsSync(join(dir, "applications", "job-a", "cv.json"))).toBe(true)
    expect(existsSync(join(dir, "applications", "ghost-job", "cover.md"))).toBe(false)
  })

  it("is idempotent (alreadyMigrated) and `force` re-runs", async () => {
    await seedLegacy(dir)
    const { client } = await setup(dir)

    await client.callTool({ name: "app_data_migrate", arguments: { appId: APP_ID } })

    const again = parseToolJson(
      await client.callTool({ name: "app_data_migrate", arguments: { appId: APP_ID } }),
    )
    expect(again.migrated).toBe(false)
    expect(again.alreadyMigrated).toBe(true)

    const forced = parseToolJson(
      await client.callTool({
        name: "app_data_migrate",
        arguments: { appId: APP_ID, force: true },
      }),
    )
    expect(forced.migrated).toBe(true)
  })
})
