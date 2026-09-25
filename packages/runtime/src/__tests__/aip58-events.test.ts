/**
 * AIP-58 §5 event log — host-level harness (P3a).
 *
 * The lower-level conformance harness
 * (`@agentproto/workflow-runtime`'s `aip58-conformance.test.ts`) drives V1/
 * V2/V8 straight against `runWorkflow` with no host and no event log (that
 * layer is transport/host-agnostic — it doesn't know what "a run" is). This
 * file drives the SAME three vectors through the real `createWorkflowRunner`
 * (the host that actually owns `~/.agentproto/runs/<runId>/events.jsonl`)
 * and asserts the resulting event log's `type` sequence matches each
 * vector's own `expected.events` exactly — proving the host-written log,
 * not just the outcome rule underneath it, is wired correctly.
 *
 * Also covers F28 (`workflow_status` showing one opaque "workflow" step
 * instead of the real ones) — every leaf step kind, and map fan-out items
 * (`<id>[<index>]`), now show up in `run.stages`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { compileWorkflow, StepOutcomeError } from "@agentproto/workflow-runtime"
import { createWorkflowRunner } from "../workflow-runner.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionsRegistry, SessionDescriptor } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const VECTORS_DIR = join(__dirname, "../../../../specs/resources/aip-58/draft/vectors")

function loadVector(file: string): { expected: { events: string[] } } {
  return JSON.parse(readFileSync(join(VECTORS_DIR, file), "utf8")) as { expected: { events: string[] } }
}

function makeMockRegistry(overrides: Partial<SessionsRegistry> = {}): SessionsRegistry {
  const descriptors = new Map<string, SessionDescriptor>()
  return {
    spawnAgent: (input: { cwd: string; label?: string }) => {
      const id = `sess_${Math.random().toString(36).slice(2, 8)}`
      const desc = {
        id,
        kind: "agent-cli" as const,
        workspaceSlug: "test",
        command: "mock",
        pid: null,
        status: "running" as const,
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        label: input.label,
      }
      descriptors.set(id, desc)
      return desc
    },
    sendPrompt: async () => {},
    get: (id: string) => descriptors.get(id),
    ...overrides,
  } as unknown as SessionsRegistry
}

function makeMockAdapter(): AgentAdapterResolver {
  return (async () => ({
    startSession: async () => ({
      sessionId: `adapter_${Math.random().toString(36).slice(2, 6)}`,
      send: async function* () {},
      cancel: async () => {},
      close: async () => {},
    }),
    commandPreview: "mock-adapter",
  })) as unknown as AgentAdapterResolver
}

describe("AIP-58 §5 event log (host-level, vectors V1/V2/V8)", () => {
  let tmpDir: string
  let persistPath: string
  let runsRoot: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "aip58-events-"))
    persistPath = join(tmpDir, "workflow-runs.json")
    runsRoot = join(tmpDir, "runs")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("V1 — invalid input rejected before dispatch: run.created, run.failed ONLY (no run.started, no step.started)", async () => {
    const vector = loadVector("v1-invalid-input.json")
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: {}, candidates: [] }),
    })

    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: Pricing brief
id: pricing-brief
description: Requires a productUrl.
version: 1.0.0
inputs:
  type: object
  properties:
    productUrl: { type: string }
  required: ["productUrl"]
outputs: {}
steps:
  - id: fetch
    kind: tool
    tool: demo.noop
---
`,
      "utf8",
    )

    const run = await runner.startFromFile({ path, input: {} })
    expect(run.status).toBe("failed")
    expect(run.errorCode).toBe("invalid-input")

    const events = runner.events(run.runId)
    expect(events?.map(e => e.type)).toEqual(vector.expected.events)
    expect(events?.map(e => e.type)).toEqual(["run.created", "run.failed"])
  })

  it("V2 — agent step signals run.requestInput: run.created, run.started, step.started, step.suspended, run.suspended", async () => {
    const vector = loadVector("v2-suspended-input-required.json")
    const bus = createSessionEventBus()
    let runner!: ReturnType<typeof createWorkflowRunner>
    let requested = false
    const registry = makeMockRegistry({
      sendPrompt: async (sessionId: string) => {
        if (!requested) {
          requested = true
          runner.recordInputRequest(sessionId, { prompt: "what tone?", schema: { type: "object" } })
        }
        bus.emit({ type: "session:turn-end", sessionId, awaitingInput: false, ts: "t" })
      },
    })
    runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
    })

    const run = await runner.start({
      workflowId: "pricing-brief",
      stages: [{ steps: [{ label: "draft", adapter: "mock", prompt: "write it" }] }],
    })

    const suspendedOrFailed = new Set(["awaiting-input", "failed"])
    let parked = runner.status(run.runId)
    for (let i = 0; i < 100 && parked && !suspendedOrFailed.has(parked.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      parked = runner.status(run.runId)
    }
    expect(parked?.status).toBe("awaiting-input")

    const events = runner.events(run.runId)
    expect(events?.map(e => e.type)).toEqual(vector.expected.events)
    expect(events?.map(e => e.type)).toEqual([
      "run.created",
      "run.started",
      "step.started",
      "step.suspended",
      "run.suspended",
    ])
    expect(events?.every(e => e.runId === run.runId)).toBe(true)
    expect(events?.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it("V8 — a step fails { code: missing-output }: run.created, run.started, step.started, step.failed, run.failed", async () => {
    const vector = loadVector("v8-heuristic-not-suspend.json")
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()

    // The outcome rule itself (turn-ends-without-signal ⇒ missing-output,
    // hinted) is P2's job and is already conformance-tested at the
    // workflow-runtime layer (aip58-conformance.test.ts's own V8 case). This
    // drives the SAME error class (StepOutcomeError) through a tool step so
    // the event log's reaction to it is exercised without re-deriving a full
    // agent-transcript simulation here.
    const failingTool = defineTool({
      id: "demo.question",
      description: "Always resolves missing-output, hinted — simulates V8's agent turn.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
    const driver = defineDriver({
      id: "demo-question-driver",
      name: "Demo question driver",
      description: "Throws StepOutcomeError unconditionally.",
      kind: "builtin",
      implements: [{ tool: failingTool.id, version: "0.1.0" }],
      implementations: [
        implementTool(failingTool, () => {
          throw new StepOutcomeError(
            "draft",
            "missing-output",
            "step 'draft': missing-output — final message never matched outputSchema",
            "possible-input-request",
          )
        }),
      ],
    })

    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      persist: true,
      persistPath,
      runsRoot,
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: { "demo.question": failingTool }, candidates: [driver] }),
    })

    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: Pricing brief
id: pricing-brief
description: A single step that always fails missing-output.
version: 1.0.0
inputs: {}
outputs: {}
steps:
  - id: draft
    kind: tool
    tool: demo.question
---
`,
      "utf8",
    )

    const run = await runner.startFromFile({ path })
    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }
    expect(final?.status).toBe("failed")
    expect(final?.errorCode).toBe("missing-output")
    expect(final?.stages[0]?.steps.find(s => s.label === "draft")?.hint).toBe("possible-input-request")

    const events = runner.events(run.runId)
    expect(events?.map(e => e.type)).toEqual(vector.expected.events)
    expect(events?.map(e => e.type)).toEqual([
      "run.created",
      "run.started",
      "step.started",
      "step.failed",
      "run.failed",
    ])
    const stepFailed = events?.find(e => e.type === "step.failed")
    expect(stepFailed?.stepId).toBe("draft")
    expect((stepFailed?.data as { code?: string })?.code).toBe("missing-output")
  })
})

describe("AIP-58 §5 / F28 — workflow_status shows the REAL steps", () => {
  let tmpDir: string

  beforeEach(() => {
    // Rooted inside node_modules like workflow-runner.test.ts's own
    // startFromFile fixtures — vitest's module resolver refuses a dynamic
    // `import()` outside the project root, and a bare WORKFLOW.md with no
    // `entry.mjs` doesn't need it, but staying consistent avoids surprises.
    tmpDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".aip58-events-real-steps-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeIdentityTool() {
    const tool = defineTool({
      id: "demo.identity",
      description: "Returns its input unchanged.",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    })
    const driver = defineDriver({
      id: "demo-identity-driver",
      name: "Identity",
      description: "Returns input verbatim.",
      kind: "builtin",
      implements: [{ tool: tool.id, version: "0.1.0" }],
      implementations: [implementTool(tool, ({ input }) => input)],
    })
    return { tool, driver }
  }

  it("a tool-only WORKFLOW.md shows its real step labels — never the opaque 'workflow' placeholder", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const { tool, driver } = makeIdentityTool()
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: { "demo.identity": tool }, candidates: [driver] }),
    })

    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: Fetch then dedup
id: fetch-dedup
description: Two tool steps, no agent.
version: 0.1.0
inputs: {}
outputs: {}
steps:
  - id: fetch
    kind: tool
    tool: demo.identity
  - id: dedup
    kind: tool
    tool: demo.identity
---
`,
      "utf8",
    )

    const run = await runner.startFromFile({ path, input: {} })
    // The real steps are visible immediately, before execution even starts —
    // `collectStaticSteps` walks the compiled workflow up front.
    expect(run.stages[0]?.steps.map(s => s.label)).toEqual(["fetch", "dedup"])

    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }
    expect(final?.status).toBe("done")
    expect(final?.stages[0]?.steps.map(s => s.label)).toEqual(["fetch", "dedup"])
    expect(final?.stages[0]?.steps.every(s => s.status === "done")).toBe(true)
  })

  it("a map fan-out's per-item steps show up as '<id>[<index>]' — discovered dynamically", async () => {
    const bus = createSessionEventBus()
    const registry = makeMockRegistry()
    const { tool, driver } = makeIdentityTool()
    const runner = createWorkflowRunner({
      registry,
      sessionEvents: bus,
      resolveAgentAdapter: makeMockAdapter(),
      compileWorkflow: (handle) => compileWorkflow(handle, { tools: { "demo.identity": tool }, candidates: [driver] }),
    })

    const path = join(tmpDir, "WORKFLOW.md")
    writeFileSync(
      path,
      `---
name: Clean chunks
id: clean-chunks
description: Map over the input items, cleaning each.
version: 0.1.0
inputs:
  type: object
  properties:
    items: { type: array }
outputs: {}
steps:
  - id: clean
    kind: map
    over: $input.items
    steps:
      - id: clean
        kind: tool
        tool: demo.identity
---
`,
      "utf8",
    )

    const run = await runner.startFromFile({ path, input: { items: ["a", "b", "c"] } })
    const terminal = new Set(["done", "failed", "cancelled"])
    let final = runner.status(run.runId)
    for (let i = 0; i < 100 && final && !terminal.has(final.status); i++) {
      await new Promise(res => setTimeout(res, 10))
      final = runner.status(run.runId)
    }
    expect(final?.status).toBe("done")
    expect(final?.stages[0]?.steps.map(s => s.label).sort()).toEqual(["clean[0]", "clean[1]", "clean[2]"])
    expect(final?.stages[0]?.steps.every(s => s.status === "done")).toBe(true)
    // No phantom "clean" (the map's own static id) or "clean__body" (the
    // synthetic multi-step-body wrapper — inapplicable here, single-step
    // body) row alongside the real per-item ones.
    expect(final?.stages[0]?.steps.some(s => s.label === "clean")).toBe(false)
  })
})
