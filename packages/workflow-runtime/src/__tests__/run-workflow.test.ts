/**
 * The step-walker over inline contracts (the framework can't depend on a
 * catalogue): tool output threads into later steps' bindings, `map` fans a tool
 * over an array with the element exposed as `bindings.item`, `transform`
 * combines + filters, and `branch` picks a path from a predicate.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
