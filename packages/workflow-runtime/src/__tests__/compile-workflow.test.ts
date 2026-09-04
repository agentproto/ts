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
  buildAgentStep,
  compileWorkflow,
  runWorkflow,
  WorkflowCompileError,
  resolveRef,
  evalPredicate,
  type AgentStep,
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
/** Throws for a negative input, otherwise doubles — exercises a map's
 *  `onError: "collect"` path without a real I/O failure. */
const flakyTool = defineTool({
  id: "demo.flaky",
  description: "Throws on a negative input, otherwise doubles.",
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
    { tool: "demo.flaky", version: "0.1.0" },
  ],
  implementations: [
    implementTool(doubleTool, ({ input }) => ({ n: input.n * 2 })),
    implementTool(addTenTool, ({ input }) => ({ n: input.n + 10 })),
    implementTool(flakyTool, ({ input }) => {
      if (input.n < 0) throw new Error(`flaky: negative input ${input.n}`)
      return { n: input.n * 2 }
    }),
  ],
})
const tools = {
  "demo.double": doubleTool,
  "demo.add-ten": addTenTool,
  "demo.flaky": flakyTool,
}
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

  it("a declarative map's `onError: collect` reaches the compiled step — one item failing doesn't abort the run", async () => {
    const wf = defineWorkflow({
      name: "Double each, tolerant",
      id: "double-each-tolerant",
      description: "Double every element, collecting per-item failures.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "doubled",
          kind: "map",
          over: "$input.xs",
          onError: "collect",
          steps: [
            {
              id: "d",
              kind: "tool",
              tool: "demo.flaky",
              inputs: { n: "$item" },
            },
          ],
        },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { output } = await runWorkflow({
      workflow: compiled,
      input: { xs: [1, -1, 3] },
    })
    const tolerant = output as {
      results: Array<
        | { status: "fulfilled"; index: number; value: { n: number } }
        | { status: "rejected"; index: number; error: string }
      >
      succeeded: number
      failed: number
    }
    expect(tolerant.succeeded).toBe(2)
    expect(tolerant.failed).toBe(1)
    expect(tolerant.results[0]).toMatchObject({ status: "fulfilled", value: { n: 2 } })
    expect(tolerant.results[1]).toMatchObject({ status: "rejected" })
    expect(tolerant.results[2]).toMatchObject({ status: "fulfilled", value: { n: 6 } })
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

describe("compileWorkflow — declarative agent step", () => {
  it("compiles a plain-adapter agent step field-for-field with translateStages's construction", () => {
    const wf = defineWorkflow({
      name: "Ask",
      id: "ask",
      description: "One agent step, no app ref.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "s1", kind: "agent", adapter: "claude-code", prompt: "hello" },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const step = compiled.steps[0] as AgentStep
    const expected = buildAgentStep("s1", { prompt: "hello", adapter: "claude-code" })
    expect(step.kind).toBe("agent")
    expect(step.id).toBe("s1")
    expect(step.adapter).toBe("claude-code")
    expect(step.prompt({ input: undefined, item: undefined, index: undefined, steps: {} })).toBe(
      expected.prompt({ input: undefined, item: undefined, index: undefined, steps: {} }),
    )
    expect(step.policy).toEqual({ awaiting: "fail" })
  })

  it("resolves a $steps ref in the prompt through the same grammar as a tool step's inputs", async () => {
    const wf = defineWorkflow({
      name: "Ask with ref",
      id: "ask-ref",
      description: "Prompt threads a prior step's output.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "d", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        { id: "s1", kind: "agent", adapter: "mock", prompt: "$steps.d.n" },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const host = {
      spawn: async () => "sess_1",
      sendPromptAndWait: async (_id: string, prompt: string) => {
        expect(prompt).toBe("10")
      },
      resolveByLabel: () => undefined,
    }
    await runWorkflow({ workflow: compiled, agents: host, input: { n: 5 } })
  })

  it("compiles a declarative agent.ref against opts.agentRefs — adapter + options resolved at compile time", () => {
    const wf = defineWorkflow({
      name: "Team ask",
      id: "team-ask",
      description: "Agent step scoped to an installed app.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "implement",
          kind: "agent",
          agent: { ref: "@my-app/implementer" },
          prompt: "Implement the change.",
        },
      ],
    })
    const compiled = compileWorkflow(wf, {
      tools,
      candidates,
      agentRefs: {
        "@my-app/implementer": {
          adapter: "mastra-agent",
          options: { agent: "/apps/my-app/.agentproto/agents/implementer/AGENT.md" },
        },
      },
    })
    const step = compiled.steps[0] as AgentStep
    expect(step.adapter).toBe("mastra-agent")
    expect(step.options).toEqual({ agent: "/apps/my-app/.agentproto/agents/implementer/AGENT.md" })
  })

  it("rejects an empty agent.ref", () => {
    const wf = defineWorkflow({
      name: "Empty ref",
      id: "empty-ref",
      description: "An agent step with a blank ref.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "s1", kind: "agent", agent: { ref: "" }, prompt: "hi" }],
    })
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(WorkflowCompileError)
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(/empty 'agent.ref'/)
  })

  it("rejects an unknown agent.ref, naming the available refs", () => {
    const wf = defineWorkflow({
      name: "Unknown ref",
      id: "unknown-ref",
      description: "An agent step referencing an agent the app doesn't bundle.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "s1", kind: "agent", agent: { ref: "@my-app/ghost" }, prompt: "hi" },
      ],
    })
    expect(() =>
      compileWorkflow(wf, {
        tools,
        candidates,
        agentRefs: { "@my-app/reviewer": { adapter: "mastra-agent" } },
      }),
    ).toThrow(/unknown agent ref '@my-app\/ghost'.*@my-app\/reviewer/)
  })

  it("rejects agent.ref when no agentRefs are configured for the compile", () => {
    const wf = defineWorkflow({
      name: "No app context",
      id: "no-app-context",
      description: "An agent.ref step compiled outside any app.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "s1", kind: "agent", agent: { ref: "@my-app/x" }, prompt: "hi" }],
    })
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(/not running in an app context/)
  })

  it("rejects an empty prompt", () => {
    const wf = defineWorkflow({
      name: "Empty prompt",
      id: "empty-prompt",
      description: "An agent step with no prompt.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "s1", kind: "agent", adapter: "claude-code", prompt: "" }],
    })
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(/non-empty 'prompt'/)
  })

  it("passes an entry-based agent step (function-valued prompt) through unchanged", async () => {
    const handle = {
      id: "entry-agent",
      description: "demo",
      steps: [
        { kind: "agent", id: "s1", adapter: "mock", prompt: () => "from entry" },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const compiled = compileWorkflow(handle, { tools, candidates })
    const host = {
      spawn: async () => "sess_entry",
      sendPromptAndWait: async (_id: string, prompt: string) => {
        expect(prompt).toBe("from entry")
      },
      resolveByLabel: () => undefined,
    }
    await runWorkflow({ workflow: compiled, agents: host })
  })
})

describe("compileWorkflow — branch (forward-only goto)", () => {
  it("first branch: the earliest truthy `when` wins", async () => {
    const wf = defineWorkflow({
      name: "Tiered",
      id: "tiered-first",
      description: "Route by size.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "gate",
          kind: "branch",
          branches: [
            { when: "$input.n >= 10", next: "big" },
            { when: "$input.n >= 5", next: "medium" },
          ],
          default: "small",
        },
        { id: "big", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        { id: "medium", kind: "tool", tool: "demo.add-ten", inputs: { n: "$input.n" } },
        { id: "small", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { bindings } = await runWorkflow({ workflow: compiled, input: { n: 20 } })
    expect(bindings.steps.big).toEqual({ n: 40 })
  })

  it("second branch: the earlier arm is skipped entirely when its `when` is falsy", async () => {
    const wf = defineWorkflow({
      name: "Tiered",
      id: "tiered-second",
      description: "Route by size.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "gate",
          kind: "branch",
          branches: [
            { when: "$input.n >= 10", next: "big" },
            { when: "$input.n >= 5", next: "medium" },
          ],
          default: "small",
        },
        { id: "big", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        { id: "medium", kind: "tool", tool: "demo.add-ten", inputs: { n: "$input.n" } },
        { id: "small", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { bindings } = await runWorkflow({ workflow: compiled, input: { n: 7 } })
    expect(bindings.steps.medium).toEqual({ n: 17 })
    expect(bindings.steps.big).toBeUndefined()
  })

  it("default: no `when` matches, jumps to `default`, skipping the earlier arms", async () => {
    const wf = defineWorkflow({
      name: "Tiered",
      id: "tiered-default",
      description: "Route by size.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "gate",
          kind: "branch",
          branches: [
            { when: "$input.n >= 10", next: "big" },
            { when: "$input.n >= 5", next: "medium" },
          ],
          default: "small",
        },
        { id: "big", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        { id: "medium", kind: "tool", tool: "demo.add-ten", inputs: { n: "$input.n" } },
        { id: "small", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { bindings } = await runWorkflow({ workflow: compiled, input: { n: 2 } })
    expect(bindings.steps.small).toEqual({ n: 4 })
    expect(bindings.steps.big).toBeUndefined()
    expect(bindings.steps.medium).toBeUndefined()
  })

  it("no default: falls through to the next sibling in document order", async () => {
    const wf = defineWorkflow({
      name: "No default",
      id: "no-default",
      description: "No `when` matches and there's no `default`.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "gate",
          kind: "branch",
          branches: [{ when: "$input.n >= 999", next: "far" }],
        },
        { id: "near", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        { id: "far", kind: "tool", tool: "demo.add-ten", inputs: { n: "$input.n" } },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { bindings } = await runWorkflow({ workflow: compiled, input: { n: 1 } })
    expect(bindings.steps.near).toEqual({ n: 2 })
  })

  it("rejects a backward branch target", () => {
    const wf = defineWorkflow({
      name: "Backward",
      id: "backward-branch",
      description: "A branch target that points at an earlier sibling.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "a", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        {
          id: "gate",
          kind: "branch",
          branches: [{ when: "$input.n >= 1", next: "a" }],
        },
        { id: "b", kind: "tool", tool: "demo.add-ten", inputs: { n: "$input.n" } },
      ],
    })
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(WorkflowCompileError)
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(/loop/)
  })

  it("rejects an unknown branch target", () => {
    const wf = defineWorkflow({
      name: "Unknown target",
      id: "unknown-branch-target",
      description: "A branch target that names no sibling.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "gate",
          kind: "branch",
          branches: [{ when: "$input.n >= 1", next: "ghost" }],
        },
        { id: "b", kind: "tool", tool: "demo.add-ten", inputs: { n: "$input.n" } },
      ],
    })
    expect(() => compileWorkflow(wf, { tools, candidates })).toThrow(WorkflowCompileError)
  })

  it("works nested inside a map's body, branching on $item", async () => {
    // `neg` is the LAST sibling in the body, so the `default` jump to it is
    // exclusive (skips `pos` entirely). `pos` sits earlier, so taking that
    // arm falls through into `neg` too — the same forward-fallthrough
    // semantics proven at the top level, just nested inside a map body.
    const wf = defineWorkflow({
      name: "Branch in map",
      id: "branch-in-map",
      description: "Sign each element.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "signed",
          kind: "map",
          over: "$input.xs",
          steps: [
            {
              id: "check",
              kind: "branch",
              branches: [{ when: "$item >= 0", next: "pos" }],
              default: "neg",
            },
            { id: "pos", kind: "tool", tool: "demo.double", inputs: { n: "$item" } },
            { id: "neg", kind: "tool", tool: "demo.add-ten", inputs: { n: "$item" } },
          ],
        },
      ],
    })
    const compiled = compileWorkflow(wf, { tools, candidates })
    const { output } = await runWorkflow({ workflow: compiled, input: { xs: [3, -2, 5] } })
    // 3 → pos (double → 6), falls through to neg (add-ten → 13)
    // -2 → default (neg only, exclusive) → add-ten → 8
    // 5 → pos (double → 10), falls through to neg (add-ten → 15)
    expect((output as Array<{ n: number }>).map((o) => o.n)).toEqual([13, 8, 15])
  })

  it("end-to-end: only the chosen arm's steps run, and the shared trailing sibling runs exactly once", async () => {
    let finalizeCalls = 0
    const finalizeTool = defineTool({
      id: "demo.finalize",
      description: "Counts its own invocations.",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
    })
    const finalizeProvider = defineDriver({
      id: "finalize-builtin",
      name: "Finalize",
      description: "Counts calls.",
      kind: "builtin",
      implements: [{ tool: "demo.finalize", version: "0.1.0" }],
      implementations: [
        implementTool(finalizeTool, ({ input }) => {
          finalizeCalls++
          return { n: input.n }
        }),
      ],
    })
    const wf = defineWorkflow({
      name: "Branch e2e",
      id: "branch-e2e",
      description: "big is placed last so taking it skips small entirely.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "gate",
          kind: "branch",
          branches: [{ when: "$input.n >= 100", next: "big" }],
          default: "small",
        },
        { id: "small", kind: "tool", tool: "demo.add-ten", inputs: { n: "$input.n" } },
        { id: "big", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        { id: "finalize", kind: "tool", tool: "demo.finalize", inputs: { n: "$input.n" } },
      ],
    })
    const compiled = compileWorkflow(wf, {
      tools: { ...tools, "demo.finalize": finalizeTool },
      candidates: [...candidates, finalizeProvider],
    })
    const { bindings } = await runWorkflow({ workflow: compiled, input: { n: 500 } })
    expect(bindings.steps.big).toEqual({ n: 1000 })
    expect(bindings.steps.small).toBeUndefined()
    expect(bindings.steps.finalize).toEqual({ n: 500 })
    expect(finalizeCalls).toBe(1)
  })
})

describe("compileWorkflow — subworkflow input projection", () => {
  const childDoubles = defineWorkflow({
    name: "Child (doubles $input.n)",
    id: "child-doubles",
    description: "Doubles n.",
    version: "0.1.0",
    inputs: {},
    outputs: {},
    steps: [{ id: "c", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } }],
  })
  const childNested = defineWorkflow({
    name: "Child (nested input)",
    id: "child-nested",
    description: "Doubles meta.n.",
    version: "0.1.0",
    inputs: {},
    outputs: {},
    steps: [{ id: "c", kind: "tool", tool: "demo.double", inputs: { n: "$input.meta.n" } }],
  })

  it("mapping with a $steps ref", async () => {
    const wf = defineWorkflow({
      name: "Parent (ref mapping)",
      id: "parent-ref-mapping",
      description: "Projects a prior step's output into the child's input.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "d", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        { id: "sub", kind: "subworkflow", workflow: "child-doubles", inputs: { n: "$steps.d.n" } },
      ],
    })
    const compiled = compileWorkflow(wf, {
      tools,
      candidates,
      workflows: { "child-doubles": childDoubles },
    })
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 5 } })
    // 5 → double 10 (parent) → double 20 (child)
    expect((output as { n: number }).n).toBe(20)
  })

  it("mapping with a literal value", async () => {
    const wf = defineWorkflow({
      name: "Parent (literal mapping)",
      id: "parent-literal-mapping",
      description: "Projects a literal into the child's input.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "sub", kind: "subworkflow", workflow: "child-doubles", inputs: { n: 42 } }],
    })
    const compiled = compileWorkflow(wf, {
      tools,
      candidates,
      workflows: { "child-doubles": childDoubles },
    })
    const { output } = await runWorkflow({ workflow: compiled, input: {} })
    expect((output as { n: number }).n).toBe(84)
  })

  it("mapping with a nested object", async () => {
    const wf = defineWorkflow({
      name: "Parent (nested mapping)",
      id: "parent-nested-mapping",
      description: "Projects a nested object into the child's input.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        { id: "d", kind: "tool", tool: "demo.double", inputs: { n: "$input.n" } },
        {
          id: "sub",
          kind: "subworkflow",
          workflow: "child-nested",
          inputs: { meta: { n: "$steps.d.n" } },
        },
      ],
    })
    const compiled = compileWorkflow(wf, {
      tools,
      candidates,
      workflows: { "child-nested": childNested },
    })
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 5 } })
    // 5 → double 10 (parent) → double 20 (child, via meta.n)
    expect((output as { n: number }).n).toBe(20)
  })

  it("absent mapping passes the parent's own input through unchanged", async () => {
    const wf = defineWorkflow({
      name: "Parent (pass-through)",
      id: "parent-pass-through",
      description: "No `inputs` on the subworkflow step.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [{ id: "sub", kind: "subworkflow", workflow: "child-doubles" }],
    })
    const compiled = compileWorkflow(wf, {
      tools,
      candidates,
      workflows: { "child-doubles": childDoubles },
    })
    const { output } = await runWorkflow({ workflow: compiled, input: { n: 7 } })
    expect((output as { n: number }).n).toBe(14)
  })

  it("rejects a mapping ref to a missing step id at compile time", () => {
    const wf = defineWorkflow({
      name: "Parent (bad ref)",
      id: "parent-bad-ref",
      description: "Maps from a step id that doesn't exist.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "sub",
          kind: "subworkflow",
          workflow: "child-doubles",
          inputs: { n: "$steps.ghost.n" },
        },
      ],
    })
    expect(() =>
      compileWorkflow(wf, { tools, candidates, workflows: { "child-doubles": childDoubles } }),
    ).toThrow(WorkflowCompileError)
  })

  it("rejects a mapping ref to a missing field at run time, naming step + key", async () => {
    const wf = defineWorkflow({
      name: "Parent (missing field)",
      id: "parent-missing-field",
      description: "Maps a parent input field that doesn't exist.",
      version: "0.1.0",
      inputs: {},
      outputs: {},
      steps: [
        {
          id: "sub",
          kind: "subworkflow",
          workflow: "child-doubles",
          inputs: { topic: "$input.bookDir" },
        },
      ],
    })
    const compiled = compileWorkflow(wf, {
      tools,
      candidates,
      workflows: { "child-doubles": childDoubles },
    })
    await expect(runWorkflow({ workflow: compiled, input: {} })).rejects.toThrow(
      /subworkflow step 'sub' input key 'topic': reference '\$input\.bookDir' resolves to nothing/,
    )
  })
})
