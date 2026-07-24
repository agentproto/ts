/**
 * The declarative-manifest path: author an AIP-15 WORKFLOW with `defineWorkflow`,
 * compile it against a tool registry, run it. Proves the reference grammar
 * (`$input` / `$steps.<id>` / `$item`) threads data through a real manifest, and
 * that a non-linear `next` goto is rejected with a clear diagnostic.
 */

import { describe, it, expect } from "vitest"
import { z } from "zod"
import { defineTool } from "@agentproto/tool"
import { defineDriver, implementTool } from "@agentproto/driver"
import { defineWorkflow } from "@agentproto/workflow"
import {
  compileWorkflow,
  runWorkflow,
  WorkflowCompileError,
  resolveRef,
  evalPredicate,
} from "../index.js"

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

describe("compileWorkflow", () => {
  it("resolveRef / evalPredicate read the binding grammar", () => {
    const b = { input: { n: 3 }, steps: { d: { n: 6 } }, item: { x: 9 }, index: 1 }
    expect(resolveRef("$input.n", b)).toBe(3)
    expect(resolveRef("$steps.d.n", b)).toBe(6)
    expect(resolveRef("$item.x", b)).toBe(9)
    expect(resolveRef("$index", b)).toBe(1)
    expect(evalPredicate("$steps.d.n >= 6", b)).toBe(true)
    expect(evalPredicate("$input.n == 4", b)).toBe(false)
  })

  it("compiles a linear two-step manifest and threads $steps refs", async () => {
    const wf = defineWorkflow({
      name: "Double then add",
      id: "double-add",
      description: "Double the input, then add ten.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "d",
          kind: "tool",
          tool: "demo.double",
          inputs: { n: "$input.n" },
        },
        {
          id: "a",
          kind: "tool",
          tool: "demo.add-ten",
          inputs: { n: "$steps.d.n" },
        },
      ],
    })

    const compiled = compileWorkflow(wf, { tools, candidates })
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 5 } })
    // 5 → double 10 → add ten 20
    expect((output as { n: number }).n).toBe(20)
  })

  it("compiles a map-over manifest using $item", async () => {
    const wf = defineWorkflow({
      name: "Double each",
      id: "double-each",
      description: "Double every element.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "doubled",
          kind: "map",
          over: "$input.xs",
          parallelism: 2,
          steps: [
            {
              id: "d",
              kind: "tool",
              tool: "demo.double",
              inputs: { n: "$item" },
            },
          ],
        },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { output } = await runWorkflow({
      workflow: compiled,
      input: { xs: [1, 2, 3] },
    })
    expect((output as Array<{ n: number }>).map((o) => o.n)).toEqual([2, 4, 6])
  })

  it("passes an entry-based `transform` step through unchanged, threading a prior tool step's output", async () => {
    // `transform` isn't a declarative manifest kind (no string expression
    // language for `compute`) — it only reaches the compiler from an
    // ENTRY-based handle, already built as a runtime TransformStep. This is
    // what lets an entry.mjs serialize a tool step's output (e.g.
    // `JSON.stringify`) into a plain string a later tool step can consume,
    // something the `$steps.*` ref grammar alone can't do.
    const handle = {
      id: "transform-demo",
      description: "demo",
      steps: [
        { id: "d", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        {
          id: "t",
          kind: "transform",
          compute: (b: { steps: Record<string, unknown> }) =>
            `n=${(b.steps.d as { n: number }).n}`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const compiled = compileWorkflow(handle, { tools, candidates })
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 5 } })
    expect(output).toBe("n=10")
  })

  it("maps the workflow output from a declarative `result` expression", async () => {
    const wf = defineWorkflow({
      name: "Double, report both",
      id: "double-report",
      description: "Double the input and return both the raw and doubled value.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      result: { raw: "$input.n", doubled: "$steps.d.n" },
      steps: [
        { id: "d", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 7 } })
    expect(output).toEqual({ raw: 7, doubled: 14 })
  })

  it("rejects a non-linear next goto with a diagnostic", () => {
    const wf = defineWorkflow({
      name: "Goto",
      id: "goto",
      description: "A non-linear jump the structured subset refuses.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "d",
          kind: "tool",
          tool: "demo.double",
          inputs: { n: "$input.n" },
          next: "z",
        },
        { id: "a", kind: "tool", tool: "demo.add-ten", inputs: { n: 1 } },
      ],
    })
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(
      WorkflowCompileError,
    )
  })
})
