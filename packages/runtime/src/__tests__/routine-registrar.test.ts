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
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { createCronScheduler, type CronScheduler, type CronJob } from "../cron-scheduler.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRoutineRegistrar, routineTargetToToolCall } from "../routine-registrar.js"
import { createEventRing } from "../event-ring.js"
import { registerOrchestrationTools } from "../orchestration-tools.js"
import { createInboundEndpointStore } from "../inbound-endpoints.js"
import type { InboundWatcher } from "../inbound-watcher.js"
import type { ActivityProjector } from "../activities.js"
import type { ActivityRecord } from "../activity-projection.js"

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

  it("target.agent stamps origin:routine:<id> when a routineId is passed", () => {
    const call = routineTargetToToolCall({ agent: { adapter: "claude-code", prompt: "say hi" } }, "demo-gc")
    expect(call).toEqual({
      tool: "agent_start",
      inputs: { adapter: "claude-code", prompt: "say hi", origin: "routine:demo-gc" },
    })
  })

  it("target.agent omits origin when no routineId is passed", () => {
    const call = routineTargetToToolCall({ agent: { adapter: "claude-code", prompt: "say hi" } })
    expect(call.inputs).not.toHaveProperty("origin")
  })

  it("target.tool ignores routineId — inputs pass through verbatim, no origin injected", () => {
    const call = routineTargetToToolCall({ tool: "worktree_gc", inputs: { apply: true } }, "demo-gc")
    expect(call).toEqual({ tool: "worktree_gc", inputs: { apply: true } })
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

  it("trigger() dispatches an agent-target routine as agent_start, tagged with its routine's origin", async () => {
    const { workspace, calls, registrar } = setup()
    writeRoutine(
      workspace,
      "agent-demo",
      "schema: routine/v1\nid: agent-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  agent:\n    adapter: claude-code\n    prompt: say hi",
    )
    const result = await registrar.trigger("agent-demo")
    expect(result.ok).toBe(true)
    expect(calls).toEqual([
      { name: "agent_start", inputs: { adapter: "claude-code", prompt: "say hi", origin: "routine:agent-demo" } },
    ])
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
      expect(agentCall.args).toEqual({ adapter: "claude-code", prompt: "say hi", origin: "routine:agent-demo" })
      const workflowCall = calls.find(c => c.name === "workflow_run_file")!
      expect(workflowCall.args).toEqual({ path: "WORKFLOW.md" })
    } finally {
      cronScheduler.shutdown()
    }
  })
})

// ── routine_trigger / routine_list MCP tools — prove they're registered and
// dispatch over a real MCP transport (see routine-registrar.ts SPEC note). ──

describe("routine_trigger MCP tool", () => {
  it("registers, dispatches over MCP, and routine_list reflects the same registrar", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const { registerOrchestrationTools } = await import("../orchestration-tools.js")
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

      const server = new McpServer({ name: "routine-trigger-test", version: "0.0.0" })
      registerOrchestrationTools(server, { registry, sessionEvents, eventRing, routineRegistrar })

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new Client({ name: "routine-trigger-test-client", version: "0.0.0" })
      await client.connect(clientTransport)

      const { tools } = await client.listTools()
      const names = tools.map(t => t.name)
      expect(names).toContain("routine_trigger")
      expect(names).toContain("routine_list")
      expect(names).not.toContain("routine_start")

      const result = await client.callTool({ name: "routine_trigger", arguments: { routineId: "mcp-demo" } })
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content
      const text = content?.find(c => c.type === "text")?.text
      const parsed = JSON.parse(text!)
      expect(parsed.ok).toBe(true)
      expect(calls).toEqual([{ name: "worktree_gc", inputs: { apply: true } }])

      const listResult = await client.callTool({ name: "routine_list", arguments: {} })
      const listContent = (listResult as { content?: Array<{ type: string; text?: string }> }).content
      const listText = listContent?.find(c => c.type === "text")?.text
      const routines = JSON.parse(listText!)
      expect(routines.map((r: { id: string }) => r.id)).toEqual(["mcp-demo"])
    } finally {
      rmSync(workspace, { recursive: true })
    }
  })
})

// ── routine_reconcile MCP tool — the Phase A gap this PR closes: without
// it, reconcile() only ran once at daemon boot (index.ts), so a
// `.routines/<id>/ROUTINE.md` dropped, edited, or removed afterward never
// took effect until a restart. ──

