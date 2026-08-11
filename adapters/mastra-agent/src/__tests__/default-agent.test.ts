/**
 * WP-3 — drives a real `AgentController` + `Session` directly (no ACP layer):
 * default mode, submit_plan suspend/approve/reject, direct mode switching,
 * tool-approval resolution, and `makeAgentFactory`'s modes-on / parity wiring.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "@mastra/core/agent"
import { AgentController } from "@mastra/core/agent-controller"
import type { AgentControllerMode } from "@mastra/core/agent-controller"
import { Workspace } from "@mastra/core/workspace"
import { afterEach, describe, expect, it } from "vitest"
import { DISABLED_BUILTIN_TOOL_IDS, makeAgentFactory } from "../default-agent.js"
import { buildSqliteStore } from "../memory.js"
import { DEFAULT_MODE_ID, DEFAULT_MODES } from "../modes.js"
import { DEFAULT_PERMISSION_RULES, toolCategoryResolver } from "../tool-categories.js"
import { makeWorkspaceTools } from "../workspace-tools.js"
import { createScriptedModel, type ScriptedModel } from "./support/scripted-model.js"

const tmpDirs: string[] = []
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastra-agent-wp3-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * Assemble an `AgentController` from the same building blocks
 * `makeAgentFactory` wires for the modes-on path (modes, workspace tools,
 * tool-category resolver + default permission rules, submit_plan re-enabled)
 * but with a {@link ScriptedModel} backing the agent instead of a real
 * provider, so a full tool-calling run works with no network access.
 */
async function buildScriptedController(
  model: ScriptedModel,
  overrides?: { modes?: AgentControllerMode[]; defaultModeId?: string },
) {
  const cwd = await makeTmpDir()
  const workspaceTools = makeWorkspaceTools({ cwd, allowExec: true })
  const agent = new Agent({
    id: "wp3-test-agent",
    name: "wp3-test-agent",
    instructions: "test agent",
    model: model as unknown as ConstructorParameters<typeof Agent>[0]["model"],
    tools: workspaceTools,
  })
  const store = buildSqliteStore({ AGENTPROTO_MASTRA_MEMORY_DB: ":memory:" })
  const controller = new AgentController({
    id: `wp3-test-controller`,
    agent,
    modes: overrides?.modes ?? [...DEFAULT_MODES],
    defaultModeId: overrides?.defaultModeId ?? DEFAULT_MODE_ID,
    storage: store,
    tools: workspaceTools,
    disableBuiltinTools: DISABLED_BUILTIN_TOOL_IDS.filter((id) => id !== "submit_plan"),
    toolCategoryResolver,
    initialState: { permissionRules: DEFAULT_PERMISSION_RULES },
    workspace: new Workspace({ skills: () => [] }),
  })
  await controller.init()
  return controller
}

describe("AgentController driven directly — modes", () => {
  it("default mode is plan", async () => {
    const controller = await buildScriptedController(createScriptedModel([{ type: "text", text: "ok" }]))
    const session = await controller.createSession({ resourceId: "default-mode" })
    expect(session.mode.get()).toBe("plan")
  })

  it("submit_plan suspends the run; approving switches to build", async () => {
    const model = createScriptedModel([
      { type: "tool-call", toolCallId: "tc1", toolName: "submit_plan", input: { path: "PLAN.md" } },
      { type: "text", text: "Proceeding with the plan." },
    ])
    const controller = await buildScriptedController(model)
    const session = await controller.createSession({ resourceId: "approve" })

    const suspended: unknown[] = []
    session.subscribe((event) => {
      if (event.type === "tool_suspended") suspended.push(event)
    })

    await session.sendMessage({ content: "please plan the work" })
    expect(suspended).toHaveLength(1)
    expect(session.mode.get()).toBe("plan")

    await session.respondToToolSuspension({ resumeData: { action: "approved" } })
    expect(session.mode.get()).toBe("build")
  })

  it("rejecting submit_plan with feedback stays in plan", async () => {
    const model = createScriptedModel([
      { type: "tool-call", toolCallId: "tc1", toolName: "submit_plan", input: { path: "PLAN.md" } },
      { type: "text", text: "Revising the plan." },
    ])
    const controller = await buildScriptedController(model)
    const session = await controller.createSession({ resourceId: "reject" })

    await session.sendMessage({ content: "please plan the work" })
    expect(session.mode.get()).toBe("plan")

    await session.respondToToolSuspension({
      resumeData: { action: "rejected", feedback: "add error handling" },
    })
    expect(session.mode.get()).toBe("plan")
  })

  it("session.mode.switch moves directly between modes", async () => {
    const controller = await buildScriptedController(createScriptedModel([{ type: "text", text: "ok" }]))
    const session = await controller.createSession({ resourceId: "direct-switch" })

    await session.mode.switch({ modeId: "review" })
    expect(session.mode.get()).toBe("review")

    await session.mode.switch({ modeId: "build" })
    expect(session.mode.get()).toBe("build")
  })
})

