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
      "worktreeGcPlan:tool",
      "branchGcPlan:tool",
      "reviewCandidates:transform",
      "review:map",
      "branchGcVerify:tool",
      "gaps:transform",
      "branchGcApply:tool",
      "worktreeGcApply:tool",
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
    // reviewOne, then the missing-verdict retry: check → same-session nudge
    // → check → large-model retry.
    expect(reviewStep.steps.map(s => `${s.id}:${s.kind}`)).toEqual([
      "reviewOne:agent",
      "verdictCheck:tool",
      "needsNudge:branch",
      "nudge:agent",
      "verdictCheckAfterNudge:tool",
      "needsLargeRetry:branch",
      "reviewRetryLarge:agent",
      "reviewSettled:transform",
    ])
    expect(reviewStep.steps[0]!.agent?.ref).toBe("@agentproto/repo-maintenance-reviewer")
    expect(reviewStep.steps.find(s => s.id === "nudge")!.sessionRef).toBe("reviewOne[{{index}}]")
    expect(reviewStep.steps.find(s => s.id === "reviewRetryLarge")!.agent?.ref).toBe("@agentproto/repo-maintenance-reviewer")
  })

  it("never reclaims a reviewed branch on apply — includeReviewed stays false on branchGcApply", async () => {
    const app = await loadAppHandle(APP_DIR)
    const [workflow] = app.workflows
    const applyStep = workflow!.steps.find(s => s.id === "branchGcApply") as { inputs: Record<string, unknown> }
    expect(applyStep.inputs.includeReviewed).toBe(false)
  })
})
