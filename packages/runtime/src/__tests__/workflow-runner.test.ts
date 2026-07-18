import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { createWorkflowRunner } from "../workflow-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

// ── Minimal mock registry ─────────────────────────────────────────────

function makeMockRegistry(overrides: Partial<SessionsRegistry> = {}): SessionsRegistry {
  const descriptors = new Map<string, SessionDescriptor>()

  const baseDesc = (id: string): SessionDescriptor => ({
    id,
    kind: "agent-cli",
    workspaceSlug: "test",
    command: "mock",
    pid: null,
    status: "running",
    startedAt: new Date().toISOString(),
  })

  return {
    spawn: vi.fn(),
    register: vi.fn(),
    spawnAgent: vi.fn((input) => {
      const id = `sess_${Math.random().toString(36).slice(2, 6)}`
      const desc = { ...baseDesc(id), cwd: input.cwd }
      descriptors.set(id, desc)
      return desc
    }),
    spawnPty: vi.fn(),
    sendPrompt: vi.fn(async () => {}),
    enqueuePrompt: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn((id) => descriptors.get(id)),
    attach: vi.fn(() => null),
    attachPty: vi.fn(() => null),
    findByIdOrName: vi.fn((q) => descriptors.get(q)),
    writeTerminalInput: vi.fn(() => false),
    readTerminalOutput: vi.fn(async () => ({ lines: [], nextCursor: 0 })),
    tailLines: vi.fn(async () => ({ lines: [], nextCursor: 0, skipped: 0 })),
    kill: vi.fn(),
    forget: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return vi.fn(async (_slug: string) => ({
    startSession: async ({ cwd }: { cwd: string }) => ({
      sessionId: `adapter_${Math.random().toString(36).slice(2, 6)}`,
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  }))
}

function waitNextTick(): Promise<void> {
  return new Promise(res => setTimeout(res, 0))
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("WorkflowRunner", () => {
  it("start() returns immediately with status=running", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      workflowId: "test",
      stages: [{ steps: [{ label: "step1", adapter: "mock" }] }],
    })

    expect(run.status).toBe("running")
    expect(run.runId).toMatch(/^wfrun_/)
  })

  it("runs all steps within a stage concurrently (barrier waits for both)", async () => {
    const bus = createSessionEventBus()
    const spawnedIds: string[] = []
    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => {
        const id = `sess_${spawnedIds.length}`
        spawnedIds.push(id)
        return {
          id,
          kind: "agent-cli" as const,
          workspaceSlug: "test",
          command: "mock",
          pid: null,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          cwd: input.cwd,
        }
      }),
      sendPrompt: vi.fn(async (sessionId: string) => {
        // Fire turn-end asynchronously (next tick) for both sessions.
        setTimeout(() => bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" }), 5)
      }),
      get: vi.fn((id) =>
        spawnedIds.includes(id)
          ? { id, kind: "agent-cli" as const, workspaceSlug: "test", command: "mock", pid: null, status: "running" as const, startedAt: "t" }
          : undefined
      ),
    })

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      workflowId: "parallel-test",
      stages: [
        {
          steps: [
            { label: "a", adapter: "mock", prompt: "do a" },
            { label: "b", adapter: "mock", prompt: "do b" },
          ],
        },
      ],
    })

    // Poll until terminal.
    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !["done", "failed", "cancelled"].includes(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }

    expect(final?.status).toBe("done")
    expect(spawnedIds).toHaveLength(2)
    expect(final?.stages).toHaveLength(1)
    expect(final?.stages[0]?.steps.every(s => s.status === "done")).toBe(true)
  })

  it("stage barrier: stage 2 does not start until stage 1 fully completes", async () => {
    const bus = createSessionEventBus()
    const spawnOrder: string[] = []
    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => {
        const id = `sess_${spawnOrder.length}`
        spawnOrder.push(input.label ?? id)
        return {
          id,
          kind: "agent-cli" as const,
          workspaceSlug: "test",
          command: "mock",
          pid: null,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          cwd: input.cwd,
        }
      }),
      sendPrompt: vi.fn(async (sessionId: string) => {
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      }),
      get: vi.fn((id) => ({ id, kind: "agent-cli" as const, workspaceSlug: "test", command: "mock", pid: null, status: "running" as const, startedAt: "t" })),
    })

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      workflowId: "stage-order",
      stages: [
        { steps: [{ label: "stage1-step", adapter: "mock", prompt: "go" }] },
        { steps: [{ label: "stage2-step", adapter: "mock", prompt: "go" }] },
      ],
    })

    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !["done", "failed", "cancelled"].includes(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }

    expect(final?.status).toBe("done")
    expect(final?.stages).toHaveLength(2)
    expect(final?.stages[0]?.status).toBe("done")
    expect(final?.stages[1]?.status).toBe("done")
  })

  it("sessionRef reuses an earlier step's session instead of spawning a new one", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => ({
        id: "sess_producer",
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
      })),
      sendPrompt: vi.fn(async (sessionId: string) => {
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      }),
      get: vi.fn((id) => (id === "sess_producer" ? { id, kind: "agent-cli" as const, workspaceSlug: "test", command: "mock", pid: null, status: "running" as const, startedAt: "t" } : undefined)),
    })

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    const run = await runner.start({
      workflowId: "session-ref-test",
      stages: [
        { steps: [{ label: "producer", adapter: "mock", prompt: "produce" }] },
        { steps: [{ label: "verifier", sessionRef: "producer", prompt: "verify" }] },
      ],
    })

    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !["done", "failed", "cancelled"].includes(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }

    expect(final?.status).toBe("done")
    const verifierStep = final?.stages[1]?.steps[0]
    expect(verifierStep?.sessionId).toBe("sess_producer")
    // Only one session was ever spawned (spawnAgent called once).
    expect((registry.spawnAgent as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it("a failed step fails the stage, the run, and skips remaining stages", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => ({
        id: "sess_fail",
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
      })),
      sendPrompt: vi.fn(async (sessionId: string) => {
        bus.emit({ type: "session:awaiting-input", sessionId, ts: "t" })
      }),
      get: vi.fn((id) =>
        id === "sess_fail"
          ? { id, kind: "agent-cli" as const, workspaceSlug: "test", command: "mock", pid: null, status: "running" as const, startedAt: "t", awaitingInput: true }
          : undefined
      ),
    })

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
    })

    // Default policy is "fail" when a session asks for input mid-step.
    const run = await runner.start({
      workflowId: "fail-test",
      stages: [
        { steps: [{ label: "step1", adapter: "mock", prompt: "go" }] },
        { steps: [{ label: "step2", adapter: "mock", prompt: "should not run" }] },
      ],
    })

    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !["done", "failed", "cancelled"].includes(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }

    expect(final?.status).toBe("failed")
    expect(final?.stages[0]?.status).toBe("failed")
    expect(final?.stages[1]?.status).toBe("pending")
  })

  it("cancel() stops the run", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: vi.fn(async () => ({
        startSession: async () => ({
          sessionId: "s",
          send: async function* () {
            await new Promise<void>(() => {})
            yield { kind: "text-delta", text: "" }
          },
          cancel: async () => {},
          close: async () => {},
        }),
      })),
    })

    const run = await runner.start({
      workflowId: "cancel-test",
      stages: [
        { steps: [{ label: "step1", adapter: "mock", prompt: "do something" }] },
        { steps: [{ label: "step2", adapter: "mock", prompt: "and more" }] },
      ],
    })

    runner.cancel(run.runId)
    await new Promise(res => setTimeout(res, 10))

    const status = runner.status(run.runId)
    expect(["cancelled", "running"]).toContain(status?.status)
  })

  it("list() returns all runs", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const isolated = join(mkdtempSync(join(tmpdir(), "workflow-list-")), "runs.json")
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath: isolated,
    })

    await runner.start({ workflowId: "w1", stages: [{ steps: [{ label: "s", adapter: "mock" }] }] })
    await runner.start({ workflowId: "w2", stages: [{ steps: [{ label: "s", adapter: "mock" }] }] })

    expect(runner.list()).toHaveLength(2)
  })
})

