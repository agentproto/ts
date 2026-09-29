/**
 * Loads the REAL shipped `session-steward` app's WORKFLOW.md (+ its
 * `entry.mjs`) the way the daemon does via `workflow_run_file`, and runs it
 * end to end against a fake `dispatchTool` and a fake agent host — no live
 * daemon, no real session touched, no real judge spawned. Same pattern as
 * `repo-maintenance-workflow.test.ts`.
 */

import { describe, it, expect, vi } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"
import { judgeSessionWithJev } from "../jev-client.js"

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "session-steward",
  ".agentproto",
  "workflows",
  "session-steward",
  "WORKFLOW.md",
)

const JUDGE_REF = "@agentproto/session-steward-judge"
const MB = 1024 * 1024
const SELF = "sess_self"

interface PlanEntry {
  sessionId: string
  label?: string
  idleMinutes: number
  rssBytes?: number
  class: "close" | "stuck" | "judge" | "keep"
  reasons: string[]
  signals: Record<string, unknown>
}

const entry = (sessionId: string, cls: PlanEntry["class"], rssMB: number, extra: Partial<PlanEntry> = {}): PlanEntry => ({
  sessionId,
  label: `label-${sessionId}`,
  idleMinutes: 90,
  rssBytes: rssMB * MB,
  class: cls,
  reasons: [`${cls} reason`],
  signals: {},
  ...extra,
})

/** What the judge replies, per candidate session id. */
type Replies = Record<string, string>
const verdict = (sessionId: string, v: string, confidence: number, reason = `because ${v}`): string =>
  JSON.stringify({ sessionId, verdict: v, confidence, reason })

function mcpResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

function fakeTools(opts: {
  entries: PlanEntry[]
  keepAlive?: Set<string>
  /** session id → newest assistant text seen by a SECOND session_evidence read (the ask). */
  askReplies?: Record<string, string>
  /** `session_judge_jev`'s answer; default = no key configured. */
  jev?: (inputs: Record<string, unknown>) => Promise<unknown>
}) {
  const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
  const evidenceReads = new Map<string, number>()
  const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
    calls.push({ name, inputs })
    if (name === "session_wrapup_plan") return mcpResult({ entries: opts.entries, totals: {} })
    if (name === "session_evidence") {
      const id = inputs.sessionId as string
      const n = (evidenceReads.get(id) ?? 0) + 1
      evidenceReads.set(id, n)
      const askText = n > 1 ? opts.askReplies?.[id] : undefined
      return mcpResult({
        sessionId: id,
        label: `label-${id}`,
        cwd: `/tmp/${id}`,
        status: "running",
        keepAlive: opts.keepAlive?.has(id) ?? false,
        awaitingInput: false,
        busy: false,
        turns: [
          { role: "user", text: "do the thing" },
          { role: "assistant", text: askText ?? "working on it" },
        ],
      })
    }
    if (name === "session_wrapup_apply") {
      const ids = inputs.sessionIds as string[]
      const closes = inputs.verdict === "done" || inputs.verdict === "abandoned"
      return mcpResult({ results: ids.map(sessionId => ({ sessionId, ok: true, class: "x", action: closes ? "closed" : "flagged" })) })
    }
    if (name === "session_judge_jev") {
      return mcpResult(
        opts.jev
          ? await opts.jev(inputs)
          : { ok: false, sessionId: inputs.sessionId, error: "JEV_API_KEY not set", noKey: true, model: inputs.model },
      )
    }
    if (name === "agent_prompt") return mcpResult({ ok: true, sessionId: inputs.sessionId, queued: true })
    if (name === "session_monitor") return mcpResult({ sessionId: inputs.sessionId, event: "turn-end", source: "bus" })
    throw new Error(`unexpected tool '${name}'`)
  })
  return { dispatchTool, calls }
}

/** A judge host: every spawn is a judge; its reply is picked by the
 *  candidate session id quoted in the prompt. Records spawns, prompts and
 *  releases. */
