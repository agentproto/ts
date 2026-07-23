/**
 * Tests for routine-registrar.ts — the AIP-41 `.routines/<id>/ROUTINE.md`
 * runtime bridge (see packages/routine/README.md "Runtime bridge" section).
 *
 * Two layers:
 *   - Unit tests against `routineTargetToToolCall` and `createRoutineRegistrar`
 *     with a FAKE CronScheduler + fake `dispatchTool` (parse → register →
 *     dispatch, no live daemon).
 *   - An integration-shaped test that proves all THREE target kinds
 *     (tool / agent / workflow) actually fire through the REAL production
 *     dispatch mechanism: a real `McpServer` with stub tools registered,
 *     `dispatchTool` built via the same `_registeredTools` reach-in
 *     `index.ts` uses, a real `CronScheduler`, and a real registrar on top —
 *     entirely in-process, no HTTP transport, no daemon process.
 */

import { describe, it, expect, afterEach } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { createCronScheduler, type CronScheduler, type CronJob } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRoutineRegistrar, routineTargetToToolCall } from "../routine-registrar.js"

function makeTmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "routine-registrar-test-"))
}

function writeRoutine(workspace: string, id: string, frontmatterYaml: string, body = "\n# test routine\n"): void {
  const dir = join(workspace, ".routines", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "ROUTINE.md"), `---\n${frontmatterYaml}\n---\n${body}`)
}

// ── fake CronScheduler for pure-unit coverage ────────────────────────

function makeFakeCronScheduler(): CronScheduler {
  const jobs = new Map<string, CronJob>()
  let counter = 0
  return {
    create({ label, schedule, timezone, recurring = true, action }) {
      const id = `fake_cron_${++counter}`
      const job: CronJob = {
        id,
        ...(label ? { label } : {}),
        schedule,
        ...(timezone ? { timezone } : {}),
        recurring,
        action,
        createdAt: new Date().toISOString(),
        active: true,
      }
      jobs.set(id, job)
      return job
    },
    list() {
      return Array.from(jobs.values())
    },
    get(id) {
      return jobs.get(id)
    },
    delete(id) {
      if (!jobs.has(id)) throw new Error(`cron job not found: ${id}`)
      jobs.delete(id)
    },
    async run(id) {
      const job = jobs.get(id)
      if (!job) throw new Error(`cron job not found: ${id}`)
      return job.lastResult
    },
    shutdown() {},
  }
}

describe("routineTargetToToolCall", () => {
  it("target.tool passes through tool + inputs verbatim", () => {
    const call = routineTargetToToolCall({ tool: "worktree_gc", inputs: { apply: true } })
    expect(call).toEqual({ tool: "worktree_gc", inputs: { apply: true } })
  })

  it("target.tool with no inputs defaults to {}", () => {
    const call = routineTargetToToolCall({ tool: "worktree_gc" })
    expect(call).toEqual({ tool: "worktree_gc", inputs: {} })
  })

  it("target.agent lowers to an agent_start tool call", () => {
    const call = routineTargetToToolCall({
      agent: { adapter: "claude-code", prompt: "say hi", model: "sonnet", cwd: "/tmp/x" },
    })
    expect(call).toEqual({
      tool: "agent_start",
      inputs: { adapter: "claude-code", prompt: "say hi", model: "sonnet", cwd: "/tmp/x" },
    })
  })

  it("target.agent omits optional fields when absent", () => {
    const call = routineTargetToToolCall({ agent: { adapter: "claude-code", prompt: "say hi" } })
    expect(call).toEqual({ tool: "agent_start", inputs: { adapter: "claude-code", prompt: "say hi" } })
  })

  it("target.workflow.file lowers to a workflow_run_file tool call", () => {
    const call = routineTargetToToolCall({ workflow: { file: "WORKFLOW.md" }, inputs: { foo: "bar" } })
    expect(call).toEqual({ tool: "workflow_run_file", inputs: { path: "WORKFLOW.md", input: { foo: "bar" } } })
  })

  it("target.workflow as a bare string is treated as a file path", () => {
    const call = routineTargetToToolCall({ workflow: "WORKFLOW.md" })
    expect(call).toEqual({ tool: "workflow_run_file", inputs: { path: "WORKFLOW.md" } })
  })

  it("target.workflow.ref (no file) throws a clear unsupported error", () => {
    expect(() => routineTargetToToolCall({ workflow: { ref: "some-saved-workflow" } })).toThrow(/ref.*inline/i)
  })

  it("target.action throws a clear not-dispatchable error", () => {
    expect(() => routineTargetToToolCall({ action: "aip39:some-action" })).toThrow(/not dispatchable/i)
  })
})