describe("routine_reconcile MCP tool", () => {
  let tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true }) } catch { /* ignore */ }
    }
    tmpDirs = []
  })

  it("is gated behind routineRegistrar and excluded from DEFAULT_ORCHESTRATOR_TOOLS", async () => {
    const { DEFAULT_ORCHESTRATOR_TOOLS } = await import("../orchestrator-gateway.js")
    expect(DEFAULT_ORCHESTRATOR_TOOLS).not.toContain("routine_reconcile")
  })

  it("registers a newly-added routine, reflects an edit, and drops a removed one — all without a daemon restart", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const { registerOrchestrationTools } = await import("../orchestration-tools.js")

    const workspace = mkdtempSync(join(tmpdir(), "routine-reconcile-mcp-test-"))
    tmpDirs.push(workspace)

    const dispatchTool = async (name: string, inputs: Record<string, unknown>) => ({
      content: [{ type: "text", text: `dispatched ${name} ${JSON.stringify(inputs)}` }],
    })
    const cronScheduler = makeFakeCronScheduler()
    const routineRegistrar = createRoutineRegistrar({ workspace, cronScheduler, dispatchTool })

    const sessionEvents = createSessionEventBus()
    const eventRing = await import("../event-ring.js").then(m => m.createEventRing())
    const registry = createSessionsRegistry({ sessionEvents, persistPath: join(workspace, "sessions.json") })

    const server = new McpServer({ name: "routine-reconcile-test", version: "0.0.0" })
    registerOrchestrationTools(server, { registry, sessionEvents, eventRing, routineRegistrar })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "routine-reconcile-test-client", version: "0.0.0" })
    await client.connect(clientTransport)

    const callReconcile = async (): Promise<{
      registered: string[]
      skipped: Array<{ id: string; reason: string }>
      removed: string[]
      errors: Array<{ file: string; error: string }>
    }> => {
      const result = await client.callTool({ name: "routine_reconcile", arguments: {} })
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content
      const text = content?.find(c => c.type === "text")?.text
      return JSON.parse(text!)
    }

    // 1. Nothing on disk yet.
    const first = await callReconcile()
    expect(first.registered).toEqual([])
    expect(cronScheduler.list()).toHaveLength(0)

    // 2. A routine dropped after "boot" (no restart) — routine_reconcile picks it up.
    writeRoutine(
      workspace,
      "live-demo",
      "schema: routine/v1\nid: live-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 4 * * *\"\ntarget:\n  tool: worktree_gc",
    )
    const second = await callReconcile()
    expect(second.registered).toEqual(["live-demo"])
    const jobsAfterRegister = cronScheduler.list()
    expect(jobsAfterRegister).toHaveLength(1)
    const firstJobId = jobsAfterRegister[0]!.id

    // 3. Editing the routine's schedule — reflected as delete+recreate.
    writeRoutine(
      workspace,
      "live-demo",
      "schema: routine/v1\nid: live-demo\ndescription: test\nschedule:\n  kind: cron\n  cron: \"0 5 * * *\"\ntarget:\n  tool: worktree_gc",
    )
    const third = await callReconcile()
    expect(third.registered).toEqual(["live-demo"])
    expect(third.removed).toEqual([firstJobId])
    const jobsAfterEdit = cronScheduler.list()
    expect(jobsAfterEdit).toHaveLength(1)
    expect(jobsAfterEdit[0]!.schedule).toBe("0 5 * * *")

    // 4. Removing the routine file — its cron job is torn down.
    rmSync(join(workspace, ".routines", "live-demo"), { recursive: true })
    const fourth = await callReconcile()
    expect(fourth.removed).toEqual([jobsAfterEdit[0]!.id])
    expect(cronScheduler.list()).toHaveLength(0)
  })
})

// ── PR-7: additive limit/cursor pagination for the orchestration list
// tools. Minimal page-walks for the lists without a dedicated test file —
// routine_list lives next to its own MCP tests above; cron_list,
// activities_list, inbound_endpoint_list, and inbound_watcher_list only
// need "paginated union == unpaginated, default unchanged". ──

interface ListPage {
  items: Array<Record<string, string>>
  nextCursor?: string
  total?: number
}

function contentText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = "content" in result ? result.content : undefined
  if (!Array.isArray(content)) throw new Error("tool returned no text content")
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text
    }
  }
  throw new Error("tool returned no text content")
}

