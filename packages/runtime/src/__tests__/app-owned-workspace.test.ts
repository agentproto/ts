/**
 * App-owned workspaces: every installed app registers `app-<slug>` in
 * workspaces.json (`ownerApp` set) at install, loses it at uninstall, and its
 * `app_run` sessions land in it instead of "default". `$HOME` is hermetic per
 * test (vitest.setup.ts), so the default `~/.agentproto/workspaces.json` is
 * the real production path under a temp home.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { registerAppTools } from "../app-tools.js"
import { createAppRegistry } from "../app-registry.js"
import { boundaryFromMeta } from "../app-boundary.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { appWorkspaceSlug } from "../app-workspace.js"
import {
  addWorkspace,
  getActiveWorkspace,
  loadWorkspacesConfig,
  removeWorkspace,
  saveWorkspacesConfig,
  type WorkspacesConfig,
} from "../workspaces-config.js"

const APP_ID = "@test/owned-app"
const SLUG = "app-test-owned-app"

type WorkspaceInput = NonNullable<Parameters<typeof defineApp>[0]["workspace"]>

async function buildApp(dir: string, opts: { id?: string; mountPath?: string } = {}) {
  const id = opts.id ?? APP_ID
  const workspace: WorkspaceInput | undefined =
    opts.mountPath === undefined
      ? undefined
      : {
          id: "@acme/home",
          name: "Home",
          owner: { type: "org", id: "org_1", slug: "acme" },
          storage: { inline: { provider: "local-fs", config: { mount_path: opts.mountPath } } },
        }
  await defineApp({
    id,
    name: "Owned App",
    agents: [
      {
        agent: defineAgent({ schema: "agent/v1", id: "worker", description: "A worker.", model: "claude-sonnet-5" }),
        body: "You work.",
      },
    ],
    ...(workspace ? { workspace } : {}),
  }).emit(dir)
}

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true

async function setup(opts: { daemonWorkspace?: string } = {}) {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = vi.fn(async (_o: Record<string, unknown>) => ({
    sessionId: "adapter_owned_ws",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
  // Adapter choice is out of scope here: app_run resolves each agent's adapter
  // from AGENT.md (the fixture's `claude-*` model → `claude-code`), so the mock
  // serves every slug and these tests only exercise workspace placement.
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({ startSession, commandPreview: "mock-adapter" })
  const server = new McpServer({ name: "owned-ws-test", version: "0.0.0" })
  registerAppTools(server, {
    registry,
    appRegistry: createAppRegistry(),
    listRegisteredToolIds: async () => [],
    resolveAgentAdapter,
    waitForSessionTerminal: async () => {},
    ...(opts.daemonWorkspace ? { daemonWorkspace: opts.daemonWorkspace } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "owned-ws-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, registry }
}

describe("workspaces-config: app-owned entries", () => {
  const empty: WorkspacesConfig = { version: 1, workspaces: [] }

  it("an app-owned entry never becomes the implicit active workspace", () => {
    const withApp = addWorkspace(empty, { slug: SLUG, path: "/a", ownerApp: APP_ID })
    expect(withApp.active).toBeUndefined()
    expect(getActiveWorkspace(withApp)).toBeUndefined()
    const withUser = addWorkspace(withApp, { slug: "mine", path: "/m" })
    expect(withUser.active).toBe("mine")
    expect(withUser.workspaces.find(w => w.slug === SLUG)?.ownerApp).toBe(APP_ID)
  })

  it("removing the active workspace hands off to a user workspace, not an app one", () => {
    let c = addWorkspace(empty, { slug: "mine", path: "/m" })
    c = addWorkspace(c, { slug: SLUG, path: "/a", ownerApp: APP_ID })
    expect(removeWorkspace(c, "mine").active).toBeUndefined()
  })
})

describe("app-owned workspace lifecycle", () => {
  let base: string
  beforeEach(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), "app-owned-ws-")))
  })
  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  const install = (client: Client, dir: string) => client.callTool({ name: "app_install", arguments: { dir } })

  it("derives a stable slug from the appId", () => {
    expect(appWorkspaceSlug(APP_ID)).toBe(SLUG)
    expect(appWorkspaceSlug("plain-app")).toBe("app-plain-app")
  })

  it("app_install registers app-<slug> at the app dir, marked app-owned", async () => {
    const appDir = join(base, "app")
    await buildApp(appDir)
    const { client } = await setup()
    expect(isError(await install(client, appDir))).toBe(false)

    const config = await loadWorkspacesConfig()
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces[0]).toMatchObject({ slug: SLUG, path: appDir, ownerApp: APP_ID })
    expect(config.active).toBeUndefined()
  })

  it("uses the WORKSPACE.md-declared home when it is a valid directory", async () => {
    const appDir = join(base, "app")
    const home = join(base, "home")
    await mkdir(home)
    await buildApp(appDir, { mountPath: home })
    const { client } = await setup()
    expect(isError(await install(client, appDir))).toBe(false)
    expect((await loadWorkspacesConfig()).workspaces[0]).toMatchObject({ slug: SLUG, path: home, ownerApp: APP_ID })
  })

  it("falls back to the app dir when the declared home does not exist", async () => {
    const appDir = join(base, "app")
    await buildApp(appDir, { mountPath: join(base, "missing") })
    const { client } = await setup()
    expect(isError(await install(client, appDir))).toBe(false)
    expect((await loadWorkspacesConfig()).workspaces[0]?.path).toBe(appDir)
  })

  it("re-install is idempotent: updates the path, never duplicates", async () => {
    const dirA = join(base, "a")
    const dirB = join(base, "b")
    await buildApp(dirA)
    await buildApp(dirB)
    const { client } = await setup()
    await install(client, dirA)
    await install(client, dirA)
    expect((await loadWorkspacesConfig()).workspaces).toHaveLength(1)

    await install(client, dirB)
    const config = await loadWorkspacesConfig()
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces[0]).toMatchObject({ slug: SLUG, path: dirB, ownerApp: APP_ID })
  })

  it("app_apply with a dir installs and registers the workspace", async () => {
    const appDir = join(base, "app")
    await buildApp(appDir)
    const { client } = await setup()
    const res = await client.callTool({ name: "app_apply", arguments: { appId: APP_ID, dir: appDir } })
    expect(isError(res)).toBe(false)
    expect((await loadWorkspacesConfig()).workspaces.map(w => w.slug)).toEqual([SLUG])
  })

  it("app_uninstall removes only its own workspace", async () => {
    const appDir = join(base, "app")
    const otherDir = join(base, "other")
    await buildApp(appDir)
    await buildApp(otherDir, { id: "@test/other-app" })
    const { client } = await setup()
    await install(client, appDir)
    await install(client, otherDir)
    let config = await loadWorkspacesConfig()
    config = addWorkspace(config, { slug: "mine", path: base })
    await saveWorkspacesConfig(config)

    expect(isError(await client.callTool({ name: "app_uninstall", arguments: { appId: APP_ID } }))).toBe(false)
    expect((await loadWorkspacesConfig()).workspaces.map(w => w.slug).sort()).toEqual(["app-test-other-app", "mine"])
  })

  it("never clobbers or removes a user workspace that squats the app slug", async () => {
    const appDir = join(base, "app")
    await buildApp(appDir)
    const userDir = join(base, "user-dir")
    await mkdir(userDir)
    await saveWorkspacesConfig(addWorkspace({ version: 1, workspaces: [] }, { slug: SLUG, path: userDir }))
    const { client, registry } = await setup()
    expect(isError(await install(client, appDir))).toBe(false)

    let config = await loadWorkspacesConfig()
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces[0]).toMatchObject({ slug: SLUG, path: userDir })
    expect(config.workspaces[0]?.ownerApp).toBeUndefined()

    // app_run must not claim the user's slug either.
    const ran = parseToolJson(await client.callTool({ name: "app_run", arguments: { appId: APP_ID } }))
    expect(registry.get(ran.sessions[0].sessionId)?.workspaceSlug).toBe("default")

    await client.callTool({ name: "app_stop", arguments: { appRunId: ran.appRunId } })
    await client.callTool({ name: "app_uninstall", arguments: { appId: APP_ID } })
    config = await loadWorkspacesConfig()
    expect(config.workspaces.map(w => w.slug)).toEqual([SLUG])
  })

  it("app_run sessions land in the app's workspace", async () => {
    const appDir = join(base, "app")
    await buildApp(appDir)
    const { client, registry } = await setup()
    await install(client, appDir)

    const ran = parseToolJson(await client.callTool({ name: "app_run", arguments: { appId: APP_ID } }))
    const desc = registry.get(ran.sessions[0].sessionId)!
    expect(desc.workspaceSlug).toBe(SLUG)
    expect(desc.cwd).toBe(appDir)
  })

  it("an explicit cwd wins over the app workspace", async () => {
    const appDir = join(base, "app")
    const elsewhere = join(base, "elsewhere")
    await buildApp(appDir)
    await mkdir(elsewhere)
    const { client, registry } = await setup()
    await install(client, appDir)

    const ran = parseToolJson(
      await client.callTool({ name: "app_run", arguments: { appId: APP_ID, cwd: elsewhere } }),
    )
    const desc = registry.get(ran.sessions[0].sessionId)!
    expect(desc.cwd).toBe(elsewhere)
    expect(desc.workspaceSlug).toBe("default")
  })

  it("an explicit cwd inside a user workspace buckets under that workspace", async () => {
    const appDir = join(base, "app")
    const userWs = join(base, "user-ws")
    await buildApp(appDir)
    await mkdir(userWs)
    await saveWorkspacesConfig(addWorkspace({ version: 1, workspaces: [] }, { slug: "mine", path: userWs }))
    const { client, registry } = await setup()
    await install(client, appDir)

    const ran = parseToolJson(await client.callTool({ name: "app_run", arguments: { appId: APP_ID, cwd: userWs } }))
    expect(registry.get(ran.sessions[0].sessionId)?.workspaceSlug).toBe("mine")
  })

  it("app_run backfills the workspace for an app installed before this feature", async () => {
    const appDir = join(base, "app")
    await buildApp(appDir)
    const { client, registry } = await setup()
    await install(client, appDir)
    await saveWorkspacesConfig(removeWorkspace(await loadWorkspacesConfig(), SLUG))
    expect((await loadWorkspacesConfig()).workspaces).toHaveLength(0)

    const ran = parseToolJson(await client.callTool({ name: "app_run", arguments: { appId: APP_ID } }))
    expect(registry.get(ran.sessions[0].sessionId)?.workspaceSlug).toBe(SLUG)
    expect((await loadWorkspacesConfig()).workspaces[0]).toMatchObject({ slug: SLUG, path: appDir, ownerApp: APP_ID })
  })

  it("the app boundary still hides the daemon workspace from app sessions", async () => {
    const appDir = join(base, "app")
    const daemonWorkspace = join(base, "daemon-ws")
    await buildApp(appDir)
    await mkdir(daemonWorkspace)
    await writeFile(join(daemonWorkspace, "CLAUDE.md"), "host instructions")
    const { client, registry } = await setup({ daemonWorkspace })
    await install(client, appDir)

    const ran = parseToolJson(await client.callTool({ name: "app_run", arguments: { appId: APP_ID } }))
    const desc = registry.get(ran.sessions[0].sessionId)!
    expect(desc.workspaceSlug).toBe(SLUG)
    const boundary = boundaryFromMeta(desc.meta)
    expect(boundary?.hidden).toContain(daemonWorkspace)
    expect(boundary?.hidden).not.toContain(appDir)
    expect(boundary?.root).toBe(appDir)
  })
})
