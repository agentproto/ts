/**
 * Pure-logic tests for the two-step steward (`actions.mjs`): the closed action
 * vocabulary, the rules matcher/validator, the origin bounds, the relaunch
 * profile suggestion, the snapshot build, the staleness re-check and the act
 * planner. Fixtures only — no daemon, no real session.
 */

import { describe, expect, it } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ACTIONS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "session-steward",
  ".agentproto",
  "workflows",
  "session-steward",
  "actions.mjs",
)

/* eslint-disable @typescript-eslint/no-explicit-any */
const A: any = await import(ACTIONS_PATH)

const NOW = Date.parse("2026-10-10T12:00:00Z")
const settings = { idleMinutes: 120, minConfidence: 0.8, userOrigins: undefined, closableOrigins: undefined }

function row(over: Record<string, unknown> = {}) {
  return {
    id: (over.id as string) ?? "s1",
    label: (over.id as string) ?? "s1",
    status: "running",
    origin: "workflow",
    cwd: "/work/a",
    model: "claude-sonnet-5",
    lastActivityAt: "2026-10-10T08:00:00Z",
    tokensIn: 100,
    tokensOut: 50,
    ...over,
  }
}

function snap(sessions: any[], extra: Record<string, unknown> = {}) {
  return A.buildSnapshot({
    settings,
    rules: A.validateRules(undefined),
    candidates: { close: [], stuck: [], judge: [], judgeOverflow: [] },
    verdicts: [],
    relabel: [],
    archive: [],
    held: [],
    liveRows: sessions,
    profiles: [],
    nowMs: NOW,
    id: "snap_test",
    ...extra,
  })
}

describe("classifyError", () => {
  it("reads the wallet tag and flags quota as transient", () => {
    const e = A.classifyError('You hit your usage limit [wallet: profile "claude-b" — Pro, subaccount kind "x"]')
    expect(e).toMatchObject({ kind: "quota", transient: true, wallet: "claude-b" })
  })
  it.each([
    ["Anthropic API overloaded (529)", "upstream"],
    ["request timed out after 300s", "timeout"],
    ["daemon restart while the turn was running", "crash"],
  ])("%s → %s", (msg, kind) => {
    expect(A.classifyError(msg)).toMatchObject({ kind, transient: true })
  })
  it("unmatched text is a non-transient logic error; empty is none", () => {
    expect(A.classifyError("TypeError: x is not a function")).toMatchObject({ kind: "logic", transient: false })
    expect(A.classifyError("")).toMatchObject({ kind: "none", transient: false })
  })
})

describe("rules validator", () => {
  it("accepts a bare list and a {rules} document", () => {
    expect(A.validateRules([{ when: { origin: "cron*" }, action: "skip" }]).ok).toBe(true)
    expect(A.validateRules({ version: 1, rules: [{ id: "a", when: { label: "x*" }, action: "keep" }] }).ok).toBe(true)
  })
  it("reports unknown keys, unknown actions and empty when — and returns NO rules", () => {
    const v = A.validateRules({
      rules: [
        { id: "a", when: { origen: "x" }, action: "keep" },
        { id: "b", when: { origin: "x" }, action: "nuke" },
        { id: "c", when: {}, action: "keep" },
        { id: "d", when: { origin: "x" }, action: "keep", colour: "red" },
      ],
      extra: 1,
    })
    expect(v.ok).toBe(false)
    expect(v.rules).toEqual([])
    const text = v.errors.join("\n")
    expect(text).toContain('unknown top-level key "extra"')
    expect(text).toContain('unknown when key "origen"')
    expect(text).toContain('action "nuke"')
    expect(text).toContain("empty `when`")
    expect(text).toContain('unknown key "colour"')
  })
  it("rejects a bad enum value and a bad numeric test", () => {
    const v = A.validateRules([{ when: { verdict: "maybe", idleMinutes: "soon" }, action: "keep" }])
    expect(v.ok).toBe(false)
    expect(v.errors.join("\n")).toContain('"maybe" is not one of')
    expect(v.errors.join("\n")).toContain("cannot read")
  })
  it("nothing parsed is ok and empty", () => {
    expect(A.validateRules(undefined)).toMatchObject({ ok: true, rules: [], source: "none" })
  })
})

