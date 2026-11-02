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
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"
import { modelRoles } from "../model-roles-tools.js"

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

/** Daemon `models` block the fake `model_roles` tool resolves against (reset by each test that sets it). */
let daemonModels: Record<string, unknown> = {}

/** The REAL `model_roles` resolver over an in-memory daemon config — no disk, no workspace layer. */
async function modelRolesResult(inputs: Record<string, unknown>) {
  return mcpResult(
    await modelRoles(inputs as never, { loadCfg: async () => ({ models: daemonModels }) as never, resolveRoot: async () => undefined }),
  )
}

/** What `branch_gc_review_worktree` answers (no real git here). */
function reviewWorktreeResult(inputs: Record<string, unknown>) {
  return mcpResult(inputs.action === "add" ? { path: inputs.path, sha: inputs.sha } : { removed: inputs.paths ?? [] })
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

/** A fake `worktree_gc` that falls back like the real tool: without
 *  `wait: true` a big repo outlasts the 25 s default `waitMs`, so the caller
 *  gets a bare running job instead of the plan / outcomes. */
function fakeWorktreeGc(inputs: Record<string, unknown>, applyOutcomes: Array<Record<string, unknown>> = []) {
  if (inputs.wait !== true) {
    return mcpResult({ jobId: "wgc_test", status: "running", followUp: { tool: "worktree_gc_status", pollAfterMs: 5000 } })
  }
  return mcpResult(inputs.apply ? { mode: "apply", outcomes: applyOutcomes } : worktreeGcPlanFixture())
}


/** A fake `sandbox_checkpoint_gc`: an empty plan, or an empty apply. */
function fakeCheckpointGc(inputs: Record<string, unknown>) {
  const plan = {
    repoRoot: "/repo",
    remote: "origin",
    base: "refs/remotes/origin/main",
    prCheckAvailable: true,
    refs: [],
  }
  const summary = { total: 0, safe: 0, keep: 0, unknown: 0 }
  return mcpResult(
    inputs.apply
      ? { mode: "apply", plan, summary, outcomes: [], applySummary: { status: "noop", deleted: 0, skipped: 0, failed: 0 } }
      : { mode: "plan", plan, summary },
  )
}

/**
 * A mock host that behaves like `SessionsRegistryAgentHost` where the retry
 * path cares: every spawn is indexed under its `stepKey` (`reviewOne[0]`), so
 * a `sessionRef: "reviewOne[{{index}}]"` step resolves to that item's own
 * session. Records every spawn and every prompt sent.
 */
function recordingAgentHost() {
  const byLabel = new Map<string, string>()
  const spawns: Array<{
    id: string
    adapter: string
    stepId?: string
    stepKey?: string
    model?: string
    access?: { profileRef?: string }
    route?: string
  }> = []
  const sends: Array<{ sessionId: string; prompt: string }> = []
  const host: AgentSessionHost = {
    spawn: vi.fn(async (adapter, opts) => {
      const o = opts as {
        stepId?: string
        stepKey?: string
        harness?: { model?: string }
        access?: { profileRef?: string }
        route?: string
      }
      const id = `sess_${spawns.length + 1}`
      spawns.push({ id, adapter, stepId: o.stepId, stepKey: o.stepKey, model: o.harness?.model, access: o.access, route: o.route })
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
      "modelRoles:tool",
      "worktreeGcPlan:tool",
      "branchGcPlan:tool",
      "checkpointGcPlan:tool",
      "reviewQueue:transform",
      "reviewCandidates:transform",
      "reviewWorktreePaths:transform",
      "review:map",
      "reviewCleanup:tool",
      "branchGcVerify:tool",
      "gaps:transform",
      "verdictLookupTips:transform",
      "verdictRecords:map",
      "worktreeGcApply:tool",
      "branchGcApply:tool",
      "checkpointGcApply:tool",
      "report:transform",
      "notifyPlan:transform",
      "shouldNotify:transform",
      "maybeNotify:branch",
      "notify:map",
      "skip-notify:gate",
      "reportFinal:transform",
    ])
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    expect(compiled.id).toBe("maintain")
  })

  it("maps the notify input to a provider-agnostic transmit_message target", async () => {
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const plan = handle.steps.find(s => s.id === "notifyPlan") as unknown as {
      compute: (b: unknown) => Record<string, unknown>
    }
    const run = (notify: unknown) => plan.compute({ input: { notify }, steps: { report: "REPORT" } })

    // agentpush: source is the agentpush channel, address the recipient.
    expect(run({ provider: "agentpush", alias: "my-ap", address: "alice", source: "whatsapp" })).toMatchObject({
      provider: "agentpush",
      alias: "my-ap",
      source: "whatsapp",
      contactRef: "alice",
      text: "REPORT",
    })
    // Legacy channel: `telegram`/`agentpush` name the provider...
    expect(run({ channel: "telegram", address: "carol" })).toMatchObject({ provider: "telegram", contactRef: "carol" })
    // ...any other value is the agentpush channel (the old meaning).
    expect(run({ channel: "whatsapp", address: "bob" })).toMatchObject({
      provider: "agentpush",
      source: "whatsapp",
      contactRef: "bob",
    })
    // Default provider, and telegram mirrors address into the required source.
    expect(run({ address: "dave" })).toMatchObject({ provider: "telegram", source: "dave", contactRef: "dave" })
    // agentpush never substitutes the recipient for the channel: no source
    // means no send, with a clean skipReason instead of a schema failure.
    const noChannel = run({ provider: "agentpush", alias: "my-ap", address: "erin" })
    expect(noChannel.source).toBeUndefined()
    expect(noChannel.skipReason).toBe("agentpush source/channel required")
    expect(noChannel.targets).toEqual([])
    // `channel: agentpush` names the provider, not a channel: same skip.
    const keywordChannel = run({ channel: "agentpush", alias: "my-ap", address: "frank" })
    expect(keywordChannel.provider).toBe("agentpush")
    expect(keywordChannel.source).toBeUndefined()
    expect(keywordChannel.skipReason).toBe("agentpush source/channel required")
    expect(keywordChannel.targets).toEqual([])
    // A missing address is skipped before any schema validation too.
    expect(run({ provider: "telegram" }).skipReason).toBe("address required")
    // No notify input at all: nothing to check, no skipReason.
    expect(run(undefined).skipReason).toBeUndefined()
    expect(run(undefined).targets).toEqual([true])
  })
})

