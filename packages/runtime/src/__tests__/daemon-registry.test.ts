import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  daemonRegistryDir,
  readDaemonRegistry,
  sweepStaleDaemonRegistry,
  unlinkDaemonRegistryEntry,
  writeDaemonRegistryEntry,
  type RuntimeMeta,
} from "../agentproto-dir.js"

// daemonRegistryDir() resolves under os.homedir(), which libuv derives
// from $HOME on POSIX — so a temp HOME fully isolates these tests.
let prevHome: string | undefined
let home: string

function meta(over: Partial<RuntimeMeta>): RuntimeMeta {
  return {
    workspace: "/ws",
    port: 18790,
    bind: "127.0.0.1",
    pid: process.pid, // alive by default
    startedAt: "2026-06-29T00:00:00.000Z",
    name: "agentproto-runtime",
    registered: [],
    token: "tok-abc",
    ...over,
  }
}

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-reg-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("daemon central registry", () => {
  it("round-trips a written entry", async () => {
    await writeDaemonRegistryEntry(meta({ port: 18790, token: "tok-1" }))
    const entries = await readDaemonRegistry()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.meta.port).toBe(18790)
    expect(entries[0]?.meta.token).toBe("tok-1")
    expect(entries[0]?.path).toBe(join(daemonRegistryDir(), "18790.json"))
  })

  it("writes the token file with mode 0600", async () => {
    await writeDaemonRegistryEntry(meta({ port: 1234 }))
    const { mode } = await import("node:fs/promises").then(m =>
      m.stat(join(daemonRegistryDir(), "1234.json")),
    )
    expect(mode & 0o777).toBe(0o600)
  })

  it("returns entries newest-first by mtime", async () => {
    await writeDaemonRegistryEntry(meta({ port: 1 }))
    // touch a second file later so its mtime is strictly newer
    await new Promise(r => setTimeout(r, 10))
    await writeDaemonRegistryEntry(meta({ port: 2 }))
    const entries = await readDaemonRegistry()
    expect(entries.map(e => e.meta.port)).toEqual([2, 1])
  })

  it("returns empty when the registry dir is absent", async () => {
    expect(await readDaemonRegistry()).toEqual([])
  })

  it("skips malformed entries without throwing", async () => {
    await writeDaemonRegistryEntry(meta({ port: 5 }))
    await writeFile(join(daemonRegistryDir(), "bad.json"), "{ not json", "utf8")
    const entries = await readDaemonRegistry()
    expect(entries.map(e => e.meta.port)).toEqual([5])
  })

  it("unlink removes the matching entry", async () => {
    await writeDaemonRegistryEntry(meta({ port: 9 }))
    await unlinkDaemonRegistryEntry(9)
    expect(await readDaemonRegistry()).toEqual([])
  })

  it("sweep deletes dead-PID entries but keeps live + current", async () => {
    // pid 1 (init) is alive but foreign; use an unused-high pid for dead.
    const deadPid = 2_147_483_646
    await writeDaemonRegistryEntry(meta({ port: 100, pid: process.pid })) // live
    await writeDaemonRegistryEntry(meta({ port: 200, pid: deadPid })) // dead
    await writeDaemonRegistryEntry(meta({ port: 300, pid: deadPid })) // dead, but current

    const cleaned = await sweepStaleDaemonRegistry(300)
    expect(cleaned).toEqual([join(daemonRegistryDir(), "200.json")])

    const remaining = (await readDaemonRegistry()).map(e => e.meta.port).sort()
    expect(remaining).toEqual([100, 300])
  })
})