describe("AgentController driven directly — tool approval", () => {
  it("read tools auto-approve; write/execute tools ask", async () => {
    const controller = await buildScriptedController(createScriptedModel([{ type: "text", text: "ok" }]))
    const session = await controller.createSession({ resourceId: "approval" })

    expect(session.resolveToolApproval("read_file")).toBe("allow")
    expect(session.resolveToolApproval("list_dir")).toBe("allow")
    expect(session.resolveToolApproval("read_diff")).toBe("allow")

    expect(session.resolveToolApproval("write_file")).toBe("ask")
    expect(session.resolveToolApproval("edit_file")).toBe("ask")
    expect(session.resolveToolApproval("run_command")).toBe("ask")
    expect(session.resolveToolApproval("run_tests")).toBe("ask")
  })
})

describe("makeAgentFactory — modes on (default)", () => {
  it("wires plan/build/review, defaultModeId plan, submit_plan enabled, permissions seeded", async () => {
    const cwd = await makeTmpDir()
    // Provider "mock" has no PROVIDER_ENV entry, so resolveMastraModel skips
    // its API-key preflight — safe here since no run is ever started.
    const factory = makeAgentFactory({ model: "mock/modes-on", cwd })
    const { controller } = await factory()
    await controller.init()

    expect(controller.listModes().map((m) => m.id).sort()).toEqual(["build", "plan", "review"])

    const session = await controller.createSession({ resourceId: "factory-modes-on" })
    expect(session.mode.get()).toBe("plan")
    expect(session.permissions.getRules()).toEqual(DEFAULT_PERMISSION_RULES)
    expect(session.resolveToolApproval("read_file")).toBe("allow")
    expect(session.resolveToolApproval("write_file")).toBe("ask")
    expect(controller.getToolCategory({ toolName: "run_command" })).toBe("execute")
  })

  it("AGENTPROTO_MASTRA_NO_MODES selects parity mode at spawn time", async () => {
    const cwd = await makeTmpDir()
    const prev = process.env.AGENTPROTO_MASTRA_NO_MODES
    process.env.AGENTPROTO_MASTRA_NO_MODES = "1"
    try {
      const factory = makeAgentFactory({ model: "mock/env-parity", cwd })
      const { controller } = await factory()
      await controller.init()
      expect(controller.listModes().map((m) => m.id)).toEqual(["main"])
    } finally {
      if (prev === undefined) delete process.env.AGENTPROTO_MASTRA_NO_MODES
      else process.env.AGENTPROTO_MASTRA_NO_MODES = prev
    }
  })
})

describe("makeAgentFactory — parity mode (modes: false)", () => {
  it("keeps WP-1 behavior: single mode, yolo tool execution, submit_plan stays disabled", async () => {
    const cwd = await makeTmpDir()
    const factory = makeAgentFactory({ model: "mock/parity", cwd, modes: false })
    const { controller } = await factory()
    await controller.init()

    expect(controller.listModes()).toEqual([{ id: "main", metadata: { default: true } }])

    const session = await controller.createSession({ resourceId: "factory-parity" })
    expect(session.mode.get()).toBe("main")
    // yolo: true short-circuits resolveToolApproval to "allow" for everything,
    // matching the pre-WP-3 no-approvals behavior.
    expect(session.resolveToolApproval("write_file")).toBe("allow")
    expect(session.resolveToolApproval("run_command")).toBe("allow")
    expect(session.permissions.getRules()).toEqual({ categories: {}, tools: {} })
  })
})
