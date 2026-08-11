/**
 * Unit + MCP-transport coverage for the `app_*` verbs (app-tools.ts).
 * Mirrors workflow-mcp-e2e.test.ts's real-McpServer + InMemoryTransport
 * setup and agent-start-mode.test.ts's session-spawn seam (a fake
 * `AgentAdapterResolver` over a real `createSessionsRegistry`) — no heavy
 * mocking of providers-store/workspaces-config/auth needed, same as those.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, type AgentStep } from "@agentproto/workflow-runtime"
import { registerAppTools, resolveAgentRefsForWorkflow, sanitizeOutputBlocks } from "../app-tools.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { registerMcpApps } from "../mcp-apps-adapter.js"
import { makeInstalledAppUiApps, createUiHtmlCache } from "../app-ui-apps.js"

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string; isError?: boolean }> })
    .content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}
function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

async function buildFixtureApp(dir: string, opts: { toolId: string }) {
  const app = defineApp({
    id: "@test/fixture-app",
    name: "Fixture App",
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker agent.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "do-thing" }],
        }),
        body: "You do the thing.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "do-thing",
        name: "Do thing",
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "step1", kind: "tool", tool: opts.toolId }],
      }),
    ],
  })
  await app.emit(dir)
}

function fakeStartSession() {
  return vi.fn(async (_opts: Record<string, unknown>) => ({
    sessionId: "adapter_app_run_test",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
}

async function setup(opts: {
  listRegisteredToolIds?: () => Promise<string[]>
  resolveAgentAdapter?: AgentAdapterResolver | null
  startSession?: ReturnType<typeof fakeStartSession>
  appRegistry?: AppRegistry
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  callImportedTool?: (alias: string, tool: string, args: Record<string, unknown>) => Promise<unknown>
  catalogPath?: string
  waitForSessionTerminal?: (sessionId: string) => Promise<void>
} = {}) {
  const registry = createSessionsRegistry({ persist: false })
  const startSession = opts.startSession ?? fakeStartSession()
  const resolveAgentAdapter: AgentAdapterResolver | undefined =
    opts.resolveAgentAdapter === null
      ? undefined
      : opts.resolveAgentAdapter ??
        (async (slug: string) =>
          slug === "mastra-agent" ? { startSession, commandPreview: "mock-adapter" } : null)
  const listRegisteredToolIds = opts.listRegisteredToolIds ?? (async () => ["known_tool"])
  const appRegistry = opts.appRegistry ?? createAppRegistry()
  // Default sequential waiter: immediately flip the spawned session to a
  // terminal state so the one-at-a-time poll resolves deterministically in
  // tests without real sleeps. Only the `sequence` path consults this.
  const waitForSessionTerminal =
    opts.waitForSessionTerminal ??
    (async (sessionId: string) => {
      const desc = registry.get(sessionId)
      if (desc) (desc as { status: string }).status = "exited"
    })

  const server = new McpServer({ name: "app-tools-test-server", version: "0.0.0" })
  registerAppTools(server, {
    registry,
    listRegisteredToolIds,
    appRegistry,
    waitForSessionTerminal,
    ...(resolveAgentAdapter ? { resolveAgentAdapter } : {}),
    ...(opts.dispatchTool ? { dispatchTool: opts.dispatchTool } : {}),
    ...(opts.callImportedTool ? { callImportedTool: opts.callImportedTool } : {}),
    ...(opts.catalogPath ? { catalogPath: opts.catalogPath } : {}),
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "app-tools-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, registry, startSession, appRegistry }
}

describe("app_* verbs", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("app_install: happy path persists an installed-app record", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(false)
    const record = parseToolJson(res)
    expect(record.appId).toBe("@test/fixture-app")
    expect(record.agents).toEqual([{ id: "worker", path: expect.stringContaining("AGENT.md") }])
    expect(record.workflows).toEqual([{ id: "do-thing", path: expect.stringContaining("WORKFLOW.md") }])
    expect(record.unvalidatedAgentTools).toEqual([])
  })

  it("app_install: a bogus workflow tool id lists ALL missing ids in one error, not one at a time", async () => {
    await buildFixtureApp(dir, { toolId: "totally_bogus_tool_xyz" })
    const { client } = await setup({ listRegisteredToolIds: async () => ["known_tool"] })

    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("totally_bogus_tool_xyz")
  })

  it("app_install: adapter not resolvable fails with an actionable hint", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup({ resolveAgentAdapter: async () => null })

    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("agentproto install mastra-agent")
  })

  it("app_list reflects the install; re-install upserts instead of duplicating", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })
    await client.callTool({ name: "app_install", arguments: { dir } })

    const apps = parseToolJson(await client.callTool({ name: "app_list", arguments: {} }))
    expect(apps).toHaveLength(1)
    expect(apps[0].appId).toBe("@test/fixture-app")
    expect(apps[0].runs).toEqual([])
  })

  it("app_run spawns a session per agent (stubbed spawn), app_status reports it, app_stop kills it", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client, registry, startSession } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })

    const ran = parseToolJson(
      await client.callTool({ name: "app_run", arguments: { appId: "@test/fixture-app" } }),
    )
    expect(ran.appRunId).toMatch(/^apprun_/)
    expect(ran.sessions).toEqual([{ agentId: "worker", sessionId: expect.stringMatching(/^sess_/) }])
    expect(startSession).toHaveBeenCalledTimes(1)
    const spawnOpts = startSession.mock.calls[0]![0]
    expect(spawnOpts.options).toEqual({ agent: expect.stringContaining("AGENT.md") })

    const sessionId = ran.sessions[0].sessionId
    expect(registry.get(sessionId)?.status).toBe("running")

    const status = parseToolJson(
      await client.callTool({ name: "app_status", arguments: { appRunId: ran.appRunId } }),
    )
    expect(status.status).toBe("running")
    expect(status.sessions).toEqual([
      { agentId: "worker", sessionId, descriptor: expect.objectContaining({ id: sessionId }) },
    ])

    const stopped = parseToolJson(
      await client.callTool({ name: "app_stop", arguments: { appRunId: ran.appRunId } }),
    )
    expect(stopped.killed).toEqual([sessionId])
    expect(stopped.status).toBe("stopped")
    expect(registry.get(sessionId)?.status).toBe("killed")
  })

  it("app_install persists ui with an absolute path, plus description/artifacts/dev", async () => {
    const app = defineApp({
      id: "@test/ui-app",
      name: "UI App",
      description: "An app with a ui.",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      ui: {
        html: "<html><body>Panel</body></html>",
        title: "Panel",
        tools: ["read_file"],
        csp: { connectDomains: ["api.example.com"] },
      },
      artifacts: [{ type: "report", description: "A generated report." }],
      dev: { launch: [{ name: "dev", runtimeExecutable: "node", port: 3000 }] },
    })
    await app.emit(dir)

    const { client } = await setup()
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(false)
    const record = parseToolJson(res)

    expect(record.description).toBe("An app with a ui.")
    expect(record.ui.path).toBe(join(dir, ".agentproto", "ui", "index.html"))
    expect(isAbsolute(record.ui.path)).toBe(true)
    expect(record.ui.title).toBe("Panel")
    expect(record.ui.tools).toEqual(["read_file"])
    expect(record.ui.csp).toEqual({ connectDomains: ["api.example.com"] })
    expect(record.artifacts).toEqual([{ type: "report", description: "A generated report." }])
    expect(record.dev).toEqual({ launch: [{ name: "dev", runtimeExecutable: "node", port: 3000 }] })
  })

  it("app_install persists artifact with an absolute path", async () => {
    const artifactHtml = "<html><body><h1>Dashboard</h1></body></html>"
    const artifactSrc = join(dir, "source-artifact.html")
    await writeFile(artifactSrc, artifactHtml, "utf8")

    const app = defineApp({
      id: "@test/artifact-app",
      name: "Artifact App",
      description: "An app with an artifact.",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      artifact: { path: artifactSrc, title: "Dashboard", description: "A dashboard." },
    })
    await app.emit(dir)

    const { client } = await setup()
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(false)
    const record = parseToolJson(res)

    expect(record.artifact.path).toBe(join(dir, ".agentproto", "artifact", "index.html"))
    expect(isAbsolute(record.artifact.path)).toBe(true)
    expect(record.artifact.title).toBe("Dashboard")
    expect(record.artifact.description).toBe("A dashboard.")
  })

  it("app_install persists skill with an absolute path", async () => {
    const skillDir = join(dir, "my-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: A test skill.\n---\n\nBody.", "utf8")
    await writeFile(join(skillDir, "helper.js"), "console.log('hello')", "utf8")

    const app = defineApp({
      id: "@test/skill-app",
      name: "Skill App",
      description: "An app with a skill.",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      skill: { path: skillDir, title: "My Skill", description: "A test skill." },
    })
    await app.emit(dir)

    const { client } = await setup()
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(false)
    const record = parseToolJson(res)

    expect(record.skill.path).toBe(join(dir, ".agentproto", "skill"))
    expect(isAbsolute(record.skill.path)).toBe(true)
    expect(record.skill.title).toBe("My Skill")
    expect(record.skill.description).toBe("A test skill.")
  })

  it("app_install rejects skill with missing SKILL.md", async () => {
    const skillDir = join(dir, "empty-skill")
    await mkdir(skillDir, { recursive: true })

    const app = defineApp({
      id: "@test/bad-skill-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      skill: { path: skillDir },
    })
    await app.emit(dir)

    const { client } = await setup()
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("missing SKILL.md")
  })

  it("app_install rejects skill with invalid SKILL.md frontmatter (no name)", async () => {
    const skillDir = join(dir, "bad-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: No name.\n---\n\nBody.", "utf8")

    const app = defineApp({
      id: "@test/bad-skill-app-2",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      skill: { path: skillDir },
    })
    await app.emit(dir)

    const { client } = await setup()
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("name")
  })

  it("app_install rejects skill with invalid SKILL.md frontmatter (no description)", async () => {
    const skillDir = join(dir, "bad-skill-2")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: no-desc\n---\n\nBody.", "utf8")

    const app = defineApp({
      id: "@test/bad-skill-app-3",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      skill: { path: skillDir },
    })
    await app.emit(dir)

    const { client } = await setup()
    const res = await client.callTool({ name: "app_install", arguments: { dir } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("description")
  })

  it("app_skill_get returns the skill files for an installed app", async () => {
    const skillDir = join(dir, "get-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: test-skill\ndescription: A test.\n---\n\nBody.", "utf8")
    await writeFile(join(skillDir, "helper.js"), "console.log('hello')", "utf8")

    const app = defineApp({
      id: "@test/skill-get-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      skill: { path: skillDir, title: "Test Skill", description: "A test." },
    })
    await app.emit(dir)

    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const res = await client.callTool({ name: "app_skill_get", arguments: { appId: "@test/skill-get-app" } })
    expect(isError(res)).toBe(false)
    const body = parseToolJson(res)
    expect(body.appId).toBe("@test/skill-get-app")
    expect(body.name).toBe("test-skill")
    expect(body.description).toBe("A test.")
    expect(body.files).toEqual(
      expect.arrayContaining([
        { path: "SKILL.md", content: expect.stringContaining("name: test-skill") },
        { path: "helper.js", content: "console.log('hello')" },
      ]),
    )
  })

  it("app_skill_get reads files at call time, not from cache", async () => {
    const skillDir = join(dir, "live-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: live-skill\ndescription: V1.\n---\n\nBody.", "utf8")
    await writeFile(join(skillDir, "data.txt"), "v1", "utf8")

    const app = defineApp({
      id: "@test/skill-live-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      skill: { path: skillDir },
    })
    await app.emit(dir)

    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const first = parseToolJson(
      await client.callTool({ name: "app_skill_get", arguments: { appId: "@test/skill-live-app" } }),
    )
    expect(first.files.find((f: any) => f.path === "data.txt").content).toBe("v1")

    await writeFile(join(dir, ".agentproto", "skill", "data.txt"), "v2", "utf8")

    const second = parseToolJson(
      await client.callTool({ name: "app_skill_get", arguments: { appId: "@test/skill-live-app" } }),
    )
    expect(second.files.find((f: any) => f.path === "data.txt").content).toBe("v2")
  })

  it("app_skill_get errors for an app with no skill", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const res = await client.callTool({ name: "app_skill_get", arguments: { appId: "@test/fixture-app" } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("has no skill")
  })

  it("app_skill_get errors for an unknown appId", async () => {
    const { client } = await setup()
    const res = await client.callTool({ name: "app_skill_get", arguments: { appId: "@test/does-not-exist" } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
  })

  it("app_run rejects an unknown agent id", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const res = await client.callTool({
      name: "app_run",
      arguments: { appId: "@test/fixture-app", agents: ["nope"] },
    })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("nope")
  })

  it("app_artifact_get returns the artifact html for an installed app", async () => {
    const artifactHtml = "<html><body><h1>Dashboard</h1></body></html>"
    const artifactSrc = join(dir, "source-artifact.html")
    await writeFile(artifactSrc, artifactHtml, "utf8")

    const app = defineApp({
      id: "@test/artifact-get-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      artifact: { path: artifactSrc, title: "Dashboard", description: "A dashboard." },
    })
    await app.emit(dir)

    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const res = await client.callTool({ name: "app_artifact_get", arguments: { appId: "@test/artifact-get-app" } })
    expect(isError(res)).toBe(false)
    const body = parseToolJson(res)
    expect(body.appId).toBe("@test/artifact-get-app")
    expect(body.title).toBe("Dashboard")
    expect(body.description).toBe("A dashboard.")
    expect(body.html).toBe(artifactHtml)
  })

  it("app_artifact_get reads the file at call time, not from cache", async () => {
    const artifactSrc = join(dir, "source-artifact.html")
    await writeFile(artifactSrc, "<html>v1</html>", "utf8")

    const app = defineApp({
      id: "@test/artifact-live-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      artifact: { path: artifactSrc },
    })
    await app.emit(dir)

    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const first = parseToolJson(
      await client.callTool({ name: "app_artifact_get", arguments: { appId: "@test/artifact-live-app" } }),
    )
    expect(first.html).toBe("<html>v1</html>")

    await writeFile(join(dir, ".agentproto", "artifact", "index.html"), "<html>v2</html>", "utf8")

    const second = parseToolJson(
      await client.callTool({ name: "app_artifact_get", arguments: { appId: "@test/artifact-live-app" } }),
    )
    expect(second.html).toBe("<html>v2</html>")
  })

  it("app_artifact_get errors for an app with no artifact", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const res = await client.callTool({ name: "app_artifact_get", arguments: { appId: "@test/fixture-app" } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("has no artifact")
  })

  it("app_artifact_get errors for an unknown appId", async () => {
    const { client } = await setup()
    const res = await client.callTool({ name: "app_artifact_get", arguments: { appId: "@test/does-not-exist" } })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("no installed app")
  })
})

describe("app_run runner pass-through + truthful terminal state (agentproto/ts A–E)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-runner-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A fixture app bundling two agents so the sequential scout→tailor path
   *  has two distinct targets to order. */
  async function buildTwoAgentApp(dir: string) {
    const app = defineApp({
      id: "@test/seq-app",
      name: "Seq App",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "job-scout",
            description: "Scout agent.",
            model: "claude-sonnet-5",
          }),
          body: "You scout.",
        },
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "job-tailor",
            description: "Tailor agent.",
            model: "claude-sonnet-5",
          }),
          body: "You tailor.",
        },
      ],
    })
    await app.emit(dir)
  }

  it("app_run accepts harness/model and they flow to the recorded run + spawn", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const startSession = fakeStartSession()
    // Resolve the canonical harness as an adapter too, so a harness-only call
    // still spawns successfully (the adapter slot defaults to the harness).
    const resolveAgentAdapter: AgentAdapterResolver = async slug =>
      slug === "mastra-agent" || slug === "harness-x" ? { startSession, commandPreview: "mock-adapter" } : null
    const { client, appRegistry, registry } = await setup({ resolveAgentAdapter, startSession })
    await client.callTool({ name: "app_install", arguments: { dir } })

    const ran = parseToolJson(
      await client.callTool({
        name: "app_run",
        arguments: { appId: "@test/fixture-app", harness: "harness-x", model: "claude-sonnet-5" },
      }),
    )
    expect(ran.adapter).toBe("harness-x") // harness absent adapter → adapter=harness
    expect(ran.harness).toBe("harness-x")
    expect(ran.model).toBe("claude-sonnet-5")

    const run = appRegistry.getRun(ran.appRunId)!
    expect(run.adapter).toBe("harness-x")
    expect(run.harness).toBe("harness-x")
    expect(run.model).toBe("claude-sonnet-5")

    // The args reached the actual spawn — the session descriptor carries the
    // adapter/ harness the runner resolved and the model it was told to use.
    expect(startSession).toHaveBeenCalledTimes(1)
    const desc = registry.get(ran.sessions[0].sessionId)!
    expect(desc.adapterSlug).toBe("harness-x")
    expect(desc.harness).toBe("harness-x")
    expect(desc.model).toBe("claude-sonnet-5")
  })

  it("app_run surfaces a bare adapter as both adapter and harness", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const startSession = fakeStartSession()
    // Resolve the default adapter (required by app_install's validate step)
    // AND the custom slug under test.
    const resolveAgentAdapter: AgentAdapterResolver = async slug =>
      slug === "mastra-agent" || slug === "adapter-y"
        ? { startSession, commandPreview: "mock-adapter" }
        : null
    const { client } = await setup({ resolveAgentAdapter, startSession })
    await client.callTool({ name: "app_install", arguments: { dir } })

    const ran = parseToolJson(
      await client.callTool({
        name: "app_run",
        arguments: { appId: "@test/fixture-app", adapter: "adapter-y" },
      }),
    )
    expect(ran.adapter).toBe("adapter-y")
    expect(ran.harness).toBe("adapter-y")
  })

  it("app_status reconciles a concurrent run whose sessions are all terminal into ended + endedAt", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client, registry } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })
    const ran = parseToolJson(
      await client.callTool({ name: "app_run", arguments: { appId: "@test/fixture-app" } }),
    )

    let status = parseToolJson(
      await client.callTool({ name: "app_status", arguments: { appRunId: ran.appRunId } }),
    )
    expect(status.status).toBe("running")
    expect(status.endedAt).toBeUndefined()

    // Flip the underlying session descriptor to a terminal status — the stored
    // run status stays "running" (a concurrent run is only ever flipped by
    // app_stop), but app_status must now reconcile it to a truthful `ended`.
    const desc = registry.get(ran.sessions[0].sessionId)!
    ;(desc as { status: string }).status = "exited"

    status = parseToolJson(
      await client.callTool({ name: "app_status", arguments: { appRunId: ran.appRunId } }),
    )
    expect(status.status).toBe("ended")
    expect(status.endedAt).toBeTruthy()
  })

  it("app_run with sequence spawns agents in order and reports ended once both are terminal", async () => {
    await buildTwoAgentApp(dir)
    const startSession = fakeStartSession()
    const resolveAgentAdapter: AgentAdapterResolver = async slug =>
      slug === "mastra-agent" || slug === "harness-h"
        ? { startSession, commandPreview: "mock-adapter" }
        : null
    const { client, appRegistry, registry } = await setup({ resolveAgentAdapter, startSession })
    await client.callTool({ name: "app_install", arguments: { dir } })

    const ran = parseToolJson(
      await client.callTool({
        name: "app_run",
        arguments: {
          appId: "@test/seq-app",
          sequence: ["job-scout", "job-tailor"],
          harness: "harness-h",
          model: "claude-sonnet-5",
        },
      }),
    )
    expect(ran.status).toBe("ended")
    expect(ran.endedAt).toBeTruthy()
    expect(ran.sessions.map((s: any) => s.agentId)).toEqual(["job-scout", "job-tailor"])
    // One spawn per agent, in sequence order (run.sessions is built strictly
    // inside the sequence loop), each behind harness-h + the model.
    expect(startSession).toHaveBeenCalledTimes(2)
    for (const s of ran.sessions) {
      const desc = registry.get(s.sessionId)!
      expect(desc.adapterSlug).toBe("harness-h")
      expect(desc.harness).toBe("harness-h")
      expect(desc.model).toBe("claude-sonnet-5")
    }

    const run = appRegistry.getRun(ran.appRunId)!
    expect(run.status).toBe("ended")
    expect(run.adapter).toBe("harness-h")
    expect(run.harness).toBe("harness-h")
    expect(run.model).toBe("claude-sonnet-5")
  })

  it("empty text blocks don't break sequential completion (sanitized, not an error)", async () => {
    await buildTwoAgentApp(dir)
    const { client, appRegistry } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const ran = parseToolJson(
      await client.callTool({
        name: "app_run",
        arguments: { appId: "@test/seq-app", sequence: ["job-scout", "job-tailor"] },
      }),
    )
    // A session whose terminal output is blank still completes; the run lands
    // on a truthful terminal `ended` rather than surfacing a blank block.
    expect(ran.status).toBe("ended")
    expect(appRegistry.getRun(ran.appRunId)!.status).toBe("ended")

    // Unit-level guard: blank/whitespace text blocks are dropped; real text
    // and non-text blocks survive.
    expect(
      sanitizeOutputBlocks([
        { type: "text", text: "" },
        { type: "text", text: "   " },
        { type: "text", text: "real output" },
        { type: "image", text: "not text" },
      ]),
    ).toEqual([
      { type: "text", text: "real output" },
      { type: "image", text: "not text" },
    ])
  })
})

