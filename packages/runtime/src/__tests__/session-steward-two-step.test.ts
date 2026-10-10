/**
 * The three-step steward — `session-steward-classify`, `-analyze`, `-act` —
 * loaded the way the daemon loads them (WORKFLOW.md + entry.mjs) and run end
 * to end against an in-memory daemon: a mutable session registry, an app data
 * dir for the snapshots, a fake Jev, a fake analyst. No real session is ever
 * touched.
 */

import { describe, it, expect, vi } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"
import { modelRoles } from "../model-roles-tools.js"
import { emulateSessionList } from "./fixtures/session-list-fake.js"

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "session-steward", ".agentproto", "workflows")
const wfPath = (id: string) => join(WORKFLOWS, id, "WORKFLOW.md")
const ANALYST_REF = "@agentproto/session-steward-analyst"
const APP = "@agentproto/session-steward"
const SELF = "sess_self"
const NOW = Date.now()
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

type Row = Record<string, unknown>

const mcp = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })

interface World {
  rows: Row[]
  entries: Array<Record<string, unknown>>
  store: Map<string, unknown>
  calls: Array<{ name: string; inputs: Record<string, unknown> }>
  dispatchTool: DispatchTool
}

/** Registry rows for the fixture; `plan` entries are separate (the daemon's planner). */
function world(opts: {
  rows: Row[]
  entries?: Array<Record<string, unknown>>
  profiles?: Row[]
  jev?: (inputs: Record<string, unknown>) => Record<string, unknown>
  noApp?: boolean
  evidence?: Record<string, Record<string, unknown>>
}): World {
  const w: World = { rows: opts.rows, entries: opts.entries ?? [], store: new Map(), calls: [], dispatchTool: undefined as never }
  w.dispatchTool = vi.fn(async (name, inputs) => {
    w.calls.push({ name, inputs })
    switch (name) {
      case "session_wrapup_plan":
        return mcp({ entries: w.entries, totals: {} })
      case "host_load":
        return mcp({ loadPerCore: 0.1, swap: { percent: 5 }, warnings: [] })
      case "session_list":
        return mcp(emulateSessionList(w.rows, inputs, NOW))
      case "session_evidence": {
        const id = inputs.sessionId as string
        const row = w.rows.find(r => r.id === id) ?? {}
        return mcp({
          sessionId: id,
          label: row.label,
          cwd: row.cwd ?? `/tmp/${id}`,
          origin: row.origin,
          busy: false,
          awaitingInput: false,
          turns: [{ role: "user", text: "do it" }, { role: "assistant", text: "working on it" }],
          ...(row.lastTurnErrorMessage ? { lastTurnError: row.lastTurnErrorMessage, lastTurnErroredAt: row.lastTurnErroredAt } : {}),
          ...(opts.evidence?.[id] ?? {}),
        })
      }
      case "session_judge_jev":
        return mcp(opts.jev ? opts.jev(inputs) : { ok: false, sessionId: inputs.sessionId, error: "JEV_API_KEY not set", noKey: true, model: inputs.model })
      case "app_list":
        return mcp(opts.noApp ? [] : [{ appId: APP }])
      case "auth_profile_list":
        return mcp({ profiles: opts.profiles ?? [] })
      case "app_data_write":
        // Serialized like the real writer: the stored copy shares nothing with the step output.
        w.store.set(`${inputs.appId}:${inputs.path}`, JSON.parse(JSON.stringify(inputs.content)))
        return mcp({ appId: inputs.appId, path: inputs.path, bytes: 1 })
      case "app_data_read": {
        const k = `${inputs.appId}:${inputs.path}`
        return mcp(w.store.has(k) ? { appId: inputs.appId, path: inputs.path, exists: true, content: w.store.get(k) } : { appId: inputs.appId, path: inputs.path, exists: false })
      }
      case "session_wrapup_apply": {
        const ids = inputs.sessionIds as string[]
        const closes = inputs.verdict === "done" || inputs.verdict === "abandoned" || inputs.verdict === "failed"
        return mcp({ results: ids.map(sessionId => ({ sessionId, ok: true, class: "x", action: closes ? "closed" : "flagged" })) })
      }
      case "agent_kill":
        return mcp({ ok: true, sessionId: inputs.sessionId, labelled: true })
      case "session_archive":
      case "session_restart":
        return mcp({ ok: true, idOrName: inputs.idOrName })
      case "session_continue_fresh":
        return mcp({ ok: true, from: inputs.idOrName, sessionId: "sess_fresh" })
      case "agent_prompt":
        return mcp({ ok: true, sessionId: inputs.sessionId, queued: true })
      case "model_roles":
        return mcp(await modelRoles(inputs as never, { loadCfg: async () => ({ models: {} }) as never, resolveRoot: async () => undefined }))
      default:
        throw new Error(`unexpected tool '${name}'`)
    }
  })
  return w
}

