/**
 * Loads the REAL shipped `repo-maintenance` app's `maintain` WORKFLOW.md
 * (+ its `entry.mjs`) exactly as the daemon would via `workflow_run_file`,
 * and compiles + runs it end to end against a fake `dispatchTool` and a
 * fake agent host — no live daemon, no real branch_gc/worktree_gc
 * execution, no real agent spawn. Mirrors the pattern
 * `worktree-gc-notify-workflow.test.ts` uses for the sibling
 * `@agentproto/worktree` routine.
 */

import { describe, it, expect, vi } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "repo-maintenance",
  ".agentproto",
  "workflows",
  "maintain",
  "WORKFLOW.md",
)

const SHA_A = "a".repeat(40) // small residual — reviewed twice (local + remote twin)
const SHA_B = "b".repeat(40) // large residual — never gets a verdict (the "gap")
const BASE_SHA = "c".repeat(40)

function branchGcPlanFixture(withVerdictOnA: boolean, verdictOnB?: { triage: string; agree: boolean | null }) {
  const verdictA = withVerdictOnA
    ? { verdict: { triage: "obsolete", agree: true, reviewer: "repo-maintenance-reviewer" } }
    : {}
  const verdictB = verdictOnB ? { verdict: { ...verdictOnB, reviewer: "repo-maintenance-reviewer" } } : {}
  return {
    mode: "plan",
    plan: {
      repoRoot: "/repo",
      repoName: "repo",
      base: "origin/main",
      baseSha: BASE_SHA,
      scopes: ["local", "remote", "orphan"],
      otherRemoteRefs: 0,
      entries: [
        {
          kind: "local",
          name: "wt/small-residual",
          ref: "refs/heads/wt/small-residual",
          sha: SHA_A,
          date: "2026-01-01T00:00:00Z",
          author: "a",
          subject: "small",
          ageDays: 10,
          class: "review",
          status: "unmerged",
          history: "current",
          ahead: 1,
          behind: 0,
          residualFiles: ["a.txt"],
          residualFileCount: 2,
          ...verdictA,
        },
        {
          kind: "remote",
          name: "wt/small-residual",
          ref: "refs/remotes/origin/wt/small-residual",
          remote: "origin",
          sha: SHA_A, // same tip as the local ref above — must dedupe to ONE review candidate
          date: "2026-01-01T00:00:00Z",
          author: "a",
          subject: "small",
          ageDays: 10,
          class: "review",
          status: "unmerged",
          history: "current",
          ahead: 1,
          behind: 0,
          residualFiles: ["a.txt"],
          residualFileCount: 2,
          ...verdictA,
        },
        {
          kind: "local",
          name: "wt/large-residual",
          ref: "refs/heads/wt/large-residual",
          sha: SHA_B,
          date: "2026-01-01T00:00:00Z",
          author: "b",
          subject: "large",
          ageDays: 20,
          class: "review",
          status: "unmerged",
          history: "current",
          ahead: 5,
          behind: 0,
          residualFiles: ["b1.txt", "b2.txt", "b3.txt", "b4.txt"],
          residualFileCount: 4,
          ...verdictB,
        },
        {
          kind: "local",
          name: "wt/merged-already",
          ref: "refs/heads/wt/merged-already",
          sha: "d".repeat(40),
          date: "2026-01-01T00:00:00Z",
          author: "c",
          subject: "merged",
          ageDays: 30,
          class: "reclaim",
          reclaimReason: "merged",
          status: "merged",
          history: "current",
          ahead: 0,
          behind: 3,
        },
      ],
    },
    summary: {
      byClass: {
        local: { reclaim: 1, review: 2, hold: 0 },
        remote: { reclaim: 0, review: 1, hold: 0 },
        orphan: { reclaim: 0, review: 0, hold: 0 },
      },
      byStatus: {},
    },
  }
}

function mcpResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function fakeAgentHost(spawn: AgentSessionHost["spawn"]): AgentSessionHost {
  return {
    spawn,
    sendPromptAndWait: vi.fn(async () => {}),
    resolveByLabel: vi.fn(() => undefined),
  }
}

