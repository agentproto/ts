/**
 * `toMastraWorkflow` against two fixtures: a real WORKFLOW.md source (the
 * declarative subset `compileWorkflowManifest` supports — chained `tool`
 * steps) proving the compile→project seam end to end, and a hand-built
 * `RuntimeWorkflow` (same convention `workflow-runtime`'s own
 * `run-workflow.test.ts` uses) exercising branch/map/transform together —
 * kinds a declarative manifest can't express (goto-style `branch` is
 * rejected by `compileWorkflow` itself; see `compile-workflow.ts`).
 * Structure is asserted via the projected `Workflow`'s own introspection
 * (`.steps`, `.stepGraph`); execution runs the real Mastra engine against
 * fake in-process tools (no network, no real Mastra-hosted infra).
 */

import { describe, it, expect, vi } from "vitest"
import { z } from "zod"
import { Mastra } from "@mastra/core"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import {
  compileWorkflowManifest,
  type AgentSessionHost,
  type Bindings,
  type RuntimeWorkflow,
} from "@agentproto/workflow-runtime"
import { toMastraWorkflow, mapMastraInputError, WorkflowProjectionError } from "../index.js"

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
const tools = { "demo.double": doubleTool, "demo.add-ten": addTenTool }
const candidates = [provider]

const FIXTURE_WORKFLOW_MD = `---
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
`

describe("toMastraWorkflow — WORKFLOW.md fixture (tool chain)", () => {
  it("projects a real WORKFLOW.md's compiled step graph onto Mastra steps", () => {
    const compiled = compileWorkflowManifest(FIXTURE_WORKFLOW_MD, { tools, candidates })
    const mastraWorkflow = toMastraWorkflow(compiled)
    expect(mastraWorkflow.id).toBe("double-add")
    expect(Object.keys(mastraWorkflow.steps)).toEqual(["d", "a"])
  })

  it("executes against the fake tool driver end to end", async () => {
    const compiled = compileWorkflowManifest(FIXTURE_WORKFLOW_MD, { tools, candidates })
    const mastraWorkflow = toMastraWorkflow(compiled)
    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: { n: 5 } })
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("unreachable")
    // 5 → double 10 → add ten 20
    expect(result.result).toEqual({ n: 20 })
  })
})

describe("toMastraWorkflow — hand-built RuntimeWorkflow (branch + map + transform)", () => {
  function kitchenSink(): RuntimeWorkflow {
    return {
      id: "kitchen-sink",
      steps: [
        {
          kind: "tool",
          id: "double",
          tool: doubleTool,
          candidates,
          input: (b: Bindings) => ({ n: (b.input as { n: number }).n }),
        },
        {
          kind: "branch",
          id: "pick",
          cond: (b: Bindings) => (b.steps.double as { n: number }).n > 10,
          then: [{ kind: "transform", id: "label", compute: () => "big" }],
          otherwise: [{ kind: "transform", id: "label", compute: () => "small" }],
        },
        {
          kind: "map",
          id: "doubled_list",
          parallelism: 2,
          over: (b: Bindings) => (b.input as { xs: number[] }).xs,
          body: () => ({
            kind: "tool",
            id: "d2",
            tool: doubleTool,
            candidates,
            input: (b: Bindings) => ({ n: b.item as number }),
          }),
        },
        {
          kind: "transform",
          id: "sum",
          compute: (b: Bindings) =>
            (b.steps.doubled_list as Array<{ n: number }>).reduce((s, o) => s + o.n, 0),
        },
      ],
    }
  }

  it("projects branch/map/transform onto Mastra's .branch()/.foreach() combinators", () => {
    const mastraWorkflow = toMastraWorkflow(kitchenSink())
    const stepIds = Object.keys(mastraWorkflow.steps)
    expect(stepIds).toContain("double")
    expect(stepIds).toContain("pick__then")
    expect(stepIds).toContain("pick__else")
    expect(stepIds).toContain("doubled_list__items")
    expect(stepIds).toContain("doubled_list__body")
    expect(stepIds).toContain("sum")
  })

  it("executes the projected workflow, threading bindings the same way the engine does", async () => {
    const mastraWorkflow = toMastraWorkflow(kitchenSink())
    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: { n: 6, xs: [1, 2, 3] } })
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("unreachable")
    // n=6 → double 12 (>10) → branch picks "big" → xs [1,2,3] doubled → [2,4,6] → sum 12
    expect(result.result).toBe(12)
    // Mastra's own per-step result tracking confirms the right branch arm ran
    // (mutual exclusion via the negated condition) and the foreach body
    // aggregated exactly like the engine's own `map` step would.
    const steps = result.steps as Record<string, { output?: unknown } | undefined>
    expect(steps.double?.output).toEqual({ n: 12 })
    expect(steps["pick__then"]?.output).toBe("big")
    expect(steps["pick__else"]).toBeUndefined()
    expect(steps["doubled_list__bind"]?.output).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }])
  })
})