// ── Persistence tests ─────────────────────────────────────────────────

describe("WorkflowRunner persistence", () => {
  let tmpDir: string
  let persistPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "workflow-runner-test-"))
    persistPath = join(tmpDir, "workflow-runs.json")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("persists runs to disk on start()", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })

    const run = await runner.start({ workflowId: "persist-test", stages: [{ steps: [{ label: "s", adapter: "mock" }] }] })

    expect(existsSync(persistPath)).toBe(true)
    const raw = readFileSync(persistPath, "utf8")
    const parsed = JSON.parse(raw) as Array<{ runId: string }>
    expect(parsed.some(r => r.runId === run.runId)).toBe(true)
  })

  it("loads persisted runs on init", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry({
      sendPrompt: vi.fn(async (sessionId: string) => {
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      }),
    })

    const runner1 = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })

    const run = await runner1.start({ workflowId: "reload-test", stages: [{ steps: [{ label: "s", adapter: "mock", prompt: "go" }] }] })
    const terminal = new Set(["done", "failed", "cancelled"])
    for (let i = 0; i < 50; i++) {
      const s = runner1.status(run.runId)
      if (s && terminal.has(s.status)) break
      await new Promise(res => setTimeout(res, 10))
    }

    const runner2 = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })
    expect(runner2.status(run.runId)).toBeDefined()
    expect(runner2.list()).toHaveLength(1)
  })

  it("marks running/awaiting-input runs as failed on restart", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    const fakeRun = {
      runId: "wfrun_fakeid1",
      workflowId: "stale-run",
      status: "running",
      startedAt: new Date().toISOString(),
      stages: [{ index: 0, status: "running", steps: [{ index: 0, label: "step1", status: "running" }] }],
      result: { sessionIds: [] },
    }
    const fakeRun2 = {
      runId: "wfrun_fakeid2",
      workflowId: "stale-run2",
      status: "awaiting-input",
      startedAt: new Date().toISOString(),
      stages: [],
      result: { sessionIds: [] },
    }
    writeFileSync(persistPath, JSON.stringify([fakeRun, fakeRun2], null, 2), "utf8")

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })

    const s1 = runner.status("wfrun_fakeid1")
    const s2 = runner.status("wfrun_fakeid2")
    expect(s1?.status).toBe("failed")
    expect(s1?.error).toBe("interrupted by daemon restart")
    expect(s2?.status).toBe("failed")
    expect(s2?.error).toBe("interrupted by daemon restart")
  })

  it("handles missing or malformed persist file gracefully", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    const runner1 = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath: join(tmpDir, "nonexistent.json"),
    })
    expect(runner1.list()).toHaveLength(0)

    writeFileSync(persistPath, "not valid json", "utf8")
    const runner2 = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persistPath,
    })
    expect(runner2.list()).toHaveLength(0)
  })
})

