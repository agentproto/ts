/**
 * `resolveAgentRefsForWorkflow` resolves only the agents a workflow's own
 * steps reference, and finds the owning app by the WORKFLOW.md's path when
 * that path is known (falling back to the workflow-id lookup only for a
 * WORKFLOW.md outside the installed registry).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp } from "@agentproto/app"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { registerAppTools, resolveAgentRefsForWorkflow } from "../app-tools.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"

function routableAgent(id: string, workflowIds: string[]) {
  return {
    agent: defineAgent({
      schema: "agent/v1",
      id,
      description: `${id} agent.`,
      model: "claude-sonnet-5",
      workflows: workflowIds.map(ref => ({ ref })),
    }),
    body: `You are ${id}.`,
  }
}

function unroutableAgent(id: string, workflowIds: string[]) {
  return {
    agent: defineAgent({
      schema: "agent/v1",
      id,
      description: `${id} agent.`,
      model: "some-provider/foo-1",
      workflows: workflowIds.map(ref => ({ ref })),
    }),
    body: `You are ${id}.`,
  }
}

function agentStep(id: string, ref: string) {
  return { id, kind: "agent" as const, agent: { ref }, prompt: "Do the thing." }
}

function fakeStartSession() {
  return async (_opts: Record<string, unknown>) => ({
    sessionId: "adapter_workflow_agent_refs_test",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  })
}

async function setup(appRegistry: AppRegistry, stateDir: string) {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ sessionEvents, persist: false })
  const startSession = fakeStartSession()
  const server = new McpServer({ name: "workflow-agent-refs-test-server", version: "0.0.0" })
  registerAppTools(server, {
    registry,
    listRegisteredToolIds: async () => ["known_tool"],
    appRegistry,
    resolveAgentAdapter: async (slug: string) =>
      slug === "mastra-agent" || slug === "claude-code"
        ? { startSession, commandPreview: "mock-adapter", agentManifestOption: "agent" }
        : null,
    persistPath: join(stateDir, "apps.json"),
    workspacesConfigPath: join(stateDir, "workspaces.json"),
    appsDir: join(stateDir, "apps"),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "workflow-agent-refs-test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client }
}

async function install(client: Client, dir: string): Promise<any> {
  const res = (await client.callTool({ name: "app_install", arguments: { dir } })) as {
    isError?: boolean
    content?: Array<{ type: string; text?: string }>
  }
  if (res.isError === true) {
    throw new Error(res.content?.find(c => c.type === "text")?.text ?? "app_install failed")
  }
  const text = res.content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("app_install returned no text")
  return JSON.parse(text)
}

describe("resolveAgentRefsForWorkflow resolves only its own workflow's agents", () => {
  let dirA: string
  let dirB: string
  let dirTmp: string
  let stateDir: string
  let appRegistry: AppRegistry
  let client: Client

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), "workflow-agent-refs-a-"))
    dirB = await mkdtemp(join(tmpdir(), "workflow-agent-refs-b-"))
    dirTmp = await mkdtemp(join(tmpdir(), "workflow-agent-refs-tmp-"))
    stateDir = await mkdtemp(join(tmpdir(), "workflow-agent-refs-state-"))
    appRegistry = createAppRegistry({ persist: false })
    ;({ client } = await setup(appRegistry, stateDir))
  })

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
    await rm(dirTmp, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  })

  it("skips an agent the workflow never references even when it has no route", async () => {
    const app = defineApp({
      id: "@test/partial-refs",
      name: "Partial refs",
      agents: [routableAgent("worker", ["only-worker"]), unroutableAgent("broken", ["only-worker"])],
      workflows: [
        defineWorkflow({
          id: "only-worker",
          name: "Only worker",
          description: "Uses one of two agents.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [agentStep("s1", "worker")],
        }),
      ],
    })
    await app.emit(dirA)
    const installed = await install(client, dirA)
    const workflowPath = installed.workflows[0].path as string
    const handle = await loadWorkflowHandle(workflowPath)

    const refs = await resolveAgentRefsForWorkflow(appRegistry, handle.id, undefined, undefined, {
      workflowPath,
      steps: handle.steps,
    })
    expect(Object.keys(refs ?? {})).toEqual(["worker"])
    expect(refs?.worker?.adapter).toBe("claude-code")
  })

  it("finds the agent nested inside a map and then a parallel", async () => {
    const app = defineApp({
      id: "@test/nested-refs",
      name: "Nested refs",
      agents: [routableAgent("worker", ["nested"]), unroutableAgent("broken", ["nested"])],
      workflows: [
        defineWorkflow({
          id: "nested",
          name: "Nested",
          description: "An agent step nested under map then parallel.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [
            {
              id: "fan",
              kind: "map",
              over: "items",
              steps: [
                {
                  id: "par",
                  kind: "parallel",
                  branches: [
                    { id: "b1", steps: [agentStep("s1", "worker")] },
                    { id: "b2", steps: [{ id: "t", kind: "tool", tool: "known_tool" }] },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    })
    await app.emit(dirA)
    const installed = await install(client, dirA)
    const workflowPath = installed.workflows[0].path as string
    const handle = await loadWorkflowHandle(workflowPath)

    const refs = await resolveAgentRefsForWorkflow(appRegistry, handle.id, undefined, undefined, {
      workflowPath,
      steps: handle.steps,
    })
    expect(Object.keys(refs ?? {})).toEqual(["worker"])
  })

  it("resolves against the app whose WORKFLOW.md path was given, not the first app with that workflow id", async () => {
    const appA = defineApp({
      id: "@test/app-a",
      name: "App A",
      agents: [routableAgent("agent-a", ["fl"])],
      workflows: [
        defineWorkflow({
          id: "fl",
          name: "Shared id A",
          description: "A.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [agentStep("s1", "agent-a")],
        }),
      ],
    })
    const appB = defineApp({
      id: "@test/app-b",
      name: "App B",
      agents: [routableAgent("agent-b", ["fl"])],
      workflows: [
        defineWorkflow({
          id: "fl",
          name: "Shared id B",
          description: "B.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [agentStep("s1", "agent-b")],
        }),
      ],
    })
    await appA.emit(dirA)
    await appB.emit(dirB)
    await install(client, dirA)
    const installedB = await install(client, dirB)
    const workflowPath = installedB.workflows[0].path as string
    const handle = await loadWorkflowHandle(workflowPath)
    expect(handle.id).toBe("fl")

    const refs = await resolveAgentRefsForWorkflow(appRegistry, handle.id, undefined, undefined, {
      workflowPath,
      steps: handle.steps,
    })
    expect(Object.keys(refs ?? {})).toEqual(["agent-b"])
  })

  it("falls back to the workflow-id lookup for a WORKFLOW.md outside the registry, and says so once", async () => {
    const installedApp = defineApp({
      id: "@test/installed-app",
      name: "Installed app",
      agents: [routableAgent("worker", ["orphan"])],
      workflows: [
        defineWorkflow({
          id: "orphan",
          name: "Orphan",
          description: "Not installed here.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [agentStep("s1", "worker")],
        }),
      ],
    })
    await installedApp.emit(dirA)
    await install(client, dirA)

    const tmpApp = defineApp({
      id: "@test/tmp-app",
      name: "Tmp app",
      agents: [routableAgent("worker", ["orphan"])],
      workflows: [
        defineWorkflow({
          id: "orphan",
          name: "Orphan",
          description: "A copy outside the registry.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [agentStep("s1", "worker")],
        }),
      ],
    })
    await tmpApp.emit(dirTmp)
    const tmpWorkflowPath = join(dirTmp, ".agentproto", "workflows", "orphan", "WORKFLOW.md")
    const handle = await loadWorkflowHandle(tmpWorkflowPath)

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const refs = await resolveAgentRefsForWorkflow(appRegistry, handle.id, undefined, undefined, {
        workflowPath: tmpWorkflowPath,
        steps: handle.steps,
      })
      expect(Object.keys(refs ?? {})).toEqual(["worker"])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/belongs to no installed app dir/)
    } finally {
      warn.mockRestore()
    }
  })

  it("keeps resolving every agent when the workflow contains a subworkflow step", async () => {
    const app = defineApp({
      id: "@test/subworkflow-refs",
      name: "Subworkflow refs",
      agents: [routableAgent("one", ["with-sub"]), routableAgent("two", ["with-sub"])],
      workflows: [
        defineWorkflow({
          id: "with-sub",
          name: "With sub",
          description: "A subworkflow step plus an agent step.",
          version: "0.1.0",
          inputs: {},
          outputs: {},
          steps: [
            { id: "sub", kind: "subworkflow", workflow: "other" },
            agentStep("s1", "one"),
          ],
        }),
      ],
    })
    await app.emit(dirA)
    const installed = await install(client, dirA)
    const workflowPath = installed.workflows[0].path as string
    const handle = await loadWorkflowHandle(workflowPath)

    const refs = await resolveAgentRefsForWorkflow(appRegistry, handle.id, undefined, undefined, {
      workflowPath,
      steps: handle.steps,
    })
    expect(Object.keys(refs ?? {}).sort()).toEqual(["one", "two"])
  })
})