describe("repo-maintenance maintain workflow — run (fake tools + fake agent)", () => {
  it("dedupes review candidates by tip sha, picks model by residual size, reports gaps, and skips notify with nothing new to say", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") {
        return fakeWorktreeGc(inputs)
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
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
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
      input: { repoRoot: "/repo", applyMerged: false, applyReviewed: false },
    })

    // One reviewOne spawn per UNIQUE tip sha, not per ref — the local+remote
    // twin of SHA_A must collapse into one reviewer turn.
    const reviewSpawns = spawns.filter(s => s.stepId === "reviewOne")
    expect(reviewSpawns).toHaveLength(2)
    const byModel = new Map(reviewSpawns.map(s => [s.model, s]))
    expect(byModel.get("claude-sonnet-5-5")).toBeDefined() // SHA_A: residualFileCount 2 <= 3 (review.small)
    expect(byModel.get("claude-opus-5-5")).toBeDefined() // SHA_B: residualFileCount 4 > 3 (review.large)

    // SHA_B (no verdict): nudged in its OWN session, then one fresh
    // large-model retry — and still a gap. SHA_A: neither.
    const reviewerOfB = sends.find(s => s.prompt.includes(`(tip ${SHA_B})`))!.sessionId
    const nudges = sends.filter(s => s.prompt.startsWith("You did not call branch_gc_verdict"))
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.sessionId).toBe(reviewerOfB)
    expect(nudges[0]!.prompt).toContain(SHA_B)
    const retries = spawns.filter(s => s.stepId === "reviewRetryLarge")
    expect(retries).toHaveLength(1)
    expect(retries[0]!.model).toBe("claude-opus-5-5")
    expect(sends.find(s => s.sessionId === retries[0]!.id)!.prompt).toContain(`(tip ${SHA_B})`)
    const checkedShas = calls.filter(c => c.name === "branch_gc_verdict_get").map(c => c.inputs.sha)
    // Per-tip checks inside the review map, plus one record read per tip
    // afterwards for the report's one-line reasons (verdictRecords).
    expect(checkedShas.filter(sha => sha === SHA_A)).toHaveLength(2)
    expect(checkedShas.filter(sha => sha === SHA_B)).toHaveLength(3)

    // branch_gc plan called once up front, once again to verify verdicts,
    // once more as the (dry-run, since applyMerged is false) apply step.
    const branchGcCalls = calls.filter(c => c.name === "branch_gc")
    expect(branchGcCalls).toHaveLength(3)
    expect(branchGcCalls[0]!.inputs).toMatchObject({ apply: false })
    expect(branchGcCalls[2]!.inputs).toMatchObject({ apply: false, includeReviewed: false, scopes: ["local", "remote", "orphan"] })

    const worktreeGcCalls = calls.filter(c => c.name === "worktree_gc")
    expect(worktreeGcCalls).toHaveLength(2)
    expect(worktreeGcCalls[0]!.inputs).toMatchObject({ apply: false, wait: true })
    expect(worktreeGcCalls[1]!.inputs).toMatchObject({ apply: false, wait: true })

    // transmit_message (the notify step) is never dispatched — no notify
    // input was given at all.
    expect(calls.some(c => c.name === "transmit_message")).toBe(false)

    const result = output as { report: string; gaps: Array<{ name: string }>; applyMerged: boolean }
    // No notify input: the report must not grow a skip line.
    expect(result.report).not.toContain("notify skipped")
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
        return fakeWorktreeGc(inputs, [{ path: "/repo/_wt/a", branch: "wt/a", result: "reclaimed" }])
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
      if (name === "transmit_message") {
        return mcpResult({ sent: true, bound: false, message_id: "msg-1" })
      }
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
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
        applyReviewed: false,
        notify: { channel: "telegram", address: "chat-1" },
      },
    })

    const branchGcCalls = calls.filter(c => c.name === "branch_gc")
    expect(branchGcCalls[2]!.inputs).toMatchObject({ apply: true, includeReviewed: false })
    const worktreeGcCalls = calls.filter(c => c.name === "worktree_gc")
    expect(worktreeGcCalls[1]!.inputs).toMatchObject({ apply: true, salvageDirty: false, wait: true })
    // The apply runs the SAME plan the review saw, so worktree_gc can skip whatever changed since.
    expect(worktreeGcCalls[1]!.inputs.expectedPlan).toEqual(worktreeGcPlanFixture().plan)

    const notifyCall = calls.find(c => c.name === "transmit_message")
    expect(notifyCall).toBeDefined()
    expect(notifyCall!.inputs.provider).toBe("telegram")
    expect(notifyCall!.inputs.contact_ref).toBe("chat-1")
    expect(notifyCall!.inputs.bind).toBe(false)
    expect(typeof notifyCall!.inputs.text).toBe("string")
    expect(notifyCall!.inputs.text).toMatch(/wt\/large-residual/)

    const result = output as { applyMerged: boolean; report: string }
    expect(result.applyMerged).toBe(true)
    // The apply's real outcomes reach the report, not a background jobId.
    expect(result.report).toContain("worktree_gc: 1 outcome(s) — reclaimed=1")
    // A successful send adds no skip note.
    expect(result.report).not.toContain("notify skipped")
  })

  it("does not fail the run when the notify provider is unconfigured; the report records the skip", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        branchGcCallCount++
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      if (name === "branch_gc_verdict_get") {
        return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      }
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "transmit_message") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sent: false, bound: false, error: "telegram_creds_not_configured" }),
            },
          ],
          isError: true,
        }
      }
      throw new Error(`unexpected tool '${name}'`)
    })

    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(vi.fn(async () => "sess_x")),
      input: {
        repoRoot: "/repo",
        applyMerged: false,
        applyReviewed: false,
        notify: { provider: "telegram", address: "chat-1" },
      },
    })

    const notifyCall = calls.find(c => c.name === "transmit_message")
    expect(notifyCall).toBeDefined()
    expect(notifyCall!.inputs.bind).toBe(false)

    const result = output as { report: string }
    expect(result.report).toContain("notify skipped: telegram_creds_not_configured")
  })

  it("dispatches agentpush's channel as source and the recipient as contact_ref", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        branchGcCallCount++
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      if (name === "branch_gc_verdict_get") {
        return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      }
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "transmit_message") return mcpResult({ sent: true, bound: false, message_id: "m" })
      throw new Error(`unexpected tool '${name}'`)
    })

    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(vi.fn(async () => "sess_x")),
      input: {
        repoRoot: "/repo",
        applyMerged: false,
        applyReviewed: false,
        notify: { provider: "agentpush", alias: "my-agentpush", address: "alice", source: "whatsapp" },
      },
    })

    const notifyCall = calls.find(c => c.name === "transmit_message")
    expect(notifyCall).toBeDefined()
    expect(notifyCall!.inputs).toMatchObject({
      provider: "agentpush",
      alias: "my-agentpush",
      source: "whatsapp",
      contact_ref: "alice",
      bind: false,
    })
  })

  it("skips instead of dispatching when the legacy channel is the provider keyword agentpush", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        branchGcCallCount++
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      if (name === "branch_gc_verdict_get") {
        return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      }
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "transmit_message") return mcpResult({ sent: true, bound: false })
      throw new Error(`unexpected tool '${name}'`)
    })

    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(vi.fn(async () => "sess_x")),
      input: {
        repoRoot: "/repo",
        applyMerged: false,
        applyReviewed: false,
        notify: { channel: "agentpush", alias: "my-agentpush", address: "alice" },
      },
    })

    expect(calls.some(c => c.name === "transmit_message")).toBe(false)
    const result = output as { report: string }
    expect(result.report).toContain("notify skipped: agentpush source/channel required")
  })

  it("applyReviewed applies with includeReviewed true and reports reclaimed reviewed branches + guard refusals", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        branchGcCallCount++
        if (branchGcCallCount === 3) {
          return mcpResult({
            mode: "apply",
            outcomes: [
              { kind: "local", name: "wt/small-residual", sha: SHA_A, result: "deleted", reclaimReason: "reviewed" },
              { kind: "local", name: "wt/large-residual", sha: SHA_B, result: "refused-guard", guard: "line coverage 80% of 50 added lines (< 95%)" },
            ],
            restoreLog: "/tmp/restore.json",
          })
        }
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      if (name === "branch_gc_verdict_get") {
        return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      }
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })

    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(vi.fn(async () => "sess_x")),
      input: { repoRoot: "/repo", applyMerged: true, applyReviewed: true },
    })

    const branchGcCalls = calls.filter(c => c.name === "branch_gc")
    expect(branchGcCalls[2]!.inputs).toMatchObject({ apply: true, includeReviewed: true })

    const result = output as { applyReviewed: boolean; report: string }
    expect(result.applyReviewed).toBe(true)
    expect(result.report).toContain("reviewed: 1 reclaimed (includeReviewed true), 1 refused by the line-coverage guard")
    expect(result.report).toContain("reclaimed (1): `wt/small-residual`")
    expect(result.report).toContain("reviewer agreed, refused by the line guard: 1")
    expect(result.report).toContain("## Human decision queue — reviewer agreed, refused by line guard (1)")
    expect(result.report).toContain("`wt/large-residual`")
    expect(result.report).toContain("80% line coverage")
    expect(result.report).toContain("line coverage 80% of 50 added lines (< 95%)")
    expect(result.report).not.toContain("documented seam")
  })

  it("lists the WHOLE human decision queue, lowest line coverage first, with how to record an operator approval", async () => {
    // 30 refusals: over the 20-name cap every other list keeps.
    const pcts = Array.from({ length: 30 }, (_, i) => 90 - ((i * 7) % 60))
    const refused = pcts.map((pct, i) => ({
      kind: "local",
      name: `wt/guarded-${i}`,
      sha: (i + 1).toString(16).padStart(40, "0"),
      result: "refused-guard",
      guard: `line coverage ${pct}% of 50 added lines (< 95%)`,
    }))
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        branchGcCallCount++
        if (branchGcCallCount === 3) return mcpResult({ mode: "apply", outcomes: refused, restoreLog: null })
        return mcpResult(branchGcPlanFixture(true, { triage: "obsolete", agree: true }))
      }
      if (name === "branch_gc_verdict_get") return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(vi.fn(async () => "sess_x")),
      input: { repoRoot: "/repo", applyMerged: true, applyReviewed: true },
    })
    const report = (output as { report: string }).report
    const queue = report.slice(report.indexOf("## Human decision queue"))
    expect(queue).toContain("(30)")
    expect(queue).not.toContain("more")
    const listed = [...queue.matchAll(/^- `(wt\/guarded-\d+)` .* — (\d+)% line coverage/gm)]
    expect(listed).toHaveLength(30)
    const listedPcts = listed.map(m => Number(m[2]))
    expect(listedPcts).toEqual([...pcts].sort((a, b) => a - b))
    // How to act on it: one ready-to-run CLI command per queued tip, in queue
    // order; the operator types only their name. No JSON template to fill in.
    const commands = [...queue.matchAll(/^agentproto branch gc approve ([0-9a-f]{40}) --by <your name> --repo \/repo {2}# (\S+)$/gm)]
    expect(commands).toHaveLength(30)
    expect(commands.map(m => m[2])).toEqual(listed.map(m => m[1]))
    for (const m of commands) expect(refused.find(r => r.name === m[2])?.sha).toBe(m[1])
    expect(queue).not.toContain('"operator"')
    expect(queue).not.toContain("no CLI command")
  })

  it("counts and lists the decision queue and the reclaimed list once per tip sha, with the ref kinds on one line", async () => {
    const twin = (name: string, sha: string, extra: Record<string, unknown>) => [
      { kind: "local", name, sha, ...extra },
      { kind: "remote", name, sha, ...extra },
    ]
    const guard = { result: "refused-guard", guard: "line coverage 40% of 50 added lines (< 95%)" }
    const outcomes = [
      ...twin("fix/ci-failures", "c2df0084".padEnd(40, "0"), guard),
      ...twin("wt/vscode-activity-panel", "1".repeat(40), { ...guard, guard: "line coverage 70% of 50 added lines (< 95%)" }),
      { kind: "local", name: "wt/only-local", sha: "2".repeat(40), ...guard },
      ...twin("perf/agent-start-compact-descriptor", "3".repeat(40), { result: "deleted", reclaimReason: "reviewed" }),
    ]
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        branchGcCallCount++
        if (branchGcCallCount === 3) return mcpResult({ mode: "apply", outcomes, restoreLog: null })
        return mcpResult(branchGcPlanFixture(true))
      }
      if (name === "branch_gc_verdict_get") return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: fakeAgentHost(vi.fn(async () => "sess_x")),
      input: { repoRoot: "/repo", applyMerged: true, applyReviewed: true },
    })
    const report = (output as { report: string }).report
    expect(report).toContain("reviewed: 1 reclaimed (includeReviewed true), 3 refused by the line-coverage guard")
    expect(report).toContain("reclaimed (1): `perf/agent-start-compact-descriptor` [local, remote]")
    expect(report).toContain("## Human decision queue — reviewer agreed, refused by line guard (3)")
    const queue = report.slice(report.indexOf("## Human decision queue"))
    expect(queue.match(/^- `fix\/ci-failures`/gm)).toHaveLength(1)
    expect(queue).toContain(`- \`fix/ci-failures\` (${"c2df0084".padEnd(40, "0")}) [local, remote] — 40% line coverage`)
    expect(queue).toContain("- `wt/only-local` (" + "2".repeat(40) + ") [local] — 40% line coverage")
    expect(queue.match(/^agentproto branch gc approve /gm)).toHaveLength(3)
  })

  it("asks branch_gc for its full reply on every call (the plan entries feed the review queue, the apply output is reported)", async () => {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") return mcpResult(branchGcPlanFixture(true))
      if (name === "branch_gc_verdict_get") return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    await runWorkflow({ workflow: compiled, agents: fakeAgentHost(vi.fn(async () => "sess_x")), input: { repoRoot: "/repo" } })
    const branchGcCalls = calls.filter(c => c.name === "branch_gc")
    expect(branchGcCalls).toHaveLength(3)
    for (const c of branchGcCalls) expect(c.inputs.full).toBe(true)
  })

  it("headlines distinct branch counts next to the ref counts", async () => {
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        const p = branchGcPlanFixture(true)
        return mcpResult({
          ...p,
          summary: { ...p.summary, distinct: { branches: 3, refs: 4, byClass: { reclaim: 1, review: 2, hold: 0 }, byStatus: { unmerged: 2, merged: 1 } } },
        })
      }
      if (name === "branch_gc_verdict_get") return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha } })
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({ workflow: compiled, agents: fakeAgentHost(vi.fn(async () => "sess_x")), input: { repoRoot: "/repo" } })
    const report = (output as { report: string }).report
    expect(report).toContain("- 3 branches (4 refs): reclaim=1 review=2 hold=0")
    expect(report).toContain("- unmerged: 2 branches")
  })
})

