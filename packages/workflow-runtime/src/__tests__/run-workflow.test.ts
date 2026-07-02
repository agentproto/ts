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
  type StepCache,
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

// ── AgentStep tests (with fake AgentSessionHost) ───────────────────────

import { vi } from "vitest"
import type { AgentSessionHost } from "../types.js"

function fakeHost(
  overrides: Partial<{
    spawn: AgentSessionHost["spawn"]
    sendPromptAndWait: AgentSessionHost["sendPromptAndWait"]
    resolveByLabel: AgentSessionHost["resolveByLabel"]
    readFinalMessage: AgentSessionHost["readFinalMessage"]
    readCostUsd: AgentSessionHost["readCostUsd"]
  }> = {},
): AgentSessionHost {
  return {
    spawn: overrides.spawn ?? vi.fn(async () => "sess_fake"),
    sendPromptAndWait: overrides.sendPromptAndWait ?? vi.fn(async () => {}),
    resolveByLabel:
      overrides.resolveByLabel ??
      vi.fn((stepId: string) => `sess_${stepId}`),
    readFinalMessage: overrides.readFinalMessage,
    readCostUsd: overrides.readCostUsd,
  }
}

describe("runWorkflow — agent step", () => {
  it("spawns by adapter and returns { sessionId }", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-spawn",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          prompt: () => "hello",
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(output).toEqual({ sessionId: "sess_fake" })
    expect(host.spawn).toHaveBeenCalledWith("mock-adapter", { cwd: undefined, workspaceSlug: undefined, stepId: "s1" })
    expect(host.sendPromptAndWait).toHaveBeenCalledWith("sess_fake", "hello")
  })

  it("reuses a session by sessionRef via resolveByLabel", async () => {
    const host = fakeHost({
      resolveByLabel: vi.fn(() => "sess_prior"),
    })
    const wf: RuntimeWorkflow = {
      id: "agent-reuse",
      steps: [
        {
          kind: "agent",
          id: "s2",
          sessionRef: "s1",
          prompt: () => "verify",
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(output).toEqual({ sessionId: "sess_prior" })
    expect(host.resolveByLabel).toHaveBeenCalledWith("s1")
    expect(host.spawn).not.toHaveBeenCalled()
    expect(host.sendPromptAndWait).toHaveBeenCalledWith("sess_prior", "verify")
  })

  it("resolves adapter from a selector function", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-sel",
      steps: [
        {
          kind: "agent",
          id: "s3",
          adapter: (b) => (b.input as { ad: string }).ad,
          prompt: () => "sel-prompt",
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, input: { ad: "dynamic-adapter" } })
    expect(host.spawn).toHaveBeenCalledWith("dynamic-adapter", expect.anything())
  })

  it("throws when no host is injected", async () => {
    const wf: RuntimeWorkflow = {
      id: "agent-no-host",
      steps: [
        { kind: "agent", id: "s4", adapter: "mock", prompt: () => "p" },
      ],
    }
    await expect(runWorkflow({ workflow: wf })).rejects.toThrow(
      /AgentStep requires a host agents implementation/,
    )
  })

  it("throws when both adapter and sessionRef are absent and resolveByLabel returns undefined", async () => {
    const host = fakeHost({
      resolveByLabel: vi.fn(() => undefined),
    })
    const wf: RuntimeWorkflow = {
      id: "agent-no-session",
      steps: [
        {
          kind: "agent",
          id: "s5",
          sessionRef: "missing",
          prompt: () => "p",
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toThrow(
      /no session/,
    )
  })
})

// ── AgentStep outputSchema tests ─────────────────────────────────────

const verdictSchema = z.object({ verdict: z.enum(["pass", "fail"]) })

describe("runWorkflow — agent step outputSchema", () => {
  it("valid on first try → step output is the parsed object, zero corrections", async () => {
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => JSON.stringify({ verdict: "pass" })),
    })
    const wf: RuntimeWorkflow = {
      id: "schema-pass",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "judge this",
          outputSchema: verdictSchema,
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(output).toEqual({ sessionId: "sess_fake", output: { verdict: "pass" } })
    expect(host.readFinalMessage).toHaveBeenCalledTimes(1)
    // No correction re-prompts beyond the initial one
    expect(host.sendPromptAndWait).toHaveBeenCalledTimes(1)
  })

  it("invalid then valid on retry 2 → succeeds, correct number of re-prompts", async () => {
    const messages: string[] = [
      JSON.stringify({ verdict: "nope" }),
      JSON.stringify({ verdict: "pass" }),
    ]
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => {
        return messages.shift() ?? ""
      }),
      sendPromptAndWait: vi.fn(async () => {}),
    })
    const wf: RuntimeWorkflow = {
      id: "schema-retry",
      steps: [
        {
          kind: "agent",
          id: "s2",
          adapter: "mock",
          prompt: () => "judge",
          outputSchema: verdictSchema,
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(output).toEqual({ sessionId: "sess_fake", output: { verdict: "pass" } })
    // sendPromptAndWait: 1 initial + 1 correction = 2
    expect(host.sendPromptAndWait).toHaveBeenCalledTimes(2)
  })

  it("never valid within maxRetries → rejects with output_invalid", async () => {
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => JSON.stringify({ verdict: "nope" })),
      sendPromptAndWait: vi.fn(async () => {}),
    })
    const wf: RuntimeWorkflow = {
      id: "schema-fail",
      steps: [
        {
          kind: "agent",
          id: "s3",
          adapter: "mock",
          prompt: () => "judge",
          outputSchema: verdictSchema,
          maxRetries: 1,
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toThrow(
      /output_invalid/,
    )
  })

  it("outputSchema set but host lacks readFinalMessage → clear throw", async () => {
    const host = fakeHost({
      // readFinalMessage intentionally omitted
    })
    const wf: RuntimeWorkflow = {
      id: "schema-noread",
      steps: [
        {
          kind: "agent",
          id: "s4",
          adapter: "mock",
          prompt: () => "judge",
          outputSchema: verdictSchema,
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toThrow(
      /outputSchema requires a host with readFinalMessage/,
    )
  })
})

// ── AgentStep maxTotalCostUsd tests ──────────────────────────────────

describe("runWorkflow — maxTotalCostUsd budget ceiling", () => {
  // 3 sequential agent steps, each spawning a fresh session that costs $0.50.
  const threeStepWorkflow: RuntimeWorkflow = {
    id: "budget",
    steps: [
      { kind: "agent", id: "s0", adapter: "mock", prompt: () => "task-0" },
      { kind: "agent", id: "s1", adapter: "mock", prompt: () => "task-1" },
      { kind: "agent", id: "s2", adapter: "mock", prompt: () => "task-2" },
    ],
  }

  it("refuses the spawn that would cross the cap", async () => {
    let seq = 0
    const host = fakeHost({
      spawn: vi.fn(async () => `sess_${seq++}`),
      readCostUsd: vi.fn(async () => 0.5), // each session costs $0.50
    })
    // spend after 2 sessions = $1.00 = cap → the 3rd spawn is refused.
    await expect(
      runWorkflow({ workflow: threeStepWorkflow, agents: host, maxTotalCostUsd: 1.0 }),
    ).rejects.toThrow(/budget_exceeded/)
    expect(host.spawn).toHaveBeenCalledTimes(2)
  })

  it("allows all spawns when total stays under the cap", async () => {
    let seq = 0
    const host = fakeHost({
      spawn: vi.fn(async () => `sess_${seq++}`),
      readCostUsd: vi.fn(async () => 0.5),
    })
    const { output } = await runWorkflow({
      workflow: threeStepWorkflow,
      agents: host,
      maxTotalCostUsd: 10.0,
    })
    expect(output).toEqual({ sessionId: "sess_2" })
    expect(host.spawn).toHaveBeenCalledTimes(3)
  })

  it("cap set but host has no readCostUsd — budgeting is a no-op, never throws", async () => {
    const host = fakeHost({
      // readCostUsd intentionally omitted → no cost is ever tallied
    })
    const { output } = await runWorkflow({
      workflow: threeStepWorkflow,
      agents: host,
      maxTotalCostUsd: 0.01,
    })
    expect(output).toEqual({ sessionId: "sess_fake" })
    expect(host.spawn).toHaveBeenCalledTimes(3)
  })

  it("a sessionRef reuse is not counted as a new spend", async () => {
    const host = fakeHost({
      spawn: vi.fn(async () => "sess_r"),
      resolveByLabel: vi.fn(() => "sess_r"),
      readCostUsd: vi.fn(async () => 0.6), // the single reused session costs $0.60
    })
    const wf: RuntimeWorkflow = {
      id: "budget-reuse",
      steps: [
        { kind: "agent", id: "s1", adapter: "mock", prompt: () => "first" },
        { kind: "agent", id: "s2", sessionRef: "s1", prompt: () => "second" },
      ],
    }
    // Only one session ever spawns; its $0.60 is counted once (not doubled to
    // $1.20 across the two steps), so the run stays under the $0.80 cap.
    await runWorkflow({ workflow: wf, agents: host, maxTotalCostUsd: 0.8 })
    expect(host.spawn).toHaveBeenCalledTimes(1)
  })
})

// ── PipelineStep tests ──────────────────────────────────────────────

describe("runWorkflow — pipeline step", () => {
  it("index-ordered results + all stages run", async () => {
    let seq = 0
    const host = fakeHost({
      spawn: vi.fn(async () => `sess_${seq++}`),
      sendPromptAndWait: vi.fn(async () => {}),
    })
    const wf: RuntimeWorkflow = {
      id: "pipeline-basic",
      steps: [
        {
          kind: "pipeline",
          id: "p1",
          over: () => ["a", "b", "c"],
          stages: [
            (item) => ({
              kind: "agent",
              id: `s0`,
              adapter: "mock",
              prompt: () => `stage-0-${String(item)}`,
            }),
            (item) => ({
              kind: "agent",
              id: `s1`,
              adapter: "mock",
              prompt: () => `stage-1-${String(item)}`,
            }),
          ],
        },
      ],
    }
    const { bindings } = await runWorkflow({ workflow: wf, agents: host })
    expect(Array.isArray(bindings.steps.p1)).toBe(true)
    expect(bindings.steps.p1).toHaveLength(3)
    // 3 items × 2 stages = 6 prompts
    expect(host.sendPromptAndWait).toHaveBeenCalledTimes(6)
  })

  it("no cross-item barrier — item 1 finishes its chain while item 0 is at stage 1", async () => {
    let seq = 0
    const order: string[] = []
    const host = fakeHost({
      spawn: vi.fn(async () => `sess_${seq++}`),
      sendPromptAndWait: vi.fn(async (_sid: string, prompt: string) => {
        if (prompt.includes("item-0-stage-1")) {
          await new Promise<void>((r) => setTimeout(r, 50))
        }
        order.push(prompt)
      }),
    })
    const wf: RuntimeWorkflow = {
      id: "pipeline-no-barrier",
      steps: [
        {
          kind: "pipeline",
          id: "p1",
          over: () => [0, 1],
          stages: [
            (item) => ({
              kind: "agent",
              id: `s0`,
              adapter: "mock",
              prompt: () => `item-${String(item)}-stage-0`,
            }),
            (item) => ({
              kind: "agent",
              id: `s1`,
              adapter: "mock",
              prompt: () => `item-${String(item)}-stage-1`,
            }),
          ],
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    // Both of item 1's prompts must appear before item 0's stage-1 prompt
    const idx01 = order.indexOf("item-0-stage-1")
    const idx10 = order.indexOf("item-1-stage-0")
    const idx11 = order.indexOf("item-1-stage-1")
    expect(idx10).toBeLessThan(idx01)
    expect(idx11).toBeLessThan(idx01)
  })

  it("concurrency: 1 serializes item execution", async () => {
    let seq = 0
    const order: string[] = []
    const host = fakeHost({
      spawn: vi.fn(async () => `sess_${seq++}`),
      sendPromptAndWait: vi.fn(async (_sid: string, prompt: string) => {
        if (prompt.includes("item-0")) {
          await new Promise<void>((r) => setTimeout(r, 50))
        }
        order.push(prompt)
      }),
    })
    const wf: RuntimeWorkflow = {
      id: "pipeline-ser",
      steps: [
        {
          kind: "pipeline",
          id: "p1",
          over: () => [0, 1],
          concurrency: 1,
          stages: [
            (item) => ({
              kind: "agent",
              id: `s`,
              adapter: "mock",
              prompt: () => `item-${String(item)}`,
            }),
          ],
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    // item 0 completes before item 1 even starts
    expect(order.indexOf("item-0")).toBeLessThan(order.indexOf("item-1"))
  })

  it("empty over returns [] without hanging", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "pipeline-empty",
      steps: [
        {
          kind: "pipeline",
          id: "p1",
          over: () => [],
          stages: [
            () => ({
              kind: "agent",
              id: `s`,
              adapter: "mock",
              prompt: () => "should-not-run",
            }),
          ],
        },
      ],
    }
    const result = await runWorkflow({ workflow: wf, agents: host })
    expect(result.bindings.steps.p1).toEqual([])
    expect(host.sendPromptAndWait).not.toHaveBeenCalled()
  })
})

// ── Step cache tests ─────────────────────────────────────────────────

function memCache(): { cache: StepCache; store: Map<string, { output: unknown; resolvedInputHash: string }> } {
  const store = new Map<string, { output: unknown; resolvedInputHash: string }>()
  const cache: StepCache = {
    get: async (k) => store.get(k),
    set: async (k, e) => { store.set(k, e) },
  }
  return { cache, store }
}

describe("step cache", () => {
  it("agent cacheable — hit skips spawn, reuses output", async () => {
    const spawns: string[] = []
    const host = fakeHost({
      spawn: vi.fn(async () => {
        const id = `sess_${spawns.length}`
        spawns.push(id)
        return id
      }),
      readFinalMessage: vi.fn(async () => JSON.stringify({ ok: true })),
    })
    const wf: RuntimeWorkflow = {
      id: "cache-agent",
      steps: [
        {
          kind: "agent",
          id: "research",
          adapter: "claude",
          cacheable: true,
          prompt: () => "do research",
          outputSchema: z.object({ ok: z.boolean() }),
        },
      ],
    }
    const { cache } = memCache()
    const r1 = await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1" })
    const r2 = await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1" })
    expect(spawns.length).toBe(1)
    expect(r2.output).toEqual(r1.output)
    expect(r1.output).toMatchObject({ output: { ok: true } })
  })

  it("input changed — hash miss re-executes", async () => {
    const spawns: string[] = []
    const host = fakeHost({
      spawn: vi.fn(async () => {
        const id = `sess_${spawns.length}`
        spawns.push(id)
        return id
      }),
      readFinalMessage: vi.fn(async () => JSON.stringify({ ok: true })),
    })
    const wf: RuntimeWorkflow = {
      id: "cache-input-changed",
      steps: [
        {
          kind: "agent",
          id: "research",
          adapter: "claude",
          cacheable: true,
          prompt: (b) => `do ${String(b.input)}`,
          outputSchema: z.object({ ok: z.boolean() }),
        },
      ],
    }
    const { cache } = memCache()
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1", input: "alpha" })
    // same input → cache hit
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1", input: "alpha" })
    // different input → cache miss
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1", input: "beta" })
    expect(spawns.length).toBe(2)
  })

  it("no cacheKey ⇒ no caching", async () => {
    const spawns: string[] = []
    const host = fakeHost({
      spawn: vi.fn(async () => {
        spawns.push(`sess_${spawns.length}`)
        return `sess_${spawns.length - 1}`
      }),
    })
    const wf: RuntimeWorkflow = {
      id: "cache-no-key",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "claude",
          cacheable: true,
          prompt: () => "hello",
        },
      ],
    }
    const { cache } = memCache()
    await runWorkflow({ workflow: wf, agents: host, cache })
    await runWorkflow({ workflow: wf, agents: host, cache })
    expect(spawns.length).toBe(2)
  })

  it("cacheable:false ⇒ no caching", async () => {
    const spawns: string[] = []
    const host = fakeHost({
      spawn: vi.fn(async () => {
        spawns.push(`sess_${spawns.length}`)
        return `sess_${spawns.length - 1}`
      }),
    })
    const wf: RuntimeWorkflow = {
      id: "cache-not-cacheable",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "claude",
          cacheable: false,
          prompt: () => "hello",
        },
      ],
    }
    const { cache } = memCache()
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1" })
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1" })
    expect(spawns.length).toBe(2)
  })

  it("tool cacheable — hit skips dispatch", async () => {
    let toolRuns = 0
    const countingProvider = defineDriver({
      id: "counting",
      name: "Counting",
      description: "Counts runs",
      kind: "builtin",
      implements: [
        { tool: "demo.double", version: "0.1.0" },
      ],
      implementations: [
        implementTool(doubleTool, ({ input }) => {
          toolRuns++
          return { n: input.n * 2 }
        }),
      ],
    })
    const countingCandidates = [countingProvider]
    const wf: RuntimeWorkflow = {
      id: "cache-tool",
      steps: [
        {
          kind: "tool",
          id: "d",
          tool: doubleTool,
          candidates: countingCandidates,
          cacheable: true,
          input: () => ({ n: 5 }),
        },
      ],
    }
    const { cache } = memCache()
    const r1 = await runWorkflow({ workflow: wf, cache, cacheKey: "run-tool" })
    const r2 = await runWorkflow({ workflow: wf, cache, cacheKey: "run-tool" })
    expect(toolRuns).toBe(1)
    expect(r2.output).toEqual(r1.output)
  })
})
