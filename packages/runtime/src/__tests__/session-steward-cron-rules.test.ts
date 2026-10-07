/**
 * Pure unit tests for the session steward's mechanical cron rules — the
 * deterministic steps ported from the `kill-idle-sessions` cron prototype
 * (`.plans/session-steward-cron/SESSIONS-LOG.md`). Loads the REAL shipped
 * `cron-rules.mjs` from the app bundle (the same module `entry.mjs` imports),
 * so the rules the workflow runs are the ones pinned here. No daemon, no I/O,
 * no clock — every function takes its clock/inputs explicitly.
 */

import { beforeAll, describe, expect, it } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "session-steward",
  ".agentproto",
  "workflows",
  "session-steward",
  "cron-rules.mjs",
)

type AnyFn = (...args: any[]) => any
interface CronRules {
  LOOP_WINDOW_MS: number
  LOOP_VERBATIM_MIN: number
  LOOP_RATIO_MAX: number
  LOOP_REREAD_MIN: number
  STALL_BUSY_MINUTES: number
  callSignature: AnyFn
  isUsefulLoopCommand: AnyFn
  readTargetOf: AnyFn
  detectLoop: AnyFn
  detectStall: AnyFn
  isNeverRan: AnyFn
  isMessageParentCall: AnyFn
  isDoneMessageParent: AnyFn
  isCommitOrPrCall: AnyFn
  detectFastPathDone: AnyFn
  terminalRelabelCandidate: AnyFn
  prNumbersOf: AnyFn
  refineRelabel: AnyFn
  sameCronJob: AnyFn
  isSelfExcluded: AnyFn
  recheckApply: AnyFn
  evidenceFingerprint: AnyFn
  foldVerdictMemory: AnyFn
  shouldRejudge: AnyFn
  verdictMemoryEvent: AnyFn
  operatorDisagreement: AnyFn
  hostSaturation: AnyFn
  saturationHeader: AnyFn
  explainZeroCandidates: AnyFn
  shouldFastPath: AnyFn
  buildProposals: AnyFn
}

let mod: CronRules
beforeAll(async () => {
  mod = (await import(MODULE_PATH)) as CronRules
})

const NOW = Date.parse("2026-10-02T14:00:00Z")
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const call = (over: Record<string, unknown> = {}) => ({
  sessionId: "sess_x",
  tool: "Bash",
  command: "rg -rn sentinel packages/runtime/docs/mcp-tools/agent_start.md | head -10",
  ts: at(1),
  ...over,
})

// ── callSignature / useful loops / read targets ──────────────────────────

describe("cron rules — callSignature", () => {
  it("joins tool + command + args, whitespace-collapsed", () => {
    expect(mod.callSignature(call())).toBe("Bash rg -rn sentinel packages/runtime/docs/mcp-tools/agent_start.md | head -10")
    expect(mod.callSignature({ tool: "Read", args: ["a/b.ts"] })).toBe("Read a/b.ts")
    expect(mod.callSignature({})).toBe("unknown")
  })
})

describe("cron rules — isUsefulLoopCommand", () => {
  it.each([
    "Bash watch -n 5 gh pr view 1673",
    "Bash git status",
    "Bash pnpm test",
    "Bash pnpm check-types",
    "Bash npx vitest run src/__tests__/x",
    "Bash gh pr view 1673 --json state",
    "Bash gh pr checks 1673 --watch",
  ])("treats %s as a useful loop", (sig) => {
    expect(mod.isUsefulLoopCommand(sig)).toBe(true)
  })

  it("does not excuse an exploratory repetition", () => {
    expect(mod.isUsefulLoopCommand(call().command!)).toBe(false)
  })
})

