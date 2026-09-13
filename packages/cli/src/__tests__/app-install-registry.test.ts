/**
 * `agentproto app install` registry semantics (app-serve.ts `installAppDir`
 * / `listInstalledApps`): the `dataDir` written to ~/.agentproto/apps.json
 * follows explicit > previous > APP.md hint > `<dir>/data`, mirroring the
 * daemon's `performInstall`. HOME is pointed at a temp dir so the real
 * apps.json is never touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"

let home: string
const originalHome = process.env.HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "app-install-registry-"))
  process.env.HOME = home
  vi.resetModules()
})

afterEach(async () => {
  process.env.HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

async function load() {
  return import("../app-serve.js")
}

async function readApps(): Promise<{ appId: string; dir: string; dataDir?: string }[]> {
  const raw = await readFile(join(home, ".agentproto", "apps.json"), "utf8")
  return (JSON.parse(raw) as { apps: { appId: string; dir: string; dataDir?: string }[] }).apps
}

describe("installAppDir dataDir resolution", () => {
  it("defaults to <dir>/data and persists it", async () => {
    expect(homedir()).toBe(home)
    const { installAppDir, listInstalledApps } = await load()
    const entry = installAppDir("@t/a", "/tmp/app-a")
    expect(entry.dataDir).toBe(resolve("/tmp/app-a", "data"))
    expect((await readApps())[0]).toEqual({ appId: "@t/a", dir: "/tmp/app-a", dataDir: resolve("/tmp/app-a", "data") })
    expect(listInstalledApps()).toEqual([{ appId: "@t/a", dir: "/tmp/app-a", dataDir: resolve("/tmp/app-a", "data") }])
  })

  it("honors the APP.md hint (relative to the app dir), then keeps it across a bare re-install", async () => {
    const { installAppDir } = await load()
    expect(installAppDir("@t/b", "/tmp/app-b", { hintDir: "store" }).dataDir).toBe(resolve("/tmp/app-b", "store"))
    // Re-install without any hint: the registered dataDir is kept.
    expect(installAppDir("@t/b", "/tmp/app-b").dataDir).toBe(resolve("/tmp/app-b", "store"))
  })

  it("an explicit --data-dir wins over both, and `~` expands", async () => {
    const { installAppDir } = await load()
    installAppDir("@t/c", "/tmp/app-c", { hintDir: "store" })
    const entry = installAppDir("@t/c", "/tmp/app-c", { dataDir: "~/big/c-data", hintDir: "store" })
    expect(entry.dataDir).toBe(join(home, "big", "c-data"))
    // A relative explicit path is taken relative to the app dir.
    expect(installAppDir("@t/c", "/tmp/app-c", { dataDir: "out" }).dataDir).toBe(resolve("/tmp/app-c", "out"))
    expect((await readApps()).map(a => a.appId)).toEqual(["@t/c"])
  })

  it("listInstalledApps backfills <dir>/data for entries written before the field existed", async () => {
    const { installAppDir, listInstalledApps } = await load()
    installAppDir("@t/d", "/tmp/app-d")
    // Simulate a pre-dataDir entry by stripping the field on disk.
    const { writeFile } = await import("node:fs/promises")
    const apps = (await readApps()).map(({ dataDir: _drop, ...rest }) => rest)
    await writeFile(join(home, ".agentproto", "apps.json"), JSON.stringify({ apps }), "utf8")
    expect(listInstalledApps()).toEqual([{ appId: "@t/d", dir: "/tmp/app-d", dataDir: resolve("/tmp/app-d", "data") }])
  })
})