// ── startFromFile tests ─────────────────────────────────────────────────

describe("WorkflowRunner.startFromFile", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "workflow-startFromFile-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeWorkflowMd(content: string): string {
    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(path, content, "utf8")
    return path
  }

  function makeStubTools() {
    const doubleTool = defineTool({
      id: "demo.double",
      description: "Double a number.",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
    })
    const addTenTool = defineTool({
      id: "demo.add-ten",
      description: "Add ten.",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
    })
    const provider = defineDriver({
      id: "math-builtin",
      name: "Math",
      description: "Trivial arithmetic.",
      kind: "builtin",
      implements: [
        { tool: "demo.double", version: "0.1.0" },
        { tool: "demo.add-ten", version: "0.1.0" },
      ],
      implementations: [
        implementTool(doubleTool, ({ input }) => ({ n: input.n * 2 })),
        implementTool(addTenTool, ({ input }) => ({ n: input.n + 10 })),
      ],
    })
    return {
      tools: { "demo.double": doubleTool, "demo.add-ten": addTenTool },
      candidates: [provider],
    }
  }

  it("loads and runs a declarative WORKFLOW.md to done with stub tools", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const { tools, candidates } = makeStubTools()
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileWorkflow(handle, { tools, candidates }),
    })

    const path = writeWorkflowMd(`---
name: Double then add
id: double-add
description: Double the input, then add ten.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: d
    kind: tool
    tool: demo.double
    inputs:
      n: $input.n
  - id: a
    kind: tool
    tool: demo.add-ten
    inputs:
      n: $steps.d.n
---

# Double then add
`)

    const run = await runner.startFromFile({ path, input: { n: 5 } })
    expect(run.status).toBe("running")
    expect(run.runId).toMatch(/^wfrun_/)
    expect(run.workflowId).toBe("double-add")

    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }

    expect(final?.status).toBe("done")
    expect(final?.stages[0]?.status).toBe("done")
    expect(final?.stages[0]?.steps[0]?.status).toBe("done")
  })

  it("exposes compiled agent step ids in run.stages and resolves sessionIds", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry({
      spawnAgent: vi.fn((input) => {
        return {
          id: "sess_review_001",
          kind: "agent-cli" as const,
          workspaceSlug: "test",
          command: "mock",
          pid: null,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          cwd: input.cwd,
          label: input.label,
        }
      }),
      sendPrompt: vi.fn(async (sessionId: string) => {
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      }),
      get: vi.fn((id) =>
        id === "sess_review_001"
          ? { id, kind: "agent-cli" as const, workspaceSlug: "test", command: "mock", pid: null, status: "running" as const, startedAt: "t" }
          : undefined
      ),
    })
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: {}, candidates: [] }),
    })

    writeFileSync(
      join(tmpDir, "entry.mjs"),
      `export default {
        name: "Review",
        id: "review-wf",
        description: "Review workflow.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [
          { id: "review", kind: "agent", adapter: "mock", prompt: () => "review it" },
        ],
      }`,
      "utf8",
    )
    const path = writeWorkflowMd(`---
name: Review
id: review-wf
description: Review workflow.
version: 0.1.0
entry: ./entry.mjs
inputs: {}
outputs: {}
steps:
  - id: review
    kind: agent
---
`)

    const run = await runner.startFromFile({ path })
    expect(run.status).toBe("running")

    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }

    expect(final?.status).toBe("done")
    expect(final?.stages).toHaveLength(1)
    expect(final?.stages[0]?.steps).toHaveLength(1)
    expect(final?.stages[0]?.steps[0]?.label).toBe("review")
    expect(final?.stages[0]?.steps[0]?.sessionId).toBe("sess_review_001")
    expect(final?.result?.sessionIds).toEqual(["sess_review_001"])
  })
})