describe("rules matcher", () => {
  const rules = (list: unknown[]) => A.validateRules(list).rules
  const facts = { origin: "model-bench", label: "Bench run 4", cwd: "/work/Bench", model: "gpt-5:free", idleMinutes: 90, class: "judge", state: "live", verdict: "done", confident: true, errorKind: "quota", transient: true }

  it("globs are case-insensitive, except cwd", () => {
    expect(A.matchRule(rules([{ id: "o", when: { origin: "MODEL-*" }, action: "keep" }]), facts)?.id).toBe("o")
    expect(A.matchRule(rules([{ id: "l", when: { label: "bench*" }, action: "keep" }]), facts)?.id).toBe("l")
    expect(A.matchRule(rules([{ id: "c", when: { cwd: "/work/bench" }, action: "keep" }]), facts)).toBeNull()
    expect(A.matchRule(rules([{ id: "c", when: { cwd: "/work/Bench" }, action: "keep" }]), facts)?.id).toBe("c")
  })
  it("a list is any-of, several keys are all-of", () => {
    expect(A.matchRule(rules([{ id: "x", when: { origin: ["cron", "model-bench"], model: "*:free" }, action: "keep" }]), facts)?.id).toBe("x")
    expect(A.matchRule(rules([{ id: "y", when: { origin: "model-bench", model: "*:paid" }, action: "keep" }]), facts)).toBeNull()
  })
  it("numeric tests: bare number, comparison, range, min/max", () => {
    const m = (spec: unknown) => A.matchRule(rules([{ id: "n", when: { idleMinutes: spec }, action: "keep" }]), facts) !== null
    expect(m(60)).toBe(true)
    expect(m(">=120")).toBe(false)
    expect(m("<100")).toBe(true)
    expect(m("80..100")).toBe(true)
    expect(m({ min: 91 })).toBe(false)
  })
  it("first match wins", () => {
    const r = rules([
      { id: "first", when: { origin: "model-bench" }, action: "close-abandoned" },
      { id: "second", when: { origin: "model-bench" }, action: "keep" },
    ])
    expect(A.matchRule(r, facts)?.id).toBe("first")
  })
  it("booleans and enums", () => {
    expect(A.matchRule(rules([{ id: "b", when: { transient: true, errorKind: "quota", class: "judge" }, action: "relaunch" }]), facts)?.id).toBe("b")
    expect(A.matchRule(rules([{ id: "b", when: { transient: false }, action: "keep" }]), facts)).toBeNull()
  })
})

describe("vocabulary: every action comes out of the default policy", () => {
  const f = (over: Record<string, unknown>) => ({ originClass: "closable", state: "live", ...over })
  it("keep — held, and an unconfident judge", () => {
    expect(A.decideAction(f({ class: "held" })).action).toBe("keep")
    expect(A.decideAction(f({ class: "judge", verdict: "done", confident: false })).action).toBe("keep")
    expect(A.decideAction(f({ class: "judge", verdict: "active", confident: true })).action).toBe("keep")
  })
  it("mark-complete — rule-certain close, merged terminal, confident judge", () => {
    expect(A.decideAction(f({ class: "close" })).action).toBe("mark-complete")
    expect(A.decideAction(f({ class: "terminal", state: "ended", verdict: "done" })).action).toBe("mark-complete")
    expect(A.decideAction(f({ class: "judge", verdict: "done", confident: true })).action).toBe("mark-complete")
  })
  it("mark-complete is demoted to needs-input when work remains (G11)", () => {
    expect(A.decideAction(f({ class: "close", remainingWork: true })).action).toBe("needs-input")
    expect(A.decideAction(f({ class: "judge", verdict: "done", confident: true, remainingWork: true })).action).toBe("needs-input")
  })
  it("mark-failed — non-transient error", () => {
    expect(A.decideAction(f({ class: "judge", errored: true, errorKind: "logic", transient: false })).action).toBe("mark-failed")
  })
  it("relaunch — transient error", () => {
    expect(A.decideAction(f({ class: "judge", errored: true, errorKind: "quota", transient: true })).action).toBe("relaunch")
  })
  it("needs-input — judged waiting / blocked", () => {
    expect(A.decideAction(f({ class: "judge", verdict: "needs-input", confident: true })).action).toBe("needs-input")
    expect(A.decideAction(f({ class: "judge", verdict: "blocked", confident: true })).action).toBe("needs-input")
  })
  it("close-abandoned — never ran, abandoned terminal, judged abandoned", () => {
    expect(A.decideAction(f({ class: "stuck", neverRan: true })).action).toBe("close-abandoned")
    expect(A.decideAction(f({ class: "terminal", state: "ended", verdict: "abandoned" })).action).toBe("close-abandoned")
    expect(A.decideAction(f({ class: "judge", verdict: "abandoned", confident: true })).action).toBe("close-abandoned")
  })
  it("archive — ended with an outcome", () => {
    expect(A.decideAction(f({ class: "archive", state: "ended" })).action).toBe("archive")
  })
  it("a custom rule runs before the defaults; skip keeps", () => {
    const rules = A.validateRules([{ id: "bench", when: { origin: "model-bench" }, action: "skip" }]).rules
    const d = A.decideAction(f({ class: "close", origin: "model-bench" }), rules)
    expect(d).toMatchObject({ action: "keep", skipped: true, ruleId: "bench" })
  })
  it("a custom relaunch rule overrides mark-failed", () => {
    const rules = A.validateRules([{ id: "r", when: { errorKind: "logic", label: "flaky*" }, action: "relaunch" }]).rules
    const d = A.decideAction(f({ class: "judge", errored: true, errorKind: "logic", transient: false, label: "flaky-1" }), rules)
    expect(d).toMatchObject({ action: "relaunch", ruleId: "r", source: "custom" })
  })
})