/** What `worktree_gc` really returns for a dry run (`makeWorktreeGcRunner`,
 *  cli/src/commands/worktree.ts): `plan` IS the entry array. */
function worktreeGcPlanFixture() {
  const wt = (path: string, cls: "reclaim" | "salvage" | "hold") => ({
    path,
    branch: `wt/${path}`,
    head: "1".repeat(40),
    class: cls,
    tree: "clean",
    integration: { state: "merged" },
    liveness: { state: "idle", sessionCount: 0 },
  })
  return { mode: "plan", plan: [wt("a", "reclaim"), wt("b", "reclaim"), wt("c", "salvage"), wt("d", "hold")] }
}

/**
 * A mock host that behaves like `SessionsRegistryAgentHost` where the retry
 * path cares: every spawn is indexed under its `stepKey` (`reviewOne[0]`), so
 * a `sessionRef: "reviewOne[{{index}}]"` step resolves to that item's own
 * session. Records every spawn and every prompt sent.
 */
function recordingAgentHost() {
  const byLabel = new Map<string, string>()
  const spawns: Array<{ id: string; stepId?: string; stepKey?: string; model?: string }> = []
  const sends: Array<{ sessionId: string; prompt: string }> = []
  const host: AgentSessionHost = {
    spawn: vi.fn(async (_adapter, opts) => {
      const o = opts as { stepId?: string; stepKey?: string; harness?: { model?: string } }
      const id = `sess_${spawns.length + 1}`
      spawns.push({ id, stepId: o.stepId, stepKey: o.stepKey, model: o.harness?.model })
      if (o.stepKey) byLabel.set(o.stepKey, id)
      return id
    }),
    sendPromptAndWait: vi.fn(async (sessionId: string, prompt: string) => {
      sends.push({ sessionId, prompt })
    }),
    resolveByLabel: vi.fn((label: string) => byLabel.get(label)),
  }
  return { host, spawns, sends }
}

describe("repo-maintenance maintain workflow — shape", () => {
  it("loads and compiles with the expected top-level step sequence", async () => {
    const dispatchTool: DispatchTool = vi.fn(async () => mcpResult({}))
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    expect(handle.id).toBe("maintain")
    const stepIds = handle.steps.map(s => `${s.id}:${s.kind}`)
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
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    expect(compiled.id).toBe("maintain")
  })
})