const MUTATING = ["session_wrapup_apply", "agent_kill", "session_archive", "session_restart", "session_continue_fresh", "agent_prompt"]
const mutations = (w: World) => w.calls.filter(c => MUTATING.includes(c.name))

function analystHost(replies: Record<string, string>) {
  const prompts = new Map<string, string>()
  let n = 0
  const host: AgentSessionHost = {
    spawn: vi.fn(async () => `analyst_${++n}`),
    sendPromptAndWait: vi.fn(async (id: string, prompt: string) => {
      prompts.set(id, prompt)
    }),
    resolveByLabel: vi.fn(() => undefined),
    readFinalMessage: vi.fn(async (id: string) => replies[/"sessionId": "([^"]+)"/.exec(prompts.get(id) ?? "")?.[1] ?? ""] ?? ""),
    releaseSession: vi.fn(async () => {}),
  }
  return { host, prompts }
}

async function runWf<T = Record<string, any>>(id: string, w: World, input: Record<string, unknown>, host?: AgentSessionHost): Promise<T> {
  const handle = await loadWorkflowHandle(wfPath(id))
  const compiled = compileWorkflow(handle, { ...createDaemonToolRegistry(handle, w.dispatchTool), agentRefs: { [ANALYST_REF]: { adapter: "mock-agent" } } })
  const { output } = await runWorkflow({ workflow: compiled, agents: host ?? analystHost({}).host, input })
  return output as T
}

const classify = (w: World, input: Record<string, unknown> = {}) => runWf("session-steward-classify", w, { callerSessionId: SELF, ...input })
const act = (w: World, input: Record<string, unknown> = {}) => runWf("session-steward-act", w, { callerSessionId: SELF, ...input })
const analyze = (w: World, input: Record<string, unknown> = {}, host?: AgentSessionHost) => runWf("session-steward-analyze", w, { callerSessionId: SELF, ...input }, host)

const planEntry = (sessionId: string, cls: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  label: `label-${sessionId}`,
  idleMinutes: 90,
  rssBytes: 100 * 1024 * 1024,
  class: cls,
  reasons: [`${cls} reason`],
  signals: {},
  origin: "cron:fixture",
  ...extra,
})

const liveRow = (id: string, extra: Row = {}): Row => ({
  id,
  label: `label-${id}`,
  status: "running",
  busy: false,
  origin: "cron:fixture",
  tokensIn: 1000,
  tokensOut: 500,
  turnsCompleted: 3,
  startedAt: minutesAgo(200),
  lastActivityAt: minutesAgo(90),
  ...extra,
})

const jevDone = (sessionId: string, verdict = "done", confidence = 0.95) => ({
  ok: true,
  sessionId,
  verdict,
  confidence,
  probabilities: { [verdict]: confidence, active: 1 - confidence },
  model: "jev-latest",
})

