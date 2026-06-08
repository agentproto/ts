/**
 * The step-walker over inline contracts (the framework can't depend on a
 * catalogue): tool output threads into later steps' bindings, `map` fans a tool
 * over an array with the element exposed as `bindings.item`, `transform`
 * combines + filters, and `branch` picks a path from a predicate.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import {
  runWorkflow,
  WorkflowSuspendedError,
  type RuntimeWorkflow,
} from "../index.js"

// double(n) and addTen(n) — two trivial tools to thread between.
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
const candidates = [provider]

describe("runWorkflow", () => {
  it("threads one tool's output into the next step's input", async () => {
    const wf: RuntimeWorkflow = {
      id: "double-then-add",
      steps: [
        {
          kind: "tool",
          id: "d",
          tool: doubleTool,
          candidates,
          input: (b) => ({ n: (b.input as { n: number }).n }),
        },
        {
          kind: "tool",
          id: "a",
          tool: addTenTool,
          candidates,
          input: (b) => ({ n: (b.steps.d as { n: number }).n }),
        },
      ],
    }
    const { output, bindings } = await runWorkflow({ workflow: wf, input: { n: 5 } })
    expect((bindings.steps.d as { n: number }).n).toBe(10)
    expect((output as { n: number }).n).toBe(20)
  })

  it("maps a tool over an array via bindings.item, then transforms + filters", async () => {
    const wf: RuntimeWorkflow = {
      id: "map-double-filter",
      steps: [
        {
          kind: "map",
          id: "doubled",
          parallelism: 2,
          over: (b) => (b.input as { xs: number[] }).xs,
          body: () => ({
            kind: "tool",
            id: "d",
            tool: doubleTool,
            candidates,
            input: (b) => ({ n: b.item as number }),
          }),
        },
        {
          kind: "transform",
          id: "big",
          compute: (b) =>
            (b.steps.doubled as Array<{ n: number }>)
              .map((o) => o.n)
              .filter((n) => n >= 6),
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, input: { xs: [1, 2, 3, 4] } })
    // [1,2,3,4] → doubled [2,4,6,8] → keep ≥6 → [6,8]
    expect(output).toEqual([6, 8])
  })

  it("branch picks a path from a predicate over the bindings", async () => {
    const wf: RuntimeWorkflow = {
      id: "branchy",
      steps: [
        {
          kind: "branch",
          id: "pick",
          cond: (b) => (b.input as { big: boolean }).big,
          then: [
            {
              kind: "transform",
              id: "out",
              compute: () => "took-then",
            },
          ],
          otherwise: [
            {
              kind: "transform",
              id: "out",
              compute: () => "took-otherwise",
            },
          ],
        },
      ],
      output: (b) => b.steps.out,
    }
    expect(
      (await runWorkflow({ workflow: wf, input: { big: true } })).output,
    ).toBe("took-then")
    expect(
      (await runWorkflow({ workflow: wf, input: { big: false } })).output,
    ).toBe("took-otherwise")
  })
})

describe("runWorkflow — parallel / approval / suspend / subworkflow", () => {
  it("parallel runs branches concurrently and binds outputs by branch id", async () => {
    const wf: RuntimeWorkflow = {
      id: "par",
      steps: [
        {
          kind: "parallel",
          id: "fan",
          branches: [
            {
              id: "a",
              steps: [
                {
                  kind: "tool",
                  id: "da",
                  tool: doubleTool,
                  candidates,
                  input: () => ({ n: 3 }),
                },
              ],
            },
            {
              id: "b",
              steps: [
                {
                  kind: "tool",
                  id: "db",
                  tool: addTenTool,
                  candidates,
                  input: () => ({ n: 3 }),
                },
              ],
            },
          ],
        },
      ],
      output: (b) => b.steps.fan,
    }
    const { output } = await runWorkflow({ workflow: wf })
    expect(output).toEqual({ a: { n: 6 }, b: { n: 13 } })
  })

  it("approval runs onReject when the host rejects", async () => {
    const wf: RuntimeWorkflow = {
      id: "appr",
      steps: [
        {
          kind: "approval",
          id: "gate",
          prompt: () => "Send to the client?",
          onApprove: [{ kind: "transform", id: "out", compute: () => "sent" }],
          onReject: [{ kind: "transform", id: "out", compute: () => "held" }],
        },
      ],
      output: (b) => b.steps.out,
    }
    expect((await runWorkflow({ workflow: wf })).output).toBe("sent") // default auto-approve
    expect(
      (await runWorkflow({ workflow: wf, approve: () => false })).output,
    ).toBe("held")
  })

  it("suspend resumes from the host hook, or throws without one", async () => {
    const wf: RuntimeWorkflow = {
      id: "susp",
      steps: [{ kind: "suspend", id: "wait", on: ["payment.confirmed"] }],
      output: (b) => b.steps.wait,
    }
    const resumed = await runWorkflow({
      workflow: wf,
      resume: ({ on }) => ({ event: on[0], ok: true }),
    })
    expect(resumed.output).toEqual({ event: "payment.confirmed", ok: true })

    await expect(runWorkflow({ workflow: wf })).rejects.toBeInstanceOf(
      WorkflowSuspendedError,
    )
  })

  it("subworkflow runs nested with isolated bindings, binds its output", async () => {
    const child: RuntimeWorkflow = {
      id: "child",
      steps: [
        {
          kind: "tool",
          id: "d",
          tool: doubleTool,
          candidates,
          input: (b) => ({ n: (b.input as { n: number }).n }),
        },
      ],
      output: (b) => (b.steps.d as { n: number }).n,
    }
    const parent: RuntimeWorkflow = {
      id: "parent",
      steps: [
        {
          kind: "subworkflow",
          id: "sub",
          workflow: child,
          input: (b) => ({ n: (b.input as { n: number }).n + 1 }),
        },
      ],
      output: (b) => b.steps.sub,
    }
    // parent input n=4 → child sees n=5 → doubled → 10
    expect((await runWorkflow({ workflow: parent, input: { n: 4 } })).output).toBe(10)
  })
})
