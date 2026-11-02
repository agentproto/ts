/**
 * Service-owner launcher — end-to-end wiring through `registerAppTools`
 * (frozen `services:` semantics, Pygmalion phase 1b item 2). A real
 * `McpServer` + InMemoryTransport over a real `createSessionsRegistry`, with a
 * fake `AgentAdapterResolver` (mirrors app-tools.test.ts). Two seams are
 * exercised: the REAL default spawn (now the DETERMINISTIC managed process of
 * app-service-process.ts — asserted via the registry descriptor: label +
 * origin + a live `kind:"command"` row, and asserted to engage NO LLM
 * adapter) and an injected spawn/kill stub (asserted for pid bookkeeping +
 * uninstall cleanup).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp } from "@agentproto/app"
import { defineAgent } from "@agentproto/agent"
import { registerAppTools, reensureInstalledAppServicesOnBoot } from "../app-tools.js"
import { createAppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import { readProcessStartTicks } from "../app-service-process.js"
import { createAppServiceStore, type AppServiceOwner, type SpawnServiceOwner } from "../app-services.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AppServiceExposer, AppServiceExposure } from "../app-service-expose.js"

const APP_ID = "@test/service-app"

async function buildServiceApp(dir: string, services: unknown, opts: { id?: string } = {}) {
  const id = opts.id ?? APP_ID
  await defineApp({
    id,
    name: "Service App",
    agents: [
      {
        agent: defineAgent({ schema: "agent/v1", id: "worker", description: "A worker.", model: "claude-sonnet-5" }),
        body: "You work.",
      },
    ],
  }).emit(dir)
  const appMd = join(dir, ".agentproto", "APP.md")
  const parsed = matter(await readFile(appMd, "utf8"))
  parsed.data.services = services
  await writeFile(appMd, matter.stringify(parsed.content, parsed.data))
}

function fakeStartSession() {
  return vi.fn(async (_opts: Record<string, unknown>) => ({
    sessionId: "adapter_service_test",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
}

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

async function setup(opts: {
  spawnServiceOwner?: SpawnServiceOwner
  killServiceOwner?: (owner: AppServiceOwner) => void | Promise<void>
  startSession?: ReturnType<typeof fakeStartSession>
  workspacesConfigPath?: string
  serviceExposer?: AppServiceExposer
} = {}) {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = opts.startSession ?? fakeStartSession()
  const resolveAgentAdapter: AgentAdapterResolver = async (slug: string) =>
    slug === "pi" || slug === "mastra-agent" || slug === "claude-code"
      ? { startSession, commandPreview: "mock-adapter", agentManifestOption: "agent" }
      : null
  const serviceStore = createAppServiceStore({ persist: false })
  const appRegistry = createAppRegistry()
  const server = new McpServer({ name: "app-services-launcher-test", version: "0.0.0" })
  registerAppTools(server, {
    registry,
    appRegistry,
    listRegisteredToolIds: async () => [],
    resolveAgentAdapter,
    waitForSessionTerminal: async () => {},
    serviceStore,
    ...(opts.workspacesConfigPath ? { workspacesConfigPath: opts.workspacesConfigPath } : {}),
    ...(opts.spawnServiceOwner ? { spawnServiceOwner: opts.spawnServiceOwner } : {}),
    ...(opts.killServiceOwner ? { killServiceOwner: opts.killServiceOwner } : {}),
    ...(opts.serviceExposer ? { serviceExposer: opts.serviceExposer } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-services-launcher-client", version: "0.0.0" })
  await client.connect(clientTransport)
  // Same wiring index.ts's `reensureAppServicesOnBoot` gateway method uses —
  // exercised directly against this test's own `appRegistry`/`serviceStore`
  // instead of going through a second MCP tool.
  const reensureServicesOnBoot = () =>
    reensureInstalledAppServicesOnBoot({
      appRegistry,
      serviceStore,
      registry,
      resolveAgentAdapter,
      ...(opts.workspacesConfigPath ? { workspacesConfigPath: opts.workspacesConfigPath } : {}),
      ...(opts.spawnServiceOwner ? { spawnServiceOwner: opts.spawnServiceOwner } : {}),
      ...(opts.killServiceOwner ? { killServiceOwner: opts.killServiceOwner } : {}),
    })
  return { client, registry, serviceStore, startSession, reensureServicesOnBoot }
}

describe("service-owner launcher via app_install", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-services-launcher-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("spawns one managed process per service (no LLM adapter), labels + origin recorded, idempotent on reinstall", async () => {
    const LONG = `node -e "setInterval(()=>{},60000)"`
    await buildServiceApp(dir, [
      { name: "web", entry: LONG, port: 4321 },
      { name: "legacy", entry: LONG },
    ])
    const { client, registry, serviceStore, startSession } = await setup()

    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    // The deterministic spawn engages NO LLM adapter session.
    expect(startSession).not.toHaveBeenCalled()

    const owners = serviceStore.listForApp(APP_ID)
    expect(owners.map(o => o.name).sort()).toEqual(["legacy", "web"])
    const web = owners.find(o => o.name === "web")!
    expect(web.port).toBe(4321)
    expect(web.sessionId).toMatch(/^sess_/)
    expect(web.pid).toBeGreaterThan(0)
    expect(web.startedAt).toBeTruthy()

    const desc = registry.get(web.sessionId)!
    expect(desc.kind).toBe("command")
    expect(desc.pty).toBeUndefined()
    expect(desc.label).toBe(`app:${APP_ID}:service:web`)
    expect(desc.origin).toBe(`app-service:${APP_ID}`)
    expect(desc.status).toBe("running")
    // The process is registered in the session list.
    expect(registry.list()).toContainEqual(expect.objectContaining({ id: web.sessionId }))

    // Reinstall over the live owners: no duplicate spawn, same records kept.
    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    expect(startSession).not.toHaveBeenCalled()
    expect(serviceStore.listForApp(APP_ID)).toHaveLength(2)

    // Cleanup: uninstall kills the recorded process groups so no test leak.
    const uninstalled = parseToolJson(
      await client.callTool({ name: "app_uninstall", arguments: { appId: APP_ID } }),
    )
    expect(uninstalled.services.sort()).toEqual(["legacy", "web"])
    expect(serviceStore.listForApp(APP_ID)).toEqual([])
  })

  it("is a no-op for an app that declares no services", async () => {
    await defineApp({
      id: "@test/plain-app",
      name: "Plain",
      agents: [
        {
          agent: defineAgent({ schema: "agent/v1", id: "worker", description: "w", model: "claude-sonnet-5" }),
          body: "work",
        },
      ],
    }).emit(dir)
    const { client, startSession, serviceStore } = await setup()
    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    expect(startSession).not.toHaveBeenCalled()
    expect(serviceStore.list()).toEqual([])
  })

  it("fails the install on a malformed services block, spawning nothing", async () => {
    await buildServiceApp(dir, [{ name: "Web", entry: "node server.js" }])
    const { client, startSession, serviceStore } = await setup()
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    expect(parseToolJson(res).error).toContain("invalid services declaration")
    expect(startSession).not.toHaveBeenCalled()
    expect(serviceStore.list()).toEqual([])
  })

  it("records a pid from the spawn seam and kills it on uninstall", async () => {
    await buildServiceApp(dir, [{ name: "web", entry: "node server.js", port: 4321 }])
    const spawnServiceOwner = vi.fn(async () => ({
      ok: true as const,
      sessionId: "owner_sess_web",
      pid: 555,
    }))
    const killServiceOwner = vi.fn()
    const { client, serviceStore } = await setup({ spawnServiceOwner, killServiceOwner })

    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    expect(spawnServiceOwner).toHaveBeenCalledTimes(1)
    expect(serviceStore.listForApp(APP_ID)).toEqual([
      {
        appId: APP_ID,
        name: "web",
        entry: "node server.js",
        sessionId: "owner_sess_web",
        pid: 555,
        port: 4321,
        startedAt: expect.any(String),
      },
    ])

    const uninstalled = parseToolJson(
      await client.callTool({ name: "app_uninstall", arguments: { appId: APP_ID } }),
    )
    expect(uninstalled.services).toEqual(["web"])
    expect(killServiceOwner).toHaveBeenCalledTimes(1)
    expect(killServiceOwner).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, name: "web", sessionId: "owner_sess_web", pid: 555 }),
    )
    expect(serviceStore.listForApp(APP_ID)).toEqual([])
  })
})

describe("services[].expose via app_install / app_status / app_uninstall (AIP-53)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-services-expose-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function memoryExposer(fail = false) {
    const tunnels = new Map<string, AppServiceExposure>()
    const removed: string[] = []
    const exposer: AppServiceExposer = {
      async ensure(appId, service) {
        if (fail) return { name: service.name, auth: service.expose.auth ?? "guard", stable: true, state: "error", error: "402 payment required" }
        const key = `app:${appId}:${service.name}`
        const x = tunnels.get(key) ?? {
          name: service.name,
          auth: service.expose.auth ?? "guard",
          stable: true,
          state: "active" as const,
          publicUrl: "https://session-chat.example.test",
          tunnelId: `tun_${tunnels.size + 1}`,
        }
        tunnels.set(key, x)
        return x
      },
      status: (appId, service) => tunnels.get(`app:${appId}:${service.name}`),
      list: appId => [...tunnels.keys()].filter(k => k.startsWith(`app:${appId}:`)).map(k => k.split(":").pop()!),
      async remove(appId, name) {
        removed.push(name)
        tunnels.delete(`app:${appId}:${name}`)
      },
    }
    return { exposer, tunnels, removed }
  }

  const exposed = [
    { name: "miniapp", command: "node", args: ["dist/miniapp.js"], port: 8788, expose: { auth: "service", hostname: "session-chat" } },
  ]

  it("reports the exposure in the install result and app_status, injects the origin, and deletes the tunnel on uninstall", async () => {
    await buildServiceApp(dir, exposed)
    const { exposer, tunnels, removed } = memoryExposer()
    const spawnServiceOwner = vi.fn(async (_input: Parameters<SpawnServiceOwner>[0]) => ({
      ok: true as const,
      sessionId: "owner_sess_miniapp",
    }))
    const { client } = await setup({
      spawnServiceOwner,
      killServiceOwner: vi.fn(),
      serviceExposer: exposer,
      workspacesConfigPath: join(dir, "workspaces.json"),
    })

    const installed = parseToolJson(await client.callTool({ name: "app_install", arguments: { dir } }))
    expect(installed.appId).toBe(APP_ID)
    expect(installed.services.exposures).toEqual([
      {
        name: "miniapp",
        auth: "service",
        stable: true,
        state: "active",
        publicUrl: "https://session-chat.example.test",
        tunnelId: "tun_1",
      },
    ])
    expect(spawnServiceOwner.mock.calls[0]![0].env).toEqual({
      AGENTPROTO_PUBLIC_URL: "https://session-chat.example.test",
    })

    // A reinstall keeps the same tunnel.
    await client.callTool({ name: "app_install", arguments: { dir } })
    expect(tunnels.size).toBe(1)

    const ran = parseToolJson(await client.callTool({ name: "app_run", arguments: { appId: APP_ID } }))
    const status = parseToolJson(await client.callTool({ name: "app_status", arguments: { appRunId: ran.appRunId } }))
    expect(status.services.exposures).toEqual([expect.objectContaining({ name: "miniapp", tunnelId: "tun_1", state: "active" })])
    await client.callTool({ name: "app_stop", arguments: { appRunId: ran.appRunId } })

    expect(isError(await client.callTool({ name: "app_uninstall", arguments: { appId: APP_ID } }))).toBe(false)
    expect(removed).toEqual(["miniapp"])
    expect(tunnels.size).toBe(0)
  })

  it("a failed tunnel never fails the install and the service starts without AGENTPROTO_PUBLIC_URL", async () => {
    await buildServiceApp(dir, exposed)
    const { exposer } = memoryExposer(true)
    const spawnServiceOwner = vi.fn(async (_input: Parameters<SpawnServiceOwner>[0]) => ({
      ok: true as const,
      sessionId: "owner_sess_miniapp",
    }))
    const { client } = await setup({
      spawnServiceOwner,
      serviceExposer: exposer,
      workspacesConfigPath: join(dir, "workspaces.json"),
    })
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(false)
    expect(parseToolJson(res).services.exposures).toEqual([
      expect.objectContaining({ name: "miniapp", state: "error", error: "402 payment required" }),
    ])
    expect(spawnServiceOwner).toHaveBeenCalledTimes(1)
    expect(spawnServiceOwner.mock.calls[0]![0].env).toBeUndefined()
  })

  it("rejects expose without a port at install", async () => {
    await buildServiceApp(dir, [{ name: "miniapp", command: "node", expose: {} }])
    const { client } = await setup({ workspacesConfigPath: join(dir, "workspaces.json") })
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    expect(JSON.stringify(res)).toMatch(/invalid services declaration.*services\[0\]\.expose requires a port/)
  })
})

describe("app-service boot re-ensure (reensureAppServicesOnBoot)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-services-boot-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("force-replaces every recorded owner, even when its session still looks alive", async () => {
    await buildServiceApp(dir, [{ name: "web", entry: "node server.js", port: 4321 }])
    let n = 0
    const spawnServiceOwner = vi.fn(async () => ({
      ok: true as const,
      sessionId: `owner_sess_${++n}`,
      pid: 700 + n,
    }))
    const killServiceOwner = vi.fn()
    const { client, serviceStore, reensureServicesOnBoot } = await setup({
      spawnServiceOwner,
      killServiceOwner,
      workspacesConfigPath: join(dir, "workspaces.json"),
    })

    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    expect(serviceStore.listForApp(APP_ID)[0]?.sessionId).toBe("owner_sess_1")

    const result = await reensureServicesOnBoot()
    expect(result).toEqual({ apps: 1, spawned: 1, errors: [] })
    // The pre-boot owner was killed (never kept) and a fresh one spawned.
    expect(killServiceOwner).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, name: "web", sessionId: "owner_sess_1" }),
    )
    expect(spawnServiceOwner).toHaveBeenCalledTimes(2)
    const after = serviceStore.listForApp(APP_ID)
    expect(after).toHaveLength(1)
    expect(after[0]?.sessionId).toBe("owner_sess_2")
  })

  it("is a no-op for an app that declares no services", async () => {
    await defineApp({
      id: "@test/plain-boot",
      name: "Plain",
      agents: [
        {
          agent: defineAgent({ schema: "agent/v1", id: "worker", description: "w", model: "claude-sonnet-5" }),
          body: "work",
        },
      ],
    }).emit(dir)
    const { client, reensureServicesOnBoot } = await setup({
      workspacesConfigPath: join(dir, "workspaces.json"),
    })
    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    expect(await reensureServicesOnBoot()).toEqual({ apps: 0, spawned: 0, errors: [] })
  })

  // ── identity-gated group kill (audit F-4) ──────────────────────────────────

  it("boot re-ensure does NOT signal a recorded pid whose start ticks mismatch (recycled pid)", async () => {
    // REPRO: the owner record names the pid of an UNRELATED process with a
    // WRONG startTicks stamp — exactly the footprint of a recycled pid. The
    // re-ensure replaces the owner, but must never signal the stranger.
    await buildServiceApp(dir, [{ name: "web", entry: "node server.js", port: 4321 }])
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" })
    const strangerPid = stranger.pid!
    expect(strangerPid).toBeGreaterThan(0)
    const truth = readProcessStartTicks(strangerPid)
    expect(truth).toBeDefined()
    try {
      const spawnServiceOwner = vi.fn(async () => ({
        ok: true as const,
        sessionId: "owner_sess_1",
        pid: strangerPid,
        // A bogus stamp ⇒ identity verdict "recycled" ⇒ skip the signal.
        startTicks: truth! + 123_456,
      }))
      const { client, serviceStore, reensureServicesOnBoot } = await setup({
        spawnServiceOwner,
        workspacesConfigPath: join(dir, "workspaces.json"),
      })
      expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
      const owner = serviceStore.listForApp(APP_ID)[0]
      expect(owner?.pid).toBe(strangerPid)
      const result = await reensureServicesOnBoot()
      expect(result.spawned).toBe(1)
      // The stranger STILL ALIVE — old code would have SIGTERM+SIGKILL'd it.
      expect(() => process.kill(strangerPid, 0)).not.toThrow()
      expect(readProcessStartTicks(strangerPid)).toBe(truth)
      // …and the stale record was replaced anyway.
      expect(serviceStore.listForApp(APP_ID)[0]?.sessionId).toBe("owner_sess_1")
    } finally {
      stranger.kill("SIGKILL")
    }
  })

  it("boot re-ensure DOES kill the recorded pid when its start ticks match", async () => {
    await buildServiceApp(dir, [{ name: "web", entry: "node server.js", port: 4321 }])
    const victim = spawn("sleep", ["30"], { stdio: "ignore" })
    const victimPid = victim.pid!
    const truth = readProcessStartTicks(victimPid)
    expect(truth).toBeDefined()
    try {
      const spawnServiceOwner = vi.fn(async () => ({
        ok: true as const,
        sessionId: "owner_sess_1",
        pid: victimPid,
        startTicks: truth!,
      }))
      const { client, serviceStore, reensureServicesOnBoot } = await setup({
        spawnServiceOwner,
        workspacesConfigPath: join(dir, "workspaces.json"),
      })
      expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
      await reensureServicesOnBoot()
      // Identity proven → the group signal went through.
      await vi.waitFor(() => expect(() => process.kill(victimPid, 0)).toThrow())
    } finally {
      victim.kill("SIGKILL")
    }
  })
})