describe("createRoutineRegistrar — unit (fakes)", () => {
  let tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
    }
    tmpDirs = []
  })

  function setup() {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)
    const cronScheduler = makeFakeCronScheduler()
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    const dispatchTool = async (name: string, inputs: Record<string, unknown>) => {
      calls.push({ name, inputs })
      return { content: [{ type: "text", text: `dispatched ${name}` }] }
    }
    const registrar = createRoutineRegistrar({ workspace, cronScheduler, dispatchTool })
    return { workspace, cronScheduler, calls, registrar }
  }

  it("reconcile() registers a cron job for an enabled, cron-scheduled tool-target routine", () => {
    const { workspace, cronScheduler, registrar } = setup()
    writeRoutine(
      workspace,
      "demo-gc",
      [
        "schema: routine/v1",
        "id: demo-gc",
        "description: test",
        "schedule:",
        "  kind: cron",
        '  cron: "0 4 * * *"',
        "target:",
        "  tool: worktree_gc",
        "  inputs:",
        "    apply: true",
      ].join("\n"),
    )
    const result = registrar.reconcile()
    expect(result.errors).toEqual([])
    expect(result.registered).toEqual(["demo-gc"])
    const jobs = cronScheduler.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.label).toBe("routine:demo-gc")
    expect(jobs[0]!.action).toEqual({ kind: "tool", tool: "worktree_gc", inputs: { apply: true } })
  })

  it("reconcile() skips a disabled routine and does not register a job", () => {
    const { workspace, cronScheduler, registrar } = setup()
    writeRoutine(
      workspace,
      "off",
      [
        "schema: routine/v1",
        "id: off",
        "description: test",
        "schedule:\n  kind: cron\n  cron: \"* * * * *\"",
        "target:\n  tool: worktree_gc",
        "enabled: false",
      ].join("\n"),
    )
    const result = registrar.reconcile()
    expect(result.registered).toEqual([])
    expect(result.skipped).toEqual([{ id: "off", reason: "enabled: false" }])
    expect(cronScheduler.list()).toHaveLength(0)
  })

  it("reconcile() skips a non-cron schedule with a clear reason", () => {
    const { workspace, registrar } = setup()
    writeRoutine(
      workspace,
      "manual-one",
      [
        "schema: routine/v1",
        "id: manual-one",
        "description: test",
        "schedule:\n  kind: manual",
        "target:\n  tool: worktree_gc",
      ].join("\n"),
    )
    const result = registrar.reconcile()
    expect(result.registered).toEqual([])
    expect(result.skipped[0]!.id).toBe("manual-one")
    expect(result.skipped[0]!.reason).toMatch(/manual/)
  })

  it("reconcile() is idempotent — a second call with no changes registers nothing new", () => {
    const { workspace, cronScheduler, registrar } = setup()
    writeRoutine(
      workspace,
      "demo-gc",
      "schema: routine/v1\nid: demo-gc\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  tool: worktree_gc",
    )
    registrar.reconcile()
    const before = cronScheduler.list().map(j => j.id)
    registrar.reconcile()
    const after = cronScheduler.list().map(j => j.id)
    expect(after).toEqual(before)
  })

  it("reconcile() delete+recreates a job whose routine content changed", () => {
    const { workspace, cronScheduler, registrar } = setup()
    writeRoutine(
      workspace,
      "demo-gc",
      "schema: routine/v1\nid: demo-gc\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  tool: worktree_gc",
    )
    registrar.reconcile()
    const firstJobId = cronScheduler.list()[0]!.id
    writeRoutine(
      workspace,
      "demo-gc",
      "schema: routine/v1\nid: demo-gc\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 5 * * *\"\ntarget:\n  tool: worktree_gc",
    )
    const result = registrar.reconcile()
    expect(result.removed).toEqual([firstJobId])
    const jobs = cronScheduler.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.id).not.toBe(firstJobId)
    expect(jobs[0]!.schedule).toBe("0 5 * * *")
  })

  it("reconcile() removes a job whose routine file was deleted", () => {
    const { workspace, cronScheduler, registrar } = setup()
    writeRoutine(
      workspace,
      "demo-gc",
      "schema: routine/v1\nid: demo-gc\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  tool: worktree_gc",
    )
    registrar.reconcile()
    expect(cronScheduler.list()).toHaveLength(1)
    rmSync(join(workspace, ".routines", "demo-gc"), { recursive: true })
    const result = registrar.reconcile()
    expect(result.removed).toHaveLength(1)
    expect(cronScheduler.list()).toHaveLength(0)
  })

  it("reconcile() collects a per-file parse error without failing the whole scan", () => {
    const { workspace, registrar } = setup()
    writeRoutine(
      workspace,
      "broken",
      "schema: routine/v1\nid: broken\ndescription: test\nschedule:\n  kind: cron\n  cron: \"* * * * *\"\ntarget:\n  nonsense: true",
    )
    writeRoutine(
      workspace,
      "good",
      "schema: routine/v1\nid: good\ndescription: test\nschedule:\n  kind: cron\n  cron: \"* * * * *\"\ntarget:\n  tool: worktree_gc",
    )
    const result = registrar.reconcile()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.file).toContain("broken")
    expect(result.registered).toEqual(["good"])
  })

  it("trigger() dispatches a tool-target routine even when disabled and not reconciled", async () => {
    const { workspace, calls, registrar } = setup()
    writeRoutine(
      workspace,
      "off-but-testable",
      "schema: routine/v1\nid: off-but-testable\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  tool: worktree_gc\n  inputs:\n    apply: true\nenabled: false",
    )
    const result = await registrar.trigger("off-but-testable")
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ name: "worktree_gc", inputs: { apply: true } }])
  })

  it("trigger() dispatches an agent-target routine as agent_start", async () => {
    const { workspace, calls, registrar } = setup()
    writeRoutine(
      workspace,
      "agent-demo",
      "schema: routine/v1\nid: agent-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  agent:\n    adapter: claude-code\n    prompt: say hi",
    )
    const result = await registrar.trigger("agent-demo")
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ name: "agent_start", inputs: { adapter: "claude-code", prompt: "say hi" } }])
  })

  it("trigger() dispatches a workflow-target routine as workflow_run_file", async () => {
    const { workspace, calls, registrar } = setup()
    writeRoutine(
      workspace,
      "workflow-demo",
      "schema: routine/v1\nid: workflow-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  workflow:\n    file: WORKFLOW.md",
    )
    const result = await registrar.trigger("workflow-demo")
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ name: "workflow_run_file", inputs: { path: "WORKFLOW.md" } }])
  })

  it("trigger() on an unknown routine id throws a clear not-found error", async () => {
    const { registrar } = setup()
    await expect(registrar.trigger("nope")).rejects.toThrow(/not found/)
  })
})