describe("declarative agent-step round-trip (WP-B4)", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-agent-step-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("defineApp → emit → app_install → loadWorkflowHandle → compileWorkflow resolves agent.ref to the app's emitted AGENT.md", async () => {
    const app = defineApp({
      id: "@test/agent-step-app",
      name: "Agent Step App",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
            workflows: [{ ref: "do-thing" }],
          }),
          body: "You do the thing.",
        },
      ],
      workflows: [
        defineWorkflow({
          id: "do-thing",
          name: "Do thing",
          description: "Does a thing, declaratively, via an agent step.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [
            {
              id: "step1",
              kind: "agent",
              agent: { ref: "worker" },
              prompt: "Do the thing.",
            },
          ],
        }),
      ],
    })
    await app.emit(dir)

    const { client, appRegistry } = await setup()
    const installed = parseToolJson(
      await client.callTool({ name: "app_install", arguments: { dir } }),
    )
    expect(installed.appId).toBe("@test/agent-step-app")

    const workflowPath = installed.workflows[0].path as string
    const handle = await loadWorkflowHandle(workflowPath)
    expect(handle.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["step1:agent"])

    const compiled = compileWorkflow(handle, {
      tools: {},
      candidates: [],
      agentRefs: resolveAgentRefsForWorkflow(appRegistry, handle.id),
    })
    const step = compiled.steps[0] as AgentStep
    expect(step.kind).toBe("agent")
    expect(step.adapter).toBe("mastra-agent")
    expect(step.options).toEqual({ agent: installed.agents[0].path })
    expect(step.prompt({ input: undefined, item: undefined, index: undefined, steps: {} })).toBe(
      "Do the thing.",
    )
  })

  it("compiling a bundled workflow's agent-step against a DIFFERENT app's registry fails naming the ref", async () => {
    const app = defineApp({
      id: "@test/agent-step-app-2",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
            workflows: [{ ref: "do-thing-2" }],
          }),
          body: "You do the thing.",
        },
      ],
      workflows: [
        defineWorkflow({
          id: "do-thing-2",
          name: "Do thing",
          description: "Does a thing.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [
            { id: "step1", kind: "agent", agent: { ref: "worker" }, prompt: "Do the thing." },
          ],
        }),
      ],
    })
    await app.emit(dir)

    // No app_install call — the shared appRegistry stays empty, so
    // `resolveAgentRefsForWorkflow` finds no bundling app for this workflow id.
    const { appRegistry } = await setup()
    const handle = await loadWorkflowHandle(join(dir, ".agentproto", "workflows", "do-thing-2", "WORKFLOW.md"))
    expect(() =>
      compileWorkflow(handle, {
        tools: {},
        candidates: [],
        agentRefs: resolveAgentRefsForWorkflow(appRegistry, handle.id),
      }),
    ).toThrow(/unknown agent ref 'worker'.*not running in an app context/)
  })
})