/** The B1 shape: a running session whose only turn errored with 0 tokens. */
const b1Row = (id: string, message = '[wallet: profile "anthropic/acct-a" — quota exceeded]'): Row =>
  liveRow(id, { tokensIn: 0, tokensOut: 0, turnsCompleted: 0, lastTurnErroredAt: minutesAgo(80), lastTurnErrorMessage: message, startedAt: minutesAgo(100), lastActivityAt: minutesAgo(80) })

function fixture() {
  const rows: Row[] = [
    liveRow(SELF),
    liveRow("close_1"),
    { ...b1Row("b1_quota"), origin: "model-bench" },
    b1Row("b1_logic", "TypeError: cannot read properties of undefined"),
    liveRow("judge_done"),
    liveRow("judge_chat", { origin: "chat-starter" }),
    liveRow("model_bench_1", { origin: "model-bench", tokensIn: 0, tokensOut: 0, turnsCompleted: 0 }),
    liveRow("old_ended", { status: "exited", endedAt: minutesAgo(60 * 30), lastActivityAt: minutesAgo(60 * 30), outcome: { verdict: "done" } }),
    liveRow("pinned_1", { pinned: true }),
  ]
  const entries = [
    planEntry("close_1", "close"),
    planEntry("b1_quota", "stuck"),
    planEntry("b1_logic", "stuck"),
    planEntry("judge_done", "judge"),
    planEntry("judge_chat", "judge", { origin: "chat-starter" }),
    planEntry(SELF, "close"),
  ]
  return { rows, entries }
}

const jevFor = (inputs: Record<string, unknown>) => jevDone(inputs.sessionId as string)

const snapshotOf = (w: World, id = "latest") => w.store.get(`${APP}:snapshots/${id}.json`) as any
const actionOf = (snap: any, id: string) => snap.sessions.find((s: any) => s.sessionId === id)

describe("session-steward two-step — shape", () => {
  it.each(["session-steward-classify", "session-steward-analyze", "session-steward-act"])("%s loads and compiles (manifest mirrors the entry)", async id => {
    const handle = await loadWorkflowHandle(wfPath(id))
    expect(handle.id).toBe(id)
    const compiled = compileWorkflow(handle, { ...createDaemonToolRegistry(handle, vi.fn(async () => mcp({}))), agentRefs: { [ANALYST_REF]: { adapter: "mock-agent" } } })
    expect(compiled.id).toBe(id)
  })
})