// ── Integration-shaped: real McpServer + real CronScheduler + real registrar ──
// No HTTP transport, no daemon process — proves the production dispatch
// mechanism (the `_registeredTools` reach-in) actually calls a registered
// tool handler in-process, for all three target kinds.

describe("AIP-41 routine → real dispatch (all three target kinds fire)", () => {
  let tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
    }
    tmpDirs = []
  })

  it("target.tool, target.agent, and target.workflow each reach their real stub tool handler", async () => {
    const workspace = makeTmpWorkspace()
    tmpDirs.push(workspace)

    const calls: Array<{ name: string; args: unknown }> = []
    const server = new McpServer({ name: "test", version: "0.0.1" })
    for (const name of ["worktree_gc", "agent_start", "workflow_run_file"]) {
      server.tool(name, `stub ${name}`, { apply: z.boolean().optional(), adapter: z.string().optional(), prompt: z.string().optional(), path: z.string().optional() }, async args => {
        calls.push({ name, args })
        return { content: [{ type: "text", text: `${name} ok` }] }
      })
    }
    // Same reach-in as index.ts's `dispatchTool` — see routine-registrar.ts SPEC note.
    const internal = server as unknown as {
      _registeredTools?: Record<string, { handler: (args: unknown, extra: unknown) => unknown }>
    }
    const dispatchTool = async (name: string, inputs: Record<string, unknown>) => {
      const tool = internal._registeredTools?.[name]
      if (!tool) throw new Error(`unknown tool: ${name}`)
      return tool.handler(inputs, {})
    }

    const sessionEvents = createSessionEventBus()
    const registry = createSessionsRegistry({ sessionEvents, persistPath: join(workspace, "sessions.json") })
    const cronScheduler = createCronScheduler({ sessionEvents, registry, workspace, dispatchTool })
    const registrar = createRoutineRegistrar({ workspace, cronScheduler, dispatchTool })

    writeRoutine(
      workspace,
      "tool-demo",
      "schema: routine/v1\nid: tool-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  tool: worktree_gc\n  inputs:\n    apply: true",
    )
    writeRoutine(
      workspace,
      "agent-demo",
      "schema: routine/v1\nid: agent-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  agent:\n    adapter: claude-code\n    prompt: say hi",
    )
    writeRoutine(
      workspace,
      "workflow-demo",
      "schema: routine/v1\nid: workflow-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  workflow:\n    file: WORKFLOW.md",
    )

    try {
      // 1. reconcile() registers all three as real, live CronScheduler jobs.
      const reconciled = registrar.reconcile()
      expect(reconciled.registered.sort()).toEqual(["agent-demo", "tool-demo", "workflow-demo"])
      const jobs = cronScheduler.list()
      expect(jobs).toHaveLength(3)

      // 2. Firing the REAL scheduled job (as the tick loop would) dispatches
      //    to the real stub tool handler for every target kind.
      for (const job of jobs) {
        const result = await cronScheduler.run(job.id)
        expect(result?.ok).toBe(true)
      }
      expect(calls.map(c => c.name).sort()).toEqual(["agent_start", "workflow_run_file", "worktree_gc"])

      calls.length = 0

      // 3. routine_trigger's underlying call (registrar.trigger) also fires
      //    each kind directly, bypassing the schedule.
      for (const id of ["tool-demo", "agent-demo", "workflow-demo"]) {
        const result = await registrar.trigger(id)
        expect(result.ok).toBe(true)
      }
      expect(calls.map(c => c.name).sort()).toEqual(["agent_start", "workflow_run_file", "worktree_gc"])

      const toolCall = calls.find(c => c.name === "worktree_gc")!
      expect(toolCall.args).toEqual({ apply: true })
      const agentCall = calls.find(c => c.name === "agent_start")!
      expect(agentCall.args).toEqual({ adapter: "claude-code", prompt: "say hi" })
      const workflowCall = calls.find(c => c.name === "workflow_run_file")!
      expect(workflowCall.args).toEqual({ path: "WORKFLOW.md" })
    } finally {
      cronScheduler.shutdown()
    }
  })
})