describe("app_apply/app_unapply/app_list_applied verbs", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-apply-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("app_apply: happy path applies an app to a scope", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })
    const applied = parseToolJson(
      await client.callTool({
        name: "app_apply",
        arguments: { appId: "@test/fixture-app", scopeId: "guild-123" },
      }),
    )

    expect(applied.scopeId).toBe("guild-123")
    expect(applied.appId).toBe("@test/fixture-app")
    expect(applied.appliedAt).toBeTruthy()
    expect(applied.agents).toHaveLength(1)
    expect(applied.workflows).toHaveLength(1)
  })

  it("app_apply: defaults scopeId to 'root'", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })
    const applied = parseToolJson(
      await client.callTool({ name: "app_apply", arguments: { appId: "@test/fixture-app" } }),
    )

    expect(applied.scopeId).toBe("root")
  })

  it("app_apply: installs if dir provided and app not installed", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    const applied = parseToolJson(
      await client.callTool({
        name: "app_apply",
        arguments: { appId: "@test/fixture-app", dir },
      }),
    )

    expect(applied.scopeId).toBe("root")
    expect(applied.appId).toBe("@test/fixture-app")
  })

  it("app_apply: validates requires dependencies", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "app-tools-base-"))
    const depDir = await mkdtemp(join(tmpdir(), "app-tools-dep-"))
    try {
      const baseApp = defineApp({
        id: "@test/base-app",
        agents: [
          {
            agent: defineAgent({
              schema: "agent/v1",
              id: "base",
              description: "Base agent.",
              model: "claude-sonnet-5",
              workflows: [{ ref: "base-wf" }],
            }),
            body: "Base.",
          },
        ],
        workflows: [
          defineWorkflow({
            id: "base-wf",
            name: "Base",
            description: "Base.",
            version: "0.1.0",
            inputs: {},
            outputs: {},
            steps: [{ id: "step1", kind: "tool", tool: "known_tool" }],
          }),
        ],
      })
      await baseApp.emit(baseDir)

      const depApp = defineApp({
        id: "@test/dep-app",
        requires: ["@test/base-app"],
        agents: [
          {
            agent: defineAgent({
              schema: "agent/v1",
              id: "dep",
              description: "Dependent agent.",
              model: "claude-sonnet-5",
              workflows: [{ ref: "dep-wf" }],
            }),
            body: "Dep.",
          },
        ],
        workflows: [
          defineWorkflow({
            id: "dep-wf",
            name: "Dep",
            description: "Dep.",
            version: "0.1.0",
            inputs: {},
            outputs: {},
            steps: [{ id: "step1", kind: "tool", tool: "known_tool" }],
          }),
        ],
      })
      await depApp.emit(depDir)

      const { client } = await setup()
      await client.callTool({ name: "app_install", arguments: { dir: baseDir } })
      await client.callTool({ name: "app_install", arguments: { dir: depDir } })

      const missingDep = await client.callTool({
        name: "app_apply",
        arguments: { appId: "@test/dep-app", scopeId: "guild-123" },
      })
      expect(isError(missingDep)).toBe(true)
      const errBody = parseToolJson(missingDep)
      expect(errBody.error).toContain("@test/base-app")

      await client.callTool({
        name: "app_apply",
        arguments: { appId: "@test/base-app", scopeId: "guild-123" },
      })

      const withDep = parseToolJson(
        await client.callTool({
          name: "app_apply",
          arguments: { appId: "@test/dep-app", scopeId: "guild-123" },
        }),
      )
      expect(withDep.appId).toBe("@test/dep-app")
    } finally {
      await rm(baseDir, { recursive: true, force: true })
      await rm(depDir, { recursive: true, force: true })
    }
  })

  it("app_list_applied: lists mounts for a scope", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })
    await client.callTool({
      name: "app_apply",
      arguments: { appId: "@test/fixture-app", scopeId: "guild-123" },
    })
    await client.callTool({
      name: "app_apply",
      arguments: { appId: "@test/fixture-app", scopeId: "guild-456" },
    })

    const guild123 = parseToolJson(
      await client.callTool({ name: "app_list_applied", arguments: { scopeId: "guild-123" } }),
    )
    expect(guild123).toHaveLength(1)
    expect(guild123[0].scopeId).toBe("guild-123")
    expect(guild123[0].appId).toBe("@test/fixture-app")

    const all = parseToolJson(await client.callTool({ name: "app_list_applied", arguments: {} }))
    expect(all).toHaveLength(2)
  })

  it("app_unapply: removes a mount", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })
    await client.callTool({
      name: "app_apply",
      arguments: { appId: "@test/fixture-app", scopeId: "guild-123" },
    })

    const removed = parseToolJson(
      await client.callTool({
        name: "app_unapply",
        arguments: { appId: "@test/fixture-app", scopeId: "guild-123" },
      }),
    )
    expect(removed.scopeId).toBe("guild-123")
    expect(removed.appId).toBe("@test/fixture-app")

    const afterRemoval = parseToolJson(
      await client.callTool({ name: "app_list_applied", arguments: { scopeId: "guild-123" } }),
    )
    expect(afterRemoval).toHaveLength(0)
  })

  it("app_unapply: refuses if another app requires it", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "app-tools-base-unapply-"))
    const depDir = await mkdtemp(join(tmpdir(), "app-tools-dep-unapply-"))
    try {
      const baseApp = defineApp({
        id: "@test/base-app-2",
        agents: [
          {
            agent: defineAgent({
              schema: "agent/v1",
              id: "base",
              description: "Base agent.",
              model: "claude-sonnet-5",
              workflows: [{ ref: "base-wf" }],
            }),
            body: "Base.",
          },
        ],
        workflows: [
          defineWorkflow({
            id: "base-wf",
            name: "Base",
            description: "Base.",
            version: "0.1.0",
            inputs: {},
            outputs: {},
            steps: [{ id: "step1", kind: "tool", tool: "known_tool" }],
          }),
        ],
      })
      await baseApp.emit(baseDir)

      const depApp = defineApp({
        id: "@test/dep-app-2",
        requires: ["@test/base-app-2"],
        agents: [
          {
            agent: defineAgent({
              schema: "agent/v1",
              id: "dep",
              description: "Dependent agent.",
              model: "claude-sonnet-5",
              workflows: [{ ref: "dep-wf" }],
            }),
            body: "Dep.",
          },
        ],
        workflows: [
          defineWorkflow({
            id: "dep-wf",
            name: "Dep",
            description: "Dep.",
            version: "0.1.0",
            inputs: {},
            outputs: {},
            steps: [{ id: "step1", kind: "tool", tool: "known_tool" }],
          }),
        ],
      })
      await depApp.emit(depDir)

      const { client } = await setup()
      await client.callTool({ name: "app_install", arguments: { dir: baseDir } })
      await client.callTool({ name: "app_install", arguments: { dir: depDir } })
      await client.callTool({
        name: "app_apply",
        arguments: { appId: "@test/base-app-2", scopeId: "guild-123" },
      })
      await client.callTool({
        name: "app_apply",
        arguments: { appId: "@test/dep-app-2", scopeId: "guild-123" },
      })

      const refused = await client.callTool({
        name: "app_unapply",
        arguments: { appId: "@test/base-app-2", scopeId: "guild-123" },
      })
      expect(isError(refused)).toBe(true)
      const errBody = parseToolJson(refused)
      expect(errBody.error).toContain("@test/dep-app-2")
      expect(errBody.error).toContain("require")
    } finally {
      await rm(baseDir, { recursive: true, force: true })
      await rm(depDir, { recursive: true, force: true })
    }
  })

  it("app_run: refuses if scopeId provided but app not applied to that scope", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()

    await client.callTool({ name: "app_install", arguments: { dir } })

    const refused = await client.callTool({
      name: "app_run",
      arguments: { appId: "@test/fixture-app", scopeId: "guild-123" },
    })
    expect(isError(refused)).toBe(true)
    const errBody = parseToolJson(refused)
    expect(errBody.error).toContain("not applied to scope")
  })
})