describe("repo-maintenance maintain workflow — missing-verdict retry", () => {
  /** Run the workflow with SHA_A always reviewed, and SHA_B's verdict landing
   *  only once `landsAfter` verdict checks for it have come back missing. */
  async function runWithVerdictLandingAfter(landsAfter: number) {
    const checksOfB = { n: 0 }
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
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
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
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
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      if (name === "worktree_gc") return mcpResult({ mode: "plan", outcomes: [] })
      if (name === "branch_gc") return mcpResult(plan)
      if (name === "branch_gc_verdict_get") return mcpResult({ found: true, missing: false })
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
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
      `Review the local branch \`wt/current\` (tip ${SHA_A}) in the repo at ${join(tmpdir(), "agentproto-maintain-review", `repo-${SHA_A}`)}. ` +
        `It is unmerged relative to base origin/main (base sha ${BASE_SHA}). `,
    )).toBe(true)
    expect(prompt).not.toMatch(/pre-rewrite/)
    expect(prompt).not.toMatch(/compare base/)
    // Agree is the reviewer's honest safety judgement; the line guard is a
    // later, deterministic policy step and must not cause self-censoring.
    expect(prompt).toContain("`gate.agree` is your HONEST judgement")
    expect(prompt).toContain("do NOT lower it because lineCoverage is under minLineCoverage")
    expect(prompt).toContain("human decision queue item")
    // A conflicting merge renders `null` explicitly, not an empty string.
    expect(prompt).toContain("or null when the merge conflicts): null. Ahead")
  })

  it("adds the compare base + pre-rewrite note only for a pre-rewrite branch", async () => {
    const prompt = (await renderPrompts()).get(SHA_B)!
    expect(prompt.startsWith(`Review the local branch \`wt/old\` (tip ${SHA_B}) in the repo at ${join(tmpdir(), "agentproto-maintain-review", `repo-${SHA_B}`)}.`)).toBe(true)
    expect(prompt).toContain(
      `(base sha ${BASE_SHA}), compare base ${ANCHOR_SHA} (pre-rewrite history — commit shas`,
    )
    expect(prompt).toContain(`or null when the merge conflicts): ${TREE_SHA}. Ahead`)
  })
})