describe("origin bounds", () => {
  it("a live user-origin session is never closed: every closing action becomes needs-input", () => {
    for (const a of ["mark-complete", "mark-failed", "close-abandoned", "relaunch", "archive"]) {
      expect(A.boundByOrigin(a, { originClass: "user", state: "live" })).toMatchObject({ action: "needs-input", bound: true })
    }
    expect(A.boundByOrigin("needs-input", { originClass: "user", state: "live" }).bound).toBe(false)
    expect(A.boundByOrigin("keep", { originClass: "user", state: "live" }).bound).toBe(false)
  })
  it("an ended user-origin session may be labelled, never relaunched or archived", () => {
    expect(A.boundByOrigin("mark-failed", { originClass: "user", state: "ended" }).bound).toBe(false)
    expect(A.boundByOrigin("relaunch", { originClass: "user", state: "ended" }).action).toBe("mark-failed")
    expect(A.boundByOrigin("archive", { originClass: "user", state: "ended" }).action).toBe("keep")
  })
  it("a custom rule cannot close a live user session", () => {
    const rules = A.validateRules([{ id: "all", when: { class: "stuck" }, action: "close-abandoned" }]).rules
    const d = A.decideAction({ class: "stuck", state: "live", originClass: "user", neverRan: true }, rules)
    expect(d).toMatchObject({ action: "needs-input", bound: true, boundFrom: "close-abandoned" })
  })
})