// ── routine_trigger MCP tool — proves it's registered and dispatches over a
// real MCP transport, and that it does not collide with the unrelated
// `routine_start`/`routine_list`/... (RoutineRunner) verbs when both are
// wired on the same server (see routine-registrar.ts SPEC note). ──

describe("routine_trigger MCP tool", () => {
  it("registers alongside routine_start (RoutineRunner) without colliding, and dispatches over MCP", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const { registerOrchestrationTools } = await import("../orchestration-tools.js")
    const { createRoutineRunner } = await import("../routine-runner.js")
    const { createEventRing } = await import("../event-ring.js")

    const workspace = mkdtempSync(join(tmpdir(), "routine-trigger-mcp-test-"))
    try {
      writeRoutine(
        workspace,
        "mcp-demo",
        "schema: routine/v1\nid: mcp-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  tool: worktree_gc\n  inputs:\n    apply: true",
      )

      const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
      const dispatchTool = async (name: string, inputs: Record<string, unknown>) => {
        calls.push({ name, inputs })
        return { content: [{ type: "text", text: "ok" }] }
      }
      const cronScheduler = makeFakeCronScheduler()
      const routineRegistrar = createRoutineRegistrar({ workspace, cronScheduler, dispatchTool })

      const sessionEvents = createSessionEventBus()
      const eventRing = createEventRing()
      const registry = createSessionsRegistry({ sessionEvents, persistPath: join(workspace, "sessions.json") })
      // Wire the unrelated RoutineRunner too, to prove no name collision.
      const routineRunner = createRoutineRunner({ registry, sessionEvents, resolveAgentAdapter: (async () => undefined) as never })

      const server = new McpServer({ name: "routine-trigger-test", version: "0.0.0" })
      registerOrchestrationTools(server, { registry, sessionEvents, eventRing, routineRunner, routineRegistrar })

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: "routine-trigger-test-client", version: "0.0.0" })
      await client.connect(clientTransport)

      const { tools } = await client.listTools()
      const names = tools.map(t => t.name)
      expect(names).toContain("routine_trigger")
      expect(names).toContain("routine_start") // RoutineRunner still there, unaffected

      const result = await client.callTool({ name: "routine_trigger", arguments: { routineId: "mcp-demo" } })
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content
      const text = content?.find(c => c.type === "text")?.text
      const parsed = JSON.parse(text!)
      expect(parsed.ok).toBe(true)
      expect(calls).toEqual([{ name: "worktree_gc", inputs: { apply: true } }])
    } finally {
      rmSync(workspace, { recursive: true })
    }
  })
})
