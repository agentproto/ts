/**
 * `repo-maintenance` is a hand-authored bundled app (`.agentproto/APP.md` +
 * `agents/` + `workflows/`), not a `defineApp()`/`.emit()`-generated one —
 * see `repo-maintenance/README.md` for why (the `maintain` workflow's
 * `review` map step needs a real function for its per-candidate model
 * selector, which only the `entry:` loader path can carry). This exercises
 * the REAL on-disk files through `loadAppHandle`, the same loader
 * `app_install` uses, so a frontmatter/schema mistake fails here instead of
 * only at install time.
 */

import { describe, it, expect } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadAppHandle } from "@agentproto/app-kit"

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "repo-maintenance")

describe("repo-maintenance app", () => {
  it("loads through loadAppHandle with the expected identity and attachment", async () => {
    const app = await loadAppHandle(APP_DIR)
    expect(app.id).toBe("@agentproto/repo-maintenance")
    expect(app.agents.map(a => a.agent.id)).toEqual(["@agentproto/repo-maintenance-reviewer"])
    expect(app.workflows.map(w => w.id)).toEqual(["maintain"])
    const { agent } = app.agents[0]!
    expect(agent.workflows).toContainEqual({ ref: "maintain" })
  })

  it("gives the reviewer read-only investigation tools plus branch_gc_verdict, never a mutating git tool", async () => {
    const app = await loadAppHandle(APP_DIR)
    const { agent } = app.agents[0]!
    expect(agent.tools).toContain("branch_gc_verdict")
    expect((agent.boundaries ?? []).some((b: string) => /read-only/i.test(b))).toBe(true)
  })

  it("compiles the maintain workflow's expected top-level step sequence", async () => {
    const app = await loadAppHandle(APP_DIR)
    const [workflow] = app.workflows
    const stepIds = workflow!.steps.map(s => `${s.id}:${s.kind}`)
    expect(stepIds).toEqual([
      "modelRoles:tool",
      "worktreeGcPlan:tool",
      "branchGcPlan:tool",
      "reviewQueue:transform",
      "reviewCandidates:transform",
      "reviewWorktreePaths:transform",
      "review:map",
      "reviewCleanup:tool",
      "branchGcVerify:tool",
      "gaps:transform",
      "worktreeGcApply:tool",
      "branchGcApply:tool",
      "report:transform",
      "notifyBody:transform",
      "shouldNotify:transform",
      "maybeNotify:branch",
      "notify:tool",
      "skip-notify:gate",
    ])
    const reviewStep = workflow!.steps.find(s => s.id === "review") as {
      steps: Array<{ id: string; kind: string; agent?: { ref: string }; sessionRef?: string }>
    }
    // reviewOne, then the missing-verdict retry: per-tip check (a map over
    // the item's tips — one verdict_get per tip) → same-session nudge →
    // check → large-model retry.
    expect(reviewStep.steps.map(s => `${s.id}:${s.kind}`)).toEqual([
      "reviewWorktreeAdd:tool",
      "reviewOne:agent",
      "verdictCheck:map",
      "needsNudge:transform",
      "needsNudgeBranch:branch",
      "nudge:agent",
      "verdictCheckAfterNudge:map",
      "needsLargeRetry:transform",
      "needsLargeRetryBranch:branch",
      "reviewRetryLarge:agent",
      "reviewSettled:transform",
      "reviewWorktreeRemove:tool",
    ])
    expect(reviewStep.steps.find(s => s.id === "reviewOne")!.agent?.ref).toBe("@agentproto/repo-maintenance-reviewer")
    expect(reviewStep.steps.find(s => s.id === "nudge")!.sessionRef).toBe("reviewOne[{{index}}]")
    expect(reviewStep.steps.find(s => s.id === "reviewRetryLarge")!.agent?.ref).toBe("@agentproto/repo-maintenance-reviewer")
  })

  it("never reclaims a reviewed branch on apply — includeReviewed stays false on branchGcApply", async () => {
    const app = await loadAppHandle(APP_DIR)
    const [workflow] = app.workflows
    const applyStep = workflow!.steps.find(s => s.id === "branchGcApply") as { inputs: Record<string, unknown> }
    expect(applyStep.inputs.includeReviewed).toBe(false)
  })

  describe("reviewer models come from model roles", () => {
    type Sel = (b: unknown) => string | undefined
    const load = async () => {
      const app = await loadAppHandle(APP_DIR)
      const [workflow] = app.workflows
      const review = workflow!.steps.find(s => s.id === "review") as { steps: Array<{ id: string; model?: unknown }> }
      return {
        app,
        workflow: workflow!,
        small: (review.steps.find(s => s.id === "reviewOne")!.model) as Sel,
        retry: (review.steps.find(s => s.id === "reviewRetryLarge")!.model) as Sel,
      }
    }
    // What the daemon's `model_roles` tool returns for the `modelRoles` step.
    const roles = (models: Record<string, string>) => ({ modelRoles: { models } })

    it("asks model_roles for review.small/review.large, folding the explicit inputs in as its top layer", async () => {
      const { workflow } = await load()
      const step = workflow.steps.find(s => s.id === "modelRoles") as { kind: string; tool: string; inputs: Record<string, unknown> }
      expect(step.kind).toBe("tool")
      expect(step.tool).toBe("model_roles")
      expect(step.inputs.roles).toEqual(["review.small", "review.large"])
      expect(step.inputs.inputs).toEqual({ "review.small": "$input.reviewModelSmall", "review.large": "$input.reviewModelLarge" })
    })

    it("does not default the model inputs (a default would be indistinguishable from an explicit choice)", async () => {
      const { workflow } = await load()
      const inputs = (workflow as unknown as { inputs: Record<string, { default?: unknown }> }).inputs
      expect(inputs.reviewModelSmall).toBeDefined()
      expect(inputs.reviewModelSmall!.default).toBeUndefined()
      expect(inputs.reviewModelLarge!.default).toBeUndefined()
    })

    it("picks the configured role by residual size, and the retry reviewer uses review.large", async () => {
      const { small, retry } = await load()
      const steps = roles({ "review.small": "cfg-small", "review.large": "cfg-large" })
      expect(small({ input: {}, steps, item: { residualFileCount: 2 } })).toBe("cfg-small")
      expect(small({ input: {}, steps, item: { residualFileCount: 4 } })).toBe("cfg-large")
      expect(retry({ input: {}, steps })).toBe("cfg-large")
    })

    it("an explicit input wins over the resolved role", async () => {
      const { small, retry } = await load()
      const steps = roles({ "review.small": "cfg-small", "review.large": "cfg-large" })
      const input = { reviewModelSmall: "in-small", reviewModelLarge: "in-large" }
      expect(small({ input, steps, item: { residualFileCount: 1 } })).toBe("in-small")
      expect(small({ input, steps, item: { residualFileCount: 9 } })).toBe("in-large")
      expect(retry({ input, steps })).toBe("in-large")
    })

    it("with no role resolution at all the selector yields undefined, leaving the reviewer AGENT.md model in charge", async () => {
      const { small } = await load()
      expect(small({ input: {}, steps: {}, item: { residualFileCount: 1 } })).toBeUndefined()
    })

    it("the reviewer AGENT.md references the review.large role instead of a model id", async () => {
      const { app } = await load()
      expect(app.agents[0]!.agent.model).toBe("role:review.large")
    })
  })
})