describe("relaunch hint: another profile of the same provider", () => {
  const profiles = [
    { id: "claude-a", endpoint: "anthropic", method: "oauth", keyStatus: "ok" },
    { id: "claude-b", endpoint: "anthropic", method: "oauth", keyStatus: "ok" },
    { id: "claude-c", endpoint: "anthropic", method: "oauth", disabled: true },
    { id: "claude-key", endpoint: "anthropic", method: "api-key", keyStatus: "ok" },
    { id: "openai-a", endpoint: "openai", method: "oauth", keyStatus: "ok" },
  ]
  it("picks a non-exhausted, enabled profile of the same endpoint", () => {
    const s = A.suggestProfile({ failedProfile: "claude-a", model: "claude-sonnet-5", profiles, exhausted: ["claude-a"] })
    expect(s.profileRef).toBe("claude-b")
  })
  it("skips exhausted ones and falls through to nothing", () => {
    const s = A.suggestProfile({ failedProfile: "claude-a", model: "claude-sonnet-5", profiles: profiles.filter(p => p.id !== "claude-key"), exhausted: ["claude-a", "claude-b"] })
    expect(s.profileRef).toBeUndefined()
    expect(s.reason).toContain("no other non-exhausted")
  })
  it("never a metered api-key profile for a free-only model", () => {
    const only = profiles.filter(p => p.id === "claude-a" || p.id === "claude-key")
    expect(A.isFreeOnlyModel("some/model:free")).toBe(true)
    expect(A.isFreeOnlyModel("claude-sonnet-5")).toBe(false)
    expect(A.suggestProfile({ failedProfile: "claude-a", model: "some/model:free", profiles: only, exhausted: [] }).profileRef).toBeUndefined()
    expect(A.suggestProfile({ failedProfile: "claude-a", model: "claude-sonnet-5", profiles: only, exhausted: [] }).profileRef).toBe("claude-key")
  })
  it("hint modes: quota → fresh on another profile, deferred when none; others continue", () => {
    expect(A.relaunchHintFor({ errorKind: "quota", walletProfile: "claude-a", model: "m" }, { profiles, exhausted: new Set(["claude-a"]) })).toMatchObject({ mode: "fresh", profileRef: "claude-b" })
    expect(A.relaunchHintFor({ errorKind: "quota", walletProfile: "openai-a", model: "m" }, { profiles, exhausted: new Set(["openai-a"]) })).toMatchObject({ mode: "continue", deferred: true })
    expect(A.relaunchHintFor({ errorKind: "timeout" }, { profiles })).toMatchObject({ mode: "continue" })
  })
})

describe("snapshot", () => {
  const quotaErr = 'usage limit reached [wallet: profile "claude-a" — Pro, subaccount kind "x"]'
  const profiles = [
    { id: "claude-a", endpoint: "anthropic", method: "oauth" },
    { id: "claude-b", endpoint: "anthropic", method: "oauth" },
  ]

  it("one recommended action per session, classes mapped, ids stable", () => {
    const rows = [
      row({ id: "close1" }),
      row({ id: "stuck1", tokensIn: 0, tokensOut: 0, origin: undefined }),
      row({ id: "quota1", lastTurnErroredAt: "2026-10-10T09:00:00Z", lastTurnErrorMessage: quotaErr, accessProfile: { profileRef: "claude-a" } }),
      row({ id: "arch1", status: "exited", archived: false }),
    ]
    const s = snap(rows, {
      candidates: { close: [{ sessionId: "close1", origin: "workflow" }], stuck: [{ sessionId: "stuck1" }], judge: [], judgeOverflow: [] },
      verdicts: [{ entry: { sessionId: "quota1", origin: "workflow" }, verdict: "abandoned", confidence: 0.9, probabilities: { abandoned: 0.9, active: 0.1 }, source: "jev", judgedBy: "jev:m" }],
      archive: [{ id: "arch1", status: "exited" }],
      profiles,
    })
    const by = Object.fromEntries(s.sessions.map((x: any) => [x.sessionId, x]))
    expect(s.id).toBe("snap_test")
    expect(s.schema).toBe("steward-snapshot/v1")
    expect(by.close1.action).toBe("mark-complete")
    expect(by.stuck1).toMatchObject({ action: "needs-input", boundFrom: "close-abandoned", originClass: "user" })
    expect(by.quota1).toMatchObject({ action: "relaunch", errorKind: "quota", relaunchHint: { mode: "fresh", profileRef: "claude-b" }, probabilities: { abandoned: 0.9 } })
    expect(by.arch1.action).toBe("archive")
    expect(s.counts).toMatchObject({ "mark-complete": 1, "needs-input": 1, relaunch: 1, archive: 1 })
    expect(by.close1.fingerprint.status).toBe("running")
  })

  it("a running session whose only turn errored with 0 tokens: failed, not stuck/judge", () => {
    const r = row({ id: "zero", tokensIn: 0, tokensOut: 0, lastTurnErroredAt: "2026-10-10T09:00:00Z", lastTurnErrorMessage: "TypeError: boom", origin: "cron" })
    const s = snap([r], { candidates: { close: [], stuck: [{ sessionId: "zero", origin: "cron" }], judge: [], judgeOverflow: [] } })
    expect(s.sessions[0]).toMatchObject({ errored: true, errorKind: "logic", action: "mark-failed" })
  })

  it("an unreadable verdict stays keep, with no confidence", () => {
    const s = snap([row({ id: "j" })], { verdicts: [{ entry: { sessionId: "j" }, malformed: true, confidence: 0.99 }] })
    expect(s.sessions[0]).toMatchObject({ action: "keep", confidence: null })
  })

  it("custom rules apply at classify time", () => {
    const rules = A.validateRules([{ id: "bench", when: { origin: "model-bench" }, action: "close-abandoned" }], "file.yaml")
    const s = snap([row({ id: "b", origin: "model-bench" })], { candidates: { close: [{ sessionId: "b", origin: "model-bench" }], stuck: [], judge: [], judgeOverflow: [] }, rules })
    expect(s.sessions[0]).toMatchObject({ action: "close-abandoned", ruleId: "bench", ruleSource: "custom" })
    expect(s.rules).toEqual({ source: "file.yaml", count: 1 })
  })

  it("renders a table grouped by action with p: strings, keep as a count", () => {
    const s = snap([row({ id: "j" }), row({ id: "k" })], {
      verdicts: [
        { entry: { sessionId: "j" }, verdict: "done", confidence: 0.91, probabilities: { done: 0.91, active: 0.06, blocked: 0.03 }, judgedBy: "jev:m" },
        { entry: { sessionId: "k" }, verdict: "active", confidence: 0.9 },
      ],
    })
    const md = A.renderSnapshot(s)
    expect(md).toContain("## mark-complete (1)")
    expect(md).toContain("done=0.91 active=0.06 blocked=0.03")
    expect(md).toContain("## keep (1)")
    expect(md).toContain("pass `--all`")
    expect(A.renderSnapshot(s, { showKeep: true })).toContain("| k |")
  })
})