describe("app_tool_call", () => {
  it("dispatches an allowlisted tool through dispatchTool", async () => {
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: "@test/tool-app",
      dir: "/tmp/fake-tool-app",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: "/tmp/fake-tool-app/index.html", tools: ["known_tool"] },
    })
    const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }))
    const { client } = await setup({ appRegistry, dispatchTool })

    const res = parseToolJson(
      await client.callTool({
        name: "app_tool_call",
        arguments: { appId: "@test/tool-app", tool: "known_tool", args: { x: 1 } },
      }),
    )
    expect(res).toEqual({ name: "known_tool", args: { x: 1 } })
    expect(dispatchTool).toHaveBeenCalledWith("known_tool", { x: 1 })
  })

  it("dispatches an imported:<alias>/<toolName> id through callImportedTool", async () => {
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: "@test/imported-tool-app",
      dir: "/tmp/fake-imported-app",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: "/tmp/fake-imported-app/index.html", tools: ["imported:github/list_repos"] },
    })
    const callImportedTool = vi.fn(
      async (alias: string, tool: string, args: Record<string, unknown>) => ({ alias, tool, args }),
    )
    const { client } = await setup({ appRegistry, callImportedTool })

    const res = parseToolJson(
      await client.callTool({
        name: "app_tool_call",
        arguments: {
          appId: "@test/imported-tool-app",
          tool: "imported:github/list_repos",
          args: { q: "x" },
        },
      }),
    )
    expect(res).toEqual({ alias: "github", tool: "list_repos", args: { q: "x" } })
    expect(callImportedTool).toHaveBeenCalledWith("github", "list_repos", { q: "x" })
  })

  it("rejects a tool that is not in the app's ui.tools allowlist", async () => {
    const appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: "@test/allowlist-app",
      dir: "/tmp/fake-allowlist-app",
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: "/tmp/fake-allowlist-app/index.html", tools: ["known_tool"] },
    })
    const dispatchTool = vi.fn(async () => ({}))
    const { client } = await setup({ appRegistry, dispatchTool })

    const res = await client.callTool({
      name: "app_tool_call",
      arguments: { appId: "@test/allowlist-app", tool: "other_tool" },
    })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("other_tool")
    expect(body.error).toContain("known_tool")
    expect(dispatchTool).not.toHaveBeenCalled()
  })

  it("rejects a call for an app that is not installed or has no UI", async () => {
    const { client } = await setup()
    const res = await client.callTool({
      name: "app_tool_call",
      arguments: { appId: "@test/does-not-exist", tool: "known_tool" },
    })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("not installed")
  })
})