describe("repo-maintenance maintain workflow — run (fake tools + fake agent)", () => {
  it("dedupes review candidates by tip sha, picks model by residual size, reports gaps, and skips notify with nothing new to say", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") {
        return mcpResult(inputs.apply ? { mode: "apply", outcomes: [] } : worktreeGcPlanFixture())
      }
      if (name === "branch_gc") {
        branchGcCallCount++
        // 1st call: branchGcPlan. 2nd: branchGcVerify (sha A now has a
        // verdict — simulates the review map having recorded one). 3rd:
        // branchGcApply.
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      if (name === "branch_gc_verdict_get") {
        // SHA_A's reviewer recorded a verdict; SHA_B's never does, whatever
        // the workflow tries.
        const missing = inputs.sha !== SHA_A
        return mcpResult({ sha: inputs.sha, found: !missing, missing, record: missing ? null : { sha: inputs.sha } })
      }
      throw new Error(`unexpected tool '${name}'`)
    })

    const { host, spawns, sends } = recordingAgentHost()
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: host,
      input: { repoRoot: "/repo", applyMerged: false },
    })

    // One reviewOne spawn per UNIQUE tip sha, not per ref — the local+remote
    // twin of SHA_A must collapse into one reviewer turn.
    const reviewSpawns = spawns.filter(s => s.stepId === "reviewOne")
    expect(reviewSpawns).toHaveLength(2)
    const byModel = new Map(reviewSpawns.map(s => [s.model, s]))
    expect(byModel.get("claude-haiku-4-5-20251001")).toBeDefined() // SHA_A: residualFileCount 2 <= 3
    expect(byModel.get("claude-sonnet-5")).toBeDefined() // SHA_B: residualFileCount 4 > 3

    // SHA_B (no verdict): nudged in its OWN session, then one fresh
    // large-model retry — and still a gap. SHA_A: neither.
    const reviewerOfB = sends.find(s => s.prompt.includes(`(tip ${SHA_B})`))!.sessionId
    const nudges = sends.filter(s => s.prompt.startsWith("You did not call branch_gc_verdict"))
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.sessionId).toBe(reviewerOfB)
    expect(nudges[0]!.prompt).toContain(SHA_B)
    const retries = spawns.filter(s => s.stepId === "reviewRetryLarge")
    expect(retries).toHaveLength(1)
    expect(retries[0]!.model).toBe("claude-sonnet-5")
    expect(sends.find(s => s.sessionId === retries[0]!.id)!.prompt).toContain(`(tip ${SHA_B})`)
    const checkedShas = calls.filter(c => c.name === "branch_gc_verdict_get").map(c => c.inputs.sha)
    expect(checkedShas.filter(sha => sha === SHA_A)).toHaveLength(1)
    expect(checkedShas.filter(sha => sha === SHA_B)).toHaveLength(2)

    // branch_gc plan called once up front, once again to verify verdicts,
    // once more as the (dry-run, since applyMerged is false) apply step.
    const branchGcCalls = calls.filter(c => c.name === "branch_gc")
    expect(branchGcCalls).toHaveLength(3)
    expect(branchGcCalls[0]!.inputs).toMatchObject({ apply: false })
    expect(branchGcCalls[2]!.inputs).toMatchObject({ apply: false, includeReviewed: false, scopes: ["local", "remote", "orphan"] })

    const worktreeGcCalls = calls.filter(c => c.name === "worktree_gc")
    expect(worktreeGcCalls).toHaveLength(2)
    expect(worktreeGcCalls[1]!.inputs).toMatchObject({ apply: false })

    // command_execute (the notify step) is never dispatched — no notify
    // input was given at all.
    expect(calls.some(c => c.name === "command_execute")).toBe(false)

    const result = output as { report: string; gaps: Array<{ name: string }>; applyMerged: boolean }
    expect(result.applyMerged).toBe(false)
    expect(result.gaps).toEqual([{ name: "wt/large-residual", sha: SHA_B, refs: ["refs/heads/wt/large-residual"] }])
    expect(result.report).toMatch(/wt\/large-residual/)
    expect(result.report).toMatch(/applyMerged.*is false|dry run only/i)
    // Worktrees: per-class counts off the real plan shape (P0-1).
    expect(result.report).toContain("4 worktree(s) classified")
    expect(result.report).toContain("reclaim=2 salvage=1 hold=1")
    // Review: the verdict tally, and no stale PLAN.md pointer.
    expect(result.report).toContain("verdicts: obsolete=1 (deletion agreed on 1)")
    expect(result.report).not.toContain("PLAN.md")
  })

  it("applies (apply:true) when applyMerged is true, and notifies when notify is set and there's something to report", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") {
        return mcpResult({ mode: inputs.apply ? "apply" : "plan", outcomes: [] })
      }
      if (name === "branch_gc") {
        branchGcCallCount++
        if (branchGcCallCount === 3) {
          // branchGcApply: pretend the one reclaim-class entry got deleted.
          return mcpResult({
            mode: "apply",
            outcomes: [{ kind: "local", name: "wt/merged-already", sha: "d".repeat(40), result: "deleted", reclaimReason: "merged" }],
            restoreLog: "/tmp/restore.json",
          })
        }
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      if (name === "branch_gc_verdict_get") {
        return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      }
      if (name === "command_execute") {
        return mcpResult({ exitCode: 0, stdout: "", stderr: "" })
      }
      throw new Error(`unexpected tool '${name}'`)
    })

    const spawn: AgentSessionHost["spawn"] = vi.fn(async () => "sess_x")

    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(spawn),
      input: {
        repoRoot: "/repo",
        applyMerged: true,
        notify: { channel: "telegram", address: "chat-1" },
      },
    })

    const branchGcCalls = calls.filter(c => c.name === "branch_gc")
    expect(branchGcCalls[2]!.inputs).toMatchObject({ apply: true, includeReviewed: false })
    const worktreeGcCalls = calls.filter(c => c.name === "worktree_gc")
    expect(worktreeGcCalls[1]!.inputs).toMatchObject({ apply: true, salvageDirty: false })

    const notifyCall = calls.find(c => c.name === "command_execute")
    expect(notifyCall).toBeDefined()
    const stdin = notifyCall!.inputs.stdin as string
    const body = JSON.parse(stdin) as { to: unknown; content: { text: string } }
    expect(body.to).toEqual({ channel: "telegram", address: "chat-1" })
    expect(body.content.text).toMatch(/wt\/large-residual/)

    const result = output as { applyMerged: boolean }
    expect(result.applyMerged).toBe(true)
  })
})