describe("toMastraWorkflow — parallel / loop / subworkflow", () => {
  it("parallel: runs branches concurrently, binds a record keyed by branch id", async () => {
    const wf: RuntimeWorkflow = {
      id: "parallel-demo",
      steps: [
        {
          kind: "parallel",
          id: "both",
          branches: [
            { id: "a", steps: [{ kind: "transform", id: "av", compute: (b: Bindings) => (b.input as { n: number }).n + 1 }] },
            { id: "b", steps: [{ kind: "transform", id: "bv", compute: (b: Bindings) => (b.input as { n: number }).n + 2 }] },
          ],
        },
        {
          kind: "transform",
          id: "combo",
          compute: (b: Bindings) => {
            const both = b.steps.both as { a: number; b: number }
            return both.a + both.b
          },
        },
      ],
    }
    const mastraWorkflow = toMastraWorkflow(wf)
    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: { n: 10 } })
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("unreachable")
    // n=10 → a=11, b=12 → combo=23
    expect(result.result).toBe(23)
  })

  it("loop: enforces maxIterations via Mastra's native iterationCount", async () => {
    const wf: RuntimeWorkflow = {
      id: "loop-demo",
      steps: [
        {
          kind: "loop",
          id: "count_to_3",
          maxIterations: 10,
          while: (b: Bindings) => ((b.steps.tick as number) ?? 0) < 3,
          body: [{ kind: "transform", id: "tick", compute: (b: Bindings) => ((b.steps.tick as number) ?? 0) + 1 }],
        },
      ],
    }
    const mastraWorkflow = toMastraWorkflow(wf)
    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: {} })
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("unreachable")
    expect(result.result).toBe(3)
  })

  it("loop: never runs the body when the condition is false from the start", async () => {
    const wf: RuntimeWorkflow = {
      id: "loop-skip",
      steps: [
        {
          kind: "loop",
          id: "never",
          maxIterations: 10,
          while: () => false,
          body: [
            {
              kind: "transform",
              id: "boom",
              compute: () => {
                throw new Error("body must not run")
              },
            },
          ],
        },
      ],
    }
    const mastraWorkflow = toMastraWorkflow(wf)
    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: {} })
    expect(result.status).toBe("success")
  })

  it("subworkflow: runs the child through an isolated runWorkflow sub-run", async () => {
    const child: RuntimeWorkflow = {
      id: "child",
      steps: [
        {
          kind: "tool",
          id: "double",
          tool: doubleTool,
          candidates,
          input: (b: Bindings) => ({ n: (b.input as { n: number }).n }),
        },
      ],
    }
    const wf: RuntimeWorkflow = {
      id: "parent",
      steps: [
        {
          kind: "subworkflow",
          id: "child_run",
          workflow: child,
          input: (b: Bindings) => ({ n: (b.input as { n: number }).n }),
        },
      ],
    }
    const mastraWorkflow = toMastraWorkflow(wf)
    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: { n: 7 } })
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("unreachable")
    expect(result.result).toEqual({ n: 14 })
  })
})