describe("orchestration list pagination — minimal page-walks (PR-7)", () => {
  async function listClient(
    opts: Partial<Parameters<typeof registerOrchestrationTools>[1]>,
  ): Promise<Client> {
    const registry = createSessionsRegistry({ persist: false })
    const server = new McpServer({ name: "orch-list-page-test", version: "0.0.0" })
    registerOrchestrationTools(server, {
      registry,
      sessionEvents: createSessionEventBus(),
      eventRing: createEventRing(),
      ...opts,
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "orch-list-page-client", version: "0.0.0" })
    await client.connect(clientTransport)
    return client
  }

  async function walk(
    client: Client,
    tool: string,
    limit = 2,
  ): Promise<{ union: Array<Record<string, string>>; total: number }> {
    const union: Array<Record<string, string>> = []
    let cursor: string | undefined
    let total = 0
    do {
      const page: ListPage = JSON.parse(
        contentText(await client.callTool({ name: tool, arguments: { limit, ...(cursor ? { cursor } : {}) } })),
      )
      total = page.total ?? 0
      union.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    return { union, total }
  }

  it("routine_list: default stays a bare array; page-walk covers exactly the unpaginated list", async () => {
    const workspace = makeTmpWorkspace()
    try {
      const dispatchTool = async (name: string, inputs: Record<string, unknown>) => ({
        content: [{ type: "text", text: `dispatched ${name}` }],
      })
      const registrar = createRoutineRegistrar({ workspace, cronScheduler: makeFakeCronScheduler(), dispatchTool })
      for (const id of ["pg-a", "pg-b", "pg-c"]) {
        writeRoutine(
          workspace,
          id,
          `schema: routine/v1\nid: ${id}\ndescription: test\nschedule:\n  kind: cron\n  cron: "0 4 * * *"\ntarget:\n  tool: worktree_gc`,
        )
      }
      registrar.reconcile()
      const client = await listClient({ routineRegistrar: registrar })

      const unpaginatedText = contentText(await client.callTool({ name: "routine_list", arguments: {} }))
      const unpaginated: Array<Record<string, string>> = JSON.parse(unpaginatedText)
      expect(unpaginated).toHaveLength(3)
      expect(unpaginatedText.trim().startsWith("[")).toBe(true)

      const { union, total } = await walk(client, "routine_list")
      expect(total).toBe(3)
      expect(union.map(r => r.id)).toEqual(unpaginated.map(r => r.id))
      await client.close()
    } finally {
      rmSync(workspace, { recursive: true })
    }
  })

  it("cron_list: page-walk covers exactly the unpaginated list", async () => {
    const cronScheduler = makeFakeCronScheduler()
    const action = { kind: "command", command: "true" } as const
    for (const label of ["pg-a", "pg-b", "pg-c"]) {
      cronScheduler.create({ label, schedule: "0 4 * * *", action })
    }
    const client = await listClient({ cronScheduler })

    const unpaginated: Array<Record<string, string>> = JSON.parse(
      contentText(await client.callTool({ name: "cron_list", arguments: {} })),
    )
    expect(unpaginated).toHaveLength(3)

    const { union, total } = await walk(client, "cron_list")
    expect(total).toBe(3)
    expect(union.map(j => j.id)).toEqual(unpaginated.map(j => j.id))
    await client.close()
  })

  it("activities_list: page-walk covers exactly the unpaginated list", async () => {
    const record = (i: number): ActivityRecord => ({
      id: `turn:sess_pg_${i}:1`,
      kind: "turn",
      sourceRef: `sess_pg_${i}`,
      source: "session",
      title: `turn ${i}`,
      startedAt: "2026-07-22T10:00:00.000Z",
      state: "active",
    })
    const records = [record(1), record(2), record(3)]
    const activityProjector: ActivityProjector = {
      list: () => records,
      wait: async () => null,
      dispose() {},
    }
    const client = await listClient({ activityProjector })

    const unpaginated: { activities: Array<Record<string, string>> } = JSON.parse(
      contentText(await client.callTool({ name: "activities_list", arguments: {} })),
    )
    expect(unpaginated.activities).toHaveLength(3)

    const { union, total } = await walk(client, "activities_list")
    expect(total).toBe(3)
    expect(union.map(a => a.id)).toEqual(unpaginated.activities.map(a => a.id))
    await client.close()
  })

  it("inbound_endpoint_list: page-walk covers exactly the unpaginated list", async () => {
    const endpointStore = createInboundEndpointStore({ persist: false })
    for (const slug of ["pg-a", "pg-b", "pg-c"]) {
      endpointStore.upsert({ slug, provider: "agentpush", alias: "agentpush" })
    }
    const client = await listClient({ endpointStore })

    const unpaginated: Array<Record<string, string>> = JSON.parse(
      contentText(await client.callTool({ name: "inbound_endpoint_list", arguments: {} })),
    )
    expect(unpaginated).toHaveLength(3)

    const { union, total } = await walk(client, "inbound_endpoint_list")
    expect(total).toBe(3)
    expect(union.map(e => e.slug)).toEqual(unpaginated.map(e => e.slug))
    await client.close()
  })

  it("inbound_watcher_list: page-walk covers exactly the unpaginated list", async () => {
    const watcher = (i: number) => ({
      watcherId: `watch_pg_${i}`,
      alias: "agentpush",
      source: `src-${i}`,
      adapter: "claude-code",
      pollIntervalMs: 5000,
      status: "running" as const,
      cursor: i,
      spawned: 0,
    })
    const watchers = [watcher(1), watcher(2), watcher(3)]
    const inboundWatcher: InboundWatcher = {
      start: () => watchers[0]!,
      stop: () => false,
      list: () => watchers,
      shutdown() {},
    }
    const client = await listClient({ inboundWatcher })

    const unpaginated: Array<Record<string, string>> = JSON.parse(
      contentText(await client.callTool({ name: "inbound_watcher_list", arguments: {} })),
    )
    expect(unpaginated).toHaveLength(3)

    const { union, total } = await walk(client, "inbound_watcher_list")
    expect(total).toBe(3)
    expect(union.map(w => w.watcherId)).toEqual(unpaginated.map(w => w.watcherId))
    await client.close()
  })
})