describe("repo-maintenance maintain workflow — missing-verdict retry", () => {
  /** Run the workflow with SHA_A always reviewed, and SHA_B's verdict landing
   *  only once `landsAfter` verdict checks for it have come back missing. */
  async function runWithVerdictLandingAfter(landsAfter: number) {
    const checksOfB = { n: 0 }
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      if (name === "worktree_gc") return mcpResult(inputs.apply ? { mode: "apply", outcomes: [] } : worktreeGcPlanFixture())
      if (name === "branch_gc") {
        branchGcCallCount++
        return mcpResult(
          branchGcPlanFixture(branchGcCallCount >= 2, branchGcCallCount >= 2 ? { triage: "salvage", agree: false } : undefined),
        )
      }
      if (name === "branch_gc_verdict_get") {
        let missing = false
        if (inputs.sha === SHA_B) missing = checksOfB.n++ < landsAfter
        return mcpResult({ sha: inputs.sha, found: !missing, missing, record: missing ? null : { sha: inputs.sha } })
      }
      throw new Error(`unexpected tool '${name}'`)
    })
    const { host, spawns, sends } = recordingAgentHost()
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({ workflow: compiled, agents: host, input: { repoRoot: "/repo" } })
    return { spawns, sends, output: output as { report: string; gaps: unknown[] } }
  }

  it("a verdict already stored after the first turn: no nudge, no retry", async () => {
    const { spawns, sends } = await runWithVerdictLandingAfter(0)
    expect(sends.some(s => s.prompt.startsWith("You did not call branch_gc_verdict"))).toBe(false)
    expect(spawns.map(s => s.stepId)).toEqual(["reviewOne", "reviewOne"])
  })

  it("the same-session nudge recovers it: no large-model retry", async () => {
    const { spawns, sends, output } = await runWithVerdictLandingAfter(1)
    const nudges = sends.filter(s => s.prompt.startsWith("You did not call branch_gc_verdict"))
    expect(nudges).toHaveLength(1)
    const reviewerOfB = sends.find(s => s.prompt.includes(`(tip ${SHA_B})`))!.sessionId
    expect(nudges[0]!.sessionId).toBe(reviewerOfB)
    expect(spawns.some(s => s.stepId === "reviewRetryLarge")).toBe(false)
    expect(output.gaps).toEqual([])
  })

  it("the large-model retry recovers it: not a gap, and a salvage verdict is named in the report", async () => {
    const { spawns, output } = await runWithVerdictLandingAfter(2)
    expect(spawns.filter(s => s.stepId === "reviewRetryLarge")).toHaveLength(1)
    expect(output.gaps).toEqual([])
    expect(output.report).toContain("every review candidate has a recorded verdict")
    expect(output.report).toContain("verdicts: obsolete=1 salvage=1 (deletion agreed on 1)")
    expect(output.report).toContain("**salvage — needs a human**: `wt/large-residual`")
  })
})