describe("toMastraWorkflow — suspend / approval (native Mastra suspend/resume)", () => {
  it("suspend: suspends on first run, resumes with the payload bound under the step's id", async () => {
    const wf: RuntimeWorkflow = {
      id: "suspend-demo",
      steps: [{ kind: "suspend", id: "wait", on: ["approval.granted"] }],
    }
    const mastraWorkflow = toMastraWorkflow(wf)
    // `run.resume()` looks its run snapshot up from storage — registering
    // with a `Mastra` instance (default in-memory store) is what any Mastra
    // caller wanting suspend/resume does; `toMastraWorkflow` builds the
    // workflow but deliberately doesn't own storage/host wiring.
    const mastra = new Mastra({ workflows: { "suspend-demo": mastraWorkflow } })
    const run = await mastra.getWorkflow("suspend-demo").createRun()
    const started = await run.start({ inputData: {} })
    expect(started.status).toBe("suspended")

    const resumed = await run.resume({ step: "wait", resumeData: { ok: true } })
    expect(resumed.status).toBe("success")
    if (resumed.status !== "success") throw new Error("unreachable")
    expect(resumed.result).toEqual({ ok: true })
  })

  it("approval: suspends with the request, resumes onApprove and runs its followups", async () => {
    const wf: RuntimeWorkflow = {
      id: "approval-demo",
      steps: [
        {
          kind: "approval",
          id: "sign-off",
          prompt: () => "ship it?",
          approvers: ["ops"],
          onApprove: [{ kind: "transform", id: "shipped", compute: () => "shipped" }],
          onReject: [{ kind: "transform", id: "shipped", compute: () => "blocked" }],
        },
        // Reads the approval's onApprove followup back out of the shared
        // `$steps` bindings bag — proving the followup ran and bound under
        // its OWN id (not just folded into "sign-off"'s own `{approved,...}`
        // output), the same shared-bindings model `branchArm` uses.
        { kind: "transform", id: "after", compute: (b: Bindings) => b.steps["shipped"] },
      ],
    }
    const mastraWorkflow = toMastraWorkflow(wf)
    const mastra = new Mastra({ workflows: { "approval-demo": mastraWorkflow } })
    const run = await mastra.getWorkflow("approval-demo").createRun()
    const started = await run.start({ inputData: {} })
    expect(started.status).toBe("suspended")

    const resumed = await run.resume({ step: "sign-off", resumeData: { approved: true, who: "ops-lead" } })
    expect(resumed.status).toBe("success")
    if (resumed.status !== "success") throw new Error("unreachable")
    expect(resumed.result).toBe("shipped")
    const steps = resumed.steps as Record<string, { output?: unknown } | undefined>
    expect(steps["sign-off"]?.output).toEqual({ approved: true, who: "ops-lead" })
  })

  it("throws for a suspend step nested inside a branch arm — no per-step suspend boundary there", () => {
    const wf: RuntimeWorkflow = {
      id: "nested-suspend",
      steps: [
        {
          kind: "branch",
          id: "gate",
          cond: () => true,
          then: [{ kind: "suspend", id: "wait", on: ["x"] }],
        },
      ],
    }
    expect(() => toMastraWorkflow(wf)).toThrow(/gate\.wait.*suspend/)
  })
})

describe("toMastraWorkflow — unmapped kinds fail loud", () => {
  it("throws for a gate step, before building anything — no public seam to reuse the runtime's ref-string resolution", () => {
    const wf: RuntimeWorkflow = {
      id: "has-gate",
      steps: [{ kind: "gate", id: "check", command: "true" }],
    }
    expect(() => toMastraWorkflow(wf)).toThrow(WorkflowProjectionError)
    expect(() => toMastraWorkflow(wf)).toThrow(/not projectable to Mastra/)
  })

  it("throws for an approval step nested inside a branch arm", () => {
    const wf: RuntimeWorkflow = {
      id: "nested-approval",
      steps: [
        {
          kind: "branch",
          id: "gate",
          cond: () => true,
          then: [
            {
              kind: "approval",
              id: "sign-off",
              prompt: () => "ok?",
              approvers: ["ops"],
            },
          ],
        },
      ],
    }
    expect(() => toMastraWorkflow(wf)).toThrow(/gate\.sign-off.*approval/)
  })

  it("throws for a pipeline step (not covered by the design spec this package implements)", () => {
    const wf: RuntimeWorkflow = {
      id: "has-pipeline",
      steps: [
        {
          kind: "pipeline",
          id: "fan",
          over: (b: Bindings) => (b.input as { xs: unknown[] }).xs,
          stages: [() => ({ kind: "transform", id: "noop", compute: (b: Bindings) => b.item })],
        },
      ],
    }
    expect(() => toMastraWorkflow(wf)).toThrow(/pipeline/)
  })

  it("throws for a gate step nested inside a loop body too — ALWAYS unprojectable, not just top-level", () => {
    const wf: RuntimeWorkflow = {
      id: "nested-gate",
      steps: [
        { kind: "loop", id: "retry", while: () => true, maxIterations: 1, body: [{ kind: "gate", id: "check", command: "true" }] },
      ],
    }
    expect(() => toMastraWorkflow(wf)).toThrow(/retry\.check.*gate/)
  })
})

