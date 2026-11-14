/**
 * An agent step with NO explicit `policy` gets the default `{ awaiting: "fail" }`
 * at run time: a session parked on an approval must fail the step instead of
 * the run reporting `done` (scout-run, 2026-11-13). WORKFLOW.md steps that omit
 * `policy` compile to `policy: undefined`, which used to skip the host check.
 */

import { describe, it, expect, vi } from "vitest"
import { runWorkflow, type AgentSessionHost, type AgentStep, type RuntimeWorkflow } from "../index.js"

function host(onAwaitingInput: AgentSessionHost["onAwaitingInput"]) {
  return {
    spawn: vi.fn(async () => "sess_1"),
    sendPromptAndWait: vi.fn(async () => {}),
    resolveByLabel: vi.fn(() => undefined as string | undefined),
    releaseSession: vi.fn(async () => {}),
    onAwaitingInput,
  }
}

const wf = (step: Partial<AgentStep> = {}): RuntimeWorkflow => ({
  id: "awaiting-wf",
  steps: [{ kind: "agent", id: "scout", adapter: "mock", prompt: () => "go", ...step } as AgentStep],
})

describe("agent step, awaiting-input default policy", () => {
  it("consults the host with { awaiting: 'fail' } when the step has no policy, and a throw fails the run", async () => {
    const onAwaitingInput = vi.fn(async () => {
      throw new Error("step failed: session sess_1 is parked on a permission request")
    })
    await expect(runWorkflow({ workflow: wf(), agents: host(onAwaitingInput) })).rejects.toThrow(/parked/)
    expect(onAwaitingInput).toHaveBeenCalledWith("sess_1", { awaiting: "fail" })
  })

  it("an explicit policy is passed through unchanged", async () => {
    const onAwaitingInput = vi.fn(async () => {})
    const policy = { awaiting: "escalate" as const }
    await runWorkflow({ workflow: wf({ policy }), agents: host(onAwaitingInput) })
    expect(onAwaitingInput).toHaveBeenCalledWith("sess_1", policy)
  })
})