function judgeHost(replies: Replies) {
  const spawns: Array<{ id: string; model?: string; cwd?: string }> = []
  const prompts = new Map<string, string>()
  const released: string[] = []
  const host: AgentSessionHost = {
    spawn: vi.fn(async (_adapter, o) => {
      const id = `judge_${spawns.length + 1}`
      spawns.push({ id, model: (o as { harness?: { model?: string } }).harness?.model, cwd: (o as { cwd?: string }).cwd })
      return id
    }),
    sendPromptAndWait: vi.fn(async (sessionId: string, prompt: string) => {
      prompts.set(sessionId, prompt)
    }),
    resolveByLabel: vi.fn(() => undefined),
    readFinalMessage: vi.fn(async (sessionId: string) => {
      const candidate = /"sessionId": "([^"]+)"/.exec(prompts.get(sessionId) ?? "")?.[1] ?? ""
      return replies[candidate] ?? ""
    }),
    releaseSession: vi.fn(async (sessionId: string) => {
      released.push(sessionId)
    }),
  }
  const candidateOf = (judgeId: string) => /"sessionId": "([^"]+)"/.exec(prompts.get(judgeId) ?? "")?.[1]
  return { host, spawns, prompts, released, candidateOf }
}

async function run(dispatchTool: DispatchTool, host: AgentSessionHost, input: Record<string, unknown>) {
  const handle = await loadWorkflowHandle(WORKFLOW_PATH)
  const compiled = compileWorkflow(handle, {
    ...createDaemonToolRegistry(handle, dispatchTool),
    agentRefs: { [JUDGE_REF]: { adapter: "mock-agent" } },
  })
  const { output } = await runWorkflow({ workflow: compiled, agents: host, input })
  return output as {
    report: string
    apply: boolean
    candidates: { close: PlanEntry[]; stuck: PlanEntry[]; judge: PlanEntry[]; judgeOverflow: PlanEntry[] }
    verdicts: Array<{ entry: PlanEntry; verdict: string; confidence: number; reason: string; source: string; malformed?: boolean }>
  }
}

/** The shared fixture: every class, the caller's own session in two classes,
 *  and judge candidates covering confident / malformed / keepAlive / low. */
function fixture() {
  const entries: PlanEntry[] = [
    entry("close_1", "close", 200, { reasons: ["idle 90m", "worktree merged"] }),
    entry("stuck_1", "stuck", 10),
    entry("keep_1", "keep", 500),
    entry(SELF, "close", 300),
    entry(SELF, "judge", 300),
    entry("done_hi", "judge", 250),
    entry("malformed", "judge", 240),
    entry("keepalive_active", "judge", 230),
    entry("keepalive_done", "judge", 220),
    entry("blocked_hi", "judge", 210),
    entry("abandoned_lo", "judge", 150),
  ]
  const replies: Replies = {
    [SELF]: verdict(SELF, "done", 1),
    done_hi: verdict("done_hi", "done", 0.95, "PR #7 merged, final report given"),
    malformed: "I think this one is done, probably.",
    keepalive_active: verdict("keepalive_active", "active", 0.3),
    keepalive_done: verdict("keepalive_done", "done", 0.9, "task finished"),
    blocked_hi: verdict("blocked_hi", "blocked", 0.9, "waiting on CI"),
    abandoned_lo: verdict("abandoned_lo", "abandoned", 0.5),
  }
  return { entries, replies, keepAlive: new Set(["keepalive_active", "keepalive_done"]) }
}

describe("session-steward workflow — shape", () => {
  it("loads and compiles with the expected top-level step sequence", async () => {
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    expect(handle.id).toBe("session-steward")
    expect(handle.steps.map(s => `${s.id}:${s.kind}`)).toEqual([
      "settings:transform",
      "plan:tool",
      "candidates:transform",
      "ruleApplyQueue:transform",
      "autoApply:map",
      "evidence:map",
      "judgeQueue:transform",
      "jevQueue:transform",
      "jevJudge:map",
      "agentJudgeQueue:transform",
      "judge:map",
      "verdicts:transform",
      "askQueue:transform",
      "ask:map",
      "finalVerdicts:transform",
      "judgedApplyQueue:transform",
      "judgedApply:map",
      "report:transform",
    ])
    const compiled = compileWorkflow(handle, {
      ...createDaemonToolRegistry(handle, vi.fn(async () => mcpResult({}))),
      agentRefs: { [JUDGE_REF]: { adapter: "mock-agent" } },
    })
    expect(compiled.id).toBe("session-steward")
  })
})