describe("app_uninstall", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-uninstall-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("removes an installed app's record", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const res = await client.callTool({
      name: "app_uninstall",
      arguments: { appId: "@test/fixture-app" },
    })
    expect(isError(res)).toBe(false)

    const apps = parseToolJson(await client.callTool({ name: "app_list", arguments: {} }))
    expect(apps).toHaveLength(0)
  })

  it("errors for an unknown appId", async () => {
    const { client } = await setup()
    const res = await client.callTool({
      name: "app_uninstall",
      arguments: { appId: "@test/does-not-exist" },
    })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("no installed app")
  })

  it("refuses when the app is applied to a scope", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })
    await client.callTool({
      name: "app_apply",
      arguments: { appId: "@test/fixture-app", scopeId: "guild-123" },
    })

    const res = await client.callTool({
      name: "app_uninstall",
      arguments: { appId: "@test/fixture-app" },
    })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("unapply")
  })

  it("refuses when the app has a running app_run", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })
    await client.callTool({ name: "app_run", arguments: { appId: "@test/fixture-app" } })

    const res = await client.callTool({
      name: "app_uninstall",
      arguments: { appId: "@test/fixture-app" },
    })
    expect(isError(res)).toBe(true)
    const body = parseToolJson(res)
    expect(body.error).toContain("stop app runs")
  })
})