describe("cron rules — readTargetOf", () => {
  it("resolves a path from a shell read", () => {
    expect(mod.readTargetOf(call())).toBe("packages/runtime/docs/mcp-tools/agent_start.md")
    expect(mod.readTargetOf({ tool: "Bash", command: "cat src/a/b.md" })).toBe("src/a/b.md")
  })
  it("targets the path after the read verb, not a leading `cd <dir>` or a trailing `| head`", () => {
    expect(mod.readTargetOf({ tool: "Bash", command: "cd /repo/packages/x && rg -n foo src/a.ts | head -5" })).toBe("src/a.ts")
    expect(mod.readTargetOf({ tool: "Bash", command: "cd /repo/packages/x && git log | head -5" })).toBeNull()
  })
  it("is null for a non-read call and for an in-agent Read with no command", () => {
    expect(mod.readTargetOf({ tool: "Edit", command: "git commit -m x" })).toBeNull()
    expect(mod.readTargetOf({ tool: "Read" })).toBeNull()
  })
})

// ── loop detection (mission item 1) ──────────────────────────────────────

describe("cron rules — detectLoop", () => {
  it("flags the same exploratory argv verbatim x3 in the window", () => {
    const records = [call({ ts: at(1) }), call({ ts: at(3) }), call({ ts: at(5) })]
    const r = mod.detectLoop(records, { nowMs: NOW })
    expect(r.looping).toBe(true)
    expect(r.stats.maxVerbatim).toBe(3)
    expect(r.reasons.join(" ")).toContain("verbatim x3")
  })

  it("flags a low distinct/total ratio over enough calls", () => {
    const records = Array.from({ length: 12 }, (_, i) => call({ command: `echo probe ${i % 2}`, ts: at(i) }))
    const r = mod.detectLoop(records, { nowMs: NOW })
    expect(r.looping).toBe(true)
    expect(r.stats.distinct).toBe(2)
    expect(r.stats.ratio).toBeLessThan(mod.LOOP_RATIO_MAX)
  })

  it("flags the same file re-read x4", () => {
    const records = [
      call({ command: "cat src/repeat.ts", ts: at(1) }),
      call({ command: "cat src/repeat.ts", ts: at(2) }),
      call({ command: "cat src/repeat.ts", ts: at(3) }),
      call({ command: "cat src/repeat.ts", ts: at(4) }),
    ]
    const r = mod.detectLoop(records, { nowMs: NOW })
    expect(r.looping).toBe(true)
    expect(r.stats.maxReads).toBe(4)
  })

  it("does NOT flag useful loops: watch, test re-runs, git status, gh pr polling", () => {
    const records = [
      call({ command: "gh pr view 1673", ts: at(1) }),
      call({ command: "gh pr view 1673", ts: at(2) }),
      call({ command: "gh pr view 1673", ts: at(3) }),
      call({ command: "pnpm check-types", ts: at(4) }),
      call({ command: "pnpm check-types", ts: at(5) }),
      call({ command: "pnpm check-types", ts: at(6) }),
      call({ command: "git status", ts: at(7) }),
      call({ command: "git status", ts: at(8) }),
      call({ command: "git status", ts: at(9) }),
    ]
    const r = mod.detectLoop(records, { nowMs: NOW })
    expect(r.looping).toBe(false)
    expect(r.stats.total).toBe(0)
    expect(r.stats.usefulExcluded).toBe(9)
  })

  it("ignores records outside the 10-minute window", () => {
    const records = [call({ ts: at(1) }), call({ ts: at(3) }), call({ ts: at(30) }), call({ ts: at(40) })]
    const r = mod.detectLoop(records, { nowMs: NOW })
    expect(r.looping).toBe(false)
    expect(r.stats.total).toBe(2)
  })

  it("does not call four different reads run from the same `cd` directory a re-read of that directory", () => {
    const records = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f, i) => call({ command: `cd /repo/packages/x && rg -n foo src/${f} | head -5`, ts: at(i + 1) }))
    expect(mod.detectLoop(records, { nowMs: NOW }).looping).toBe(false)
  })

  it("ignores anonymous in-agent calls (no command, no args): three `read`s in 10 minutes are not a loop", () => {
    const records = [{ tool: "read", ts: at(1) }, { tool: "read", ts: at(3) }, { tool: "read", ts: at(5) }, { tool: "edit", ts: at(6) }]
    const r = mod.detectLoop(records, { nowMs: NOW })
    expect(r.looping).toBe(false)
    expect(r.stats.total).toBe(0)
    expect(r.stats.anonymousExcluded).toBe(4)
  })

  it("still flags a verbatim shell command repeated among anonymous calls", () => {
    const records = [{ tool: "read", ts: at(1) }, call({ command: "cron list", ts: at(2) }), call({ command: "cron list", ts: at(3) }), call({ command: "cron list", ts: at(4) })]
    expect(mod.detectLoop(records, { nowMs: NOW }).looping).toBe(true)
  })

  it("does not flag a handful of distinct calls", () => {
    const records = [call({ command: "ls", ts: at(1) }), call({ command: "pwd", ts: at(2) })]
    expect(mod.detectLoop(records, { nowMs: NOW }).looping).toBe(false)
  })
})

