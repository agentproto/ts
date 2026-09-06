/**
 * Unit + MCP-transport coverage for the app-scoped data plane (app-data.ts).
 * Mirrors app-tools.test.ts's real-McpServer + InMemoryTransport +
 * parseToolJson pattern — no heavy mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  registerAppDataTools,
  resolveAppDataPath,
  collapseLegacyDataPrefix,
  appDataDir,
  AppPathTraversalError,
} from "../app-data.js"
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

async function setup(dir: string, dataDir?: string) {
  const appRegistry = createAppRegistry()
  appRegistry.upsertApp({
    appId: APP_ID,
    dir,
    ...(dataDir !== undefined ? { dataDir } : {}),
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
    // `.` is the data dir (default `<dir>/data`), not the app's source dir —
    // `top.txt` at the app root is still readable by path (legacy fallback)
    // but not enumerated here.
    expect(r.entries).toEqual([{ name: "a.json", type: "file", size: 2 }])
    const legacySpelling = parseToolJson(
      await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID, dir: "data" } }),
    )
    expect(legacySpelling.entries).toEqual([{ name: "a.json", type: "file", size: 2 }])
    const top = parseToolJson(
      await client.callTool({ name: "app_data_read", arguments: { appId: APP_ID, path: "top.txt" } }),
    )
    expect(top).toEqual({ appId: APP_ID, path: "top.txt", exists: true, content: "x" })
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

  it("page-walk with limit=2 covers exactly the unpaginated entries; default call unchanged (PR-8)", async () => {
    await mkdir(join(dir, "data"), { recursive: true })
    for (const name of ["a.json", "b.json", "c.txt"]) {
      await writeFile(join(dir, "data", name), "{}", "utf8")
    }
    const { client } = await setup(dir)

    // Default call unchanged: the { appId, dir, entries } envelope, no page fields.
    const unpaginated = parseToolJson(
      await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID, dir: "." } }),
    )
    expect(unpaginated.appId).toBe(APP_ID)
    expect(unpaginated.dir).toBe(".")
    expect(unpaginated.entries.map((e: any) => e.name)).toEqual(["a.json", "b.json", "c.txt"])
    expect(unpaginated.items).toBeUndefined()
    expect(unpaginated.total).toBeUndefined()

    // Page-walk: the union of pages equals the unpaginated list exactly.
    const union: string[] = []
    let cursor: string | undefined
    do {
      const page = parseToolJson(
        await client.callTool({
          name: "app_data_list",
          arguments: { appId: APP_ID, dir: ".", limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      )
      expect(page.total).toBe(3)
      union.push(...page.items.map((e: any) => e.name))
      cursor = page.nextCursor
    } while (cursor)
    expect(union).toEqual(["a.json", "b.json", "c.txt"])
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

    // No legacy `<dir>/applications` in this fixture → the folder is created
    // under the data dir like every other brand-new path.
    const cover = await readFile(join(dir, "data", "applications", "job-a", "cover.md"), "utf8")
    expect(cover).toBe("# Cover for A")
    expect(existsSync(join(dir, "data", "applications", "job-a", "job.json"))).toBe(true)
    expect(existsSync(join(dir, "data", "applications", "job-a", "cv.json"))).toBe(true)
    expect(existsSync(join(dir, "applications", "job-a", "cover.md"))).toBe(false)
    expect(existsSync(join(dir, "data", "applications", "ghost-job", "cover.md"))).toBe(false)
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

describe("app_data_migrate with a pre-dataDir applications/ folder", () => {
  it("keeps writing into <dir>/applications when it already exists (legacy top-level folder)", async () => {
    await writeFile(
      join(dir, "ranked-jobs.json"),
      JSON.stringify([{ jobId: "job-a", title: "A", url: "https://example.com/a" }]),
      "utf8",
    )
    const dossier = join(dir, "dossiers", "a")
    await mkdir(dossier, { recursive: true })
    await writeFile(join(dossier, "job.json"), JSON.stringify({ jobId: "job-a" }), "utf8")
    await writeFile(join(dossier, "cover.md"), "# A", "utf8")
    await mkdir(join(dir, "applications", "older"), { recursive: true })

    const { client } = await setup(dir)
    const res = parseToolJson(await client.callTool({ name: "app_data_migrate", arguments: { appId: APP_ID } }))
    expect(res.migrated).toBe(true)
    expect(await readFile(join(dir, "applications", "job-a", "cover.md"), "utf8")).toBe("# A")
    expect(existsSync(join(dir, "data", "applications"))).toBe(false)
    // Durable shape still lands under the data dir, at the new base spelling.
    expect(existsSync(join(dir, "data", "jobs", "job-a.json"))).toBe(true)
    expect(existsSync(join(dir, "data", "state.json"))).toBe(true)
  })
})

describe("collapseLegacyDataPrefix", () => {
  it("drops a leading data/ segment and nothing else", () => {
    expect(collapseLegacyDataPrefix("data/trips/x.json")).toBe(join("trips", "x.json"))
    expect(collapseLegacyDataPrefix("./data/trips/x.json")).toBe(join("trips", "x.json"))
    expect(collapseLegacyDataPrefix("data")).toBe(".")
    expect(collapseLegacyDataPrefix("data/")).toBe(".")
    expect(collapseLegacyDataPrefix("database/x.json")).toBe("database/x.json")
    expect(collapseLegacyDataPrefix("trips/data/x.json")).toBe("trips/data/x.json")
    expect(collapseLegacyDataPrefix("data/../secret")).toBe("data/../secret")
  })
})

describe("appDataDir", () => {
  it("is the persisted dataDir, else <dir>/data", () => {
    expect(appDataDir({ dir: "/apps/a" })).toBe(join("/apps/a", "data"))
    expect(appDataDir({ dir: "/apps/a", dataDir: "/big/a-data" })).toBe("/big/a-data")
  })
})

describe("dataDir resolution — default layout (<dir>/data)", () => {
  it("writes new files under <dir>/data and reads them back at the new base", async () => {
    const { client } = await setup(dir)
    const w = parseToolJson(
      await client.callTool({
        name: "app_data_write",
        arguments: { appId: APP_ID, path: "trips/t1/brief.json", content: { days: 15 } },
      }),
    )
    expect(w.size).toBeGreaterThan(0)
    expect(existsSync(join(dir, "data", "trips", "t1", "brief.json"))).toBe(true)
    expect(existsSync(join(dir, "trips"))).toBe(false)
    const r = parseToolJson(
      await client.callTool({ name: "app_data_read", arguments: { appId: APP_ID, path: "trips/t1/brief.json" } }),
    )
    expect(r).toEqual({ appId: APP_ID, path: "trips/t1/brief.json", exists: true, content: { days: 15 } })
  })

  it("accepts the legacy data/ spelling for the same file — reads AND writes", async () => {
    await mkdir(join(dir, "data", "trips", "t1"), { recursive: true })
    await writeFile(join(dir, "data", "trips", "t1", "brief.json"), JSON.stringify({ days: 15 }), "utf8")
    const { client } = await setup(dir)

    const legacy = parseToolJson(
      await client.callTool({ name: "app_data_read", arguments: { appId: APP_ID, path: "data/trips/t1/brief.json" } }),
    )
    expect(legacy.exists).toBe(true)
    expect(legacy.content).toEqual({ days: 15 })
    const fresh = parseToolJson(
      await client.callTool({ name: "app_data_read", arguments: { appId: APP_ID, path: "trips/t1/brief.json" } }),
    )
    expect(fresh.content).toEqual({ days: 15 })

    // A write with the legacy spelling lands in <dir>/data/trips — never <dir>/data/data.
    await client.callTool({
      name: "app_data_write",
      arguments: { appId: APP_ID, path: "data/trips/t2/taste.json", content: { loves: ["dogs"] } },
    })
    expect(existsSync(join(dir, "data", "trips", "t2", "taste.json"))).toBe(true)
    expect(existsSync(join(dir, "data", "data"))).toBe(false)

    const listed = parseToolJson(
      await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID, dir: "data/trips" } }),
    )
    expect(listed.entries.map((e: { name: string }) => e.name)).toEqual(["t1", "t2"])
  })

  it("falls back to the app dir for files a pre-dataDir install wrote at <dir> root", async () => {
    await mkdir(join(dir, "applications", "j1"), { recursive: true })
    await writeFile(join(dir, "applications", "j1", "cv.json"), JSON.stringify({ v: 1 }), "utf8")
    const { client } = await setup(dir)

    const r = parseToolJson(
      await client.callTool({ name: "app_data_read", arguments: { appId: APP_ID, path: "applications/j1/cv.json" } }),
    )
    expect(r.content).toEqual({ v: 1 })

    // Existing legacy file: updated in place.
    await client.callTool({
      name: "app_data_write",
      arguments: { appId: APP_ID, path: "applications/j1/cv.json", content: { v: 2 } },
    })
    expect(JSON.parse(await readFile(join(dir, "applications", "j1", "cv.json"), "utf8"))).toEqual({ v: 2 })
    expect(existsSync(join(dir, "data", "applications"))).toBe(false)

    // New file whose top-level folder only exists under <dir>: joins its siblings there.
    await client.callTool({
      name: "app_data_write",
      arguments: { appId: APP_ID, path: "applications/j2/cv.json", content: { v: 1 } },
    })
    expect(existsSync(join(dir, "applications", "j2", "cv.json"))).toBe(true)

    // A brand-new top-level folder goes under the data dir.
    await client.callTool({
      name: "app_data_write",
      arguments: { appId: APP_ID, path: "notes/n1.md", content: { text: "hi" } },
    })
    expect(existsSync(join(dir, "data", "notes", "n1.md"))).toBe(true)
    expect(existsSync(join(dir, "notes"))).toBe(false)
  })

  it("merges the legacy and data-dir views of a folder in app_data_list, data dir winning on clashes", async () => {
    await mkdir(join(dir, "applications", "old"), { recursive: true })
    await mkdir(join(dir, "applications", "both"), { recursive: true })
    await writeFile(join(dir, "applications", "both", "x.json"), "{}", "utf8")
    await mkdir(join(dir, "data", "applications", "new"), { recursive: true })
    await writeFile(join(dir, "data", "applications", "both"), "clash", "utf8")
    const { client } = await setup(dir)
    const listed = parseToolJson(
      await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID, dir: "applications" } }),
    )
    expect(listed.entries).toEqual([
      { name: "both", type: "file", size: 5 },
      { name: "new", type: "directory", size: 0 },
      { name: "old", type: "directory", size: 0 },
    ])
  })

  it("lists `.` as the data dir once it exists, and as the app dir before that", async () => {
    await writeFile(join(dir, "ranked-jobs.json"), "[]", "utf8")
    const { client } = await setup(dir)
    const before = parseToolJson(await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID } }))
    expect(before.entries.map((e: { name: string }) => e.name)).toEqual(["ranked-jobs.json"])

    await client.callTool({
      name: "app_data_write",
      arguments: { appId: APP_ID, path: "jobs/j1.json", content: {} },
    })
    const after = parseToolJson(await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID } }))
    expect(after.entries.map((e: { name: string }) => e.name)).toEqual(["jobs"])
  })
})

describe("dataDir resolution — explicit dataDir outside the app dir", () => {
  let store: string
  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), "app-data-store-"))
  })
  afterEach(async () => {
    await rm(store, { recursive: true, force: true })
  })

  it("anchors reads/writes/lists under dataDir, creating it lazily, with no data/ collapse", async () => {
    const dataDir = join(store, "tripsmith-data")
    const { client } = await setup(dir, dataDir)
    expect(existsSync(dataDir)).toBe(false)

    const missing = parseToolJson(
      await client.callTool({ name: "app_data_read", arguments: { appId: APP_ID, path: "trips/t1/brief.json" } }),
    )
    expect(missing.exists).toBe(false)

    await client.callTool({
      name: "app_data_write",
      arguments: { appId: APP_ID, path: "trips/t1/brief.json", content: { days: 3 } },
    })
    expect(existsSync(join(dataDir, "trips", "t1", "brief.json"))).toBe(true)
    expect(existsSync(join(dir, "data"))).toBe(false)

    // A custom root is a fresh layout: `data/` is a real folder name there.
    await client.callTool({
      name: "app_data_write",
      arguments: { appId: APP_ID, path: "data/x.json", content: 1 },
    })
    expect(existsSync(join(dataDir, "data", "x.json"))).toBe(true)

    const listed = parseToolJson(await client.callTool({ name: "app_data_list", arguments: { appId: APP_ID } }))
    expect(listed.entries.map((e: { name: string }) => e.name)).toEqual(["data", "trips"])
  })

  it("still finds files a pre-dataDir install left under the app dir", async () => {
    await mkdir(join(dir, "data", "trips", "t1"), { recursive: true })
    await writeFile(join(dir, "data", "trips", "t1", "brief.json"), JSON.stringify({ old: true }), "utf8")
    const { client } = await setup(dir, join(store, "elsewhere"))
    const r = parseToolJson(
      await client.callTool({ name: "app_data_read", arguments: { appId: APP_ID, path: "data/trips/t1/brief.json" } }),
    )
    expect(r.content).toEqual({ old: true })
  })

  it("rejects traversal out of dataDir and a symlink escaping it", async () => {
    const dataDir = join(store, "d")
    await mkdir(dataDir, { recursive: true })
    const outside = join(store, "outside")
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, "secret.txt"), "s3cret", "utf8")
    await symlink(outside, join(dataDir, "link"))
    const { client } = await setup(dir, dataDir)

    const climb = await client.callTool({
      name: "app_data_read",
      arguments: { appId: APP_ID, path: "../outside/secret.txt" },
    })
    expect(isError(climb)).toBe(true)
    expect(parseToolJson(climb).error).toContain("traversal")

    const viaLink = await client.callTool({
      name: "app_data_read",
      arguments: { appId: APP_ID, path: "link/secret.txt" },
    })
    expect(isError(viaLink)).toBe(true)
    expect(parseToolJson(viaLink).error).toContain("traversal")
  })
})