describe("staleness re-check", () => {
  const r = row({ id: "s" })
  const s = snap([r], { candidates: { close: [{ sessionId: "s", origin: "workflow" }], stuck: [], judge: [], judgeOverflow: [] } })
  const entry = s.sessions[0]

  it("unchanged → fresh", () => {
    expect(A.staleness(entry, r)).toEqual({ changed: false, why: [] })
  })
  it.each([
    ["new activity", { lastActivityAt: "2026-10-10T11:59:00Z" }],
    ["status change", { status: "exited" }],
    ["new tokens", { tokensOut: 99 }],
    ["new error", { lastTurnErroredAt: "2026-10-10T11:00:00Z" }],
    ["busy", { busy: true }],
    ["outcome recorded", { outcome: { verdict: "done" } }],
  ])("%s → changed", (_n, over) => {
    expect(A.staleness(entry, { ...r, ...over }).changed).toBe(true)
  })
  it("a vanished session is changed", () => {
    expect(A.staleness(entry, undefined)).toMatchObject({ changed: true })
  })
})

describe("act planner", () => {
  const rows = [
    row({ id: "done1" }),
    row({ id: "user1", origin: undefined, tokensIn: 0, tokensOut: 0 }),
    row({ id: "ended1", status: "exited", origin: "workflow", lastTurnErroredAt: "2026-10-10T09:00:00Z", lastTurnErrorMessage: "TypeError: boom" }),
    row({ id: "q1", lastTurnErroredAt: "2026-10-10T09:00:00Z", lastTurnErrorMessage: 'usage limit [wallet: profile "claude-a" — P, subaccount kind "x"]', accessProfile: { profileRef: "claude-a" } }),
    row({ id: "to1", lastTurnErroredAt: "2026-10-10T09:00:00Z", lastTurnErrorMessage: "request timed out" }),
    row({ id: "arch1", status: "exited" }),
    row({ id: "keep1" }),
  ]
  const s = snap(rows, {
    candidates: { close: [{ sessionId: "done1", origin: "workflow" }], stuck: [{ sessionId: "user1" }], judge: [], judgeOverflow: [] },
    verdicts: [
      { entry: { sessionId: "q1", origin: "workflow" }, verdict: "abandoned", confidence: 0.95, judgedBy: "jev:m" },
      { entry: { sessionId: "to1", origin: "workflow" }, verdict: "abandoned", confidence: 0.95, judgedBy: "jev:m" },
      { entry: { sessionId: "keep1", origin: "workflow" }, verdict: "active", confidence: 0.95 },
    ],
    relabel: [{ sessionId: "ended1", origin: "workflow", proposedVerdict: "abandoned", reason: "x" }],
    archive: [{ id: "arch1" }],
    profiles: [
      { id: "claude-a", endpoint: "anthropic", method: "oauth" },
      { id: "claude-b", endpoint: "anthropic", method: "oauth" },
    ],
  })
  const plan = (opts: Record<string, unknown> = {}, live = rows) => A.planActs(s, live, opts)
  const find = (p: any, id: string) => p.plan.find((x: any) => x.sessionId === id)

  it("actTargets lists the ids a plan would re-check live (selectors honoured, kept rows left out)", () => {
    const targets = A.actTargets(s, {})
    expect(targets).toContain("done1")
    expect(targets).toContain("ended1")
    expect(targets).not.toContain("keep1")
    expect(A.actTargets(s, { sessions: ["done1"] })).toEqual(["done1"])
    expect(A.actTargets(s, { only: ["mark-failed"] })).toEqual(expect.arrayContaining(["ended1"]))
    expect(A.actTargets(s, { only: ["mark-failed"] })).not.toContain("done1")
    expect(A.actTargets(s, { only: ["bogus"] })).toEqual([])
  })
  it("dry run plans, but queues nothing", () => {
    const p = plan()
    expect(find(p, "done1")).toMatchObject({ action: "mark-complete", status: "planned", tool: "session_wrapup_apply" })
    expect(Object.values(p.queues).flat()).toHaveLength(0)
  })
  it("apply fills the queues with outcome detail", () => {
    const p = plan({ apply: true })
    const w = p.queues.wrapup.find((i: any) => i.sessionId === "done1")
    expect(w).toMatchObject({ verdict: "done", judgedBy: "steward-rules", by: "steward-rules" })
    expect(w.reason).toBeTruthy()
  })
  it("a live user-origin stuck session is only flagged", () => {
    const p = plan({ apply: true })
    expect(find(p, "user1")).toMatchObject({ action: "needs-input", status: "planned" })
    expect(p.queues.wrapup.find((i: any) => i.sessionId === "user1")).toMatchObject({ verdict: "needs-input" })
  })
  it("an ended session is labelled through agent_kill's outcome, not wrapup", () => {
    const p = plan({ apply: true })
    expect(find(p, "ended1")).toMatchObject({ action: "mark-failed", tool: "agent_kill" })
    expect(p.queues.label[0]).toMatchObject({ sessionId: "ended1", outcome: { verdict: "failed" } })
  })
  it("relaunch and archive are opt-in", () => {
    const p = plan({ apply: true })
    expect(find(p, "q1")).toMatchObject({ action: "relaunch", status: "skipped" })
    expect(find(p, "q1").why).toContain("--only")
    expect(find(p, "arch1")).toMatchObject({ action: "archive", status: "skipped" })
    expect(p.queues.fresh).toHaveLength(0)
    expect(p.queues.archive).toHaveLength(0)
  })
  it("--only relaunch: quota → fresh on another profile; timeout → continue (live ⇒ prompt)", () => {
    const p = plan({ apply: true, only: "relaunch" })
    expect(p.queues.fresh[0]).toMatchObject({ sessionId: "q1", idOrName: "q1", access: { profileRef: "claude-b" } })
    expect(p.queues.prompt[0]).toMatchObject({ sessionId: "to1" })
    expect(find(p, "done1")).toMatchObject({ status: "skipped" })
  })
  it("--allow-relaunch enables relaunch without restricting the rest", () => {
    const p = plan({ apply: true, allowRelaunch: true })
    expect(p.queues.fresh).toHaveLength(1)
    expect(p.queues.wrapup.length).toBeGreaterThan(0)
  })
  it("--only archive on an ended session", () => {
    const p = plan({ apply: true, only: ["archive"] })
    expect(p.queues.archive).toEqual([{ sessionId: "arch1", idOrName: "arch1" }])
  })
  it("relaunch of an ended session continues by restart", () => {
    const endedTimeout = row({ id: "to1", status: "exited", lastTurnErroredAt: "2026-10-10T09:00:00Z", lastTurnErrorMessage: "request timed out" })
    const s2 = snap([endedTimeout], { verdicts: [], relabel: [{ sessionId: "to1", origin: "workflow", proposedVerdict: "abandoned" }] })
    const p = A.planActs(s2, [endedTimeout], { apply: true, only: "relaunch" })
    expect(p.queues.restart).toEqual([{ sessionId: "to1", idOrName: "to1" }])
  })
  it("--session narrows to the named ids", () => {
    const p = plan({ sessions: "done1" })
    expect(p.plan.map((x: any) => x.sessionId)).toEqual(["done1"])
  })
  it("--only validates action names", () => {
    expect(plan({ only: "explode" }).errors[0]).toContain('unknown action "explode"')
  })
  it("keep rows are never dispatched", () => {
    expect(find(plan({ apply: true }), "keep1")).toMatchObject({ action: "keep", status: "kept" })
  })
  it("STALE: a session that changed since the snapshot is skipped with the reason", () => {
    const live = rows.map(r => (r.id === "done1" ? { ...r, lastActivityAt: "2026-10-10T11:58:00Z", tokensOut: 400 } : r))
    const p = plan({ apply: true }, live)
    expect(find(p, "done1")).toMatchObject({ status: "skipped" })
    expect(find(p, "done1").why).toContain("changed since snapshot")
    expect(p.queues.wrapup.find((i: any) => i.sessionId === "done1")).toBeUndefined()
  })
  it("STALE: a vanished session is skipped", () => {
    const p = plan({ apply: true }, rows.filter(r => r.id !== "done1"))
    expect(find(p, "done1").why).toContain("changed since snapshot")
  })
  it("rules re-evaluated at act time: skip, override, bound by origin", () => {
    const rules = A.validateRules([
      { id: "skip-done", when: { label: "done1" }, action: "skip" },
      { id: "fail-timeouts", when: { errorKind: "timeout" }, action: "mark-failed" },
      { id: "close-user", when: { class: "stuck" }, action: "close-abandoned" },
    ], "inline")
    const p = plan({ apply: true, rules })
    expect(find(p, "done1")).toMatchObject({ action: "keep", from: "mark-complete", status: "skipped" })
    expect(find(p, "to1")).toMatchObject({ action: "mark-failed", from: "relaunch", ruleId: "fail-timeouts", status: "planned" })
    expect(find(p, "user1")).toMatchObject({ action: "needs-input" })
  })
  it("analysis detail lands on the outcome", () => {
    const withAnalysis = A.applyAnalyses(
      s,
      new Map([["done1", { action: "mark-complete", confidence: 0.95, reason: "PR merged", errorKind: "none", nextStep: "none", by: "agent" }]]),
      {},
    ).snapshot
    const p = A.planActs(withAnalysis, rows, { apply: true })
    expect(p.queues.wrapup.find((i: any) => i.sessionId === "done1")).toMatchObject({ reason: "PR merged", by: "agent" })
  })
  it("foldActResults pairs refusals with a readable reason", () => {
    const p = plan({ apply: true })
    const folded = A.foldActResults(
      p.plan,
      p.queues,
      { wrapup: [{ results: [{ sessionId: "done1", ok: false, error: "ambiguous_needs_judge" }] }], label: { results: [{ index: 0, status: "rejected", error: "boom", item: { sessionId: "ended1" } }] } },
      (e: string) => `explained ${e}`,
    )
    expect(folded.find((x: any) => x.sessionId === "done1").result).toEqual({ ok: false, text: "refused (explained ambiguous_needs_judge)" })
    expect(folded.find((x: any) => x.sessionId === "ended1").result).toEqual({ ok: false, text: "failed: boom" })
  })
  it("renders dry-run and diff", () => {
    const base = plan()
    const custom = plan({ rules: A.validateRules([{ id: "r", when: { label: "done1" }, action: "keep" }]) })
    expect(A.renderPlan("snap_test", base.plan, { apply: false })).toContain("Dry run")
    expect(A.diffPlans(base.plan, custom.plan)).toEqual([expect.objectContaining({ sessionId: "done1", before: "mark-complete/planned", after: "keep/kept" })])
  })
})