// ── stall (mission item 2) ───────────────────────────────────────────────

describe("cron rules — detectStall", () => {
  it("flags busy > 20 min with no new activity", () => {
    const r = mod.detectStall({ busy: true, idleMinutes: 35, nowMs: NOW })
    expect(r).toMatchObject({ stalled: true, kind: "busy" })
  })

  it("flags a recent turn error on an idle process", () => {
    const r = mod.detectStall({ busy: false, lastTurnErroredAt: at(5), nowMs: NOW })
    expect(r).toMatchObject({ stalled: true, kind: "error" })
  })

  it("does not flag a fresh busy session, a stale error, or a busy error", () => {
    expect(mod.detectStall({ busy: true, idleMinutes: 5, nowMs: NOW }).stalled).toBe(false)
    expect(mod.detectStall({ busy: false, lastTurnErroredAt: at(90), nowMs: NOW }).stalled).toBe(false)
    expect(mod.detectStall({ busy: true, lastTurnErroredAt: at(5), nowMs: NOW }).stalled).toBe(false)
  })
})

// ── never-ran (mission item 3) ───────────────────────────────────────────

describe("cron rules — isNeverRan", () => {
  it("is true only for an explicit 0/0", () => {
    expect(mod.isNeverRan({ tokensIn: 0, tokensOut: 0 })).toBe(true)
    expect(mod.isNeverRan({ tokensIn: 0, tokensOut: 12 })).toBe(false)
    expect(mod.isNeverRan({})).toBe(false)
  })

  const NOW = Date.parse("2026-10-06T16:00:00.000Z")
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
  const zero = { tokensIn: 0, tokensOut: 0 }
  const opts = { nowMs: NOW, idleMinutes: 30 }

  it("is false for a busy just-started session", () => {
    expect(mod.isNeverRan({ ...zero, busy: true, startedAt: ago(0.3), lastActivityAt: ago(0.3) }, opts)).toBe(false)
  })

  it("is false while starting, provisioning, or a first prompt is queued", () => {
    const old = { ...zero, startedAt: ago(120), lastActivityAt: ago(120) }
    expect(mod.isNeverRan({ ...old, status: "starting" }, opts)).toBe(false)
    expect(mod.isNeverRan({ ...old, provisioning: { step: "x" } }, opts)).toBe(false)
    expect(mod.isNeverRan({ ...old, pendingPrompts: [{ id: "p" }] }, opts)).toBe(false)
  })

  it("needs both age and idle to reach the threshold", () => {
    expect(mod.isNeverRan({ ...zero, startedAt: ago(10), lastActivityAt: ago(10) }, opts)).toBe(false)
    expect(mod.isNeverRan({ ...zero, startedAt: ago(120), lastActivityAt: ago(5) }, opts)).toBe(false)
    expect(mod.isNeverRan({ ...zero, startedAt: ago(5), lastActivityAt: ago(120) }, opts)).toBe(false)
  })

  it("is true for an idle 0/0 session older than the threshold", () => {
    expect(mod.isNeverRan({ ...zero, startedAt: ago(45), lastActivityAt: ago(45) }, opts)).toBe(true)
    expect(mod.isNeverRan({ ...zero, startedAt: ago(45) }, opts)).toBe(true)
  })
})

