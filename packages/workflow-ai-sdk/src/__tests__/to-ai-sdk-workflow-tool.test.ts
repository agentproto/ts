/**
 * `toAiSdkWorkflowTool` against the same fixture WORKFLOW.md
 * `to-mastra-workflow.test.ts` uses (a real manifest source, compiled via
 * `compileWorkflowManifest`) — proving both projections accept the exact
 * same compiled input. Unlike the Mastra projection, there's no per-step
 * structure to assert here (the whole workflow is one tool call), so these
 * tests cover: the tool's shape, execution against a fake tool driver, and
 * the eager unmapped-kind rejection.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import {
  compileWorkflowManifest,
  type Bindings,
  type RuntimeWorkflow,
} from "@agentproto/workflow-runtime"
import { toAiSdkWorkflowTool, WorkflowProjectionError } from "../index.js"

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

describe("toAiSdkWorkflowTool", () => {
  it("wraps the compiled workflow as one dynamicTool, description defaulting to the workflow's own", () => {
    const compiled = compileWorkflowManifest(FIXTURE_WORKFLOW_MD, { tools, candidates })
    const tool = toAiSdkWorkflowTool(compiled)
    expect(tool.type).toBe("dynamic")
    expect(tool.description).toBe("Double the input, then add ten.")
    expect(typeof tool.execute).toBe("function")
  })

  it("honors an explicit description override", () => {
    const compiled = compileWorkflowManifest(FIXTURE_WORKFLOW_MD, { tools, candidates })
    const tool = toAiSdkWorkflowTool(compiled, { description: "custom" })
    expect(tool.description).toBe("custom")
  })

  it("runs the whole compiled workflow through runWorkflow behind one call", async () => {
    const compiled = compileWorkflowManifest(FIXTURE_WORKFLOW_MD, { tools, candidates })
    const tool = toAiSdkWorkflowTool(compiled)
    const result = await tool.execute!({ n: 5 }, { toolCallId: "t1", messages: [] })
    // 5 → double 10 → add ten 20
    expect(result).toEqual({ n: 20 })
  })

  it("propagates AI SDK's abortSignal into runWorkflow's signal", async () => {
    const slowTool = defineTool({
      id: "demo.slow",
      description: "Resolves only on abort.",
      inputSchema: z.object({}),
      outputSchema: z.object({ aborted: z.boolean() }),
    })
    const slowProvider = defineDriver({
      id: "slow-builtin",
      name: "Slow",
      description: "Waits for abort.",
      kind: "builtin",
      implements: [{ tool: "demo.slow", version: "0.1.0" }],
      implementations: [
        implementTool(slowTool, ({ signal }) => {
          return new Promise<{ aborted: boolean }>((resolve) => {
            signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true })
          })
        }),
      ],
    })
    const compiled: RuntimeWorkflow = {
      id: "waits",
      steps: [
        { kind: "tool", id: "wait", tool: slowTool, candidates: [slowProvider], input: () => ({}) },
      ],
    }
    const tool = toAiSdkWorkflowTool(compiled)
    const ac = new AbortController()
    const promise = tool.execute!({}, { toolCallId: "t2", messages: [], abortSignal: ac.signal })
    ac.abort()
    await expect(promise).resolves.toEqual({ aborted: true })
  })
})

describe("toAiSdkWorkflowTool — unmapped kinds fail loud", () => {
  it("throws WorkflowProjectionError eagerly, at wrap time, for a top-level suspend step", () => {
    const wf: RuntimeWorkflow = {
      id: "has-suspend",
      steps: [{ kind: "suspend", id: "wait", on: ["approval.granted"] }],
    }
    expect(() => toAiSdkWorkflowTool(wf)).toThrow(WorkflowProjectionError)
    expect(() => toAiSdkWorkflowTool(wf)).toThrow(/not projectable to AI SDK/)
  })

  it("throws for an approval step nested inside a subworkflow child", () => {
    const child: RuntimeWorkflow = {
      id: "child",
      steps: [{ kind: "approval", id: "sign-off", prompt: () => "ok?", approvers: ["ops"] }],
    }
    const wf: RuntimeWorkflow = {
      id: "parent",
      steps: [{ kind: "subworkflow", id: "child_run", workflow: child }],
    }
    expect(() => toAiSdkWorkflowTool(wf)).toThrow(/child_run\.sign-off.*approval/)
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
    expect(() => toAiSdkWorkflowTool(wf)).toThrow(/pipeline/)
  })
})