describe("repo-maintenance maintain workflow — review queue grouping (FIX-4: one reviewer per branch name)", () => {
  const SHA_NEW = "1".repeat(40)
  const SHA_OLD = "2".repeat(40)
  const sha = (c: string) => c.repeat(40)

  function reviewEntry(over: Record<string, unknown>) {
    return {
      kind: "local",
      date: "2026-01-01T00:00:00Z",
      author: "a",
      subject: "s",
      ageDays: 10,
      class: "review",
      status: "unmerged",
      history: "current",
      ahead: 1,
      behind: 0,
      residualFiles: [],
      residualFileCount: 1,
      ...over,
    }
  }

  function planOf(entries: Array<Record<string, unknown>>) {
    return {
      mode: "plan",
      plan: { repoRoot: "/repo", repoName: "repo", base: "origin/main", baseSha: sha("c"), scopes: ["local", "remote"], entries },
      summary: { byClass: { local: { reclaim: 0, review: entries.length, hold: 0 }, remote: { reclaim: 0, review: 0, hold: 0 }, orphan: { reclaim: 0, review: 0, hold: 0 } }, byStatus: {} },
    }
  }

  async function buildQueue(plan: unknown) {
    const entry = await import(join(dirname(WORKFLOW_PATH), "entry.mjs")) as { buildReviewQueue: (p: unknown) => { queue: Array<Record<string, unknown>>; alreadyReviewed: number } }
    return entry.buildReviewQueue(plan)
  }

  it("merges a local branch and its DIVERGED remote twin into one candidate: newest tip primary, older tip in otherTips, refs unioned", async () => {
    const { queue, alreadyReviewed } = await buildQueue(planOf([
      // Local `foo` moved on to a NEWER tip than its remote twin.
      reviewEntry({
        kind: "local",
        name: "foo",
        ref: "refs/heads/foo",
        sha: SHA_NEW,
        date: "2026-02-02T00:00:00Z",
        ageDays: 5,
      }),
      reviewEntry({
        kind: "remote",
        remote: "origin",
        name: "foo",
        ref: "refs/remotes/origin/foo",
        sha: SHA_OLD,
        date: "2026-01-01T00:00:00Z",
        ageDays: 10,
      }),
    ]))
    expect(queue).toHaveLength(1)
    const item = queue[0]!
    expect(item.name).toBe("foo")
    expect(item.sha).toBe(SHA_NEW) // primary = the NEWEST tip
    expect(item.otherTips).toEqual([{ sha: SHA_OLD, refs: ["refs/remotes/origin/foo"] }])
    expect(item.allTips).toEqual([
      { sha: SHA_NEW, refs: ["refs/heads/foo"] },
      { sha: SHA_OLD, refs: ["refs/remotes/origin/foo"] },
    ])
    expect(item.refs).toEqual(["refs/heads/foo", "refs/remotes/origin/foo"])
    expect(alreadyReviewed).toBe(0)
  })

  it("a name with one reviewed and one unreviewed tip stays queued with only the unreviewed tips; a fully reviewed name counts as alreadyReviewed", async () => {
    const { queue, alreadyReviewed } = await buildQueue(planOf([
      // `foo`: local tip reviewed, remote tip not — still needs a review.
      reviewEntry({
        kind: "local",
        name: "foo",
        ref: "refs/heads/foo",
        sha: SHA_NEW,
        verdict: { triage: "obsolete", agree: true, reviewer: "repo-maintenance-reviewer" },
      }),
      reviewEntry({
        kind: "remote",
        remote: "origin",
        name: "foo",
        ref: "refs/remotes/origin/foo",
        sha: SHA_OLD,
      }),
      // `bar`: its only tip carries a verdict — fully reviewed.
      reviewEntry({
        name: "bar",
        ref: "refs/heads/bar",
        sha: sha("3"),
        verdict: { triage: "obsolete", agree: true, reviewer: "repo-maintenance-reviewer" },
      }),
    ]))
    expect(queue).toHaveLength(1)
    expect(queue[0]!.name).toBe("foo")
    expect(queue[0]!.sha).toBe(SHA_OLD) // only the UNREVIEWED tip remains; it is the primary
    expect(queue[0]!.allTips).toEqual([{ sha: SHA_OLD, refs: ["refs/remotes/origin/foo"] }])
    expect(queue[0]!.otherTips).toBeUndefined()
    expect(alreadyReviewed).toBe(1)
  })

  it("same-tip local+remote twins still collapse to one candidate with no otherTips (unchanged behavior)", async () => {
    const { queue, alreadyReviewed } = await buildQueue(planOf([
      reviewEntry({ name: "twin", ref: "refs/heads/twin", sha: SHA_NEW }),
      reviewEntry({ kind: "remote", remote: "origin", name: "twin", ref: "refs/remotes/origin/twin", sha: SHA_NEW }),
    ]))
    expect(queue).toHaveLength(1)
    expect(queue[0]!.sha).toBe(SHA_NEW)
    expect(queue[0]!.refs).toEqual(["refs/heads/twin", "refs/remotes/origin/twin"])
    expect(queue[0]!.allTips).toEqual([{ sha: SHA_NEW, refs: ["refs/heads/twin", "refs/remotes/origin/twin"] }])
    expect(queue[0]!.otherTips).toBeUndefined()
    expect(alreadyReviewed).toBe(0)
  })
})