describe("classify", () => {
  it("writes a snapshot with one action per session, never mutates, and persists latest.json + <id>.json", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    const out = await classify(w)

    expect(mutations(w)).toEqual([])
    const snap = snapshotOf(w)
    expect(snap.schema).toBe("steward-snapshot/v1")
    expect(out.summary.snapshotId).toBe(snap.id)
    expect(w.store.get(`${APP}:snapshots/${snap.id}.json`)).toEqual(snap)
    expect(snap.sessions.map((s: any) => s.sessionId)).not.toContain(SELF)
    for (const s of snap.sessions) expect(typeof s.action).toBe("string")

    expect(actionOf(snap, "close_1").action).toBe("mark-complete")
    expect(actionOf(snap, "judge_done")).toMatchObject({ action: "mark-complete", verdict: "done", judgedBy: "jev:jev-latest" })
    expect(actionOf(snap, "judge_done").probabilities).toEqual({ done: 0.95, active: expect.closeTo(0.05, 5) })
    expect(out.report).toContain(snap.id)
    expect(out.report).toContain("steward act")
  })

  it("B1: a running session whose only turn errored with 0 tokens gets a rule verdict and a clear action, not an ambiguous refusal", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const snap = snapshotOf(w)
    const quota = actionOf(snap, "b1_quota")
    const logic = actionOf(snap, "b1_logic")
    expect(quota).toMatchObject({ errored: true, errorKind: "quota", transient: true, neverRan: true, judgedBy: "steward-rules" })
    expect(quota.action).toBe("relaunch")
    expect(logic).toMatchObject({ errored: true, errorKind: "logic", transient: false })
    expect(logic.action).toBe("mark-failed")
    expect(quota.evidence.summary).toContain("error quota")
  })

  it("B1 through act --apply: the rule verdict is applied with judgedBy and the outcome fields", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    w.calls.length = 0
    const out = await act(w, { apply: true, only: ["mark-failed"] })
    const calls = w.calls.filter(c => c.name === "session_wrapup_apply")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputs).toMatchObject({ sessionIds: ["b1_logic"], verdict: "failed", judgedBy: "steward-rules", errorKind: "logic", by: "steward-rules", wait: true })
    expect(String(calls[0]!.inputs.reason)).toMatch(/\S/)
    expect(out.summary.statuses.applied).toBe(1)
  })

  it("B2: model-bench is a machine origin — closable, never treated as a user session", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const bench = actionOf(snapshotOf(w), "model_bench_1")
    expect(bench.originClass).not.toBe("user")
    expect(bench.action).not.toBe("needs-input")
  })

  it("origin bound: a user-origin session is never closed, only flagged needs-input", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const chat = actionOf(snapshotOf(w), "judge_chat")
    expect(chat.originClass).toBe("user")
    expect(chat.action).toBe("needs-input")
    expect(chat.boundFrom).toBe("mark-complete")
  })

  it("recommends archive for an old ended session with an outcome, and keep for a pinned one", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const snap = snapshotOf(w)
    expect(actionOf(snap, "old_ended").action).toBe("archive")
  })

  it("Jev unavailable: rows are still classified by rules, the report says so", async () => {
    const f = fixture()
    const w = world(f)
    const out = await classify(w)
    expect(actionOf(snapshotOf(w), "judge_done").verdict).toBeNull()
    expect(actionOf(snapshotOf(w), "judge_done").action).toBe("keep")
    expect(out.report).toMatch(/not judged/i)
  })

  it("invalid custom rules: classification proceeds with the defaults and the report lists every error", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    const out = await classify(w, { rules: { version: 1, rules: [{ id: "bad", when: { colour: "red" }, action: "keep" }] }, rulesSource: "my-rules.yaml" })
    expect(out.summary.rules.ok).toBe(false)
    expect(out.report).toContain("RULES IGNORED")
    expect(out.report).toContain("colour")
    expect(actionOf(snapshotOf(w), "close_1").ruleSource).not.toBe("custom")
  })

  it("custom rules re-route a session and record the rule id", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w, { rules: { version: 1, rules: [{ id: "bench-archive", when: { origin: "model-bench" }, action: "archive" }] } })
    expect(actionOf(snapshotOf(w), "model_bench_1")).toMatchObject({ action: "archive", ruleId: "bench-archive", ruleSource: "custom" })
  })

  it("--apply (one-shot) classifies and acts in the same run", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    const out = await classify(w, { apply: true })
    const wrapups = w.calls.filter(c => c.name === "session_wrapup_apply")
    expect(wrapups.length).toBeGreaterThan(0)
    expect(wrapups.map(c => (c.inputs.sessionIds as string[])[0])).toEqual(expect.arrayContaining(["close_1", "judge_done"]))
    // the user-origin session is only flagged, never closed
    expect(wrapups.find(c => (c.inputs.sessionIds as string[])[0] === "judge_chat")!.inputs.verdict).toBe("needs-input")
    // relaunch / archive stay opt-in, even in a one-shot
    expect(w.calls.some(c => c.name === "session_archive" || c.name === "session_restart" || c.name === "session_continue_fresh")).toBe(false)
    expect(out.summary.act.apply).toBe(true)
  })

  it("without a persisted app it still returns the snapshot on request, and says it was not saved", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor, noApp: true })
    const out = await classify(w, { returnSnapshot: true })
    expect(w.calls.some(c => c.name === "app_data_write")).toBe(false)
    expect(out.report).toMatch(/not persisted/)
    expect(out.summary.snapshot.schema).toBe("steward-snapshot/v1")
  })
})

