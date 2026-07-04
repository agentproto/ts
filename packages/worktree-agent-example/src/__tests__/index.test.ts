/**
 * The workflow def moved to `@agentproto/worktree` (see its own
 * `src/__tests__/workflow.test.ts` for full coverage) — this just pins the
 * back-compat re-export.
 */
import { describe, it, expect } from "vitest"
import { worktreeAgentWorkflow, worktreeAgentInputSchema } from "../index.js"

describe("worktree-agent-example re-export", () => {
  it("re-exports the workflow def from @agentproto/worktree", () => {
    expect(worktreeAgentWorkflow.id).toBe("worktree-agent")
    expect(worktreeAgentInputSchema.safeParse({ repoRoot: "/tmp/x", slug: "s", task: "t", gateCmd: "true" }).success).toBe(true)
  })
})