describe("analyze", () => {
  const rows = [
    row({ id: "a", lastTurnErroredAt: "2026-10-10T09:00:00Z", lastTurnErrorMessage: "request timed out" }),
    row({ id: "b" }),
    row({ id: "c" }),
    row({ id: "d" }),
  ]
  const s = snap(rows, {
    verdicts: [
      { entry: { sessionId: "a", origin: "workflow" }, verdict: "abandoned", confidence: 0.95, judgedBy: "jev:m" },
      { entry: { sessionId: "b", origin: "workflow" }, verdict: "active", confidence: 0.95 },
      { entry: { sessionId: "c", origin: "workflow" }, verdict: "active", confidence: 0.4 },
      { entry: { sessionId: "d", origin: "workflow" }, verdict: "done", confidence: 0.95 },
    ],
  })
  it("selects non-keep and low-confidence rows only, caps, and honours explicit ids", () => {
    const sel = A.selectForAnalysis(s, {})
    expect(sel.selected.map((x: any) => x.sessionId).sort()).toEqual(["a", "c", "d"])
    expect(A.selectForAnalysis(s, { maxSessions: 1 })).toMatchObject({ overflow: 2 })
    expect(A.selectForAnalysis(s, { sessions: "b" }).selected.map((x: any) => x.sessionId)).toEqual(["b"])
    expect(A.selectForAnalysis(s, { only: "relaunch" }).selected.map((x: any) => x.sessionId)).toEqual(["a"])
  })
  it("parseAnalysis is strict", () => {
    const ok = JSON.stringify({ sessionId: "a", action: "relaunch", confidence: 0.9, reason: "timed out", errorKind: "timeout", relaunchHint: { mode: "continue" } })
    expect(A.parseAnalysis(ok, "a")).toMatchObject({ action: "relaunch", errorKind: "timeout", relaunchHint: { mode: "continue" } })
    expect(A.parseAnalysis("```json\n" + ok + "\n```", "a").malformed).toBeUndefined()
    expect(A.parseAnalysis(ok, "other").malformed).toBe(true)
    expect(A.parseAnalysis("sure! " + ok, "a").malformed).toBe(true)
    expect(A.parseAnalysis(JSON.stringify({ sessionId: "a", action: "nope", confidence: 1, reason: "x" }), "a").malformed).toBe(true)
  })
  it("a confident revision changes the action and keeps the classify one; a weak one does not", () => {
    const strong = A.applyAnalyses(s, new Map([["a", { action: "mark-failed", confidence: 0.9, reason: "gave up", by: "agent" }]]), {})
    const a = strong.snapshot.sessions.find((x: any) => x.sessionId === "a")
    expect(a).toMatchObject({ action: "mark-failed", classifiedAction: "relaunch", analysis: { classifiedAction: "relaunch", by: "agent" } })
    expect(strong.revised).toBe(1)
    const weak = A.applyAnalyses(s, new Map([["a", { action: "mark-failed", confidence: 0.3, reason: "maybe" }]]), {})
    expect(weak.snapshot.sessions.find((x: any) => x.sessionId === "a").action).toBe("relaunch")
    expect(weak.revised).toBe(0)
  })
  it("a malformed reply is recorded and changes nothing", () => {
    const r = A.applyAnalyses(s, new Map([["a", { malformed: true, reason: "bad" }]]), {})
    expect(r.snapshot.sessions.find((x: any) => x.sessionId === "a")).toMatchObject({ action: "relaunch", analysisError: "bad" })
    expect(r.analyzed).toBe(0)
  })
  it("a revised action is still origin-bounded", () => {
    const u = snap([row({ id: "u", origin: undefined })], { verdicts: [{ entry: { sessionId: "u" }, verdict: "done", confidence: 0.95 }] })
    const r = A.applyAnalyses(u, new Map([["u", { action: "close-abandoned", confidence: 0.99, reason: "x" }]]), {})
    expect(r.snapshot.sessions[0].action).toBe("needs-input")
  })
  it("the heuristic (jev) analysis fills reason, errorKind and a hint without an LLM", () => {
    const a = s.sessions.find((x: any) => x.sessionId === "a")
    const h = A.heuristicAnalysis(a, { lastTurnError: "request timed out" })
    expect(h).toMatchObject({ action: "relaunch", errorKind: "timeout" })
    expect(h.reason).toContain("transient timeout")
  })
})
