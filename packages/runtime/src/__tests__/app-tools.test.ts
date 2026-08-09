/**
 * Unit + MCP-transport coverage for the `app_*` verbs (app-tools.ts).
 * Mirrors workflow-mcp-e2e.test.ts's real-McpServer + InMemoryTransport
 * setup and agent-start-mode.test.ts's session-spawn seam (a fake
 * `AgentAdapterResolver` over a real `createSessionsRegistry`) — no heavy
 * mocking of providers-store/workspaces-config/auth needed, same as those.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
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
import { registerAppTools, resolveAgentRefsForWorkflow } from "../app-tools.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

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

  const server = new McpServer({ name: "app-tools-test-server", version: "0.0.0" })
  registerAppTools(server, {
    registry,
    listRegisteredToolIds,
    appRegistry,
    ...(resolveAgentAdapter ? { resolveAgentAdapter } : {}),
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