// ── fast-path done (mission item 4) ──────────────────────────────────────

describe("cron rules — detectFastPathDone", () => {
  const doneParent = { tool: "message_parent", args: ["done", "shipped"], ts: at(1) }
  const commit = { tool: "Bash", command: "git commit -m done", ts: at(2) }

  it("is done when the last call is message_parent(kind:done) + a commit/PR", () => {
    const r = mod.detectFastPathDone({ toolCalls: [commit, doneParent], lastToolCall: doneParent })
    expect(r.done).toBe(true)
  })

  it("accepts a merged PR as the second half", () => {
    const r = mod.detectFastPathDone({ lastToolCall: doneParent, worktree: { pr: { state: "merged" } } })
    expect(r.done).toBe(true)
  })

  it("is not done without the done message, or without a commit/PR", () => {
    expect(mod.detectFastPathDone({ toolCalls: [commit] }).done).toBe(false)
    expect(mod.detectFastPathDone({ toolCalls: [{ tool: "message_parent", args: ["needs-input"] }] }).done).toBe(false)
  })
})

// ── terminal relabel (mission item 5) ────────────────────────────────────

describe("cron rules — terminalRelabelCandidate", () => {
  it("proposes done for a terminal session with a merged PR and no outcome", () => {
    const r = mod.terminalRelabelCandidate({ status: "killed", worktree: { pr: { state: "merged" } } })
    expect(r).toMatchObject({ candidate: true, proposedVerdict: "done" })
  })

  it("proposes done with the PR numbers for a session that opened PRs (row openedPrs / outcome artifacts)", () => {
    const openedPrs = [{ number: 1740 }, { number: 1738 }]
    const r = mod.terminalRelabelCandidate({ status: "killed", openedPrs })
    expect(r).toMatchObject({ candidate: true, proposedVerdict: "done", reason: "PRs #1738, #1740 opened", prs: [1738, 1740] })
    const art = { status: "exited", outcome: { status: "produced", verdict: null, artifacts: [{ type: "pr", ref: "https://github.com/o/r/pull/1743", title: "#1743" }, { type: "file", ref: "x" }] } }
    expect(mod.terminalRelabelCandidate(art)).toMatchObject({ proposedVerdict: "done", reason: "PR #1743 opened" })
    expect(mod.prNumbersOf({ outcome: { artifacts: [{ type: "pr", ref: "https://github.com/o/r/pull/9" }] } })).toEqual([9])
  })

  it("names the PR when the worktree PR is merged", () => {
    const r = mod.terminalRelabelCandidate({ status: "killed", worktree: { pr: { state: "merged", number: 12 } } })
    expect(r).toMatchObject({ proposedVerdict: "done", reason: "PR #12 merged (worktree)" })
  })

  it("does not credit a shared worktree's merged PR to a session whose last turn errored", () => {
    const r = mod.terminalRelabelCandidate({ status: "killed", lastTurnErroredAt: "2026-10-06T13:54:38Z", worktree: { pr: { state: "merged", number: 1737 } } })
    expect(r).toMatchObject({ candidate: true, proposedVerdict: "unknown" })
  })

  it("keeps a worktree PR the session recorded itself as plain 'merged'", () => {
    const r = mod.terminalRelabelCandidate({ status: "killed", lastTurnErroredAt: "2026-10-06T13:54:38Z", openedPrs: [{ number: 12 }], worktree: { pr: { state: "merged", number: 12 } } })
    expect(r).toMatchObject({ proposedVerdict: "done", reason: "PR #12 merged" })
  })

  it("refineRelabel: merged → done+merged, open/opened → done, nothing → unchanged", () => {
    const base = { sessionId: "s", proposedVerdict: "unknown", reason: "terminal, no PR recorded — outcome unknown", prs: [] }
    expect(mod.refineRelabel(base, undefined)).toBe(base)
    expect(mod.refineRelabel(base, { pullRequests: { opened: 0, merged: 0, state: null } })).toBe(base)
    expect(mod.refineRelabel(base, { worktree: { pr: { state: "merged", number: 3 } } })).toMatchObject({ proposedVerdict: "done", reason: "PR #3 merged (worktree)" })
    expect(mod.refineRelabel(base, { pullRequests: { opened: 1, merged: 0, state: null } })).toMatchObject({ proposedVerdict: "done", reason: "1 PR opened" })
    const opened = { ...base, proposedVerdict: "done", reason: "PR #8 opened", prs: [8] }
    expect(mod.refineRelabel(opened, { pullRequests: { opened: 1, merged: 1, state: "merged" } })).toMatchObject({ reason: "PR #8 merged" })
  })

  it("proposes unknown (not abandoned) for a terminal session with no PR: absence of a PR is not evidence of abandonment", () => {
    expect(mod.terminalRelabelCandidate({ status: "exited" })).toMatchObject({ candidate: true, proposedVerdict: "unknown" })
  })

  it("refineRelabel: no PR → abandoned only on positive evidence (errored last turn, no turn completed)", () => {
    const base = { sessionId: "s", proposedVerdict: "unknown", reason: "x", prs: [] }
    expect(mod.refineRelabel(base, { turnsCompleted: 3, pullRequests: { opened: 0, merged: 0, state: null } })).toBe(base)
    expect(mod.refineRelabel(base, { turnsCompleted: 2, lastTurnError: "Upstream request failed" })).toMatchObject({ proposedVerdict: "abandoned" })
    expect(mod.refineRelabel(base, { turnsCompleted: 0 })).toMatchObject({ proposedVerdict: "abandoned", reason: "no PR, no turn ever completed" })
  })

  it("refineRelabel: a sibling's merged worktree PR is not credited to an errored session with no PR of its own", () => {
    const base = { sessionId: "s", proposedVerdict: "unknown", reason: "x", prs: [] }
    const ev = { lastTurnError: "Endpoint is unavailable", turnsCompleted: 1, pullRequests: { opened: 0, merged: 1, state: "merged" }, worktree: { pr: { state: "merged", number: 1737 } } }
    const r = mod.refineRelabel(base, ev)
    expect(r.proposedVerdict).not.toBe("done")
    expect(mod.refineRelabel({ ...base, prs: [1737] }, ev)).toMatchObject({ proposedVerdict: "done", reason: "PR #1737 merged" })
  })

  it("skips a running session, a recorded outcome, or an existing flag", () => {
    expect(mod.terminalRelabelCandidate({ status: "running" }).candidate).toBe(false)
    expect(mod.terminalRelabelCandidate({ status: "killed", outcome: { verdict: "done" } }).candidate).toBe(false)
    expect(mod.terminalRelabelCandidate({ status: "killed", wrapupFlag: { verdict: "blocked" } }).candidate).toBe(false)
  })
})