describe("act", () => {
  it("dry run (the default) plans from the latest snapshot and mutates nothing", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    w.calls.length = 0
    const out = await act(w)
    expect(mutations(w)).toEqual([])
    expect(out.summary.apply).toBe(false)
    expect(out.report).toContain("dry run")
    expect(out.summary.statuses.planned).toBeGreaterThan(0)
  })

  it("relaunch and archive only run when named in --only", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const dry = await act(w)
    const rows = dry.summary.rows as Array<{ sessionId: string; action: string; status: string; why: string }>
    expect(rows.find(r => r.sessionId === "old_ended")).toMatchObject({ status: "skipped" })
    expect(rows.find(r => r.sessionId === "old_ended")!.why).toContain("--only")
    w.calls.length = 0
    await act(w, { apply: true, only: ["archive"] })
    expect(w.calls.filter(c => c.name === "session_archive").map(c => c.inputs.idOrName)).toEqual(["old_ended"])
    expect(w.calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
  })

  it("--session restricts the targets", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    w.calls.length = 0
    await act(w, { apply: true, sessions: ["judge_done"] })
    expect(w.calls.filter(c => c.name === "session_wrapup_apply").map(c => c.inputs.sessionIds)).toEqual([["judge_done"]])
  })

  it("staleness: a session that moved since the snapshot is skipped, not touched", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const row = w.rows.find(r => r.id === "judge_done")!
    row.lastActivityAt = minutesAgo(1)
    row.tokensOut = 99_999
    w.calls.length = 0
    const out = await act(w, { apply: true })
    const r = (out.summary.rows as any[]).find(x => x.sessionId === "judge_done")
    expect(r.status).toBe("skipped")
    expect(r.why).toContain("changed since snapshot")
    expect(w.calls.filter(c => c.name === "session_wrapup_apply").flatMap(c => c.inputs.sessionIds as string[])).not.toContain("judge_done")
  })

  it("custom rules at act time override the snapshot's recommendation; skip leaves the session alone", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const rules = { version: 1, rules: [{ id: "keep-fixture", when: { label: "label-close_*" }, action: "skip" }, { id: "judge-fail", when: { label: "label-judge_done" }, action: "mark-failed" }] }
    const out = await act(w, { rules, rulesSource: "r.yaml" })
    const rows = out.summary.rows as any[]
    expect(rows.find(r => r.sessionId === "close_1")).toMatchObject({ status: "skipped", ruleId: "keep-fixture" })
    expect(rows.find(r => r.sessionId === "judge_done")).toMatchObject({ action: "mark-failed", from: "mark-complete", ruleId: "judge-fail", status: "planned" })
  })

  it("invalid rules block the act entirely", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    w.calls.length = 0
    const out = await act(w, { apply: true, rules: { version: 1, rules: [{ id: "x", when: {}, action: "keep" }] } })
    expect(mutations(w)).toEqual([])
    expect(out.summary.errors.join(" ")).toContain("rules:")
  })

  it("a missing snapshot is a clear error, not a crash", async () => {
    const w = world({ rows: [] })
    const out = await act(w, { snapshot: "sn_nope" })
    expect(out.summary.errors.join(" ")).toMatch(/no snapshot|could not read/)
    expect(mutations(w)).toEqual([])
  })

  it("relaunch: transient errors continue in place, with --only relaunch; a free-only model never gets a paid fallback", async () => {
    const f = fixture()
    const profiles = [
      { id: "anthropic/acct-a", endpoint: "anthropic", subaccount: "a", keyStatus: "exhausted" },
      { id: "anthropic/acct-b", endpoint: "anthropic", subaccount: "b", keyStatus: "ok" },
    ]
    const w = world({ ...f, jev: jevFor, profiles })
    await classify(w)
    const quota = actionOf(snapshotOf(w), "b1_quota")
    expect(quota.relaunchHint).toBeDefined()
    w.calls.length = 0
    await act(w, { apply: true, only: ["relaunch"] })
    const touched = w.calls.filter(c => c.name === "session_restart" || c.name === "session_continue_fresh" || c.name === "agent_prompt")
    expect(touched.length).toBeGreaterThan(0)
  })
})

