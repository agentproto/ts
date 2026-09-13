import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, rm, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { syncApps, writeCatalog } from "../bin/sync.js"

describe("agentproto-apps-sync", () => {
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it("emits every bundled app under baseDir and writes a valid catalog next to it", async () => {
    const root = await mkdtemp(join(tmpdir(), "apps-sync-"))
    dirs.push(root)
    const baseDir = join(root, "apps")

    const catalog = await syncApps(baseDir)
    expect(catalog.map((e) => e.appId).sort()).toEqual([
      "@agentproto/code-team",
      "@agentproto/content-team",
      "@agentproto/mail-triage",
      "@agentproto/media-viewer",
      "@agentproto/ops-panel",
      "@agentproto/session-viewer",
    ])

    for (const entry of catalog) {
      await expect(access(join(entry.dir, ".agentproto", "APP.md"))).resolves.toBeUndefined()
    }

    const catalogPath = await writeCatalog(baseDir, catalog)
    expect(catalogPath).toBe(join(root, "app-catalog.json"))
    const raw = await readFile(catalogPath, "utf8")
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed.apps)).toBe(true)
    expect(parsed.apps).toHaveLength(6)
    expect(parsed.apps[0]).toMatchObject({
      appId: expect.any(String),
      name: expect.any(String),
      description: expect.any(String),
      dir: expect.any(String),
      category: expect.any(String),
    })
  })
})
