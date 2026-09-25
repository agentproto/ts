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

function branchGcPlanFixture(withVerdictOnA: boolean) {
  const verdictA = withVerdictOnA
    ? { verdict: { triage: "obsolete", agree: true, reviewer: "repo-maintenance-reviewer" } }
    : {}
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
        return mcpResult({ mode: inputs.apply ? "apply" : "plan", outcomes: [] })
      }
      if (name === "branch_gc") {
        branchGcCallCount++
        // 1st call: branchGcPlan. 2nd: branchGcVerify (sha A now has a
        // verdict — simulates the review map having recorded one). 3rd:
        // branchGcApply.
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      throw new Error(`unexpected tool '${name}'`)
    })

    const spawnCalls: Array<{ adapter: string; opts: Record<string, unknown> }> = []
    const spawn: AgentSessionHost["spawn"] = vi.fn(async (adapter, opts) => {
      spawnCalls.push({ adapter, opts: opts as Record<string, unknown> })
      return `sess_${spawnCalls.length}`
    })

    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(spawn),
      input: { repoRoot: "/repo", applyMerged: false },
    })

    // Exactly one spawn per UNIQUE tip sha, not per ref — the local+remote
    // twin of SHA_A must collapse into one reviewer turn.
    expect(spawnCalls).toHaveLength(2)
    const bySha = new Map(spawnCalls.map(c => [(c.opts.harness as { model?: string })?.model, c]))
    expect(bySha.get("claude-haiku-4-5-20251001")).toBeDefined() // SHA_A: residualFileCount 2 <= 3
    expect(bySha.get("claude-sonnet-5")).toBeDefined() // SHA_B: residualFileCount 4 > 3

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