describe("session-steward workflow — run (fake tools + fake judge)", () => {
  it("dry run (the default): plans and judges, but mutates nothing", async () => {
    const f = fixture()
    const { dispatchTool, calls } = fakeTools({ entries: f.entries, keepAlive: f.keepAlive })
    const j = judgeHost(f.replies)
    const out = await run(dispatchTool, j.host, { callerSessionId: SELF })

    expect(out.apply).toBe(false)
    expect(calls.find(c => c.name === "session_wrapup_plan")!.inputs).toEqual({ idleMinutes: 30 })
    // Nothing mutating is ever dispatched.
    expect(calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
    expect(calls.some(c => c.name === "agent_prompt")).toBe(false)
    // Judges still ran (one per judge candidate, caller excluded), on haiku,
    // and every judge session was released after its turn.
    expect(j.spawns).toHaveLength(6)
    expect(new Set(j.spawns.map(s => s.model))).toEqual(new Set(["claude-haiku-4-5-20251001"]))
    expect(j.released.sort()).toEqual(j.spawns.map(s => s.id).sort())
    expect(out.report).toContain("dry run")
    expect(out.report).toContain("none (dry run)")
  })

  it("never makes the caller's own session or a keep-class session a candidate", async () => {
    const f = fixture()
    const { dispatchTool, calls } = fakeTools({ entries: f.entries, keepAlive: f.keepAlive })
    const j = judgeHost(f.replies)
    const out = await run(dispatchTool, j.host, { apply: true, callerSessionId: SELF })

    const all = [...out.candidates.close, ...out.candidates.stuck, ...out.candidates.judge].map(e => e.sessionId)
    expect(all).not.toContain(SELF)
    expect(all).not.toContain("keep_1")
    expect([...j.prompts.keys()].map(j.candidateOf)).not.toContain(SELF)
    const touched = calls.filter(c => c.name === "session_wrapup_apply").flatMap(c => c.inputs.sessionIds as string[])
    expect(touched).not.toContain(SELF)
    expect(touched).not.toContain("keep_1")
    expect(calls.filter(c => c.name === "session_evidence").map(c => c.inputs.sessionId)).not.toContain(SELF)
  })

  it("apply: rules close close/stuck; confident verdicts close or flag; malformed / low / active are left alone", async () => {
    const f = fixture()
    const { dispatchTool, calls } = fakeTools({ entries: f.entries, keepAlive: f.keepAlive })
    const j = judgeHost(f.replies)
    const out = await run(dispatchTool, j.host, { apply: true, callerSessionId: SELF })

    const applies = calls.filter(c => c.name === "session_wrapup_apply").map(c => c.inputs)
    const byId = new Map(applies.map(a => [(a.sessionIds as string[])[0], a]))

    // Rules pass — no judgedBy.
    expect(byId.get("close_1")).toEqual({ sessionIds: ["close_1"], verdict: "done", note: "steward-rules: idle 90m; worktree merged" })
    expect(byId.get("stuck_1")).toEqual({ sessionIds: ["stuck_1"], verdict: "abandoned", note: "stuck starting, never ran" })

    // Judged pass — carries the judge's own session id.
    const judgeOf = (candidate: string) => [...j.prompts.keys()].find(k => j.candidateOf(k) === candidate)
    expect(byId.get("done_hi")).toMatchObject({ verdict: "done", judgedBy: judgeOf("done_hi"), note: "PR #7 merged, final report given" })
    expect(byId.get("blocked_hi")).toMatchObject({ verdict: "blocked", judgedBy: judgeOf("blocked_hi") })

    // A malformed reply never closes; it reads as active / 0.
    expect(byId.has("malformed")).toBe(false)
    const malformed = out.verdicts.find(v => v.entry.sessionId === "malformed")!
    expect(malformed).toMatchObject({ verdict: "active", confidence: 0, malformed: true })
    // Below threshold → untouched.
    expect(byId.has("abandoned_lo")).toBe(false)

    expect(applies).toHaveLength(5)
    expect(out.report).toContain("RAM freed (closed sessions): ")
    // done_hi (250) + keepalive_done (220) + close_1 (200) + stuck_1 (10) closed.
    expect(out.report).toContain(`RAM freed (closed sessions): ${250 + 220 + 200 + 10} MB`)
  })

  it("a keepAlive session is never closed by rules — only by a confident judge verdict", async () => {
    const f = fixture()
    const { dispatchTool, calls } = fakeTools({ entries: f.entries, keepAlive: f.keepAlive })
    const j = judgeHost(f.replies)
    await run(dispatchTool, j.host, { apply: true, callerSessionId: SELF })

    const applies = calls.filter(c => c.name === "session_wrapup_apply").map(c => c.inputs)
    const forId = (id: string) => applies.filter(a => (a.sessionIds as string[]).includes(id))
    // keepAlive + judged active (low) → never touched.
    expect(forId("keepalive_active")).toEqual([])
    // keepAlive + confident done → closed, and ONLY through the judged path.
    expect(forId("keepalive_done")).toHaveLength(1)
    expect(forId("keepalive_done")[0]!.judgedBy).toMatch(/^judge_/)
    // No rules-pass call (no judgedBy) ever names a keepAlive session.
    expect(applies.filter(a => a.judgedBy === undefined).flatMap(a => a.sessionIds as string[])).toEqual(["close_1", "stuck_1"])
  })

  it("orders judge candidates most RAM first and caps them at maxJudged", async () => {
    const f = fixture()
    const { dispatchTool, calls } = fakeTools({ entries: f.entries, keepAlive: f.keepAlive })
    const j = judgeHost(f.replies)
    const out = await run(dispatchTool, j.host, { maxJudged: 2, callerSessionId: SELF })

    expect(out.candidates.judge.map(e => e.sessionId)).toEqual(["done_hi", "malformed"])
    expect(out.candidates.judgeOverflow.map(e => e.sessionId)).toEqual(["keepalive_active", "keepalive_done", "blocked_hi", "abandoned_lo"])
    expect(calls.filter(c => c.name === "session_evidence")).toHaveLength(2)
    expect(j.spawns).toHaveLength(2)
    expect(out.report).toContain("not judged this run (maxJudged 2)")
  })

  it("askSessions: asks only low-confidence, non-keepAlive sessions once, and acts on a declared DONE", async () => {
    const f = fixture()
    const { dispatchTool, calls } = fakeTools({
      entries: f.entries,
      keepAlive: f.keepAlive,
      askReplies: { abandoned_lo: "Sure.\nSTEWARD: DONE shipped in PR #12", malformed: "still going" },
    })
    const j = judgeHost(f.replies)
    const out = await run(dispatchTool, j.host, { apply: true, askSessions: true, callerSessionId: SELF })

    const asked = calls.filter(c => c.name === "agent_prompt")
    // malformed (0) and abandoned_lo (0.5) are below 0.8 and eligible;
    // keepalive_active is below but keepAlive — never asked.
    expect(asked.map(c => c.inputs.sessionId).sort()).toEqual(["abandoned_lo", "malformed"])
    for (const a of asked) {
      expect(a.inputs).toMatchObject({ queue: false, interrupt: false })
      expect(String(a.inputs.prompt)).toContain("STEWARD: DONE")
    }

    const abandoned = out.verdicts.find(v => v.entry.sessionId === "abandoned_lo")!
    expect(abandoned).toMatchObject({ verdict: "done", confidence: 1, source: "declared" })
    const apply = calls.find(c => c.name === "session_wrapup_apply" && (c.inputs.sessionIds as string[])[0] === "abandoned_lo")!
    expect(apply.inputs).toMatchObject({ verdict: "done", judgedBy: "steward-ask:abandoned_lo" })
    // No STEWARD line → no declaration → still untouched.
    expect(calls.some(c => c.name === "session_wrapup_apply" && (c.inputs.sessionIds as string[])[0] === "malformed")).toBe(false)
  })

  it("a judge turn that fails outright reads as active / 0 and is never acted on", async () => {
    const entries = [entry("boom", "judge", 100)]
    const { dispatchTool, calls } = fakeTools({ entries })
    const j = judgeHost({})
    ;(j.host.sendPromptAndWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("adapter died"))
    const out = await run(dispatchTool, j.host, { apply: true })
    expect(out.verdicts[0]).toMatchObject({ verdict: "active", confidence: 0 })
    expect(calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
  })
})

/** A fetch that answers Jev with `body` (status 200) or a bare `status`. */
function jevFetch(reply: { status?: number; body?: unknown }) {
  return vi.fn(async () =>
    reply.status && reply.status !== 200
      ? new Response("overloaded", { status: reply.status })
      : new Response(JSON.stringify(reply.body), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>
}

/** Route `session_judge_jev` through the REAL judge with an injected fetch. */
function realJev(fetchImpl: typeof fetch, apiKey: string | null = "test-key") {
  return (inputs: Record<string, unknown>) =>
    judgeSessionWithJev({
      sessionId: inputs.sessionId as string,
      evidence: inputs.evidence,
      apiKey,
      ...(inputs.model ? { model: inputs.model as string } : {}),
      fetchImpl,
      sleep: async () => {},
    })
}

describe("session-steward workflow — Jev judge backend", () => {
  const PROBS = { done: 0.93, active: 0.04, abandoned: 0.01, blocked: 0.01, "needs-input": 0.01 }

  it("auto + a key: Jev answers (choice + probabilities → verdict/confidence), no agent judge spawned", async () => {
    const fetchImpl = jevFetch({ body: { model: "jev-latest", answers: { verdict: { type: "choice", choice: "done", probabilities: PROBS } } } })
    const { dispatchTool, calls } = fakeTools({ entries: [entry("jev_done", "judge", 300)], jev: realJev(fetchImpl) })
    const j = judgeHost({})
    const out = await run(dispatchTool, j.host, { apply: true })

    expect(j.spawns).toHaveLength(0)
    // The evidence object is Jev's state; one `choice` question over the five verdicts.
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))
    expect(body.model).toBe("jev-latest")
    expect(body.state.sessionId).toBe("jev_done")
    expect(Object.keys(body.questions.verdict.criteria).sort()).toEqual(["abandoned", "active", "blocked", "done", "needs-input"])
    expect(out.verdicts[0]).toMatchObject({ verdict: "done", confidence: 0.93, source: "jev" })
    const apply = calls.find(c => c.name === "session_wrapup_apply")!
    expect(apply.inputs).toMatchObject({ sessionIds: ["jev_done"], verdict: "done", judgedBy: "jev:jev-latest" })
    expect(out.report).toContain("done=0.93 active=0.04")
    expect(out.report).toContain("judged by: jev=1 agent=0")
  })

  it("a Jev 5xx (after retries) falls back to the agent judge for that session, and the report says so", async () => {
    const fetchImpl = jevFetch({ status: 503 })
    const { dispatchTool, calls } = fakeTools({ entries: [entry("jev_down", "judge", 300)], jev: realJev(fetchImpl) })
    const j = judgeHost({ jev_down: verdict("jev_down", "done", 0.9, "final report given") })
    const out = await run(dispatchTool, j.host, { apply: true, judge: "jev" })

    expect(fetchImpl).toHaveBeenCalledTimes(4) // 1 + 3 bounded retries
    expect(j.spawns).toHaveLength(1)
    expect(out.verdicts[0]).toMatchObject({ verdict: "done", source: "judged" })
    const apply = calls.find(c => c.name === "session_wrapup_apply")!
    expect(apply.inputs.judgedBy).toMatch(/^judge_/)
    expect(out.report).toContain("jev failed: 503")
    expect(out.report).toContain("1 Jev failure(s) fell back to the agent judge")
  })

  it("a malformed Jev answer never closes — it falls back, and a malformed agent reply stays active/0", async () => {
    const fetchImpl = jevFetch({ body: { answers: { verdict: { type: "choice", choice: "probably-done", probabilities: { "probably-done": 0.99 } } } } })
    const { dispatchTool, calls } = fakeTools({ entries: [entry("jev_bad", "judge", 300)], jev: realJev(fetchImpl) })
    const j = judgeHost({ jev_bad: "looks done to me" })
    const out = await run(dispatchTool, j.host, { apply: true })

    expect(out.verdicts[0]).toMatchObject({ verdict: "active", confidence: 0 })
    expect(calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
    expect(out.report).toContain("unknown verdict choice 'probably-done'")
  })

  it("auto without a key uses the agent judge quietly; judge:agent never calls Jev", async () => {
    const f1 = fakeTools({ entries: [entry("nokey", "judge", 100)] })
    const out1 = await run(f1.dispatchTool, judgeHost({ nokey: verdict("nokey", "active", 0.2) }).host, {})
    expect(out1.report).not.toContain("jev failed")
    expect(out1.report).toContain("judged by: jev=0 agent=1")

    const f2 = fakeTools({ entries: [entry("agentonly", "judge", 100)], jev: vi.fn() })
    await run(f2.dispatchTool, judgeHost({}).host, { judge: "agent" })
    expect(f2.calls.some(c => c.name === "session_judge_jev")).toBe(false)
  })

  it("judge:jev without a key falls back to the agent judge and reports it", async () => {
    const { dispatchTool } = fakeTools({ entries: [entry("nokey2", "judge", 100)], jev: realJev(jevFetch({}), null) })
    const out = await run(dispatchTool, judgeHost({ nokey2: verdict("nokey2", "active", 0.2) }).host, { judge: "jev" })
    expect(out.report).toContain("jev failed: JEV_API_KEY not set")
  })
})