// ── self-exclusion (mission item 7) ──────────────────────────────────────

describe("cron rules — self-exclusion", () => {
  it("excludes the caller itself", () => {
    expect(mod.isSelfExcluded({ id: "sess_self" }, { callerSessionId: "sess_self" })).toMatchObject({ excluded: true })
  })

  it("excludes an older run of the caller's own cron job", () => {
    const s = { id: "sess_old", origin: "cron:kill-idle-sessions" }
    expect(mod.isSelfExcluded(s, { callerOrigin: "cron:kill-idle-sessions" })).toMatchObject({ excluded: true })
    expect(mod.isSelfExcluded(s, { callerOrigin: "cron:other" }).excluded).toBe(false)
  })

  it("does not exclude a different origin", () => {
    expect(mod.isSelfExcluded({ id: "sess_a", origin: "chat-starter" }, { callerOrigin: "cron:x" }).excluded).toBe(false)
  })
})

// ── re-check at apply (mission item 6) ───────────────────────────────────

describe("cron rules — recheckApply", () => {
  it("proceeds for a still-idle running session", () => {
    expect(mod.recheckApply({}, { status: "running", busy: false })).toMatchObject({ proceed: true })
  })
  it("skips a session that became busy or terminal, or vanished", () => {
    expect(mod.recheckApply({}, { status: "running", busy: true }).proceed).toBe(false)
    expect(mod.recheckApply({}, { status: "killed", busy: false }).proceed).toBe(false)
    expect(mod.recheckApply({}, undefined).proceed).toBe(false)
  })
})