describe("toMastraWorkflow — schema projection", () => {
  it("workflow-level inputSchema: rejects invalid input before any step runs, via mapMastraInputError", async () => {
    const impl = vi.fn(() => ({ n: 1 }))
    const tool = defineTool({
      id: "demo.needs-n",
      description: "fake",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
    })
    const driver = defineDriver({
      id: "needs-n-builtin",
      name: "Needs n",
      description: "fake",
      kind: "builtin",
      implements: [{ tool: tool.id, version: "0.1.0" }],
      implementations: [implementTool(tool, impl)],
    })
    const wf: RuntimeWorkflow = {
      id: "needs-n",
      steps: [{ kind: "tool", id: "fetch", tool, candidates: [driver], input: () => ({ n: 1 }) }],
    }
    const mastraWorkflow = toMastraWorkflow(wf, {
      inputsSchema: { productUrl: { type: "string", required: true } },
    })
    const run = await mastraWorkflow.createRun()
    let caught: unknown
    try {
      await run.start({ inputData: {} })
    } catch (err) {
      caught = err
    }
    const mapped = mapMastraInputError(caught)
    expect(mapped).toBeDefined()
    expect(mapped?.code).toBe("invalid-input")
    expect(mapped?.fields).toContain("productUrl")
    expect(impl).not.toHaveBeenCalled()
  })

  it("workflow-level inputSchema: passes through fields the manifest's `inputs` block never declared", async () => {
    const wf: RuntimeWorkflow = {
      id: "loose-input",
      steps: [{ kind: "transform", id: "echo", compute: (b: Bindings) => b.input }],
    }
    const mastraWorkflow = toMastraWorkflow(wf, {
      inputsSchema: { productUrl: { type: "string", required: true } },
    })
    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: { productUrl: "https://x", extra: "kept" } })
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("unreachable")
    expect(result.result).toEqual({ productUrl: "https://x", extra: "kept" })
  })

  it("tool step: projects the TOOL contract's real outputSchema instead of z.any()", () => {
    const wf: RuntimeWorkflow = {
      id: "tool-schema",
      steps: [{ kind: "tool", id: "d", tool: doubleTool, candidates, input: (b: Bindings) => ({ n: (b.input as { n: number }).n }) }],
    }
    const mastraWorkflow = toMastraWorkflow(wf)
    const outputSchema = mastraWorkflow.steps["d"].outputSchema
    expect(outputSchema.safeParse({ n: 5 }).success).toBe(true)
    expect(outputSchema.safeParse({ n: "not a number" }).success).toBe(false)
  })

  it("agent step: outputSchema wraps the declared schema in the real { sessionId, output } return shape", async () => {
    const outputSchema = z.object({ summary: z.string() })
    const host: AgentSessionHost = {
      spawn: vi.fn(async () => "sess_fake"),
      sendPromptAndWait: vi.fn(async () => {}),
      resolveByLabel: vi.fn(() => undefined),
      readFinalMessage: vi.fn(async () => JSON.stringify({ summary: "hi" })),
    }
    const wf: RuntimeWorkflow = {
      id: "agent-schema",
      steps: [{ kind: "agent", id: "draft", adapter: "mock", prompt: () => "go", outputSchema }],
    }
    const mastraWorkflow = toMastraWorkflow(wf, { agents: host })
    const step = mastraWorkflow.steps["draft"]
    expect(step.outputSchema.safeParse({ sessionId: "x", output: { summary: "hi" } }).success).toBe(true)
    expect(step.outputSchema.safeParse({ summary: "hi" }).success).toBe(false) // bare shape, not the real return

    const run = await mastraWorkflow.createRun()
    const result = await run.start({ inputData: {} })
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("unreachable")
    expect(result.result).toEqual({ sessionId: "sess_fake", output: { summary: "hi" } })
  })
})