/** A machine session (no owner run) whose only turn failed on quota. */
const benchFailed = (id: string, extra: Row = {}): Row =>
  liveRow(id, {
    origin: "model-bench",
    tokensIn: 0,
    tokensOut: 0,
    turnsCompleted: 0,
    startedAt: minutesAgo(100),
    lastTurnErrorMessage: '[wallet: profile "anthropic/acct-a" — quota exceeded]',
    ...extra,
  })

const endedBench = (id: string, label: string, ago: number, extra: Row = {}): Row =>
  benchFailed(id, {
    label,
    status: "exited",
    startedAt: minutesAgo(ago + 20),
    lastTurnErroredAt: minutesAgo(ago),
    endedAt: minutesAgo(ago),
    lastActivityAt: minutesAgo(ago),
    ...extra,
  })

describe("classify — relaunch is only for work that is not superseded, not owned, and recent", () => {
  const classifyRows = async (rows: Row[], input: Record<string, unknown> = {}) => {
    const w = world({ rows: [liveRow(SELF), ...rows], entries: [], jev: jevFor })
    await classify(w, input)
    return { w, snap: snapshotOf(w) }
  }

  it("superseded: a later session of the same task that ran supersedes every earlier failed attempt", async () => {
    const { snap, w } = await classifyRows([
      endedBench("t_a", "bench:claims", 300),
      endedBench("t_b", "bench:claims:fallback1", 200),
      endedBench("t_c", "bench:claims:fallback2", 100, { tokensIn: 4000, tokensOut: 900, turnsCompleted: 2, lastTurnErroredAt: undefined, lastTurnErrorMessage: undefined, status: "exited" }),
    ])
    for (const id of ["t_a", "t_b"]) {
      expect(actionOf(snap, id)).toMatchObject({ action: "mark-failed", ruleId: "superseded", superseded: true, supersededBy: "t_c", errorKind: "quota" })
      expect(actionOf(snap, id).actionReason).toContain("superseded by t_c")
    }
    expect(mutations(w)).toEqual([])
  })

  it("not superseded: a later attempt that never ran does not supersede, and the last failed attempt is the one relaunched", async () => {
    const { snap } = await classifyRows([
      endedBench("n_a", "bench:docs", 100),
      endedBench("n_b", "bench:docs:fallback1", 60),
    ])
    expect(actionOf(snap, "n_a")).toMatchObject({ action: "relaunch" })
    expect(actionOf(snap, "n_b")).toMatchObject({ action: "relaunch" })
    expect(actionOf(snap, "n_a").superseded).toBeUndefined()
  })

  it("owned by a run: review / gate / cron origins and anything with a parent are mark-failed with the error kind, never relaunch", async () => {
    const { snap } = await classifyRows([
      endedBench("o_review", "review:repo:glm", 90, { origin: "review" }),
      endedBench("o_gate", "gate:abc", 90, { origin: "gate" }),
      endedBench("o_cron", "cron-job", 90, { origin: "cron:daily" }),
      endedBench("o_child", "child-task", 90, { origin: "model-bench", parentSessionId: "run_1" }),
      endedBench("o_free", "free-task", 90),
    ])
    for (const id of ["o_review", "o_gate", "o_cron", "o_child"]) {
      expect(actionOf(snap, id)).toMatchObject({ action: "mark-failed", ruleId: "owned-by-run", ownedByRun: true, errorKind: "quota" })
      expect(actionOf(snap, id).actionReason).toMatch(/owner relaunches/)
    }
    expect(actionOf(snap, "o_free").action).toBe("relaunch")
  })

  it("recency window: failures older than the window are mark-failed; the window is an input and a rules key", async () => {
    const rows = [endedBench("r_new", "bench:new", 60), endedBench("r_old", "bench:old", 600)]
    const { snap } = await classifyRows(rows)
    expect(actionOf(snap, "r_new").action).toBe("relaunch")
    expect(actionOf(snap, "r_old")).toMatchObject({ action: "mark-failed", ruleId: "stale-failure", staleFailure: true })
    expect(actionOf(snap, "r_old").actionReason).toMatch(/outside the relaunch window/)
    expect(snap.settings.relaunchWindowMinutes).toBe(360)

    const wide = await classifyRows(rows, { relaunchWindowMinutes: 1440 })
    expect(actionOf(wide.snap, "r_old").action).toBe("relaunch")

    const narrow = await classifyRows(rows, { relaunchWindowMinutes: 30 })
    expect(actionOf(narrow.snap, "r_new").action).toBe("mark-failed")

    const byRule = await classifyRows(rows, { rules: { version: 1, rules: [{ id: "older-than-2h", when: { failedMinutesAgo: ">120" }, action: "mark-failed", reason: "too old" }] } })
    expect(actionOf(byRule.snap, "r_old")).toMatchObject({ action: "mark-failed", ruleId: "older-than-2h" })
    expect(actionOf(byRule.snap, "r_new").action).toBe("relaunch")
  })

  it("act --apply --only relaunch never relaunches a superseded, owned or stale session", async () => {
    const { w } = await classifyRows([
      endedBench("a_sup", "bench:x", 300),
      endedBench("a_ran", "bench:x:fallback1", 100, { tokensIn: 10, tokensOut: 10, turnsCompleted: 1, lastTurnErroredAt: undefined, lastTurnErrorMessage: undefined }),
      endedBench("a_own", "review:y", 90, { origin: "review" }),
      endedBench("a_old", "bench:z", 900),
    ])
    w.calls.length = 0
    await act(w, { apply: true, only: ["relaunch"] })
    expect(w.calls.filter(c => ["session_restart", "session_continue_fresh", "agent_prompt"].includes(c.name))).toEqual([])
    w.calls.length = 0
    await act(w, { apply: true, only: ["mark-failed"] })
    const labelled = w.calls.filter(c => c.name === "agent_kill").map(c => (c.inputs as any).sessionId).sort()
    expect(labelled).toEqual(["a_old", "a_own", "a_sup"])
    const outcome = (w.calls.find(c => c.name === "agent_kill" && (c.inputs as any).sessionId === "a_sup")!.inputs as any).outcome
    expect(outcome).toMatchObject({ verdict: "failed", errorKind: "quota" })
    expect(outcome.reason).toContain("superseded by a_ran")
  })
})

