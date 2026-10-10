/**
 * `agentproto app install <dir>` with no daemon: runs the daemon's own
 * `performInstall` in-process and persists the FULL record to
 * ~/.agentproto/apps.json (a bare `{appId, dir, dataDir}` made the next
 * daemon throw inside every workflow run). `dataDir` follows explicit >
 * previous > APP.md hint > `<dir>/data`. HOME points at a temp dir and the
 * configured daemon port at a closed one, so neither the real registry nor a
 * live daemon is ever touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"

let home: string
const originalHome = process.env.HOME

async function closedPort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => res(port))
    })
    s.on("error", rej)
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "app-install-registry-"))
  process.env.HOME = home
  await mkdir(join(home, ".agentproto"), { recursive: true })
  await writeFile(join(home, ".agentproto", "config.json"), JSON.stringify({ daemon: { port: await closedPort() } }))
  vi.resetModules()
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.env.HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

async function writeApp(name: string, dataHint?: string): Promise<string> {
  const dir = join(home, name)
  await mkdir(join(dir, ".agentproto", "workflows", "do-thing"), { recursive: true })
  await mkdir(join(dir, ".agentproto", "agents", "worker"), { recursive: true })
  await writeFile(
    join(dir, ".agentproto", "APP.md"),
    [
      "---",
      "schema: app/v1",
      `id: '@t/${name}'`,
      `name: ${name}`,
      "version: 0.1.0",
      ...(dataHint ? ["data:", `  dir: ${dataHint}`] : []),
      "agents:",
      "  - id: worker",
      "    path: .agentproto/agents/worker/AGENT.md",
      "workflows:",
      "  - id: do-thing",
      "    path: .agentproto/workflows/do-thing/WORKFLOW.md",
      "---",
      "",
    ].join("\n"),
  )
  await writeFile(
    join(dir, ".agentproto", "workflows", "do-thing", "WORKFLOW.md"),
    "---\nid: do-thing\nname: Do thing\ndescription: Does a thing.\nversion: 0.1.0\ninputs: {}\noutputs: {}\nsteps:\n  - id: step1\n    kind: tool\n    tool: known_tool\n---\n\nDoes a thing.\n",
  )
  await writeFile(
    join(dir, ".agentproto", "agents", "worker", "AGENT.md"),
    "---\nschema: agent/v1\nid: worker\ndescription: A worker agent.\nmodel: claude-sonnet-5\nworkflows:\n  - ref: do-thing\n---\n\nYou do the thing.\n",
  )
  return dir
}

async function install(...args: string[]): Promise<number> {
  const { runAppInstall } = await import("../commands/app.js")
  return runAppInstall(args)
}

async function readApps(): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(home, ".agentproto", "apps.json"), "utf8")
  return (JSON.parse(raw) as { apps: Record<string, unknown>[] }).apps
}

describe("app install <dir> without a daemon", () => {
  it("persists the full record (agents, workflows, timestamps), not a bare mapping", async () => {
    expect(homedir()).toBe(home)
    const dir = await writeApp("a")
    expect(await install(dir)).toBe(0)
    const [rec] = await readApps()
    expect(rec).toMatchObject({
      appId: "@t/a",
      dir,
      dataDir: resolve(dir, "data"),
      version: "0.1.0",
      agents: [{ id: "worker" }],
      workflows: [{ id: "do-thing" }],
      unvalidatedAgentTools: [],
    })
    expect(typeof rec!["installedAt"]).toBe("string")
    const { listInstalledApps } = await import("../app-serve.js")
    expect(listInstalledApps()).toEqual([{ appId: "@t/a", dir, dataDir: resolve(dir, "data") }])
  })

  it("honors the APP.md hint (relative to the app dir), then keeps it across a bare re-install", async () => {
    const dir = await writeApp("c", "store")
    expect(await install(dir)).toBe(0)
    expect((await readApps())[0]!["dataDir"]).toBe(resolve(dir, "store"))
    expect(await install(dir)).toBe(0)
    expect((await readApps())[0]!["dataDir"]).toBe(resolve(dir, "store"))
  })

  it("an explicit --data-dir wins, `~` expands, and re-install keeps one record", async () => {
    const dir = await writeApp("d", "store")
    expect(await install(dir)).toBe(0)
    expect(await install(dir, "--data-dir", "~/big/d-data")).toBe(0)
    const apps = await readApps()
    expect(apps).toHaveLength(1)
    expect(apps[0]!["dataDir"]).toBe(join(home, "big", "d-data"))
    expect(await install(dir, "--data-dir", "out")).toBe(0)
    expect((await readApps())[0]!["dataDir"]).toBe(resolve(dir, "out"))
  })

  it("an app that fails to load exits 1 and writes nothing", async () => {
    const dir = await writeApp("e")
    await rm(join(dir, ".agentproto", "workflows", "do-thing", "WORKFLOW.md"))
    expect(await install(dir)).toBe(1)
    await expect(readFile(join(home, ".agentproto", "apps.json"), "utf8")).rejects.toThrow()
  })

  it("listInstalledApps backfills <dir>/data for entries written before the field existed", async () => {
    await writeFile(join(home, ".agentproto", "apps.json"), JSON.stringify({ apps: [{ appId: "@t/old", dir: "/tmp/app-old" }] }))
    const { listInstalledApps } = await import("../app-serve.js")
    expect(listInstalledApps()).toEqual([{ appId: "@t/old", dir: "/tmp/app-old", dataDir: resolve("/tmp/app-old", "data") }])
  })
})