describe("app_catalog", () => {
  let dir: string
  let catalogDir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-catalog-test-"))
    catalogDir = await mkdtemp(join(tmpdir(), "app-tools-catalog-file-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(catalogDir, { recursive: true, force: true })
  })

  it("merges catalog file entries with installed-app status", async () => {
    const catalogPath = join(catalogDir, "app-catalog.json")
    await writeFile(
      catalogPath,
      JSON.stringify({
        apps: [
          { appId: "@test/fixture-app", name: "Fixture (catalog)", dir: "/catalog/fixture" },
          { appId: "@test/not-installed", name: "Not Installed", dir: "/catalog/other" },
        ],
      }),
      "utf8",
    )

    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup({ catalogPath })
    await client.callTool({ name: "app_install", arguments: { dir } })

    const entries = parseToolJson(await client.callTool({ name: "app_catalog", arguments: {} }))
    expect(entries).toHaveLength(2)

    const fixture = entries.find((e: any) => e.appId === "@test/fixture-app")
    expect(fixture.installed).toBe(true)
    expect(fixture.hasUi).toBe(false)
    expect(fixture.hasArtifact).toBe(false)

    const notInstalled = entries.find((e: any) => e.appId === "@test/not-installed")
    expect(notInstalled.installed).toBe(false)
    expect(notInstalled.hasUi).toBe(false)
    expect(notInstalled.hasArtifact).toBe(false)
  })

  it("tolerates a missing catalog file, still lists installed apps", async () => {
    await buildFixtureApp(dir, { toolId: "known_tool" })
    const { client } = await setup({ catalogPath: join(catalogDir, "does-not-exist.json") })
    await client.callTool({ name: "app_install", arguments: { dir } })

    const entries = parseToolJson(await client.callTool({ name: "app_catalog", arguments: {} }))
    expect(entries).toHaveLength(1)
    expect(entries[0].appId).toBe("@test/fixture-app")
    expect(entries[0].installed).toBe(true)
  })

  it("returns an empty list when there's no catalog file and nothing installed", async () => {
    const { client } = await setup({ catalogPath: join(catalogDir, "does-not-exist.json") })
    const entries = parseToolJson(await client.callTool({ name: "app_catalog", arguments: {} }))
    expect(entries).toEqual([])
  })

  it("reports hasArtifact=true for an installed app with an artifact", async () => {
    const artifactHtml = "<html><body>Artifact</body></html>"
    const artifactSrc = join(dir, "source-artifact.html")
    await writeFile(artifactSrc, artifactHtml, "utf8")

    const app = defineApp({
      id: "@test/artifact-catalog-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      artifact: { path: artifactSrc, title: "Dashboard" },
    })
    await app.emit(dir)

    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const entries = parseToolJson(await client.callTool({ name: "app_catalog", arguments: {} }))
    const entry = entries.find((e: any) => e.appId === "@test/artifact-catalog-app")
    expect(entry.installed).toBe(true)
    expect(entry.hasArtifact).toBe(true)
  })

  it("reports hasSkill=true for an installed app with a skill", async () => {
    const skillDir = join(dir, "catalog-skill")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: catalog-skill\ndescription: A test skill.\n---\n\nBody.", "utf8")

    const app = defineApp({
      id: "@test/skill-catalog-app",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      skill: { path: skillDir },
    })
    await app.emit(dir)

    const { client } = await setup()
    await client.callTool({ name: "app_install", arguments: { dir } })

    const entries = parseToolJson(await client.callTool({ name: "app_catalog", arguments: {} }))
    const entry = entries.find((e: any) => e.appId === "@test/skill-catalog-app")
    expect(entry.installed).toBe(true)
    expect(entry.hasSkill).toBe(true)
  })
})