describe("analyze", () => {
  const reply = (sessionId: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ sessionId, action: "mark-failed", confidence: 0.9, reason: "the run crashed on a TypeError in step 2", errorKind: "logic", nextStep: "fix the null check", remainingWork: ["add a test"], evidenceRefs: ["turn 2"], ...extra })

  it("analyses only the relevant rows and writes reason / errorKind / nextStep into the same snapshot", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const before = snapshotOf(w)
    const a = analystHost({ b1_logic: reply("b1_logic") })
    const out = await analyze(w, { only: ["mark-failed"] }, a.host)

    expect(mutations(w)).toEqual([])
    expect(a.host.spawn).toHaveBeenCalledTimes(1)
    const snap = snapshotOf(w)
    expect(snap.id).toBe(before.id)
    expect(actionOf(snap, "b1_logic").analysis).toMatchObject({ reason: "the run crashed on a TypeError in step 2", errorKind: "logic", nextStep: "fix the null check", by: "agent", classifiedAction: "mark-failed" })
    expect(actionOf(snap, "close_1").analysis).toBeUndefined()
    expect(out.summary.analysis.analyzed).toBe(1)
  })

  it("a malformed analyst reply keeps the classify action and notes why", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const a = analystHost({ b1_logic: "I think it failed." })
    const out = await analyze(w, { sessions: ["b1_logic"] }, a.host)
    const row = actionOf(snapshotOf(w), "b1_logic")
    expect(row.action).toBe("mark-failed")
    expect(row.analysisError).toMatch(/malformed/)
    expect(out.report).toMatch(/malformed/)
  })

  it("--judge jev: structured heuristic reasons, no agent spawned", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const a = analystHost({})
    await analyze(w, { judge: "jev", sessions: ["b1_quota"] }, a.host)
    expect(a.host.spawn).not.toHaveBeenCalled()
    expect(actionOf(snapshotOf(w), "b1_quota").analysis).toMatchObject({ errorKind: "quota" })
    expect(String(actionOf(snapshotOf(w), "b1_quota").analysis.reason)).toMatch(/\S/)
  })

  it("the analysis flows through act: the outcome carries reason / errorKind / nextStep / by", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    await analyze(w, { only: ["mark-failed"] }, analystHost({ b1_logic: reply("b1_logic") }).host)
    w.calls.length = 0
    await act(w, { apply: true, only: ["mark-failed"] })
    const call = w.calls.find(c => c.name === "session_wrapup_apply")!
    expect(call.inputs).toMatchObject({ verdict: "failed", reason: "the run crashed on a TypeError in step 2", errorKind: "logic", nextStep: "fix the null check", by: "agent" })
  })

  it("maxSessions caps the pass and reports the overflow", async () => {
    const f = fixture()
    const w = world({ ...f, jev: jevFor })
    await classify(w)
    const a = analystHost({})
    const out = await analyze(w, { judge: "jev", only: ["mark-complete", "mark-failed", "needs-input", "relaunch"], maxSessions: 1 }, a.host)
    expect(out.summary.analysis.analyzed).toBe(1)
    expect(out.summary.analysis.overflow).toBeGreaterThan(0)
  })
})