describe("repo-maintenance maintain workflow — at scale (FIX-3 dogfood)", () => {
  const sha = (i: number) => i.toString(16).padStart(40, "0")
  /** Every tool call of the most recent `run` (also when it rejected). */
  let lastCalls: Array<{ name: string; inputs: Record<string, unknown> }> = []
  /** `n` unreviewed review candidates `wt/c<i>` (ageDays = `ages[i]`,
   *  residualFileCount = `residuals[i]`), plus one tip already reviewed. */
  function scalePlan(n: number, ages: (i: number) => number, residuals: (i: number) => number) {
    const entries: Array<Record<string, unknown>> = Array.from({ length: n }, (_, i) => ({
      kind: "local",
      name: `wt/c${i}`,
      ref: `refs/heads/wt/c${i}`,
      sha: sha(i + 1),
      date: "2026-01-01T00:00:00Z",
      author: "a",
      subject: "s",
      ageDays: ages(i),
      class: "review",
      status: "unmerged",
      history: "current",
      ahead: 1,
      behind: 0,
      residualFiles: [],
      residualFileCount: residuals(i),
    }))
    entries.push({
      kind: "local",
      name: "wt/already-reviewed",
      ref: "refs/heads/wt/already-reviewed",
      sha: "f".repeat(40),
      ageDays: 0,
      class: "review",
      status: "unmerged",
      history: "current",
      residualFileCount: 9,
      verdict: { triage: "obsolete", agree: true, reviewer: "repo-maintenance-reviewer" },
    })
    return {
      mode: "plan",
      plan: { repoRoot: "/repo", repoName: "repo", base: "origin/main", baseSha: BASE_SHA, scopes: ["local"], entries },
      summary: { byClass: { local: { reclaim: 0, review: n + 1, hold: 0 } }, byStatus: {} },
    }
  }

  async function run(opts: {
    plan: unknown
    input?: Record<string, unknown>
    spawn?: AgentSessionHost["spawn"]
    verdictLands?: boolean
    onBranchGc?: () => void
  }) {
    const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
    lastCalls = calls
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      calls.push({ name, inputs })
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        opts.onBranchGc?.()
        return mcpResult(opts.plan)
      }
      if (name === "branch_gc_verdict_get") {
        const missing = opts.verdictLands !== true
        return mcpResult({ sha: inputs.sha, found: !missing, missing, record: null })
      }
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })
    const spawns: Array<{ stepId?: string; stepKey?: string; cwd?: string }> = []
    const sends: Array<{ sessionId: string; prompt: string }> = []
    const byLabel = new Map<string, string>()
    const host: AgentSessionHost = {
      spawn: vi.fn(async (adapter, o) => {
        spawns.push({ stepId: o.stepId, stepKey: o.stepKey, cwd: o.cwd })
        if (opts.spawn) return opts.spawn(adapter, o)
        const id = `sess_${spawns.length}`
        if (o.stepKey) byLabel.set(o.stepKey, id)
        return id
      }),
      sendPromptAndWait: vi.fn(async (sessionId: string, prompt: string) => {
        sends.push({ sessionId, prompt })
      }),
      resolveByLabel: vi.fn((label: string) => byLabel.get(label)),
    }
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: host,
      // The run cwd (the app's own directory in the daemon) — NOT where
      // reviewers run.
      cwd: tmpdir(),
      input: { repoRoot: "/repo", ...opts.input },
    })
    return { spawns, sends, calls, output: output as { report: string; gaps: Array<{ name: string }> } }
  }

  it("P0-1: every reviewer runs in its own detached review worktree — never the repo's main worktree — and the prompt names that worktree, not the live repo", async () => {
    const { spawns, sends, calls } = await run({ plan: scalePlan(2, i => i, () => 9) })
    const reviewerSpawns = spawns.filter(s => s.stepId === "reviewOne" || s.stepId === "reviewRetryLarge")
    expect(reviewerSpawns.length).toBeGreaterThanOrEqual(2)
    const adds = calls.filter(c => c.name === "branch_gc_review_worktree" && c.inputs.action === "add")
    expect(adds.map(c => c.inputs.sha).sort()).toEqual([sha(1), sha(2)].sort())
    const addedPaths = new Set(adds.map(c => c.inputs.path as string))
    for (const s of reviewerSpawns) {
      expect(s.cwd).not.toBe("/repo")
      expect(s.cwd!.startsWith(join(tmpdir(), "agentproto-maintain-review", "repo-"))).toBe(true)
      expect(addedPaths.has(s.cwd!)).toBe(true)
    }
    for (const send of sends) expect(send.prompt).not.toContain("/repo\"")
    expect(sends[0]!.prompt).toContain(`in the repo at ${join(tmpdir(), "agentproto-maintain-review")}`)
    expect(sends[0]!.prompt).toContain("disposable detached worktree")
  })

  it("review worktrees are removed on success: per item, after the map, and in finally", async () => {
    const { calls } = await run({ plan: scalePlan(2, i => i, () => 1), verdictLands: true })
    const wt = calls.filter(c => c.name === "branch_gc_review_worktree")
    const adds = wt.filter(c => c.inputs.action === "add").map(c => c.inputs.path as string)
    const removes = wt.filter(c => c.inputs.action === "remove").map(c => c.inputs.paths as string[])
    expect(adds).toHaveLength(2)
    // one per item, then reviewCleanup and the finally sweep over all of them
    expect(removes.filter(p => p.length === 1).flat().sort()).toEqual([...adds].sort())
    const sweeps = removes.filter(p => p.length === 2)
    expect(sweeps).toHaveLength(2)
    for (const sw of sweeps) expect([...sw].sort()).toEqual([...adds].sort())
    // finally is the very last tool call of the run
    expect(calls.at(-1)).toMatchObject({ name: "branch_gc_review_worktree", inputs: { action: "remove" } })
  })

  it("review worktrees are removed on failure: a reviewer that dies leaves its item's worktree to the sweep, and a run that fails still cleans up in finally", async () => {
    // Reviewers can't spawn: items fail before their own remove step.
    const failedItems = await run({
      plan: scalePlan(2, i => i, () => 1),
      spawn: async () => {
        throw new Error("spawn failed")
      },
    })
    const wt1 = failedItems.calls.filter(c => c.name === "branch_gc_review_worktree")
    const added1 = wt1.filter(c => c.inputs.action === "add").map(c => c.inputs.path as string).sort()
    expect(added1).toHaveLength(2)
    expect(wt1.filter(c => c.inputs.action === "remove" && (c.inputs.paths as string[]).length === 1)).toHaveLength(0)
    const sweeps1 = wt1.filter(c => c.inputs.action === "remove").map(c => [...(c.inputs.paths as string[])].sort())
    expect(sweeps1).toEqual([added1, added1])

    // The whole run fails after the map (branchGcVerify throws): finally still sweeps.
    let branchGcCalls = 0
    const failedRun = run({
      plan: scalePlan(2, i => i, () => 1),
      verdictLands: true,
      onBranchGc: () => {
        if (++branchGcCalls === 2) throw new Error("verify exploded")
      },
    })
    await expect(failedRun).rejects.toThrow("verify exploded")
    const calls2 = lastCalls
    const added2 = calls2.filter(c => c.name === "branch_gc_review_worktree" && c.inputs.action === "add").map(c => c.inputs.path as string).sort()
    expect(calls2.at(-1)).toMatchObject({ name: "branch_gc_review_worktree", inputs: { action: "remove" } })
    expect([...(calls2.at(-1)!.inputs.paths as string[])].sort()).toEqual(added2)
  })

  it("P1-5: reviews at most maxReviews (default 40), newest tip first then larger residual; the backlog is 'not reviewed this run', never a gap; a reviewed tip is skipped", async () => {
    // 45 candidates: ages 0..44 reversed so index order != priority order.
    const { spawns, output } = await run({
      plan: scalePlan(45, i => 44 - i, () => 1),
      verdictLands: true,
    })
    const reviewed = spawns.filter(s => s.stepId === "reviewOne")
    expect(reviewed).toHaveLength(40)
    expect(output.report).toContain("queue: 45 unreviewed tip(s)")
    expect(output.report).toContain("not reviewed this run (5)")
    expect(output.report).toContain("1 tip(s) already carry a verdict from an earlier run")
    // The verify plan (same fixture) has no verdict for any c<i>: the 40
    // reviewed ones are gaps, the 5 backlog ones are not.
    expect(output.gaps).toHaveLength(40)
    const gapNames = new Set(output.gaps.map(g => g.name))
    // Newest first: ages 0..39 are c44..c5 — c0..c4 (oldest) wait.
    for (const i of [0, 1, 2, 3, 4]) expect(gapNames.has(`wt/c${i}`)).toBe(false)
    expect(gapNames.has("wt/already-reviewed")).toBe(false)

    // Ties on age: the larger residual goes first.
    const tie = await run({
      plan: scalePlan(3, () => 5, i => [1, 7, 3][i]!),
      input: { maxReviews: 2 },
      verdictLands: true,
    })
    const reviewedSends = tie.sends.filter(s => s.prompt.startsWith("Review the"))
    expect(reviewedSends.map(s => /branch `([^`]+)`/.exec(s.prompt)![1])).toEqual(["wt/c1", "wt/c2"])
    expect(tie.output.report).toContain("not reviewed this run (1)")
  })

  it("P1-6: the report inlines at most 20 names per list, the run output keeps them all", async () => {
    const { output } = await run({ plan: scalePlan(25, i => i, () => 1), verdictLands: true })
    expect(output.gaps).toHaveLength(25)
    const gapsLine = output.report.split("\n").find(l => l.includes("with no recorded verdict"))!
    expect(gapsLine).toContain("… and 5 more")
    expect(gapsLine.match(/`wt\/c\d+`/g)).toHaveLength(20)
  })

  it("P0-3/P0-4: a systemic spawn failure opens the circuit — the report lists each distinct error with its count, and unstarted candidates aren't gaps", async () => {
    const { spawns, output } = await run({
      plan: scalePlan(10, i => i, () => 1),
      spawn: async () => {
        throw new Error("spawn node ENOENT")
      },
    })
    // parallelism 4: all four workers are already spawning when the third
    // failure opens the breaker — in-flight items finish, nothing new starts.
    expect(spawns.filter(s => s.stepId === "reviewOne")).toHaveLength(4)
    expect(output.report).toContain("0 ok, 4 failed, 6 not started")
    expect(output.report).toContain("spawn circuit open")
    expect(output.report).toContain("failure reasons (1 distinct):")
    expect(output.report).toContain("  - 4× step 'reviewOne': agent spawn failed — spawn node ENOENT")
    expect(output.gaps).toHaveLength(4)
    expect(output.report).not.toContain("every review candidate has a recorded verdict")
  })

  it("one systemic failure naming each item's own review worktree groups as ONE reason, not one per branch", async () => {
    const { output } = await run({
      plan: scalePlan(6, i => i, () => 1),
      spawn: async (_adapter, o) => {
        throw new Error(`agent step spawn refused (app_boundary_cwd_outside): path is outside the app boundary: '${String(o.cwd)}'`)
      },
    })
    expect(output.report).toContain("failure reasons (1 distinct):")
    expect(output.report).toMatch(/ {2}- 4× .*app_boundary_cwd_outside.*'<review worktree>'/)
  })
})

describe("repo-maintenance maintain workflow — reviewer models come from model roles", () => {
  async function reviewerSpawns(input: Record<string, unknown>) {
    let branchGcCallCount = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      if (name === "worktree_gc") return fakeWorktreeGc(inputs)
      if (name === "branch_gc") {
        branchGcCallCount++
        return mcpResult(branchGcPlanFixture(branchGcCallCount >= 2))
      }
      if (name === "branch_gc_verdict_get") {
        const missing = inputs.sha !== SHA_A
        return mcpResult({ sha: inputs.sha, found: !missing, missing, record: missing ? null : { sha: inputs.sha } })
      }
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })
    const { host, spawns } = recordingAgentHost()
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    await runWorkflow({ workflow: compiled, agents: host, input: { repoRoot: "/repo", applyMerged: false, ...input } })
    return spawns
  }

  async function reviewerModels(input: Record<string, unknown>) {
    const spawns = await reviewerSpawns(input)
    return {
      small: spawns.find(s => s.stepId === "reviewOne" && s.stepKey === "reviewOne[0]")?.model,
      large: spawns.find(s => s.stepId === "reviewOne" && s.stepKey === "reviewOne[1]")?.model,
      retry: spawns.find(s => s.stepId === "reviewRetryLarge")?.model,
    }
  }

  async function reviewerAdapters(input: Record<string, unknown>) {
    const spawns = await reviewerSpawns(input)
    return {
      small: spawns.find(s => s.stepId === "reviewOne" && s.stepKey === "reviewOne[0]")?.adapter,
      large: spawns.find(s => s.stepId === "reviewOne" && s.stepKey === "reviewOne[1]")?.adapter,
      retry: spawns.find(s => s.stepId === "reviewRetryLarge")?.adapter,
    }
  }

  it("passes the resolved role profile (as access.profileRef) and route to every reviewer spawn", async () => {
    const profile = "opencode-developerws003"
    const model = "opencode-go/deepseek-v4.1-flash"
    daemonModels = {
      "review.small": { model, profile, route: "opencode-go" },
      "review.large": { model, profile, route: "opencode-go" },
    }
    try {
      const spawns = await reviewerSpawns({})
      const reviewSpawns = spawns.filter(s => s.stepId === "reviewOne")
      expect(reviewSpawns).toHaveLength(2)
      for (const spawn of reviewSpawns) {
        expect(spawn.model).toBe(model)
        expect(spawn.access).toEqual({ profileRef: profile })
        expect(spawn.route).toBe("opencode-go")
      }
      const retry = spawns.find(s => s.stepId === "reviewRetryLarge")!
      expect(retry.access).toEqual({ profileRef: profile })
      expect(retry.route).toBe("opencode-go")
    } finally {
      daemonModels = {}
    }
  })

  it("the daemon `models` config drives the small, large and retry reviewers", async () => {
    daemonModels = { "review.small": "claude-opus-5-5", "review.large": "claude-sonnet-5-5" }
    try {
      expect(await reviewerModels({})).toEqual({ small: "claude-opus-5-5", large: "claude-sonnet-5-5", retry: "claude-sonnet-5-5" })
    } finally {
      daemonModels = {}
    }
  })

  it("an explicit reviewModelSmall/Large input beats the configured role", async () => {
    daemonModels = { "review.small": "claude-opus-5-5", "review.large": "claude-sonnet-5-5" }
    try {
      expect(await reviewerModels({ reviewModelSmall: "explicit-small-model", reviewModelLarge: "explicit-large-model" })).toEqual({
        small: "explicit-small-model",
        large: "explicit-large-model",
        retry: "explicit-large-model",
      })
    } finally {
      daemonModels = {}
    }
  })

  // reviewPreset picks the model AND the adapter that model requires.
  it("go-free runs every reviewer on the opencode Go free model, on the opencode adapter", async () => {
    const free = "opencode-go/beam-free"
    expect(await reviewerModels({ reviewPreset: "go-free" })).toEqual({ small: free, large: free, retry: free })
    expect(await reviewerAdapters({ reviewPreset: "go-free" })).toEqual({ small: "opencode", large: "opencode", retry: "opencode" })
  })

  it("free-sonnet mixes adapters per item: opencode for the small residual, claude-code for large + retry", async () => {
    expect(await reviewerAdapters({ reviewPreset: "free-sonnet" })).toEqual({
      small: "opencode",
      large: "claude-code",
      retry: "claude-code",
    })
  })

  it("haiku runs every reviewer on claude-haiku-5-5", async () => {
    const haiku = "claude-haiku-5-5"
    expect(await reviewerModels({ reviewPreset: "haiku" })).toEqual({ small: haiku, large: haiku, retry: haiku })
  })

  it("an explicit model input still beats the preset", async () => {
    expect((await reviewerModels({ reviewPreset: "go-free", reviewModelLarge: "claude-opus-5-5" })).large).toBe("claude-opus-5-5")
    expect((await reviewerAdapters({ reviewPreset: "go-free", reviewModelLarge: "claude-opus-5-5" })).large).toBe("claude-code")
  })

  it("a model id that implies no adapter keeps the reviewer agent's own adapter", async () => {
    expect(await reviewerAdapters({ reviewModelSmall: "some-model", reviewModelLarge: "other-model" })).toEqual({
      small: "mock-agent",
      large: "mock-agent",
      retry: "mock-agent",
    })
  })
})

describe("repo-maintenance maintain workflow — held worktrees (reviewHeldWorktrees)", () => {
  const SHA_IDLE = "1".repeat(40)
  const SHA_LIVE = "2".repeat(40)
  const SHA_DIRTY = "3".repeat(40)
  const SHA_YOUNG = "4".repeat(40)
  const SHA_PR = "5".repeat(40)

  /** branch_gc's real shape for a branch checked out in a worktree: the
   *  content ladder still ran (status/coverage/residual), then `holdFor`
   *  won with `holdReason: "worktree"` and the worktree path as detail. */
  function heldEntry(name: string, sha: string, over: Record<string, unknown> = {}) {
    return {
      kind: "local",
      name,
      ref: `refs/heads/${name}`,
      sha,
      date: "2026-01-01T00:00:00Z",
      ageDays: 10,
      author: "dev",
      subject: `work on ${name}`,
      status: "unmerged",
      history: "current",
      compareBase: BASE_SHA,
      mergeBase: "9".repeat(40),
      mergedTree: null,
      ahead: 2,
      behind: 7,
      residualFiles: ["src/x.ts"],
      residualFileCount: 1,
      class: "hold",
      holdReason: "worktree",
      holdDetail: `/wt/${name}`,
      ...over,
    }
  }

  function branchPlan(withVerdict: boolean, idleExtra: Record<string, unknown> = {}) {
    const verdict = withVerdict ? { verdict: { triage: "obsolete", agree: true, reviewer: "r" } } : {}
    return {
      mode: "plan",
      plan: {
        repoRoot: "/repo",
        repoName: "repo",
        base: "origin/main",
        baseSha: BASE_SHA,
        scopes: ["local"],
        entries: [
          heldEntry("idle", SHA_IDLE, { ...verdict, ...idleExtra }),
          heldEntry("live", SHA_LIVE),
          heldEntry("dirty", SHA_DIRTY),
          heldEntry("young", SHA_YOUNG, { ageDays: 1 }),
          heldEntry("pr", SHA_PR),
          // The main checkout's branch: held for `worktree` too, but worktree_gc
          // never lists the main checkout, so it is never a candidate.
          heldEntry("main-co", "6".repeat(40), { holdDetail: "/repo" }),
        ],
      },
      summary: { byClass: { local: { reclaim: 0, review: 0, hold: 6 } }, byStatus: {} },
    }
  }

  function worktreePlan(idleIntegration?: Record<string, unknown>) {
    const wt = (name: string, over: Record<string, unknown> = {}) => ({
      path: `/wt/${name}`,
      branch: name,
      head: "1".repeat(40),
      class: "hold",
      // The daemon's real `worktree_gc` projection: `tree` is the bare
      // discriminant, `liveness` carries a count, not the sessions.
      tree: "clean",
      integration: { state: "diverged" },
      liveness: { state: "idle", sessionCount: 0 },
      ...over,
    })
    return {
      mode: "plan",
      plan: [
        wt("idle", idleIntegration ? { integration: idleIntegration } : {}),
        wt("live", { liveness: { state: "sessions", sessionCount: 1 } }),
        wt("dirty", { tree: "dirty" }),
        wt("young"),
        wt("pr", { integration: { state: "open", pr: 7 } }),
      ],
    }
  }

  async function run(
    input: Record<string, unknown>,
    opts: { integration?: Record<string, unknown>; idleExtra?: Record<string, unknown>; record?: Record<string, unknown> } = {},
  ) {
    let branchGcCalls = 0
    const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
      if (name === "worktree_gc") {
        if (inputs.wait !== true) return mcpResult({ jobId: "wgc_test", status: "running" })
        return mcpResult(inputs.apply ? { mode: "apply", outcomes: [] } : worktreePlan(opts.integration))
      }
      if (name === "branch_gc") return mcpResult(branchPlan(++branchGcCalls >= 2, opts.idleExtra))
      if (name === "branch_gc_verdict_get") {
        return mcpResult({ sha: inputs.sha, found: true, missing: false, record: { sha: inputs.sha, ...opts.record } })
      }
      if (name === "sandbox_checkpoint_gc") return fakeCheckpointGc(inputs)
      if (name === "branch_gc_review_worktree") return reviewWorktreeResult(inputs)
      if (name === "model_roles") return modelRolesResult(inputs)
      throw new Error(`unexpected tool '${name}'`)
    })
    const { host, spawns, sends } = recordingAgentHost()
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, dispatchTool),
      agentRefs: { "@agentproto/repo-maintenance-reviewer": { adapter: "mock-agent" } },
    })
    const { output } = await runWorkflow({ workflow: compiled, agents: host, input: { repoRoot: "/repo", ...input } })
    return { spawns, sends, report: (output as { report: string }).report }
  }

  it("reviews only the idle, clean, no-PR, old-enough worktree branch, telling the reviewer why it was held", async () => {
    const { spawns, sends } = await run({})
    expect(spawns.filter(s => s.stepId === "reviewOne")).toHaveLength(1)
    expect(sends).toHaveLength(1)
    const prompt = sends[0]!.prompt
    expect(prompt).toContain(`Review the local branch \`idle\` (tip ${SHA_IDLE})`)
    expect(prompt).toContain("checked out in the linked worktree /wt/idle")
    expect(prompt).toContain("Never touch that worktree")
    for (const sha of [SHA_LIVE, SHA_DIRTY, SHA_YOUNG, SHA_PR]) expect(prompt).not.toContain(sha)
  })

  it("reports the verdict with the removal command when the reviewer agreed — and removes nothing itself", async () => {
    const { report } = await run({})
    expect(report).toContain("## Held worktrees reviewed (1)")
    expect(report).toContain("- `idle` - obsolete - PR: none")
    expect(report).toContain("nothing of value lost: `agentproto worktree rm /wt/idle`")
    expect(report).toContain("dry run only, nothing was deleted")
  })

  describe("reviewer evidence: PR state + git cherry", () => {
    const CLOSED = { state: "closed-unmerged", pr: 9 }
    const CHERRY = { total: 5, unmatched: 2 }
    const RECORD = {
      triage: { verdict: "obsolete", confidence: 0.9, reason: "superseded by #12\nsecond line is dropped" },
      gate: { agree: true, verdict: "obsolete", reason: "all hunks re-landed in #12", evidence: ["git cherry shows -"] },
    }

    it("hands the reviewer the PR state + number and the cherry summary of a held worktree", async () => {
      const { sends } = await run({}, { integration: CLOSED, idleExtra: { cherry: CHERRY } })
      const prompt = sends[0]!.prompt
      expect(prompt).toContain("PR state: closed-unmerged PR #9")
      expect(prompt).toContain("git cherry: 2 of 5 commit(s) have no patch-equivalent on base")
    })

    it("tells the reviewer how to weigh the evidence: closed-unmerged is a strong signal not proof, an open PR is never safe to delete", async () => {
      const { sends } = await run({}, { integration: CLOSED })
      const prompt = sends[0]!.prompt
      expect(prompt).toMatch(/closed-unmerged PR is a strong signal[^.]*abandon[^.]*supersed[^.]*not proof/i)
      expect(prompt).toMatch(/open PR is live work[^.]*never[^.]*gate\.agree/i)
      expect(prompt).toContain("git cherry: unavailable")
    })

    it("prints exactly ONE line per verdict: branch, PR state, cherry summary and the reviewer's one-line reason", async () => {
      const { report } = await run({}, { integration: CLOSED, idleExtra: { cherry: CHERRY }, record: RECORD })
      const lines = report.split("\n").filter(l => l.includes("`idle`") && l.includes("reason:"))
      expect(lines).toEqual([
        "- `idle` - obsolete - PR: closed-unmerged #9 - cherry: 2/5 not patch-equivalent on base - " +
          "reason: all hunks re-landed in #12 - nothing of value lost: `agentproto worktree rm /wt/idle`",
      ])
      expect(report).not.toContain("second line is dropped")
    })

    it("falls back to the triage reason when the reviewer recorded no gate, and says so when no reason was stored", async () => {
      const triageOnly = await run({}, { integration: CLOSED, record: { triage: RECORD.triage } })
      expect(triageOnly.report).toContain("reason: superseded by #12 -")
      expect(triageOnly.report).not.toContain("second line is dropped")
      const none = await run({}, { integration: CLOSED })
      expect(none.report).toContain("reason: (none recorded)")
    })

    it("renders unavailable cherry data as such, never as zero", async () => {
      const { report } = await run({}, { integration: CLOSED, record: RECORD })
      expect(report).toContain("cherry: unavailable")
    })
  })

  it("reviewHeldWorktrees:false leaves held worktrees alone", async () => {
    const { spawns, report } = await run({ reviewHeldWorktrees: false })
    expect(spawns).toHaveLength(0)
    expect(report).not.toContain("## Held worktrees reviewed")
  })
})

