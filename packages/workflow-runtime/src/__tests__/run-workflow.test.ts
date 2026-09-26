/**
 * The step-walker over inline contracts (the framework can't depend on a
 * catalogue): tool output threads into later steps' bindings, `map` fans a tool
 * over an array with the element exposed as `bindings.item`, `transform`
 * combines + filters, and `branch` picks a path from a predicate.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
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

// Throws for negative `n` (simulating e.g. an expired listing), else doubles —
// used to exercise per-item failure handling in `map`/`pipeline`.
const maybeThrowTool = defineTool({
  id: "demo.maybe-throw",
  description: "Throws for negative n, else doubles.",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ n: z.number() }),
})
const flakyProvider = defineDriver({
  id: "flaky-builtin",
  name: "Flaky",
  description: "Throws on negative n.",
  kind: "builtin",
  implements: [{ tool: "demo.maybe-throw", version: "0.1.0" }],
  implementations: [
    implementTool(maybeThrowTool, ({ input }) => {
      if (input.n < 0) throw new Error(`item ${input.n} is expired`)
      return { n: input.n * 2 }
    }),
  ],
})
const flakyCandidates = [flakyProvider]

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

describe("runWorkflow — map onError", () => {
  it("default (no onError) — one item throwing aborts the whole map, matching prior behavior", async () => {
    const wf: RuntimeWorkflow = {
      id: "map-throws",
      steps: [
        {
          kind: "map",
          id: "doubled",
          parallelism: 1,
          over: () => [1, 2, -3, 4],
          body: () => ({
            kind: "tool",
            id: "d",
            tool: maybeThrowTool,
            candidates: flakyCandidates,
            input: (b) => ({ n: b.item as number }),
          }),
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf })).rejects.toThrow("item -3 is expired")
  })

  it("onError: collect — every item runs; failures are visible instead of aborting the run", async () => {
    const wf: RuntimeWorkflow = {
      id: "map-collect",
      steps: [
        {
          kind: "map",
          id: "doubled",
          parallelism: 2,
          over: () => [1, 2, -3, 4, -5],
          onError: "collect",
          body: () => ({
            kind: "tool",
            id: "d",
            tool: maybeThrowTool,
            candidates: flakyCandidates,
            input: (b) => ({ n: b.item as number }),
          }),
        },
      ],
      output: (b) => b.steps.doubled,
    }
    const { output } = await runWorkflow({ workflow: wf })
    const tolerant = output as {
      results: Array<{ status: string; index: number; value?: { n: number }; error?: string }>
      succeeded: number
      failed: number
    }
    expect(tolerant.succeeded).toBe(3)
    expect(tolerant.failed).toBe(2)
    expect(tolerant.results).toHaveLength(5)
    // successes carry their doubled value, in the original `over` order
    expect(tolerant.results[0]).toEqual({ status: "fulfilled", index: 0, value: { n: 2 } })
    expect(tolerant.results[1]).toEqual({ status: "fulfilled", index: 1, value: { n: 4 } })
    expect(tolerant.results[3]).toEqual({ status: "fulfilled", index: 3, value: { n: 8 } })
    // failures are visible with a reason, not silently dropped
    expect(tolerant.results[2]).toEqual({
      status: "rejected",
      index: 2,
      item: -3,
      error: "item -3 is expired",
    })
    expect(tolerant.results[4]).toEqual({
      status: "rejected",
      index: 4,
      item: -5,
      error: "item -5 is expired",
    })
  })
})

describe("runWorkflow — map parallelism is a sliding window", () => {
  it("starts the next item as soon as ANY slot frees, not when the whole batch finishes", async () => {
    const release = new Map<number, () => void>()
    const started: number[] = []
    const wf: RuntimeWorkflow = {
      id: "map-window",
      steps: [
        {
          kind: "map",
          id: "m",
          parallelism: 2,
          over: () => [0, 1, 2, 3],
          body: (item) => ({
            kind: "transform",
            id: "t",
            compute: () => {
              started.push(item as number)
              return new Promise<number>((resolve) => release.set(item as number, () => resolve(item as number)))
            },
          }),
        },
      ],
      output: (b) => b.steps.m,
    }
    const done = runWorkflow({ workflow: wf })
    const tick = () => new Promise((r) => setTimeout(r, 0))
    await tick()
    expect(started).toEqual([0, 1])
    // Item 0 is slow; item 1 finishing must free its slot for item 2 now.
    release.get(1)!()
    await tick()
    expect(started).toEqual([0, 1, 2])
    release.get(2)!()
    await tick()
    expect(started).toEqual([0, 1, 2, 3])
    release.get(3)!()
    release.get(0)!()
    expect((await done).output).toEqual([0, 1, 2, 3])
  })

  it("non-tolerant: no new item starts after the first failure", async () => {
    const started: number[] = []
    const wf: RuntimeWorkflow = {
      id: "map-window-fail",
      steps: [
        {
          kind: "map",
          id: "m",
          parallelism: 1,
          over: () => [0, 1, 2],
          body: (item) => ({
            kind: "transform",
            id: "t",
            compute: () => {
              started.push(item as number)
              if (item === 1) throw new Error("boom")
              return item
            },
          }),
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf })).rejects.toThrow("boom")
    expect(started).toEqual([0, 1])
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
    emitHarnessWarning: AgentSessionHost["emitHarnessWarning"]
    takeInputRequest: AgentSessionHost["takeInputRequest"]
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
    ...(overrides.emitHarnessWarning ? { emitHarnessWarning: overrides.emitHarnessWarning } : {}),
    ...(overrides.takeInputRequest ? { takeInputRequest: overrides.takeInputRequest } : {}),
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

  it("resolves `{{index}}` in a map-body sessionRef to the item's own spawn (stepKey), not the last one", async () => {
    const byLabel = new Map<string, string>()
    let n = 0
    const host = fakeHost({
      spawn: vi.fn(async (_adapter: string, opts: { stepKey?: string }) => {
        const id = `sess_${n++}`
        if (opts.stepKey) byLabel.set(opts.stepKey, id)
        return id
      }),
      resolveByLabel: vi.fn((label: string) => byLabel.get(label)),
    })
    const wf: RuntimeWorkflow = {
      id: "agent-reuse-indexed",
      steps: [
        {
          kind: "map",
          id: "fan",
          over: () => ["a", "b"],
          parallelism: 2,
          body: () => ({
            kind: "group",
            id: "fan__body",
            steps: [
              { kind: "agent", id: "first", adapter: "mock-adapter", prompt: b => `first ${String(b.item)}` },
              { kind: "agent", id: "again", sessionRef: "first[{{index}}]", prompt: b => `again ${String(b.item)}` },
            ],
          }),
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(host.resolveByLabel).toHaveBeenCalledWith("first[0]")
    expect(host.resolveByLabel).toHaveBeenCalledWith("first[1]")
    const sends = vi.mocked(host.sendPromptAndWait).mock.calls
    const sessionFor = (prompt: string) => sends.find(([, p]) => p === prompt)?.[0]
    expect(sessionFor("again a")).toBe(sessionFor("first a"))
    expect(sessionFor("again b")).toBe(sessionFor("first b"))
    expect(sessionFor("first a")).not.toBe(sessionFor("first b"))
  })

  it("passes a literal sandbox ref (slug) through to host.spawn", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-sandbox-slug",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          sandbox: "e2b",
          prompt: () => "hello",
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(host.spawn).toHaveBeenCalledWith("mock-adapter", {
      cwd: undefined,
      workspaceSlug: undefined,
      stepId: "s1",
      sandbox: "e2b",
    })
  })

  it("resolves a sandbox selector per-run; undefined ⇒ host spawn (no sandbox key)", async () => {
    const host = fakeHost()
    const spec = { provider: "e2b", config: {}, env: { passthrough: ["GITHUB_TOKEN"] } }
    const wf: RuntimeWorkflow = {
      id: "agent-sandbox-sel",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          sandbox: (b) => ((b.input as { boxed: boolean }).boxed ? spec : undefined),
          prompt: () => "hello",
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, input: { boxed: true } })
    expect(host.spawn).toHaveBeenLastCalledWith("mock-adapter", {
      cwd: undefined,
      workspaceSlug: undefined,
      stepId: "s1",
      sandbox: spec,
    })
    await runWorkflow({ workflow: wf, agents: host, input: { boxed: false } })
    expect(host.spawn).toHaveBeenLastCalledWith("mock-adapter", {
      cwd: undefined,
      workspaceSlug: undefined,
      stepId: "s1",
    })
  })

  it("a host that rejects the sandbox spawn fails the run loudly (no silent host fallback)", async () => {
    const spawn = vi.fn(async () => {
      throw new Error("agent step sandbox spawn failed (sandbox_provider_not_found): no resolver")
    })
    const host = fakeHost({ spawn })
    const wf: RuntimeWorkflow = {
      id: "agent-sandbox-fail-loud",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          sandbox: "e2b",
          prompt: () => "hello",
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toThrow(
      /sandbox spawn failed \(sandbox_provider_not_found\)/,
    )
    // The failed spawn is the ONLY spawn attempt — the step must not retry
    // on the host without the sandbox.
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith("mock-adapter", expect.objectContaining({ sandbox: "e2b" }))
    expect(host.sendPromptAndWait).not.toHaveBeenCalled()
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

  it("step.cwd selector binds a prior step's output cwd into the spawn", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-cwd-bound",
      steps: [
        {
          kind: "transform",
          id: "provision",
          compute: () => ({ cwd: "/tmp/worktree-xyz" }),
        },
        {
          kind: "agent",
          id: "code",
          adapter: "mock-adapter",
          cwd: (b) => (b.steps.provision as { cwd: string }).cwd,
          prompt: () => "do the task",
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, cwd: "/should/not/be/used" })
    expect(host.spawn).toHaveBeenCalledWith("mock-adapter", {
      cwd: "/tmp/worktree-xyz",
      workspaceSlug: undefined,
      stepId: "code",
    })
  })

  it("no step.cwd ⇒ falls back to the run-level ctx.cwd", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-cwd-fallback",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          prompt: () => "hello",
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, cwd: "/run/level/cwd" })
    expect(host.spawn).toHaveBeenCalledWith("mock-adapter", {
      cwd: "/run/level/cwd",
      workspaceSlug: undefined,
      stepId: "s1",
    })
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

  it("returns { sessionId, text } when no outputSchema and readFinalMessage available", async () => {
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => "Here is my analysis..."),
    })
    const wf: RuntimeWorkflow = {
      id: "agent-text-output",
      steps: [
        {
          kind: "agent",
          id: "analyze",
          adapter: "mock",
          prompt: () => "analyze this",
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(output).toEqual({ sessionId: "sess_fake", text: "Here is my analysis..." })
    expect(host.readFinalMessage).toHaveBeenCalledWith("sess_fake")
  })

  it("returns { sessionId } when no outputSchema and readFinalMessage unavailable", async () => {
    const host = fakeHost({
      readFinalMessage: undefined,
    })
    const wf: RuntimeWorkflow = {
      id: "agent-no-text",
      steps: [
        {
          kind: "agent",
          id: "s6",
          adapter: "mock",
          prompt: () => "do something",
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(output).toEqual({ sessionId: "sess_fake" })
  })

  it("threads agent step text output into next step's prompt via bindings.steps", async () => {
    const prompts: string[] = []
    const host = fakeHost({
      readFinalMessage: vi.fn(async (sid: string) => {
        if (sid === "sess_step1") return "Step 1 found 3 issues."
        return "Step 2 verification complete."
      }),
      spawn: vi.fn(async (_adapter, opts) => {
        return opts!.stepId === "step1" ? "sess_step1" : "sess_step2"
      }),
      sendPromptAndWait: vi.fn(async (_sid, prompt) => {
        prompts.push(prompt)
      }),
    })
    const wf: RuntimeWorkflow = {
      id: "agent-chaining",
      steps: [
        {
          kind: "agent",
          id: "step1",
          adapter: "mock",
          prompt: () => "Find bugs",
        },
        {
          kind: "agent",
          id: "step2",
          adapter: "mock",
          prompt: (b) => {
            const step1Out = b.steps.step1 as { sessionId: string; text?: string }
            return step1Out.text
              ? `Verify these findings: ${step1Out.text}`
              : "Verify findings"
          },
        },
      ],
    }
    const { bindings } = await runWorkflow({ workflow: wf, agents: host })
    expect((bindings.steps.step1 as { text: string }).text).toBe("Step 1 found 3 issues.")
    expect((bindings.steps.step2 as { text: string }).text).toBe("Step 2 verification complete.")
    // Second prompt should contain the first step's output
    expect(prompts[1]).toContain("Step 1 found 3 issues.")
  })
})

describe("runWorkflow — agent step harness (AIP-15 P2)", () => {
  it("threads the harness block onto host.spawn's opts", async () => {
    const host = fakeHost()
    const harness = {
      model: "opus",
      effort: "high",
      role: "executor",
      tools: ["read"],
      skills: ["review"],
      cwd: "/work",
    }
    const wf: RuntimeWorkflow = {
      id: "agent-harness",
      steps: [{ kind: "agent", id: "s1", adapter: "mock-adapter", prompt: () => "hello", harness }],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(host.spawn).toHaveBeenCalledWith("mock-adapter", expect.objectContaining({ harness }))
  })

  it("harness.cwd overrides both the step's own cwd and the run's cwd", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-harness-cwd",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          prompt: () => "hi",
          cwd: () => "/step-cwd",
          harness: { cwd: "/harness-cwd" },
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, cwd: "/run-cwd" })
    expect(host.spawn).toHaveBeenCalledWith(
      "mock-adapter",
      expect.objectContaining({ cwd: "/harness-cwd" }),
    )
  })

  it("harness.tools with no generic per-spawn allowlist records toolsApplied:false on the step's own output — never silently ignored", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-harness-tools",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          prompt: () => "hi",
          harness: { tools: ["read"] },
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host })
    expect(output).toMatchObject({ harness: { tools: ["read"], toolsApplied: false } })
  })
})

describe("runWorkflow — kind: gate (AIP-15 P3)", () => {
  it("passes on exit code 0, parses stdout as the report, and binds { ok, exitCode, report }", async () => {
    const runGateCommand = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ checked: 3 }),
      stderr: "",
    }))
    const onGateReport = vi.fn()
    const wf: RuntimeWorkflow = {
      id: "gate-pass",
      steps: [{ kind: "gate", id: "g", command: "pnpm", args: ["test"] }],
    }
    const { output, bindings } = await runWorkflow({ workflow: wf, runGateCommand, onGateReport })
    expect(output).toEqual({ ok: true, exitCode: 0, report: { checked: 3 } })
    expect(bindings.steps.g).toEqual(output)
    expect(onGateReport).toHaveBeenCalledWith({
      stepId: "g",
      ok: true,
      exitCode: 0,
      report: { checked: 3 },
      attempt: 1,
    })
  })

  it("reads the report from a file (relative to cwd) when stdout doesn't parse as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-report-"))
    try {
      writeFileSync(join(dir, "report.json"), JSON.stringify({ checked: 7 }), "utf8")
      const runGateCommand = vi.fn(async () => ({ exitCode: 0, stdout: "not json", stderr: "" }))
      const wf: RuntimeWorkflow = {
        id: "gate-report-file",
        steps: [{ kind: "gate", id: "g", command: "pnpm", cwd: dir, reportPath: "report.json" }],
      }
      const { output } = await runWorkflow({ workflow: wf, runGateCommand })
      expect(output).toEqual({ ok: true, exitCode: 0, report: { checked: 7 } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails after exhausting retry.maxAttempts, throwing with the last exit code + report attached", async () => {
    const runGateCommand = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "boom" }))
    const wf: RuntimeWorkflow = {
      id: "gate-fail",
      steps: [
        { kind: "gate", id: "g", command: "pnpm", retry: { maxAttempts: 2, backoff: "fixed" } },
      ],
    }
    await expect(runWorkflow({ workflow: wf, runGateCommand })).rejects.toThrow(
      /gate failed after 2 attempt\(s\) — exit code 1/,
    )
    expect(runGateCommand).toHaveBeenCalledTimes(2)
  })

  it("retries on a failing attempt and succeeds once the command passes", async () => {
    let calls = 0
    const runGateCommand = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: "{}", stderr: "" }
    })
    const onGateReport = vi.fn()
    const wf: RuntimeWorkflow = {
      id: "gate-retry-ok",
      steps: [
        { kind: "gate", id: "g", command: "pnpm", retry: { maxAttempts: 2, backoff: "fixed" } },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, runGateCommand, onGateReport })
    expect(output).toMatchObject({ ok: true, exitCode: 0 })
    expect(runGateCommand).toHaveBeenCalledTimes(2)
    expect(onGateReport.mock.calls.map((c) => c[0].attempt)).toEqual([1, 2])
    expect(onGateReport.mock.calls.map((c) => c[0].ok)).toEqual([false, true])
  })

  it("on_fail.reprompt sends the named prior agent step's session the gate's report before retrying, then re-runs", async () => {
    const sendPromptAndWait = vi.fn(async (_sessionId: string, _prompt: string) => {})
    // Every step's session id is the same constant here — the test only
    // cares that the reprompt targets the same session the 'implement'
    // step's own prompt was sent to.
    const host = fakeHost({ sendPromptAndWait, resolveByLabel: vi.fn(() => "sess_fake") })
    let calls = 0
    const runGateCommand = vi.fn(async () => {
      calls += 1
      return calls === 1
        ? { exitCode: 1, stdout: JSON.stringify({ err: "boom" }), stderr: "" }
        : { exitCode: 0, stdout: "{}", stderr: "" }
    })
    const wf: RuntimeWorkflow = {
      id: "gate-reprompt",
      steps: [
        { kind: "agent", id: "implement", adapter: "mock", prompt: () => "implement it" },
        {
          kind: "gate",
          id: "g",
          command: "pnpm",
          retry: { maxAttempts: 2, backoff: "fixed" },
          onFail: { reprompt: "implement" },
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, runGateCommand })
    expect(runGateCommand).toHaveBeenCalledTimes(2)
    expect(sendPromptAndWait).toHaveBeenCalledTimes(2)
    const [reSessionId, reprompt] = sendPromptAndWait.mock.calls[1]!
    expect(reSessionId).toBe("sess_fake")
    expect(reprompt).toContain("Gate 'g' failed (exit code 1)")
    expect(reprompt).toContain('"err": "boom"')
  })

  it("forwards timeoutMs to the command runner and fails on a timed-out attempt", async () => {
    const runGateCommand = vi.fn(async (spec: { timeoutMs?: number }) => {
      expect(spec.timeoutMs).toBe(50)
      return { exitCode: 1, stdout: "", stderr: "", timedOut: true }
    })
    const wf: RuntimeWorkflow = {
      id: "gate-timeout",
      steps: [{ kind: "gate", id: "g", command: "sleep", args: ["5"], timeoutMs: 50 }],
    }
    await expect(runWorkflow({ workflow: wf, runGateCommand })).rejects.toThrow(
      /gate failed after 1 attempt\(s\) — exit code 1/,
    )
    expect(runGateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "sleep", args: ["5"], timeoutMs: 50 }),
    )
  })

  it("expands $… reference args against the bindings before running the command", async () => {
    const wf: RuntimeWorkflow = {
      id: "gate-ref-args",
      steps: [
        {
          kind: "gate",
          id: "g",
          command: "node",
          args: ["-e", "process.exit(process.argv[1] === 'book3' ? 0 : 1)", "$input.book"],
        },
      ],
    }
    // The ref expands to "book3" (exit 0); a literal "$input.book" would make
    // node exit 1. $$ stays a literal $.
    const { output } = await runWorkflow({ workflow: wf, input: { book: "book3" } })
    expect(output).toMatchObject({ ok: true, exitCode: 0 })

    const literal: RuntimeWorkflow = {
      id: "gate-literal-arg",
      steps: [
        {
          kind: "gate",
          id: "g",
          command: "node",
          args: ["-e", "process.exit(process.argv[1] === '$input.book' ? 0 : 1)", "$$input.book"],
        },
      ],
    }
    await expect(runWorkflow({ workflow: literal, input: { book: "book3" } })).resolves.toMatchObject({
      output: { ok: true, exitCode: 0 },
    })
  })

  it("throws a clear error naming the step and the arg when a ref resolves to nothing", async () => {
    const runGateCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const wf: RuntimeWorkflow = {
      id: "gate-bad-ref",
      steps: [
        { kind: "gate", id: "g", command: "node", args: ["--version", "$input.nonexistent"] },
      ],
    }
    await expect(runWorkflow({ workflow: wf, input: {}, runGateCommand })).rejects.toThrow(
      /step 'g': args\[1\] '\$input\.nonexistent' resolves to nothing/,
    )
    expect(runGateCommand).not.toHaveBeenCalled()
  })

  it("expands a leading ref plus trailing text in an arg ($input.book/knowledge)", async () => {
    const wf: RuntimeWorkflow = {
      id: "gate-ref-arg-trailing",
      steps: [
        {
          kind: "gate",
          id: "g",
          command: "node",
          args: [
            "-e",
            "process.exit(process.argv[1] === 'book3/knowledge' ? 0 : 1)",
            "$input.book/knowledge",
          ],
        },
      ],
    }
    // The ref expands to "book3" and "/knowledge" is appended verbatim (exit
    // 0); a bare-ref-only grammar would reject the arg outright.
    const { output } = await runWorkflow({ workflow: wf, input: { book: "book3" } })
    expect(output).toMatchObject({ ok: true, exitCode: 0 })
  })

  it("resolves a cwd ref: absolute stays absolute, relative (incl. .) resolves against the run cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-cwd-"))
    try {
      const cwds: string[] = []
      const runGateCommand = vi.fn(async (spec: { cwd: string }) => {
        cwds.push(spec.cwd)
        return { exitCode: 0, stdout: "{}", stderr: "" }
      })
      const gate = (cwd?: string) => ({ kind: "gate" as const, id: "g", command: "pnpm", ...(cwd !== undefined ? { cwd } : {}) })
      const wf: RuntimeWorkflow = { id: "gate-cwd-ref", steps: [] }

      await runWorkflow({ workflow: { ...wf, steps: [gate(dir)] }, runGateCommand })
      await runWorkflow({
        workflow: { ...wf, steps: [gate("$input.dir")] },
        input: { dir },
        runGateCommand,
      })
      await runWorkflow({ workflow: { ...wf, steps: [gate("sub/dir")] }, cwd: dir, runGateCommand })
      await runWorkflow({ workflow: { ...wf, steps: [gate(".")] }, cwd: dir, runGateCommand })
      await runWorkflow({ workflow: { ...wf, steps: [gate()] }, cwd: dir, runGateCommand })

      // Absolute ref → as-is; relative/`.` and absent → the run's own cwd,
      // never the daemon process cwd (vitest's cwd is the package dir).
      expect(cwds).toEqual([dir, dir, join(dir, "sub/dir"), dir, dir])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws a clear error naming the step and 'cwd' when a cwd ref resolves to nothing", async () => {
    const runGateCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }))
    const wf: RuntimeWorkflow = {
      id: "gate-bad-cwd",
      steps: [{ kind: "gate", id: "g", command: "pnpm", cwd: "$input.nonexistent" }],
    }
    await expect(runWorkflow({ workflow: wf, input: {}, runGateCommand })).rejects.toThrow(
      /step 'g': cwd '\$input\.nonexistent' resolves to nothing/,
    )
    expect(runGateCommand).not.toHaveBeenCalled()
  })

  it("run-level: a gate with cwd: $input.dir executes in that directory (its marker file lands there)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-cwd-run-"))
    try {
      const wf: RuntimeWorkflow = {
        id: "gate-cwd-run",
        steps: [
          {
            kind: "gate",
            id: "g",
            command: "node",
            args: ["-e", "require('fs').writeFileSync('marker-from-gate.txt', 'ok')"],
            cwd: "$input.dir",
          },
        ],
      }
      // No runGateCommand override — the real execFile path runs, in dir.
      const { output } = await runWorkflow({ workflow: wf, input: { dir } })
      expect(output).toMatchObject({ ok: true, exitCode: 0 })
      expect(readFileSync(join(dir, "marker-from-gate.txt"), "utf8")).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  // F27: the output contract goes out on the FIRST prompt, not only on a
  // rejected-reply retry — the model should never have to guess the shape.
  it("F27: an outputSchema step's FIRST prompt already states the JSON Schema contract", async () => {
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => JSON.stringify({ verdict: "pass" })),
    })
    const wf: RuntimeWorkflow = {
      id: "schema-first-prompt",
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
    await runWorkflow({ workflow: wf, agents: host })
    expect(host.sendPromptAndWait).toHaveBeenCalledTimes(1)
    const firstPrompt = (host.sendPromptAndWait as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    expect(firstPrompt).toContain("judge this")
    expect(firstPrompt).toContain("When done, reply with ONLY a JSON object matching this JSON Schema:")
    expect(firstPrompt).toContain('"verdict"')
    expect(firstPrompt).toContain('"pass"')
    expect(firstPrompt).toContain('"fail"')
  })

  // F27: a rejected-reply retry restates the schema too, not just a generic
  // "didn't match" note the model has no way to act on.
  it("F27: a retry prompt (invalid JSON) also restates the JSON Schema contract", async () => {
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => "not json at all"),
      sendPromptAndWait: vi.fn(async () => {}),
    })
    const wf: RuntimeWorkflow = {
      id: "schema-retry-prompt",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "judge this",
          outputSchema: verdictSchema,
          maxRetries: 1,
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toMatchObject({
      code: "missing-output",
    })
    expect(host.sendPromptAndWait).toHaveBeenCalledTimes(2)
    const retryPrompt = (host.sendPromptAndWait as ReturnType<typeof vi.fn>).mock.calls[1]![1] as string
    expect(retryPrompt).toContain("did not match the required schema")
    expect(retryPrompt).toContain("When done, reply with ONLY a JSON object matching this JSON Schema:")
  })

  // F27, declarative path: a WORKFLOW.md-authored `outputSchema` compiles
  // (via `compileOutputSchema`) into an `OutputSchemaLike` carrying the raw
  // JSON Schema on its `jsonSchema` marker — the prompt note should render
  // that EXACT schema, not a zod re-derivation.
  it("F27: a compiled JSON-Schema outputSchema (the WORKFLOW.md path) renders its exact schema into the first prompt", async () => {
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => JSON.stringify({ ok: true })),
    })
    const rawJsonSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
    const wf: RuntimeWorkflow = {
      id: "schema-declarative",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "judge this",
          outputSchema: {
            safeParse: (value: unknown) =>
              typeof value === "object" && value !== null && "ok" in value
                ? { success: true as const, data: value }
                : { success: false as const, error: { issues: [] } },
            jsonSchema: rawJsonSchema,
          },
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    const firstPrompt = (host.sendPromptAndWait as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    expect(firstPrompt).toContain(
      `When done, reply with ONLY a JSON object matching this JSON Schema: ${JSON.stringify(rawJsonSchema)}`,
    )
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

  it("never valid within maxRetries → rejects with StepOutcomeError { code: 'missing-output' }", async () => {
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
    // AIP-58 §3 Outcome rule: a declared-but-unsatisfied contract is
    // `failed { code: "missing-output" }` (not a bare Error), and the zod
    // mismatch message is preserved on `error.message`.
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toMatchObject({
      name: "StepOutcomeError",
      stepId: "s3",
      code: "missing-output",
      message: expect.stringContaining("missing-output"),
    })
  })

  it("missing-output on a final message ending in '?' sets hint 'possible-input-request' without changing the outcome", async () => {
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => "What tone should the brief use — formal or casual?"),
      sendPromptAndWait: vi.fn(async () => {}),
    })
    const wf: RuntimeWorkflow = {
      id: "schema-hint",
      steps: [
        {
          kind: "agent",
          id: "draft",
          adapter: "mock",
          prompt: () => "judge",
          outputSchema: verdictSchema,
          maxRetries: 0,
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toMatchObject({
      code: "missing-output",
      hint: "possible-input-request",
    })
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

// ── AIP-58 §3(a) run.requestInput signal ─────────────────────────────

describe("runWorkflow — agent step AIP-58 §3(a) run.requestInput signal", () => {
  it("no onInputRequired hook ⇒ throws AgentInputRequiredError (no-hook-supplied shape)", async () => {
    const host = fakeHost({
      takeInputRequest: vi.fn(() => ({ prompt: "what tone?", schema: { type: "object" } })),
    })
    const wf: RuntimeWorkflow = {
      id: "input-required-no-hook",
      steps: [{ kind: "agent", id: "draft", adapter: "mock", prompt: () => "write it" }],
    }
    await expect(runWorkflow({ workflow: wf, agents: host })).rejects.toMatchObject({
      name: "AgentInputRequiredError",
      stepId: "draft",
      prompt: "what tone?",
    })
  })

  it("signal present ⇒ suspends via onInputRequired, sends the resume payload to the SAME session, re-applies the outcome rule", async () => {
    const prompts: string[] = []
    let signalled = false
    const host = fakeHost({
      sendPromptAndWait: vi.fn(async (_sid, prompt) => {
        prompts.push(prompt)
      }),
      // First turn signals; the resumed turn (whatever prompt comes next) doesn't.
      takeInputRequest: vi.fn(() => {
        if (signalled) return undefined
        signalled = true
        return { prompt: "what tone?", schema: { type: "object", properties: { tone: { type: "string" } } } }
      }),
    })
    const onInputRequired = vi.fn(async (req: { stepId: string; prompt: string; schema?: unknown }) => {
      expect(req).toEqual({
        stepId: "draft",
        prompt: "what tone?",
        schema: { type: "object", properties: { tone: { type: "string" } } },
      })
      return { tone: "formal" }
    })
    const wf: RuntimeWorkflow = {
      id: "input-required-resume",
      steps: [{ kind: "agent", id: "draft", adapter: "mock", prompt: () => "write it" }],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host, onInputRequired })
    expect(onInputRequired).toHaveBeenCalledTimes(1)
    expect(output).toEqual({ sessionId: "sess_fake" })
    expect(prompts).toEqual([
      "write it\n\nIf you need information you don't have, call the run_request_input tool instead of asking in your reply.",
      JSON.stringify({ tone: "formal" }),
    ])
  })

  it("a step may suspend again after being resumed (loop, not one-shot)", async () => {
    let calls = 0
    const host = fakeHost({
      takeInputRequest: vi.fn(() => {
        calls++
        return calls <= 2 ? { prompt: `question ${calls}` } : undefined
      }),
    })
    const onInputRequired = vi.fn(async (req: { prompt: string }) => ({ answer: req.prompt }))
    const wf: RuntimeWorkflow = {
      id: "input-required-twice",
      steps: [{ kind: "agent", id: "draft", adapter: "mock", prompt: () => "write it" }],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host, onInputRequired })
    expect(onInputRequired).toHaveBeenCalledTimes(2)
    expect(output).toEqual({ sessionId: "sess_fake" })
  })

  it("checked inside the outputSchema retry loop too — a signal on a reprompt still suspends", async () => {
    // First readFinalMessage is unparseable JSON (triggers the retry-loop's
    // reprompt); every call after the resume returns a valid verdict.
    let readCalls = 0
    const host = fakeHost({
      readFinalMessage: vi.fn(async () => (++readCalls === 1 ? "not json" : JSON.stringify({ verdict: "pass" }))),
      // Signal only on the SECOND sendPromptAndWait (the retry loop's own
      // reprompt) — the initial send and the post-resume resend see none.
      takeInputRequest: vi.fn((() => {
        let n = 0
        return () => (++n === 2 ? { prompt: "need a value" } : undefined)
      })()),
    })
    const onInputRequired = vi.fn(async () => ({ verdict: "pass" }))
    const wf: RuntimeWorkflow = {
      id: "input-required-in-retry",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "judge",
          outputSchema: verdictSchema,
        },
      ],
    }
    const { output } = await runWorkflow({ workflow: wf, agents: host, onInputRequired })
    expect(onInputRequired).toHaveBeenCalledTimes(1)
    expect(output).toEqual({ sessionId: "sess_fake", output: { verdict: "pass" } })
  })

  it("no takeInputRequest on the host ⇒ no prompt affordance appended", async () => {
    const prompts: string[] = []
    const host = fakeHost({
      sendPromptAndWait: vi.fn(async (_sid, prompt) => {
        prompts.push(prompt)
      }),
    })
    const wf: RuntimeWorkflow = {
      id: "no-affordance",
      steps: [{ kind: "agent", id: "s1", adapter: "mock", prompt: () => "write it" }],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(prompts).toEqual(["write it"])
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

describe("runWorkflow — pipeline onError", () => {
  it("default (no onError) — one item's chain throwing aborts the whole pipeline, matching prior behavior", async () => {
    const wf: RuntimeWorkflow = {
      id: "pipeline-throws",
      steps: [
        {
          kind: "pipeline",
          id: "p1",
          over: () => [1, 2, -3, 4],
          concurrency: 1,
          stages: [
            (item) => ({
              kind: "tool",
              id: "s",
              tool: maybeThrowTool,
              candidates: flakyCandidates,
              input: () => ({ n: item as number }),
            }),
          ],
        },
      ],
    }
    await expect(runWorkflow({ workflow: wf })).rejects.toThrow("item -3 is expired")
  })

  it("onError: collect — every item's chain runs; failures are visible instead of aborting the run", async () => {
    const wf: RuntimeWorkflow = {
      id: "pipeline-collect",
      steps: [
        {
          kind: "pipeline",
          id: "p1",
          over: () => [1, 2, -3, 4, -5],
          onError: "collect",
          stages: [
            (item) => ({
              kind: "tool",
              id: "s",
              tool: maybeThrowTool,
              candidates: flakyCandidates,
              input: () => ({ n: item as number }),
            }),
          ],
        },
      ],
      output: (b) => b.steps.p1,
    }
    const { output } = await runWorkflow({ workflow: wf })
    const tolerant = output as {
      results: Array<{ status: string; index: number; value?: { n: number }; error?: string }>
      succeeded: number
      failed: number
    }
    expect(tolerant.succeeded).toBe(3)
    expect(tolerant.failed).toBe(2)
    expect(tolerant.results).toHaveLength(5)
    expect(tolerant.results[0]).toEqual({ status: "fulfilled", index: 0, value: { n: 2 } })
    expect(tolerant.results[2]).toEqual({
      status: "rejected",
      index: 2,
      item: -3,
      error: "item -3 is expired",
    })
    expect(tolerant.results[4]).toEqual({
      status: "rejected",
      index: 4,
      item: -5,
      error: "item -5 is expired",
    })
  })

  it("onError: collect on an empty over returns a zeroed tolerant envelope, not a bare array", async () => {
    const wf: RuntimeWorkflow = {
      id: "pipeline-collect-empty",
      steps: [
        {
          kind: "pipeline",
          id: "p1",
          over: () => [],
          onError: "collect",
          stages: [
            () => ({
              kind: "tool",
              id: "s",
              tool: maybeThrowTool,
              candidates: flakyCandidates,
              input: () => ({ n: 1 }),
            }),
          ],
        },
      ],
    }
    const result = await runWorkflow({ workflow: wf })
    expect(result.bindings.steps.p1).toEqual({ results: [], succeeded: 0, failed: 0 })
  })
})

// ── Agent step `model` (PR-G1) ───────────────────────────────────────

describe("runWorkflow — agent step model", () => {
  it("threads a literal model onto host.spawn's harness (same semantics as agent_start.model)", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-model",
      steps: [
        { kind: "agent", id: "s1", adapter: "mock-adapter", model: "glm-5.3-flash", prompt: () => "p" },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(host.spawn).toHaveBeenCalledWith(
      "mock-adapter",
      expect.objectContaining({ harness: { model: "glm-5.3-flash" } }),
    )
  })

  it("resolves a model selector per run against the bindings", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-model-selector",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          model: (b) => `m-${String((b.input as { n: string }).n)}`,
          prompt: () => "p",
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host, input: { n: "1" } })
    expect(host.spawn).toHaveBeenLastCalledWith(
      "mock-adapter",
      expect.objectContaining({ harness: { model: "m-1" } }),
    )
    await runWorkflow({ workflow: wf, agents: host, input: { n: "2" } })
    expect(host.spawn).toHaveBeenLastCalledWith(
      "mock-adapter",
      expect.objectContaining({ harness: { model: "m-2" } }),
    )
  })

  it("an explicit harness.model pinning wins over step.model", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-model-pinning",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock-adapter",
          model: "step-model",
          harness: { model: "harness-model" },
          prompt: () => "p",
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(host.spawn).toHaveBeenCalledWith(
      "mock-adapter",
      expect.objectContaining({ harness: { model: "harness-model" } }),
    )
  })

  it("no model and no harness ⇒ spawn opts untouched (zero-diff default)", async () => {
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "agent-no-model",
      steps: [{ kind: "agent", id: "s1", adapter: "mock-adapter", prompt: () => "p" }],
    }
    await runWorkflow({ workflow: wf, agents: host })
    expect(host.spawn).toHaveBeenCalledWith("mock-adapter", { cwd: undefined, workspaceSlug: undefined, stepId: "s1" })
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

  it("model changed — hash miss re-executes (model is part of the cache key)", async () => {
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
      id: "cache-model-changed",
      steps: [
        {
          kind: "agent",
          id: "research",
          adapter: "claude",
          model: (b) => `m-${String(b.input)}`,
          cacheable: true,
          prompt: () => "do research",
          outputSchema: z.object({ ok: z.boolean() }),
        },
      ],
    }
    const { cache } = memCache()
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1", input: "alpha" })
    // same model → cache hit
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1", input: "alpha" })
    // different model → cache miss
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-1", input: "beta" })
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

  it("map of cacheable tool items — each item caches independently (F33)", async () => {
    const runsByN: number[] = []
    const countingProvider = defineDriver({
      id: "counting-map",
      name: "Counting",
      description: "Counts runs, tagged by input n.",
      kind: "builtin",
      implements: [{ tool: "demo.double", version: "0.1.0" }],
      implementations: [
        implementTool(doubleTool, ({ input }) => {
          runsByN.push(input.n)
          return { n: input.n * 2 }
        }),
      ],
    })
    const mapWf = (xs: number[]): RuntimeWorkflow => ({
      id: "cache-map",
      steps: [
        {
          kind: "map",
          id: "doubled",
          parallelism: 2,
          over: () => xs,
          body: () => ({
            kind: "tool",
            id: "d",
            tool: doubleTool,
            candidates: [countingProvider],
            cacheable: true,
            input: (b) => ({ n: b.item as number }),
          }),
        },
      ],
      output: (b) => b.steps.doubled,
    })
    const { cache } = memCache()

    const r1 = await runWorkflow({ workflow: mapWf([1, 2, 3]), cache, cacheKey: "run-map" })
    expect(runsByN.sort()).toEqual([1, 2, 3])
    expect(r1.output).toEqual([{ n: 2 }, { n: 4 }, { n: 6 }])

    // Second run, same items, same cacheKey ⇒ every item is a cache hit —
    // before the F33 fix all three items shared ONE journal key (same
    // step id + kind) and stomped each other, so this never hit for >1 item.
    runsByN.length = 0
    const r2 = await runWorkflow({ workflow: mapWf([1, 2, 3]), cache, cacheKey: "run-map" })
    expect(runsByN).toEqual([])
    expect(r2.output).toEqual(r1.output)

    // Change only the middle item's input ⇒ only that item re-runs; the
    // other two stay cache hits.
    runsByN.length = 0
    const r3 = await runWorkflow({ workflow: mapWf([1, 20, 3]), cache, cacheKey: "run-map" })
    expect(runsByN).toEqual([20])
    expect(r3.output).toEqual([{ n: 2 }, { n: 40 }, { n: 6 }])
  })

  it("a failing later step doesn't stop an earlier cacheable step from replaying on re-run with the same cacheKey", async () => {
    let doubleRuns = 0
    let addTenAttempts = 0
    const doubleProvider = defineDriver({
      id: "counting-double",
      name: "Counting double",
      description: "Counts invocations of demo.double.",
      kind: "builtin",
      implements: [{ tool: "demo.double", version: "0.1.0" }],
      implementations: [
        implementTool(doubleTool, ({ input }) => {
          doubleRuns++
          return { n: input.n * 2 }
        }),
      ],
    })
    // Fails on the first attempt (simulating a transient failure), succeeds
    // on any retry — the re-run-from-failure scenario the cacheKey is for.
    const flakyAddTenProvider = defineDriver({
      id: "flaky-add-ten",
      name: "Flaky add ten",
      description: "Throws on the first attempt, succeeds after.",
      kind: "builtin",
      implements: [{ tool: "demo.add-ten", version: "0.1.0" }],
      implementations: [
        implementTool(addTenTool, ({ input }) => {
          addTenAttempts++
          if (addTenAttempts === 1) throw new Error("transient failure")
          return { n: input.n + 10 }
        }),
      ],
    })
    const wf: RuntimeWorkflow = {
      id: "cache-replay-on-failure",
      steps: [
        {
          kind: "tool",
          id: "d",
          tool: doubleTool,
          candidates: [doubleProvider],
          cacheable: true,
          input: (b) => ({ n: (b.input as { n: number }).n }),
        },
        {
          kind: "tool",
          id: "a",
          tool: addTenTool,
          candidates: [flakyAddTenProvider],
          cacheable: true,
          input: (b) => ({ n: (b.steps.d as { n: number }).n }),
        },
      ],
    }
    const { cache } = memCache()
    await expect(
      runWorkflow({ workflow: wf, input: { n: 5 }, cache, cacheKey: "run-retry" }),
    ).rejects.toThrow("transient failure")
    expect(doubleRuns).toBe(1)
    expect(addTenAttempts).toBe(1)

    // Re-run with the SAME cacheKey: the already-succeeded "d" step replays
    // from the journal (no second dispatch); only the failed "a" step
    // re-executes, and this time succeeds.
    const { output } = await runWorkflow({ workflow: wf, input: { n: 5 }, cache, cacheKey: "run-retry" })
    expect(doubleRuns).toBe(1)
    expect(addTenAttempts).toBe(2)
    expect(output).toEqual({ n: 20 })
  })

  it("a cache-hit step still fires onStepStart/onStepComplete, tagged cached (F35) — agent, tool, and map items", async () => {
    let spawns = 0
    const host = fakeHost({
      spawn: vi.fn(async () => `sess_${spawns++}`),
      readFinalMessage: vi.fn(async () => JSON.stringify({ ok: true })),
    })
    const wf: RuntimeWorkflow = {
      id: "cache-hooks",
      steps: [
        {
          kind: "agent",
          id: "research",
          adapter: "claude",
          cacheable: true,
          prompt: () => "do research",
          outputSchema: z.object({ ok: z.boolean() }),
        },
        {
          kind: "tool",
          id: "d",
          tool: doubleTool,
          candidates,
          cacheable: true,
          input: () => ({ n: 1 }),
        },
        {
          kind: "map",
          id: "chunks",
          over: () => [1, 2],
          body: () => ({
            kind: "agent",
            id: "clean-chunk",
            adapter: "claude",
            cacheable: true,
            prompt: (b) => `clean ${String(b.item)}`,
            outputSchema: z.object({ ok: z.boolean() }),
          }),
        },
      ],
    }
    const { cache } = memCache()
    const record = () => {
      const starts: Array<[string, unknown]> = []
      const completes: Array<[string, unknown]> = []
      return {
        starts,
        completes,
        onStepStart: (id: string, info?: { cached?: boolean }) => { starts.push([id, info]) },
        onStepComplete: (id: string, _out: unknown, info?: { cached?: boolean }) => { completes.push([id, info]) },
      }
    }

    const first = record()
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-hooks", ...first })
    expect(spawns).toBe(3)
    // First run executes everything — no cached tag anywhere.
    expect(first.starts.every(([, info]) => info === undefined)).toBe(true)
    expect(first.completes.every(([, info]) => info === undefined)).toBe(true)

    const second = record()
    await runWorkflow({ workflow: wf, agents: host, cache, cacheKey: "run-hooks", ...second })
    expect(spawns).toBe(3)
    const leafIds = ["research", "d", "clean-chunk[0]", "clean-chunk[1]"]
    for (const id of leafIds) {
      expect(second.starts).toContainEqual([id, { cached: true }])
      expect(second.completes).toContainEqual([id, { cached: true }])
    }
    // The map container itself executed (it isn't cacheable) — not tagged.
    expect(second.starts).toContainEqual(["chunks", undefined])
    expect(second.completes).toContainEqual(["chunks", undefined])
  })
})

describe("runWorkflow — agent step harness.knowledge materialization (AIP-15 P2)", () => {
  const entry = (slug: string, tags: string[], extra = ""): string =>
    [
      "---",
      "schema: knowledge.entry/v1",
      `slug: ${slug}`,
      "kind: fact",
      `title: ${slug[0]!.toUpperCase()}${slug.slice(1)}`,
      `tags: [${tags.join(", ")}]`,
      ...(extra ? [extra] : []),
      "---",
      "",
      `Body of ${slug}.`,
      "",
    ].join("\n")

  /** A minimal AIP-10 corpus workspace: three matching-tag entries, one
   *  without the allOf tag, one archived tombstone. */
  function makeCorpus(): string {
    const ws = mkdtempSync(join(tmpdir(), "corpus-"))
    mkdirSync(join(ws, "entries"), { recursive: true })
    writeFileSync(join(ws, "entries", "alpha.md"), entry("alpha", ["book-factory", "style-guide"]))
    writeFileSync(join(ws, "entries", "beta.md"), entry("beta", ["book-factory"]))
    writeFileSync(
      join(ws, "entries", "gamma.md"),
      entry("gamma", ["book-factory"], "metadata:\n  corpus:\n    status: archived"),
    )
    writeFileSync(join(ws, "entries", "delta.md"), entry("delta", ["book-factory", "style-guide"]))
    return ws
  }

  function stepHarness(workspace: string, extra: Record<string, unknown> = {}) {
    return {
      knowledge: [{ workspace, anyOf: ["book-factory"], ...extra }],
    }
  }

  it("materializes matching entries into .knowledge/, prepends the prompt note, and records knowledgeApplied", async () => {
    const ws = makeCorpus()
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    const prompts: string[] = []
    const host = fakeHost({
      sendPromptAndWait: async (_sid, prompt) => {
        prompts.push(prompt)
      },
    })
    const wf: RuntimeWorkflow = {
      id: "knowledge-materialize",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "write the chapter",
          cwd: () => stepCwd,
          harness: stepHarness(ws),
        },
      ],
    }
    const { bindings } = await runWorkflow({ workflow: wf, agents: host })
    // gamma (archived tombstone) is skipped → 3 matched/written
    expect((bindings.steps.s1 as { knowledgeApplied?: unknown }).knowledgeApplied).toEqual([
      { workspace: ws, matched: 3, written: 3 },
    ])
    // Prompt note prepended, original prompt preserved after it
    expect(prompts[0]).toContain(".knowledge/INDEX.md, 3 entries")
    expect(prompts[0]).toContain("write the chapter")
    // Raw entries (frontmatter + body) written under .knowledge/<basename>/
    const kdir = join(stepCwd, ".knowledge", basename(ws))
    const alpha = readFileSync(join(kdir, "alpha.md"), "utf8")
    expect(alpha).toContain("schema: knowledge.entry/v1")
    expect(alpha).toContain("Body of alpha.")
    expect(readFileSync(join(kdir, "beta.md"), "utf8")).toContain("Body of beta.")
    expect(readFileSync(join(kdir, "delta.md"), "utf8")).toContain("Body of delta.")
    // Deterministic INDEX: slug-ascending, one line per entry
    const index = readFileSync(join(stepCwd, ".knowledge", "INDEX.md"), "utf8")
    expect(index).toContain(`## ${basename(ws)}`)
    expect(index.indexOf("alpha.md")).toBeLessThan(index.indexOf("beta.md"))
    expect(index.indexOf("beta.md")).toBeLessThan(index.indexOf("delta.md"))
    expect(index).toContain(`- [Alpha](${basename(ws)}/alpha.md) — fact, book-factory, style-guide`)
  })

  it("applies allOf as a post-filter and caps at maxEntries", async () => {
    const ws = makeCorpus()
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    const host = fakeHost()
    const wf: RuntimeWorkflow = {
      id: "knowledge-allof-cap",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "go",
          cwd: () => stepCwd,
          harness: stepHarness(ws, { allOf: ["style-guide"], maxEntries: 1 }),
        },
      ],
    }
    const { bindings } = await runWorkflow({ workflow: wf, agents: host })
    // beta lacks style-guide; gamma is archived → matched 2, capped to 1
    expect((bindings.steps.s1 as { knowledgeApplied?: unknown }).knowledgeApplied).toEqual([
      { workspace: ws, matched: 2, written: 1 },
    ])
    const kdir = join(stepCwd, ".knowledge", basename(ws))
    expect(readFileSync(join(kdir, "alpha.md"), "utf8")).toContain("Body of alpha.")
    expect(readFileSync(join(stepCwd, ".knowledge", "INDEX.md"), "utf8")).not.toContain("delta.md")
  })

  it("is idempotent — a second run rewrites the same deterministic file set", async () => {
    const ws = makeCorpus()
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    const wf: RuntimeWorkflow = {
      id: "knowledge-idempotent",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "go",
          cwd: () => stepCwd,
          harness: stepHarness(ws),
        },
      ],
    }
    await runWorkflow({ workflow: wf, agents: fakeHost() })
    const index1 = readFileSync(join(stepCwd, ".knowledge", "INDEX.md"), "utf8")
    await runWorkflow({ workflow: wf, agents: fakeHost() })
    expect(readFileSync(join(stepCwd, ".knowledge", "INDEX.md"), "utf8")).toBe(index1)
    expect(readFileSync(join(stepCwd, ".knowledge", basename(ws), "alpha.md"), "utf8")).toContain(
      "Body of alpha.",
    )
  })

  it("records matched: 0 without failing and emits a knowledge-empty harness warning", async () => {
    const ws = makeCorpus()
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    const warnings: unknown[] = []
    const host = fakeHost({
      emitHarnessWarning: (w) => {
        warnings.push(w)
      },
    })
    const wf: RuntimeWorkflow = {
      id: "knowledge-empty",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "go",
          cwd: () => stepCwd,
          harness: stepHarness(ws, { anyOf: ["no-such-tag"] }),
        },
      ],
    }
    const { bindings } = await runWorkflow({ workflow: wf, agents: host })
    expect((bindings.steps.s1 as { knowledgeApplied?: unknown }).knowledgeApplied).toEqual([
      { workspace: ws, matched: 0, written: 0 },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      sessionId: "sess_fake",
      label: "s1",
      warnings: [expect.stringContaining("knowledge-empty")],
    })
  })

  it("resolves $-bearing workspace and anyOf refs against the run bindings before materializing", async () => {
    // Corpus at `<base>/knowledge` so `$input.bookDir/knowledge` lands on it.
    const base = mkdtempSync(join(tmpdir(), "book-"))
    const ws = join(base, "knowledge")
    mkdirSync(join(ws, "entries"), { recursive: true })
    writeFileSync(join(ws, "entries", "alpha.md"), entry("alpha", ["book-factory"]))
    writeFileSync(join(ws, "entries", "beta.md"), entry("beta", ["book-factory"]))
    writeFileSync(
      join(ws, "entries", "gamma.md"),
      entry("gamma", ["book-factory"], "metadata:\n  corpus:\n    status: archived"),
    )
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    const prompts: string[] = []
    const host = fakeHost({
      sendPromptAndWait: async (_sid, prompt) => {
        prompts.push(prompt)
      },
    })
    const wf: RuntimeWorkflow = {
      id: "knowledge-refs",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "write the chapter",
          cwd: () => stepCwd,
          harness: {
            knowledge: [
              {
                workspace: "$input.bookDir/knowledge",
                anyOf: ["$input.topicTag"],
                deferred: true,
              },
            ],
          },
        },
      ],
    }
    const { bindings } = await runWorkflow({
      workflow: wf,
      agents: host,
      input: { bookDir: base, topicTag: "book-factory" },
    })
    // The workspace carried the ref: `$input.bookDir/knowledge` resolved to
    // the corpus dir itself; the tag ref resolved to `book-factory`.
    // gamma (archived) is skipped → 2 matched/written
    expect((bindings.steps.s1 as { knowledgeApplied?: unknown }).knowledgeApplied).toEqual([
      { workspace: ws, matched: 2, written: 2 },
    ])
    const kdir = join(stepCwd, ".knowledge", basename(ws))
    expect(readFileSync(join(kdir, "alpha.md"), "utf8")).toContain("Body of alpha.")
    expect(prompts[0]).toContain(".knowledge/INDEX.md, 2 entries")
  })

  it("throws naming the step and field when a selector ref resolves to nothing", async () => {
    const ws = makeCorpus()
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    const wf: RuntimeWorkflow = {
      id: "knowledge-ref-missing",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "go",
          cwd: () => stepCwd,
          harness: {
            knowledge: [{ workspace: "$input.noSuchDir/knowledge", deferred: true }],
          },
        },
      ],
    }
    await expect(
      runWorkflow({ workflow: wf, agents: fakeHost(), input: { bookDir: ws } }),
    ).rejects.toThrow(
      /step 's1': harness\.knowledge\[0\]\.workspace '\$input\.noSuchDir' resolves to nothing/,
    )
  })

  it("warns knowledge-workspace-missing (not a throw) when the resolved workspace does not exist", async () => {
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    const warnings: unknown[] = []
    const host = fakeHost({
      emitHarnessWarning: (w) => {
        warnings.push(w)
      },
    })
    const wf: RuntimeWorkflow = {
      id: "knowledge-missing-after-resolve",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "go",
          cwd: () => stepCwd,
          harness: {
            knowledge: [{ workspace: "$input.bookDir/no-such-corpus", deferred: true }],
          },
        },
      ],
    }
    const { bindings } = await runWorkflow({
      workflow: wf,
      agents: host,
      input: { bookDir: stepCwd },
    })
    expect((bindings.steps.s1 as { knowledgeApplied?: unknown }).knowledgeApplied).toEqual([
      { workspace: join(stepCwd, "no-such-corpus"), matched: 0, written: 0 },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      sessionId: "sess_fake",
      label: "s1",
      warnings: [expect.stringContaining("knowledge-workspace-missing")],
    })
  })

  it("joins a relative resolved workspace to the run cwd and materializes", async () => {
    const stepCwd = mkdtempSync(join(tmpdir(), "stepcwd-"))
    // Corpus INSIDE the step cwd, referenced by a ref that resolves to a
    // RELATIVE workspace — it must join against the run cwd.
    const relName = "corpus-rel"
    mkdirSync(join(stepCwd, relName, "entries"), { recursive: true })
    writeFileSync(join(stepCwd, relName, "entries", "alpha.md"), entry("alpha", ["book-factory"]))
    const wf: RuntimeWorkflow = {
      id: "knowledge-relative",
      steps: [
        {
          kind: "agent",
          id: "s1",
          adapter: "mock",
          prompt: () => "go",
          cwd: () => stepCwd,
          harness: {
            knowledge: [{ workspace: "$input.rel", deferred: true }],
          },
        },
      ],
    }
    const { bindings } = await runWorkflow({
      workflow: wf,
      agents: fakeHost(),
      input: { rel: relName },
    })
    expect((bindings.steps.s1 as { knowledgeApplied?: unknown }).knowledgeApplied).toEqual([
      { workspace: join(stepCwd, relName), matched: 1, written: 1 },
    ])
    expect(
      readFileSync(join(stepCwd, ".knowledge", relName, "alpha.md"), "utf8"),
    ).toContain("Body of alpha.")
  })
})