// ── verdict memory (mission item 10) ─────────────────────────────────────

describe("cron rules — verdict memory", () => {
  const ev = (sessionId: string, verdict: string, fingerprint: string, ts = at(1)) => ({
    kind: "note",
    ts,
    payload: { kind: "steward-verdict", sessionId, verdict, confidence: 0.9, fingerprint },
  })

  it("folds consecutive agreeing verdicts into a streak and resets on change", () => {
    const m = mod.foldVerdictMemory([
      ev("sess_a", "active", "fp1", at(30)),
      ev("sess_a", "active", "fp1", at(20)),
      ev("sess_a", "active", "fp1", at(10)),
      ev("sess_a", "done", "fp2", at(1)),
    ])
    expect(m.get("sess_a")).toMatchObject({ verdict: "done", streak: 1 })
  })

  it("does not re-judge a stable verdict+fingerprint, re-judges on evidence change", () => {
    const m = mod.foldVerdictMemory([ev("sess_a", "active", "fp1"), ev("sess_a", "active", "fp1")])
    expect(mod.shouldRejudge(m, "sess_a", "fp1", { stablePasses: 2 })).toMatchObject({ rejudge: false })
    expect(mod.shouldRejudge(m, "sess_a", "fp2", { stablePasses: 2 }).rejudge).toBe(true)
    expect(mod.shouldRejudge(m, "sess_unknown", "fp1").rejudge).toBe(true)
  })

  it("fingerprints decision-relevant evidence only", () => {
    const a = mod.evidenceFingerprint({ status: "running", busy: true, turns: [{ text: "one" }] })
    const b = mod.evidenceFingerprint({ status: "running", busy: true, turns: [{ text: "two" }] })
    expect(a).toBe(b)
    expect(mod.evidenceFingerprint({ status: "running", busy: false })).not.toBe(a)
  })

  it("builds a note event and records operator disagreements", () => {
    const e = mod.verdictMemoryEvent({ sessionId: "sess_a", verdict: "done", confidence: 0.9, fingerprint: "fp1", judgedBy: "jev" })
    expect(e).toMatchObject({ kind: "note", by: "policy", stage: "session-steward", item: "sess_a" })
    expect(e.payload).toMatchObject({ kind: "steward-verdict", verdict: "done" })
    const m = mod.foldVerdictMemory([e])
    expect(mod.operatorDisagreement(m, "sess_a", "active")).toMatchObject({ judgeVerdict: "done", operatorVerdict: "active" })
    expect(mod.operatorDisagreement(m, "sess_a", "done")).toBeNull()
  })
})

// ── host saturation (mission item 9) ─────────────────────────────────────