describe("repo-maintenance maintain workflow - reviewer evidence (pure functions)", () => {
  const sha = (c: string) => c.repeat(40)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Fn = (...a: any[]) => any
  const load = async () =>
    (await import(join(dirname(WORKFLOW_PATH), "entry.mjs"))) as {
      normalizePrState: Fn
      formatPrState: Fn
      formatCherry: Fn
      buildReviewQueue: Fn
    }

  it("normalizePrState maps worktree_gc integration onto {open, merged, closed-unmerged, none} and carries the PR number", async () => {
    const { normalizePrState } = await load()
    expect(normalizePrState({ state: "open", pr: 3 })).toEqual({ state: "open", number: 3 })
    expect(normalizePrState({ state: "merged", pr: 4 })).toEqual({ state: "merged", number: 4 })
    expect(normalizePrState({ state: "closed-unmerged", pr: 5 })).toEqual({ state: "closed-unmerged", number: 5 })
    // partial = merged PR plus commits made after it: still merged, but flagged.
    expect(normalizePrState({ state: "partial", pr: 6, aheadBy: 2 })).toEqual({ state: "merged", number: 6, partial: true, aheadBy: 2 })
    for (const state of ["pushed-no-pr", "unpushed", "local-only", "diverged"]) {
      expect(normalizePrState({ state })).toEqual({ state: "none", number: null })
    }
    // No PR number means no PR, whatever the state says.
    expect(normalizePrState({ state: "closed-unmerged" })).toEqual({ state: "none", number: null })
    expect(normalizePrState(undefined)).toEqual({ state: "none", number: null })
  })

  it("formatPrState / formatCherry render the evidence strings, cherry unavailable stays unavailable", async () => {
    const { formatPrState, formatCherry } = await load()
    expect(formatPrState({ state: "closed-unmerged", number: 9 })).toBe("closed-unmerged PR #9")
    expect(formatPrState({ state: "merged", number: 6, partial: true, aheadBy: 2 })).toBe("merged PR #6 (partial: +2 commit(s) made after it)")
    expect(formatPrState({ state: "none", number: null })).toBe("none")
    expect(formatPrState({ state: "unknown", number: null })).toBe("unknown")
    expect(formatCherry({ total: 5, unmatched: 2 })).toBe("2 of 5 commit(s) have no patch-equivalent on base")
    expect(formatCherry(null)).toBe("unavailable")
    expect(formatCherry(undefined)).toBe("unavailable")
  })

  function branchPlan(entries: Array<Record<string, unknown>>) {
    return { mode: "plan", plan: { repoRoot: "/repo", repoName: "repo", base: "origin/main", baseSha: sha("c"), entries } }
  }
  const base = {
    kind: "local",
    date: "2026-01-01T00:00:00Z",
    author: "a",
    subject: "s",
    ageDays: 10,
    status: "unmerged",
    history: "current",
    ahead: 2,
    behind: 0,
    residualFiles: ["x.ts"],
    residualFileCount: 1,
  }

  it("buildReviewQueue takes a worktree-held candidate's PR state from the matching worktree_gc entry (path + branch) and passes the cherry summary through", async () => {
    const { buildReviewQueue } = await load()
    const wtPlan = {
      mode: "plan",
      plan: [
        {
          path: "/wt/held",
          branch: "held",
          class: "hold",
          tree: "clean",
          integration: { state: "closed-unmerged", pr: 9 },
          liveness: { state: "idle", sessionCount: 0 },
        },
      ],
    }
    const { queue } = buildReviewQueue(
      branchPlan([
        { ...base, name: "held", ref: "refs/heads/held", sha: sha("1"), class: "hold", holdReason: "worktree", holdDetail: "/wt/held", cherry: { total: 2, unmatched: 2 } },
      ]),
      wtPlan,
    ) as { queue: Array<Record<string, unknown>> }
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({
      worktree: "/wt/held",
      pr: { state: "closed-unmerged", number: 9 },
      prState: "closed-unmerged",
      prNumber: 9,
      prSummary: "closed-unmerged PR #9",
      cherry: { total: 2, unmatched: 2 },
      cherrySummary: "2 of 2 commit(s) have no patch-equivalent on base",
    })
  })

  it("buildReviewQueue never invents a PR state or a cherry result for a plain branch candidate", async () => {
    const { buildReviewQueue } = await load()
    const { queue } = buildReviewQueue(
      branchPlan([{ ...base, name: "plain", ref: "refs/heads/plain", sha: sha("2"), class: "review" }]),
      { mode: "plan", plan: [] },
    ) as { queue: Array<Record<string, unknown>> }
    expect(queue[0]).toMatchObject({ prState: "unknown", prNumber: null, prSummary: "unknown", cherry: null, cherrySummary: "unavailable" })
  })

  it("buildReviewQueue uses the PR number a branch_gc entry does expose (forgePr / mergedPr) without claiming a state", async () => {
    const { buildReviewQueue } = await load()
    const { queue } = buildReviewQueue(
      branchPlan([{ ...base, name: "mirror", ref: "refs/heads/mirror", sha: sha("3"), class: "review", forgePr: 77 }]),
      { mode: "plan", plan: [] },
    ) as { queue: Array<Record<string, unknown>> }
    expect(queue[0]).toMatchObject({ prState: "unknown", prNumber: 77, prSummary: "unknown (PR #77)" })
  })
})
