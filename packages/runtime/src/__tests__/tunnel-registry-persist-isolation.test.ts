/**
 * TunnelRegistry persistence isolation + shutdown race:
 *
 * 1. A test gateway (`persist: false`) must never touch the real
 *    `~/.agentproto/tunnels.json` — no load, no write — and must not
 *    relaunch (or spawn any provider process for) the user's autostart
 *    tunnels. File lives in a fake HOME so a regression shows up as a
 *    byte change.
 * 2. `shutdown()` landing while a provider's `start()` is still pending
 *    must end with the provider's `stop()` called and the descriptor NOT
 *    left `active` (otherwise the child leaks once the start resolves).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"

import { createGateway, type GatewayHandle } from "../index.js"
import { TunnelRegistry } from "../tunnel-registry.js"
import { TunnelStartAbortedError, type RemoteProvider } from "../remote-providers/types.js"

let fakeHome = ""
let homeTunnelsFile = ""

function cloudflaredNamedConfigs(workspace: string): string[] {
  const dir = join(workspace, ".agentproto")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.startsWith("cloudflared-named-"))
}

function writeHomeTunnelsFile(): string {
  mkdirSync(join(fakeHome, ".agentproto"), { recursive: true })
  const body = {
    savedAt: "2026-01-01T00:00:00.000Z",
    tunnels: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        provider: "cloudflare-named",
        targetHost: "127.0.0.1",
        targetPort: 9999,
        publicUrl: "https://real-user-tunnel.example.com",
        status: "stopped",
        pid: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        name: "real",
        hostname: "real-user-tunnel.example.com",
        tunnelId: "fake-tunnel-id",
        access: "private",
        ttl: "24h",
        autostart: true,
      },
    ],
  }
  writeFileSync(homeTunnelsFile, JSON.stringify(body, null, 2), { mode: 0o600 })
  return readFileSync(homeTunnelsFile, "utf8")
}

describe("tunnel registry persists to workspace when persist:false", () => {
  let realHome: string
  let workspace: string
  let gateway: GatewayHandle | undefined

  beforeAll(async () => {
    realHome = process.env.HOME ?? homedir()
    fakeHome = await mkdtemp(join(tmpdir(), "tunnel-registry-home-"))
    workspace = await mkdtemp(join(tmpdir(), "tunnel-registry-ws-"))
    homeTunnelsFile = join(fakeHome, ".agentproto", "tunnels.json")
    process.env.HOME = fakeHome
  })

  afterAll(async () => {
    process.env.HOME = realHome ?? homedir()
    await gateway?.stop().catch(() => {})
    await rm(fakeHome, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  it("does not read/modify the real HOME tunnels file or spawn a provider", async () => {
    const before = writeHomeTunnelsFile()

    gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(workspace, "sessions.json"),
    })

    // Give a (buggy) restoreOnBoot a chance to run: load the real file,
    // relaunch the autostart tunnel with the tmp workspace (writing a
    // `cloudflared-named-*.yml` config), rewrite the file. With the fix
    // none of this happens.
    await vi.waitFor(
      () => {
        expect(readFileSync(homeTunnelsFile, "utf8")).toBe(before)
        expect(cloudflaredNamedConfigs(workspace)).toEqual([])
      },
      { timeout: 1000 },
    )
    expect(readFileSync(homeTunnelsFile, "utf8")).toBe(before)
  })
})

describe("shutdown during pending provider start", () => {
  const registries: TunnelRegistry[] = []
  const tmpdirs: string[] = []

  afterEach(async () => {
    await Promise.all(registries.splice(0).map(r => r.shutdown().catch(() => {})))
    await Promise.all(tmpdirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
  })

  it("stops the provider once start resolves and leaves the descriptor stopped", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tunnel-registry-shutdown-"))
    tmpdirs.push(tmp)
    const stopCalls: number[] = []
    let releaseStart!: () => void
    const startPending = new Promise<void>(resolve => {
      releaseStart = resolve
    })

    const reg = new (class extends TunnelRegistry {
      protected override async pickProviderForTest(): Promise<RemoteProvider> {
        return {
          id: "mock",
          async start() {
            await startPending
            return { publicUrl: "https://mock.example.com", pid: 42 }
          },
          async stop() {
            stopCalls.push(Date.now())
          },
        }
      }
    })({ persistPath: join(tmp, "tunnels.json"), workspace: tmp })
    registries.push(reg)

    const created = reg.create({
      provider: "quick",
      targetPort: 8081,
      name: "slow-start",
      public: true,
    })
    // Give shutdown() a moment to land while start() is still pending.
    await new Promise(resolve => setTimeout(resolve, 20))
    const shuttingDown = reg.shutdown()

    let desc: Awaited<ReturnType<typeof reg.create>>
    releaseStart()
    await Promise.all([created.then(d => (desc = d)), shuttingDown])
    expect(stopCalls.length).toBeGreaterThan(0)
    expect(desc!.status).toBe("stopped")
  })

  it("settles as stopped (not error) when the provider aborts its own start", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "tunnel-registry-abort-"))
    tmpdirs.push(tmp)
    let stopped = false
    const persistPath = join(tmp, "tunnels.json")
    let releaseStart!: () => void
    const startPending = new Promise<void>(resolve => {
      releaseStart = resolve
    })

    // Mirrors the built-in cloudflared providers: stop() flips a flag, and
    // start() reaps its own child then throws the typed abort.
    const reg = new (class extends TunnelRegistry {
      protected override async pickProviderForTest(): Promise<RemoteProvider> {
        return {
          id: "mock",
          async start() {
            await startPending
            if (stopped) throw new TunnelStartAbortedError()
            return { publicUrl: "https://mock.example.com", pid: 42 }
          },
          async stop() {
            stopped = true
          },
        }
      }
    })({ persistPath, workspace: tmp })
    registries.push(reg)

    const created = reg.create({
      provider: "quick",
      targetPort: 8082,
      name: "aborted-start",
      public: true,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const shuttingDown = reg.shutdown()
    releaseStart()
    const [desc] = await Promise.all([created, shuttingDown])

    expect(desc.status).toBe("stopped")
    expect(desc.lastError).toBeUndefined()
    expect(desc.stoppedAt).toBeDefined()

    // A registry created later from the same persisted file must see the
    // tunnel as `stopped` (autostart-eligible for restoreOnBoot).
    const reloaded = new (class extends TunnelRegistry {
      protected override async pickProviderForTest(): Promise<RemoteProvider> {
        throw new Error("should not be constructed")
      }
    })({ persistPath, workspace: tmp })
    registries.push(reloaded)
    const persisted = reloaded.list().find(t => t.name === "aborted-start")
    expect(persisted).toBeDefined()
    expect(persisted!.status).toBe("stopped")
  })
})

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}