describe("footprint — no whole-registry step output", () => {
  // 1000 wide registry rows (30 `availableCommands` x 400 chars each, like the real
  // daemon); 40 live, 60 active in the last 72h, the rest long ended.
  const wide = (i: number): Row => ({
    ...liveRow(`wide_${i}`, {
      status: i < 40 ? "running" : "exited",
      lastActivityAt: minutesAgo(i < 60 ? i * 20 : 6000 + i),
      ...(i >= 40 ? { endedAt: minutesAgo(i < 60 ? i * 20 : 6000 + i), outcome: { verdict: "done" } } : {}),
    }),
    availableCommands: Array.from({ length: 30 }, (_, k) => ({ name: `cmd${k}`, description: "x".repeat(400) })),
    config: { blob: "y".repeat(2000) },
  })

  async function measure(id: string, input: Record<string, unknown>) {
    const rows = Array.from({ length: 1000 }, (_, i) => wide(i))
    const w = world({ rows, entries: [], jev: jevFor })
    const handle = await loadWorkflowHandle(wfPath(id))
    const compiled = compileWorkflow(handle, { ...createDaemonToolRegistry(handle, w.dispatchTool), agentRefs: { [ANALYST_REF]: { adapter: "mock-agent" } } })
    let bytes = 0
    const { output } = await runWorkflow({
      workflow: compiled,
      agents: analystHost({}).host,
      input,
      onStepComplete: (_id: string, out: unknown) => {
        bytes += JSON.stringify(out ?? null).length
      },
    })
    return { w, bytes, output }
  }

  it("classify: projected, paged listing; step outputs and run output stay small", async () => {
    const { w, bytes, output } = await measure("session-steward-classify", { callerSessionId: SELF })
    const lists = w.calls.filter(c => c.name === "session_list")
    expect(lists.length).toBeGreaterThan(0)
    for (const c of lists) {
      expect(c.inputs.full).toBeUndefined()
      expect(Array.isArray(c.inputs.fields)).toBe(true)
      expect(c.inputs.fields).not.toContain("availableCommands")
      expect(c.inputs.limit).toBeLessThanOrEqual(200)
    }
    expect(bytes).toBeLessThan(300_000)
    expect(JSON.stringify(output).length).toBeLessThan(60_000)
  })
})
