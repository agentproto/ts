/**
 * Service-owner launcher — end-to-end wiring through `registerAppTools`
 * (frozen `services:` semantics, Pygmalion phase 1b item 2). A real
 * `McpServer` + InMemoryTransport over a real `createSessionsRegistry`, with a
 * fake `AgentAdapterResolver` (mirrors app-tools.test.ts). Two seams are
 * exercised: the REAL default spawn (`spawnAgentSession`, asserted via the
 * registry descriptor: label + keepAlive + restartPolicy) and an injected
 * spawn/kill stub (asserted for pid bookkeeping + uninstall cleanup).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import matter from "gray-matter"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { registerAppTools, reensureInstalledAppServicesOnBoot } from "../app-tools.js"
import { createAppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import { createAppServiceStore, type AppServiceOwner, type SpawnServiceOwner } from "../app-services.js"
import type { AgentAdapterResolver } from "../http-server.js"

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

  it("spawns one owner session per service, keepAlive + restartPolicy, and is idempotent on reinstall", async () => {
    await buildServiceApp(dir, [
      { name: "web", entry: "node server.js", port: 4321 },
      { name: "worker", entry: "node worker.js" },
    ])
    const { client, registry, serviceStore, startSession } = await setup()

    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    expect(startSession).toHaveBeenCalledTimes(2)

    const owners = serviceStore.listForApp(APP_ID)
    expect(owners.map(o => o.name).sort()).toEqual(["web", "worker"])
    const web = owners.find(o => o.name === "web")!
    expect(web.entry).toBe("node server.js")
    expect(web.port).toBe(4321)
    expect(web.sessionId).toMatch(/^sess_/)
    expect(web.startedAt).toBeTruthy()

    const desc = registry.get(web.sessionId)!
    expect(desc.keepAlive).toBe(true)
    expect(desc.label).toBe(`app:${APP_ID}:service:web`)
    expect(desc.restartPolicy?.on).toEqual(["crashed", "error"])
    expect(desc.status).toBe("running")

    // Reinstall over the live owners: no duplicate spawn, same records kept.
    expect(isError(await client.callTool({ name: "app_install", arguments: { dir } }))).toBe(false)
    expect(startSession).toHaveBeenCalledTimes(2)
    expect(serviceStore.listForApp(APP_ID)).toHaveLength(2)
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
})