describe("cron rules — host saturation", () => {
  const saturated = {
    loadAvg: [50, 40, 30],
    cpuCount: 12,
    loadPerCore: 4.2,
    memory: { totalBytes: 34 * 1024 ** 3, freeBytes: 50 * 1024 ** 2, availableBytes: 80 * 1024 ** 2 },
    swap: { percent: 96 },
    warnings: [{ kind: "load", severity: "critical", message: "load is 4.2x the 12 cores" }],
    topByMemory: [
      { pid: 1, command: "next-server", memoryBytes: 2 * 1024 ** 3, elapsedSec: 40000, owner: { kind: "orphan" } },
      { pid: 2, command: "llama-server", memoryBytes: 8 * 1024 ** 3, elapsedSec: 2000, owner: { kind: "other" } },
      { pid: 3, command: "agent", memoryBytes: 1 * 1024 ** 3, elapsedSec: 20, owner: { kind: "session", sessionId: "sess_a" } },
    ],
  }

  it("is critical with load/swap/RAM reasons", () => {
    const r = mod.hostSaturation(saturated)
    expect(r.critical).toBe(true)
    expect(r.reasons.join(" ")).toContain("cores")
    expect(r.reasons.join(" ")).toContain("swap")
  })

  it("is not critical on a calm host", () => {
    expect(mod.hostSaturation({ loadPerCore: 0.5, memory: { totalBytes: 100, availableBytes: 60 }, swap: { percent: 2 } }).critical).toBe(false)
  })

  it("lists orphans and big non-session processes, report-only", () => {
    const lines = mod.saturationHeader(saturated)
    const text = lines.join("\n")
    expect(text).toContain("Host saturated")
    expect(text).toContain("orphans:")
    expect(text).toContain("next-server")
    expect(text).toContain("big non-session:")
    expect(text).toContain("llama-server")
    expect(text).not.toContain("sess_a")
  })

  it("returns no header on a calm host", () => {
    expect(mod.saturationHeader({ loadPerCore: 0.5, memory: { totalBytes: 100, availableBytes: 60 }, swap: { percent: 2 } })).toEqual([])
  })
})

// ── explicit 0-candidate report (mission item 8) ─────────────────────────

describe("cron rules — zero candidates / fast path", () => {
  it("states why there was nothing to do", () => {
    const s = mod.explainZeroCandidates({ live: 9, busy: 4, idle: 5, terminal: 2, terminalRelabel: 1, excluded: 3 })
    expect(s).toContain("0 candidates: 9 live")
    expect(s).toContain("4 busy")
    expect(s).toContain("1 need a relabel")
    expect(s).toContain("3 excluded")
  })

  it("fast-paths only when nothing idle/terminal but some busy", () => {
    expect(mod.shouldFastPath({ busy: [{}], idle: [], terminalRelabel: [] })).toMatchObject({ fastPath: true })
    expect(mod.shouldFastPath({ busy: [{}], idle: [{}], terminalRelabel: [] }).fastPath).toBe(false)
    expect(mod.shouldFastPath({ busy: [], idle: [], terminalRelabel: [] }).fastPath).toBe(false)
  })
})

// ── proposals (mission items 1, 2) ───────────────────────────────────────

describe("cron rules — buildProposals", () => {
  it("makes one interrupt proposal for a loop, preferring it over a stall", () => {
    const { proposals } = mod.buildProposals({
      loopResults: [{ sessionId: "s1", looping: true, reasons: ["verbatim x3"], originClass: "closable" }],
      stallResults: [{ sessionId: "s1", stalled: true, reason: "busy 30m", originClass: "closable" }],
    })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ sessionId: "s1", kind: "interrupt" })
  })

  it("makes a continue proposal for a stall", () => {
    const { proposals } = mod.buildProposals({ stallResults: [{ sessionId: "s2", stalled: true, reason: "errored", originClass: "closable" }] })
    expect(proposals[0]).toMatchObject({ sessionId: "s2", kind: "continue" })
  })

  it("never nudges a user-origin session — reports it as observed", () => {
    const { proposals, observed } = mod.buildProposals({ loopResults: [{ sessionId: "chat", looping: true, reasons: ["x"], originClass: "user" }] })
    expect(proposals).toHaveLength(0)
    expect(observed[0]).toMatchObject({ sessionId: "chat", suppressed: "origine utilisateur" })
  })

  it("never proposes a close", () => {
    const { proposals } = mod.buildProposals({
      loopResults: [{ sessionId: "s1", looping: true, reasons: ["x"], originClass: "closable" }],
      stallResults: [{ sessionId: "s2", stalled: true, reason: "y", originClass: "closable" }],
    })
    expect(proposals.every((p: { kind: string }) => p.kind === "interrupt" || p.kind === "continue")).toBe(true)
  })
})
