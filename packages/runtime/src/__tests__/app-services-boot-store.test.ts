/**
 * Gateway wiring for the app-service owner store (TS-18). The boot
 * re-ensure used to build its own throwaway in-memory store, so it neither
 * saw the owner records the daemon had persisted (leftover children kept
 * their ports) nor wrote the fresh owners back. This file pins the fix
 * behaviourally through the real gateway, an app installed over MCP that
 * declares a `services:` entry, and an injected store the test can seed.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import { readFile, writeFile } from "node:fs/promises"
import matter from "gray-matter"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { defineApp } from "@agentproto/app"
import { defineAgent } from "@agentproto/agent"

import { createGateway, type GatewayHandle } from "../index.js"
import { createAppServiceStore } from "../app-services.js"
import {
  readProcessStartTicks,
  stopAppServiceSupervisor,
} from "../app-service-process.js"
import type { AgentAdapterResolver } from "../http-server.js"

const APP_ID = "@test/boot-store-app"
const SERVICE_NAME = "web"
const LONG_ENTRY = `node -e "setInterval(()=>{},60000)"`

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

async function buildServiceApp(dir: string): Promise<void> {
  await defineApp({
    id: APP_ID,
    name: "Boot Store App",
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker.",
          model: "claude-sonnet-5",
        }),
        body: "You work.",
      },
    ],
  }).emit(dir)
  const appMd = join(dir, ".agentproto", "APP.md")
  const parsed = matter(await readFile(appMd, "utf8"))
  parsed.data.services = [{ name: SERVICE_NAME, entry: LONG_ENTRY }]
  await writeFile(appMd, matter.stringify(parsed.content, parsed.data))
}

function fakeAgentResolver(): AgentAdapterResolver {
  return async (slug: string) =>
    slug === "mastra-agent"
      ? {
          commandPreview: "mock-adapter",
          agentManifestOption: "agent",
          startSession: async () => ({
            sessionId: "adapter_boot_store_test",
            send: async function* () {},
            cancel: async () => {},
            close: async () => {},
          }),
        }
      : null
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text) as Record<string, unknown>
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("gateway boot re-ensure shares the app-service owner store", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []
  const leftoverPids = new Set<number>()

  afterEach(async () => {
    // Stop every service supervisor the gateway may have started (install
    // pass and boot pass alike), then kill the leftover children this test
    // spawned itself.
    await stopAppServiceSupervisor(APP_ID, SERVICE_NAME).catch(() => false)
    for (const pid of leftoverPids) {
      if (isAlive(pid)) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            // already gone
          }
        }
      }
    }
    leftoverPids.clear()
    vi.unstubAllEnvs()
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it("sees a pre-existing owner record (kills the leftover child) and stores the fresh owner", { timeout: 30000 }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-boot-store-ws-"))
    const home = await mkdtemp(join(tmpdir(), "agentproto-boot-store-home-"))
    const appDir = await mkdtemp(join(tmpdir(), "agentproto-boot-store-app-"))
    dirs.push(workspace, home, appDir)
    await buildServiceApp(appDir)

    // A real detached child standing in for a service the PREVIOUS daemon
    // left behind: its own process group, the recorded pid is its pgid.
    const leftover = spawn("node", ["-e", "setInterval(()=>{},1e3)"], {
      detached: true,
      stdio: "ignore",
    })
    if (leftover.pid === undefined) throw new Error("leftover child did not start")
    const leftoverPid = leftover.pid
    leftoverPids.add(leftoverPid)
    leftover.unref()
    const startTicks = readProcessStartTicks(leftoverPid)
    expect(startTicks).toBeDefined()

    const serviceStore = createAppServiceStore({ persist: false })

    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(home, "sessions.json"),
      resolveAgentAdapter: fakeAgentResolver(),
      appServiceStore: serviceStore,
    })
    gateways.push(gateway)

    // Install the app so its `services:` entry is in the gateway's registry.
    const client = new Client({ name: "boot-store-test", version: "0.0.1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
    try {
      const installed = await client.callTool({ name: "app_install", arguments: { dir: appDir } })
      expect((installed as { isError?: boolean }).isError).not.toBe(true)
      parseToolJson(installed)
    } finally {
      await client.close()
    }
    // The install pass writes through the SAME store (design item 2), so it
    // must already hold the install-time owner record.
    const installOwners = serviceStore.listForApp(APP_ID)
    // Whatever the install pass spawned is not the point of this test: stop
    // its supervisor and the owner record is replaced below by the leftover.
    await stopAppServiceSupervisor(APP_ID, SERVICE_NAME)

    serviceStore.upsert({
      appId: APP_ID,
      name: SERVICE_NAME,
      entry: LONG_ENTRY,
      sessionId: "sess_leftover_previous_daemon",
      pid: leftoverPid,
      startTicks: startTicks!,
      startedAt: new Date().toISOString(),
    })

    const result = await gateway.reensureAppServicesOnBoot()
    expect(result).toEqual(expect.objectContaining({ enabled: true, apps: 1, spawned: 1 }))
    expect(result.errors).toEqual([])

    // (a) The seeded record was seen: killOwner signalled the leftover
    // child's process group and it is gone.
    await expect
      .poll(() => isAlive(leftoverPid), { timeout: 5000 })
      .toBe(false)

    // (b) The injected store now holds the NEW owner, not the old record.
    const owners = serviceStore.listForApp(APP_ID)
    expect(owners).toHaveLength(1)
    const owner = owners[0]!
    expect(owner.sessionId).not.toBe("sess_leftover_previous_daemon")
    expect(owner.name).toBe(SERVICE_NAME)
    expect(owner.pid).toBeDefined()
    expect(owner.pid).not.toBe(leftoverPid)
    expect(owner.pid !== undefined && isAlive(owner.pid)).toBe(true)

    // registerAppTools got the injected store too: the install-time owner
    // was written there before this test overwrote it with the leftover.
    expect(installOwners).toHaveLength(1)
    expect(installOwners[0]!.name).toBe(SERVICE_NAME)
  })

  it("resolves `persist` for its store, so the boot pass keeps app-services.json current", { timeout: 30000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "agentproto-boot-store-persist-home-"))
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-boot-store-persist-ws-"))
    const appDir = await mkdtemp(join(tmpdir(), "agentproto-boot-store-persist-app-"))
    dirs.push(home, workspace, appDir)
    vi.stubEnv("HOME", home)
    vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
    await buildServiceApp(appDir)

    // Persistence ON (the daemon case): the store defaults to
    // <home>/.agentproto/app-services.json. No store is injected here, so
    // this exercises the gateway's own resolved-`persist` default.
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persistPath: join(home, "sessions.json"),
      resolveAgentAdapter: fakeAgentResolver(),
    })
    gateways.push(gateway)

    const client = new Client({ name: "boot-store-persist-test", version: "0.0.1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
    try {
      const installed = await client.callTool({ name: "app_install", arguments: { dir: appDir } })
      expect((installed as { isError?: boolean }).isError).not.toBe(true)
    } finally {
      await client.close()
    }

    const storePath = join(home, ".agentproto", "app-services.json")
    const readOwnerPid = async (): Promise<number | undefined> => {
      const parsed = JSON.parse(await readFile(storePath, "utf8")) as {
        owners?: Array<{ appId?: string; name?: string; pid?: number }>
      }
      const owner = (parsed.owners ?? []).find(o => o.appId === APP_ID && o.name === SERVICE_NAME)
      return owner?.pid
    }
    const installPid = await readOwnerPid()
    expect(installPid).toBeDefined()

    await stopAppServiceSupervisor(APP_ID, SERVICE_NAME)
    const result = await gateway.reensureAppServicesOnBoot()
    expect(result).toEqual(expect.objectContaining({ enabled: true, apps: 1, spawned: 1 }))
    expect(result.errors).toEqual([])

    // The boot pass persisted its fresh owner to the SAME file, replacing
    // the stale install-time record. An unresolved `opts.persist` would
    // build an in-memory store and leave the file on the old pid.
    const bootPid = await readOwnerPid()
    expect(bootPid).toBeDefined()
    expect(bootPid).not.toBe(installPid)
    expect(bootPid !== undefined && isAlive(bootPid)).toBe(true)
  })
})