describe("repo-maintenance maintain workflow — rendered reviewer prompt", () => {
  const ANCHOR_SHA = "e".repeat(40)
  const TREE_SHA = "f".repeat(40)

  function reviewEntry(over: Record<string, unknown>) {
    return {
      kind: "local",
      date: "2026-01-01T00:00:00Z",
      author: "a",
      subject: "s",
      ageDays: 10,
      class: "review",
      status: "unmerged",
      ahead: 1,
      behind: 0,
      mergeBase: "9".repeat(40),
      residualFiles: ["a.txt"],
      residualFileCount: 1,
      ...over,
    }
  }

  async function renderPrompts(): Promise<Map<string, string>> {
    const plan = {
      mode: "plan",
      plan: {
        repoRoot: "/repo",
        repoName: "repo",
        base: "origin/main",
        baseSha: BASE_SHA,
        scopes: ["local"],
        entries: [
          // What branch_gc really emits for a current-history tip: compareBase
          // is base itself — NOT pre-rewrite. Merge conflicts ⇒ mergedTree null.
          reviewEntry({
            name: "wt/current",
            ref: "refs/heads/wt/current",
            sha: SHA_A,
            history: "current",
            compareBase: BASE_SHA,
            mergedTree: null,
          }),
          reviewEntry({
            name: "wt/old",
            ref: "refs/heads/wt/old",
            sha: SHA_B,
            history: "pre-rewrite",
            compareBase: ANCHOR_SHA,
            mergedTree: TREE_SHA,
          }),
        ],
      },
      summary: { byClass: { local: { reclaim: 0, review: 2, hold: 0 } }, byStatus: {} },
    }
    const dispatchTool: DispatchTool = vi.fn(async name => {
      if (name === "worktree_gc") return mcpResult({ mode: "plan", outcomes: [] })
      if (name === "branch_gc") return mcpResult(plan)
      if (name === "branch_gc_verdict_get") return mcpResult({ found: true, missing: false })
      throw new Error(`unexpected tool '${name}'`)
    })
    const sessionToSha = new Map<string, string>()
    const prompts = new Map<string, string>()
    let n = 0
    const host: AgentSessionHost = {
      spawn: vi.fn(async () => `sess_${++n}`),
      sendPromptAndWait: vi.fn(async (sessionId: string, prompt: string) => {
        const sha = prompt.includes(SHA_A) ? SHA_A : SHA_B
        sessionToSha.set(sessionId, sha)
        prompts.set(sha, prompt)
      }),
      resolveByLabel: vi.fn(() => undefined),
    }
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    await runWorkflow({ workflow: compiled, agents: host, input: { repoRoot: "/repo" } })
    return prompts
  }

  it("keeps the opening sentence (branch, tip, repo, base) and omits the pre-rewrite note for a current-history branch", async () => {
    const prompt = (await renderPrompts()).get(SHA_A)!
    expect(prompt.startsWith(
      `Review the local branch \`wt/current\` (tip ${SHA_A}) in the repo at /repo. ` +
        `It is unmerged relative to base origin/main (base sha ${BASE_SHA}). `,
    )).toBe(true)
    expect(prompt).not.toMatch(/pre-rewrite/)
    expect(prompt).not.toMatch(/compare base/)
    // A conflicting merge renders `null` explicitly, not an empty string.
    expect(prompt).toContain("or null when the merge conflicts): null. Ahead")
  })

  it("adds the compare base + pre-rewrite note only for a pre-rewrite branch", async () => {
    const prompt = (await renderPrompts()).get(SHA_B)!
    expect(prompt.startsWith(`Review the local branch \`wt/old\` (tip ${SHA_B}) in the repo at /repo.`)).toBe(true)
    expect(prompt).toContain(
      `(base sha ${BASE_SHA}), compare base ${ANCHOR_SHA} (pre-rewrite history — commit shas`,
    )
    expect(prompt).toContain(`or null when the merge conflicts): ${TREE_SHA}. Ahead`)
  })
})