describe("installed-app UI panels — tools/list integration", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-tools-ui-toolslist-test-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("emit ui app → install → registering its AgnoMcpApp surfaces app_ui_<slug> in tools/list", async () => {
    const app = defineApp({
      id: "@test/ui-toolslist-app",
      name: "UI Toolslist App",
      agents: [
        {
          agent: defineAgent({
            schema: "agent/v1",
            id: "worker",
            description: "A worker agent.",
            model: "claude-sonnet-5",
          }),
          body: "You do the thing.",
        },
      ],
      ui: { html: "<html><body>Panel</body></html>", title: "Panel", tools: ["read_file"] },
    })
    await app.emit(dir)

    const { client, appRegistry } = await setup()
    const installed = parseToolJson(
      await client.callTool({ name: "app_install", arguments: { dir } }),
    )
    expect(installed.appId).toBe("@test/ui-toolslist-app")

    const uiServer = new McpServer({ name: "app-ui-toolslist-test-server", version: "0.0.0" })
    const uiApps = await makeInstalledAppUiApps(appRegistry, createUiHtmlCache(), new Set())
    registerMcpApps(uiServer, uiApps)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await uiServer.connect(serverTransport)
    const uiClient = new Client({ name: "app-ui-toolslist-test-client", version: "0.0.0" })
    await uiClient.connect(clientTransport)

    const { tools } = await uiClient.listTools()
    expect(tools.map(t => t.name)).toContain("app_ui_ui_toolslist_app")
  })
})
