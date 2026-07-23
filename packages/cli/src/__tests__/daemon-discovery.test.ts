import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  writeDaemonRegistryEntry,
  type RuntimeMeta,
} from "@agentproto/runtime"
import { discoverDaemon } from "../commands/_daemon-helpers.js"

// discoverDaemon resolves everything under os.homedir(), which libuv
// derives from $HOME on POSIX — so a temp HOME + cleared env fully
// isolates these tests from the developer's real ~/.agentproto.
let prevHome: string | undefined
let prevUrl: string | undefined
let prevToken: string | undefined
let home: string

function meta(over: Partial<RuntimeMeta>): RuntimeMeta {
  return {
    workspace: "/ws",
    port: 18790,
    bind: "127.0.0.1",
    pid: process.pid, // alive by default
    startedAt: "2026-07-23T00:00:00.000Z",
    name: "agentproto-serve",
    registered: [],
    token: "tok",
    ...over,
  }
}

async function writeConfig(daemon: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, ".agentproto"), { recursive: true })
  await writeFile(
    join(home, ".agentproto", "config.json"),
    JSON.stringify({ version: 1, daemon }),
    "utf8",
  )
}

async function writeHomeRuntimeJson(m: Partial<RuntimeMeta>): Promise<void> {
  await mkdir(join(home, ".agentproto"), { recursive: true })
  await writeFile(
    join(home, ".agentproto", "runtime.json"),
    JSON.stringify(meta(m)),
    "utf8",
  )
}

const tick = () => new Promise(r => setTimeout(r, 12))

beforeEach(async () => {
  prevHome = process.env.HOME
  prevUrl = process.env.AGENTPROTO_DAEMON_URL
  prevToken = process.env.AGENTPROTO_DAEMON_TOKEN
  delete process.env.AGENTPROTO_DAEMON_URL
  delete process.env.AGENTPROTO_DAEMON_TOKEN
  home = await mkdtemp(join(tmpdir(), "agp-disc-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (prevUrl === undefined) delete process.env.AGENTPROTO_DAEMON_URL
  else process.env.AGENTPROTO_DAEMON_URL = prevUrl
  if (prevToken === undefined) delete process.env.AGENTPROTO_DAEMON_TOKEN
  else process.env.AGENTPROTO_DAEMON_TOKEN = prevToken
  await rm(home, { recursive: true, force: true })
})

describe("discoverDaemon", () => {
  it("prefers the config-declared serve daemon over a newer transient entry", async () => {
    await writeConfig({ port: 18790 })
    // Live serve daemon on the declared port, written FIRST (older mtime).
    await writeDaemonRegistryEntry(
      meta({ port: 18790, token: "serve-tok", name: "agentproto-serve" }),
    )
    await tick()
    // Newer, still-live transient runtime on an ephemeral port — newest by
    // mtime, so the old newest-first logic would have grabbed this one.
    await writeDaemonRegistryEntry(
      meta({ port: 55190, token: "transient-tok", name: "agentproto-runtime" }),
    )

    const report = await discoverDaemon()
    expect(report.found?.url).toBe("http://127.0.0.1:18790")
    expect(report.found?.token).toBe("serve-tok")
  })

  it("falls through to a live entry when the config-declared port is dead", async () => {
    const deadPid = 2_147_483_646 // unused high pid → isPidAlive false
    await writeConfig({ port: 18790 })
    await writeDaemonRegistryEntry(meta({ port: 18790, pid: deadPid }))
    await tick()
    await writeDaemonRegistryEntry(
      meta({ port: 55190, token: "live-tok", pid: process.pid }),
    )

    const report = await discoverDaemon()
    expect(report.found?.url).toBe("http://127.0.0.1:55190")
    expect(report.found?.token).toBe("live-tok")
    expect(report.stale.map(s => s.pid)).toContain(deadPid)
  })

  it("honors ~/.agentproto/runtime.json when present and live", async () => {
    // A registry entry exists, but the explicit home runtime.json wins.
    await writeConfig({ port: 18790 })
    await writeDaemonRegistryEntry(meta({ port: 18790, token: "registry-tok" }))
    await writeHomeRuntimeJson({ port: 22222, token: "pinned-tok" })

    const report = await discoverDaemon()
    expect(report.found?.url).toBe("http://127.0.0.1:22222")
    expect(report.found?.token).toBe("pinned-tok")
  })

  it("ignores a stale ~/.agentproto/runtime.json (dead PID) and uses the registry", async () => {
    const deadPid = 2_147_483_646
    await writeConfig({ port: 18790 })
    await writeDaemonRegistryEntry(meta({ port: 18790, token: "registry-tok" }))
    await writeHomeRuntimeJson({ port: 22222, pid: deadPid })

    const report = await discoverDaemon()
    expect(report.found?.url).toBe("http://127.0.0.1:18790")
    expect(report.found?.token).toBe("registry-tok")
    expect(report.stale.some(s => s.pid === deadPid)).toBe(true)
  })
})
