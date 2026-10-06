/**
 * Loads the REAL shipped `session-steward` app's WORKFLOW.md (+ its
 * `entry.mjs`) the way the daemon does via `workflow_run_file`, and runs it
 * end to end against a fake `dispatchTool` and a fake agent host — no live
 * daemon, no real session touched, no real judge spawned. Same pattern as
 * `repo-maintenance-workflow.test.ts`.
 */

import { beforeAll, describe, it, expect, vi } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadWorkflowHandle } from "@agentproto/workflow-loader"
import { compileWorkflow, runWorkflow } from "@agentproto/workflow-runtime"
import type { AgentSessionHost } from "@agentproto/workflow-runtime"
import { createDaemonToolRegistry, type DispatchTool } from "../workflow-tool-registry.js"
import { judgeSessionWithJev } from "../jev-client.js"
import { modelRoles } from "../model-roles-tools.js"

const CRON_RULES_PATH = join(
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
let cronRules: { evidenceFingerprint: (evidence: unknown) => string }
beforeAll(async () => {
  cronRules = (await import(CRON_RULES_PATH)) as never
})

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
  origin?: string
  parentSessionId?: string
  /** Live-row overrides for the `session_list` fake (scan inputs). */
  status?: string
  busy?: boolean
  tokensIn?: number
  tokensOut?: number
  startedAt?: string
  worktree?: { pr?: { state: string; number?: number } }
  outcome?: { verdict?: string }
}

const entry = (sessionId: string, cls: PlanEntry["class"], rssMB: number, extra: Partial<PlanEntry> = {}): PlanEntry => ({
  sessionId,
  label: `label-${sessionId}`,
  idleMinutes: 90,
  rssBytes: rssMB * MB,
  class: cls,
  reasons: [`${cls} reason`],
  signals: {},
  // A cron origin keeps the default fixture closeable; origin-policy tests
  // below override it with a user origin / no origin.
  origin: "cron:fixture",
  ...extra,
})

/** What the judge replies, per candidate session id. */
type Replies = Record<string, string>
const verdict = (sessionId: string, v: string, confidence: number, reason = `because ${v}`): string =>
  JSON.stringify({ sessionId, verdict: v, confidence, reason })

function mcpResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
}

/** Daemon `models` block the fake `model_roles` tool resolves against. */
let daemonModels: Record<string, unknown> = {}

/** The REAL `model_roles` resolver over an in-memory daemon config. */
async function modelRolesResult(inputs: Record<string, unknown>) {
  return mcpResult(
    await modelRoles(inputs as never, { loadCfg: async () => ({ models: daemonModels }) as never, resolveRoot: async () => undefined }),
  )
}

function fakeTools(opts: {
  entries: PlanEntry[]
  keepAlive?: Set<string>
  /** session id → newest assistant text seen by a SECOND session_evidence read (the ask). */
  askReplies?: Record<string, string>
  /** `session_judge_jev`'s answer; default = no key configured. */
  jev?: (inputs: Record<string, unknown>) => Promise<unknown>
  /** Extra `session_list` rows (busy sessions for the loop/stall scan). */
  liveExtra?: Array<Record<string, unknown>>
  /** `tool_calls_list` records per session id (loop scan). */
  toolCalls?: Record<string, unknown[]>
  /** Prior verdict-memory events returned by `app_state_list`. */
  memoryEvents?: unknown[]
  /** Installed app ids `app_list` reports; default = the real steward app id. */
  installedApps?: string[]
  /** `session_list` result wrapper: the real un-paged `{sessions}` (default) or the paged `{items}`. */
  listShape?: "sessions" | "items"
  /** `host_load` report; default = a calm host. */
  hostLoad?: Record<string, unknown>
}) {
  const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
  const evidenceReads = new Map<string, number>()
  const calmHost = {
    loadAvg: [1, 1, 1],
    cpuCount: 12,
    loadPerCore: 0.08,
    memory: { totalBytes: 34 * 1024 ** 3, freeBytes: 10 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 },
    swap: { percent: 4 },
    warnings: [],
    topByMemory: [],
  }
  const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
    calls.push({ name, inputs })
    if (name === "session_wrapup_plan") return mcpResult({ entries: opts.entries, totals: {} })
    if (name === "host_load") return mcpResult(opts.hostLoad ?? calmHost)
    if (name === "session_list") {
      const rows = opts.entries.map(e => ({
        id: e.sessionId,
        label: e.label,
        status: e.status ?? "running",
        busy: e.busy ?? false,
        keepAlive: opts.keepAlive?.has(e.sessionId) ?? false,
        origin: e.origin,
        parentSessionId: e.parentSessionId,
        ...(e.tokensIn !== undefined ? { tokensIn: e.tokensIn } : {}),
        ...(e.tokensOut !== undefined ? { tokensOut: e.tokensOut } : {}),
        ...(e.worktree ? { worktree: e.worktree } : {}),
        ...(e.outcome ? { outcome: e.outcome } : {}),
        ...(e.startedAt ? { startedAt: e.startedAt } : {}),
        lastActivityAt: new Date(Date.now() - e.idleMinutes * 60_000).toISOString(),
      }))
      return mcpResult({ [opts.listShape ?? "sessions"]: [...rows, ...(opts.liveExtra ?? [])] })
    }
    if (name === "tool_calls_list") {
      return mcpResult({ records: opts.toolCalls?.[inputs.sessionId as string] ?? [] })
    }
    if (name === "app_list") return mcpResult((opts.installedApps ?? ["@agentproto/session-steward"]).map(appId => ({ appId })))
    if (name === "app_state_list") {
      if (inputs.appId !== "@agentproto/session-steward") return { content: [{ type: "text" as const, text: `app_state_list: no installed app "${inputs.appId}".` }], isError: true }
      return mcpResult({ events: opts.memoryEvents ?? [] })
    }
    if (name === "app_state_append") return mcpResult({ appId: inputs.appId, event: inputs.event })
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
    if (name === "model_roles") return modelRolesResult(inputs)
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
    proposals: { proposals: Array<{ sessionId: string; kind: string; reason: string }>; observed: Array<{ sessionId: string; kind: string }> }
    relabel: Array<{ sessionId: string; proposedVerdict: string }>
    scan: { counts: Record<string, number> }
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
      "modelRoles:tool",
      "settings:transform",
      "plan:tool",
      "candidates:transform",
      "hostLoad:tool",
      "liveSessions:tool",
      "scan:transform",
      "candidatesPlus:transform",
      "ruleApplyQueue:transform",
      "autoApply:map",
      "installedApps:tool",
      "memoryApp:transform",
      "memoryQueue:transform",
      "memoryRead:map",
      "memory:transform",
      "loopScan:map",
      "loopResults:transform",
      "proposals:transform",
      "relabelQueue:transform",
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
      "memoryWriteQueue:transform",
      "memoryWrite:map",
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
  it("dry run (the default): plans and judges, but mutates no session", async () => {
    const f = fixture()
    const { dispatchTool, calls } = fakeTools({ entries: f.entries, keepAlive: f.keepAlive })
    const j = judgeHost(f.replies)
    const out = await run(dispatchTool, j.host, { callerSessionId: SELF })

    expect(out.apply).toBe(false)
    expect(calls.find(c => c.name === "session_wrapup_plan")!.inputs).toEqual({ idleMinutes: 30, wait: true })
    // No SESSION is ever mutated in a dry run.
    expect(calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
    expect(calls.some(c => c.name === "agent_prompt")).toBe(false)
    // The only write is the append-only verdict-memory ledger.
    const writes = calls.filter(c => c.name === "app_state_append")
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w.inputs.event).toMatchObject({ stage: "session-steward", kind: "note" })
    // Judges still ran (one per judge candidate, caller excluded), on sonnet,
    // and every judge session was released after its turn.
    expect(j.spawns).toHaveLength(6)
    expect(new Set(j.spawns.map(s => s.model))).toEqual(new Set(["claude-sonnet-5-5"]))
    expect(j.released.sort()).toEqual(j.spawns.map(s => s.id).sort())
    expect(out.report).toContain("dry run")
    // The retained action is shown even in dry run (origin-bounded decision).
    expect(out.report).toContain("close (règle certaine) (dry run)")
    expect(out.report).toContain("| origin |")
    expect(out.report).toContain("cron:fixture")
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

  it("apply: a user-origin session is only ever flagged — never closed, even with a confident done", async () => {
    const entries: PlanEntry[] = [
      entry("chat_close", "close", 200, { origin: "chat-starter" }),
      entry("vscode_close", "close", 100, { origin: "vscode" }),
      entry("human_close", "close", 50, { origin: undefined }),
      entry("cron_close", "close", 40, { origin: "cron:job" }),
      entry("chat_done", "judge", 30, { origin: "chat-starter" }),
      entry("human_done", "judge", 20, { origin: undefined }),
      entry("exec_done", "judge", 10, { parentSessionId: "sess_parent", origin: undefined }),
    ]
    const replies: Replies = {
      chat_done: verdict("chat_done", "done", 0.99, "finished"),
      human_done: verdict("human_done", "done", 0.99, "finished"),
      exec_done: verdict("exec_done", "done", 0.99, "finished"),
    }
    const { dispatchTool, calls } = fakeTools({ entries })
    const j = judgeHost(replies)
    const out = await run(dispatchTool, j.host, { apply: true })

    const applies = calls.filter(c => c.name === "session_wrapup_apply").map(c => c.inputs)
    const byId = new Map(applies.map(a => [(a.sessionIds as string[])[0], a]))
    // Rule-certain user-origin sessions: flagged needs-input, never closed.
    expect(byId.get("chat_close")).toMatchObject({ verdict: "needs-input", note: "flag (origine utilisateur)" })
    expect(byId.get("vscode_close")).toMatchObject({ verdict: "needs-input", note: "flag (origine utilisateur)" })
    expect(byId.get("human_close")).toMatchObject({ verdict: "needs-input", note: "flag (origine utilisateur)" })
    // Closable origins still close.
    expect(byId.get("cron_close")).toMatchObject({ verdict: "done" })
    expect(byId.get("exec_done")).toMatchObject({ verdict: "done" })
    // A confident done on a user origin is still only a flag.
    expect(byId.get("chat_done")).toMatchObject({ verdict: "needs-input" })
    expect(byId.get("human_done")).toMatchObject({ verdict: "needs-input" })
    expect(byId.get("chat_done")!.judgedBy).toMatch(/^judge_/)
    // The report carries the origin column and the retained action.
    expect(out.report).toContain("flag (origine utilisateur)")
    expect(out.report).toContain("chat-starter (user)")
    expect(out.report).toContain("(none, user)")
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

  describe("judge model comes from the judge.session role", () => {
    const judgeModels = async (input: Record<string, unknown>) => {
      const f = fakeTools({ entries: [entry("roleone", "judge", 100)] })
      const j = judgeHost({ roleone: verdict("roleone", "active", 0.2) })
      await run(f.dispatchTool, j.host, { judge: "agent", ...input })
      return { models: j.spawns.map(s => s.model), roleCalls: f.calls.filter(c => c.name === "model_roles") }
    }

    it("follows the daemon `models` config", async () => {
      daemonModels = { "judge.session": "claude-opus-5-5" }
      try {
        const r = await judgeModels({})
        expect(r.models).toEqual(["claude-opus-5-5"])
        expect(r.roleCalls).toHaveLength(1)
      } finally {
        daemonModels = {}
      }
    })

    it("an explicit judgeModel input beats the configured role", async () => {
      daemonModels = { "judge.session": "claude-opus-5-5" }
      try {
        expect((await judgeModels({ judgeModel: "explicit-judge-model" })).models).toEqual(["explicit-judge-model"])
      } finally {
        daemonModels = {}
      }
    })
  })
})

/** The evidence object embedded at the tail of a judge prompt. */
function evidenceFromPrompt(prompt: string): Record<string, unknown> {
  const marker = "Evidence:\n"
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
}

describe("session-steward workflow — mechanical cron rules (mission items 1-10)", () => {
  const now = () => new Date().toISOString()
  const busyRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    status: "running",
    busy: true,
    origin: "cron:job",
    lastActivityAt: now(),
    ...over,
  })

  it("proposes an interrupt nudge (never a close) for a looping busy session", async () => {
    const records = Array.from({ length: 3 }, (_, i) => ({
      tool: "Bash",
      command: "rg -rn sentinel docs/x.md | head -10",
      ts: new Date(Date.now() - i * 1000).toISOString(),
    }))
    const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], liveExtra: [busyRow("sess_loop")], toolCalls: { sess_loop: records } })
    const out = await run(f.dispatchTool, judgeHost({ idle_1: verdict("idle_1", "active", 0.2) }).host, {})
    expect(out.proposals.proposals).toHaveLength(1)
    expect(out.proposals.proposals[0]).toMatchObject({ sessionId: "sess_loop", kind: "interrupt" })
    expect(out.proposals.proposals[0]!.reason).toContain("loop")
    expect(out.report).toContain("interrupt nudge → sess_loop")
    expect(f.calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
    expect(f.calls.some(c => c.name === "agent_prompt")).toBe(false)
  })

  it("observes a user-origin loop without proposing a nudge", async () => {
    const records = Array.from({ length: 3 }, (_, i) => ({
      tool: "Bash",
      command: "rg -rn sentinel docs/x.md",
      ts: new Date(Date.now() - i * 1000).toISOString(),
    }))
    const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], liveExtra: [busyRow("sess_chat", { origin: "chat-starter" })], toolCalls: { sess_chat: records } })
    const out = await run(f.dispatchTool, judgeHost({ idle_1: verdict("idle_1", "active", 0.2) }).host, {})
    expect(out.proposals.proposals).toHaveLength(0)
    expect(out.proposals.observed.map(o => o.sessionId)).toContain("sess_chat")
    expect(out.report).not.toContain("interrupt nudge → sess_chat")
    expect(out.report).toContain("observed → sess_chat")
  })

  it("proposes a continue nudge for a stalled busy session", async () => {
    const stale = new Date(Date.now() - 35 * 60_000).toISOString()
    const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], liveExtra: [busyRow("sess_stall", { lastActivityAt: stale })] })
    const out = await run(f.dispatchTool, judgeHost({ idle_1: verdict("idle_1", "active", 0.2) }).host, {})
    expect(out.proposals.proposals).toHaveLength(1)
    expect(out.proposals.proposals[0]).toMatchObject({ sessionId: "sess_stall", kind: "continue" })
    expect(out.proposals.proposals[0]!.reason).toContain("stall")
    expect(f.calls.some(c => c.name === "agent_prompt")).toBe(false)
  })

  it("classifies a never-ran 0/0 session as stuck without judging it", async () => {
    const f = fakeTools({ entries: [entry("nr", "judge", 100, { tokensIn: 0, tokensOut: 0 })] })
    const j = judgeHost({})
    const out = await run(f.dispatchTool, j.host, { apply: true })
    expect(out.candidates.stuck.map(e => e.sessionId)).toContain("nr")
    expect(out.candidates.judge.map(e => e.sessionId)).not.toContain("nr")
    expect(j.spawns).toHaveLength(0)
    const apply = f.calls.find(c => c.name === "session_wrapup_apply" && (c.inputs.sessionIds as string[])[0] === "nr")
    expect(apply?.inputs).toMatchObject({ verdict: "abandoned" })
  })

  it("does not call a busy, just-started 0/0 session stuck (never ran)", async () => {
    const justStarted = new Date(Date.now() - 20_000).toISOString()
    const f = fakeTools({
      entries: [entry("young", "judge", 100, { tokensIn: 0, tokensOut: 0, busy: true, idleMinutes: 0, startedAt: justStarted })],
    })
    const j = judgeHost({})
    const out = await run(f.dispatchTool, j.host, { apply: true })
    expect(out.scan.counts.neverRan).toBe(0)
    expect(out.candidates.stuck.map(e => e.sessionId)).not.toContain("young")
    expect(out.report).not.toContain("never ran")
    expect(f.calls.some(c => c.name === "session_wrapup_apply" && (c.inputs.sessionIds as string[]).includes("young"))).toBe(false)
  })

  it("does not call a young idle 0/0 session stuck, but an old one is", async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
    const f = fakeTools({
      entries: [
        entry("young_idle", "judge", 100, { tokensIn: 0, tokensOut: 0, idleMinutes: 45, startedAt: minutesAgo(5) }),
        entry("old_idle", "judge", 100, { tokensIn: 0, tokensOut: 0, idleMinutes: 45, startedAt: minutesAgo(60) }),
      ],
    })
    const out = await run(f.dispatchTool, judgeHost({ young_idle: verdict("young_idle", "active", 0.2) }).host, {})
    expect(out.candidates.stuck.map(e => e.sessionId)).toContain("old_idle")
    expect(out.candidates.stuck.map(e => e.sessionId)).not.toContain("young_idle")
  })

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  const terminalRow = (id: string, endedAt: string | undefined, over: Record<string, unknown> = {}) => ({
    id,
    status: "killed",
    origin: "cron:job",
    ...(endedAt ? { endedAt } : {}),
    ...over,
  })

  it("surfaces terminal sessions with no outcome as relabel candidates", async () => {
    const term = terminalRow("sess_term", hoursAgo(1), { worktree: { pr: { state: "merged" } } })
    const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], liveExtra: [term] })
    const out = await run(f.dispatchTool, judgeHost({ idle_1: verdict("idle_1", "active", 0.2) }).host, {})
    expect(out.relabel).toEqual([expect.objectContaining({ sessionId: "sess_term", proposedVerdict: "done" })])
    expect(out.report).toContain("Terminal sessions missing an outcome")
  })

  it("lists only relabel candidates inside the window, capped at 20 newest first, with counts", async () => {
    const recent = Array.from({ length: 30 }, (_, i) => terminalRow(`new_${i}`, hoursAgo(1 + i * 0.5)))
    const old = Array.from({ length: 50 }, (_, i) => terminalRow(`old_${i}`, hoursAgo(48 + i)))
    const noTime = terminalRow("no_time", undefined)
    const merged = terminalRow("new_merged", hoursAgo(0.5), { worktree: { pr: { state: "merged" } } })
    const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], liveExtra: [...old, ...recent, noTime, merged] })
    const out = await run(f.dispatchTool, judgeHost({ idle_1: verdict("idle_1", "active", 0.2) }).host, {})
    const ids = out.relabel.map(r => r.sessionId)
    expect(ids).toHaveLength(31)
    expect(ids.every(id => id.startsWith("new_"))).toBe(true)
    expect(ids[0]).toBe("new_merged")
    expect(ids[1]).toBe("new_0")
    const lines = out.report.split("\n").filter(l => /^- sess|^- (new|old)_/.test(l) && l.includes("→"))
    expect(lines).toHaveLength(20)
    expect(lines[0]).toContain("new_merged → done")
    expect(out.report).toContain("31 ended in the last 24h (82 without an outcome in all) — done: 1, abandoned: 30")
    expect(out.report).toContain("… and 62 more (older/omitted)")
    expect(out.report).not.toContain("old_0")
  })

  it("honours relabelWindowHours", async () => {
    const rows = [terminalRow("t_1h", hoursAgo(1)), terminalRow("t_30h", hoursAgo(30))]
    const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], liveExtra: rows })
    const j = judgeHost({ idle_1: verdict("idle_1", "active", 0.2) })
    expect((await run(f.dispatchTool, j.host, {})).relabel.map(r => r.sessionId)).toEqual(["t_1h"])
    expect((await run(f.dispatchTool, j.host, { relabelWindowHours: 48 })).relabel.map(r => r.sessionId)).toEqual(["t_1h", "t_30h"])
  })

  it("puts a saturated-host header first, listing orphans and non-session processes", async () => {
    const saturated = {
      loadAvg: [50, 40, 30],
      cpuCount: 12,
      loadPerCore: 4.2,
      memory: { totalBytes: 34 * 1024 ** 3, freeBytes: 50 * 1024 ** 2, availableBytes: 80 * 1024 ** 2 },
      swap: { percent: 96 },
      warnings: [],
      topByMemory: [{ pid: 1, command: "next-server", memoryBytes: 2 * 1024 ** 3, elapsedSec: 40000, owner: { kind: "orphan" } }],
    }
    const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], hostLoad: saturated })
    const out = await run(f.dispatchTool, judgeHost({ idle_1: verdict("idle_1", "active", 0.2) }).host, {})
    expect(out.report).toContain("Host saturated")
    expect(out.report).toContain("next-server")
  })

  it("serves a stable verdict from memory cache without spawning a judge, and writes memory", async () => {
    const f1 = fakeTools({ entries: [entry("cache_1", "judge", 100)] })
    const j1 = judgeHost({ cache_1: verdict("cache_1", "active", 0.2) })
    await run(f1.dispatchTool, j1.host, { judge: "agent" })
    const evidence = evidenceFromPrompt([...j1.prompts.values()][0]!)
    const fp = cronRules.evidenceFingerprint(evidence)
    const prior = (ts: string) => ({
      kind: "note",
      ts,
      payload: { kind: "steward-verdict", sessionId: "cache_1", verdict: "active", confidence: 0.2, fingerprint: fp, judgedBy: "stub" },
    })

    const f2 = fakeTools({ entries: [entry("cache_1", "judge", 100)], memoryEvents: [prior("2026-10-02T10:00:00Z"), prior("2026-10-02T11:00:00Z")] })
    const j2 = judgeHost({})
    const out = await run(f2.dispatchTool, j2.host, { judge: "agent" })
    expect(j2.spawns).toHaveLength(0)
    expect(out.verdicts.find(v => v.entry.sessionId === "cache_1")?.source).toBe("cache")
    expect(out.report).toContain("served from cache")
    expect(f2.calls.some(c => c.name === "app_state_append")).toBe(true)
  })

  it("reads the real {sessions} session_list shape (and the paged {items} one) — live counts are not 0", async () => {
    for (const listShape of ["sessions", "items"] as const) {
      const f = fakeTools({ entries: [], listShape, liveExtra: [busyRow("sess_a"), busyRow("sess_b"), { id: "sess_t", status: "killed", origin: "cron:job" }] })
      const out = await run(f.dispatchTool, judgeHost({}).host, {})
      expect(out.report).toContain("0 candidates:")
      expect(out.report).toContain("2 busy")
      expect(out.report).not.toContain("0 live")
    }
  })

  it("verdict memory resolves the installed app id by default (read + write use it)", async () => {
    const f = fakeTools({ entries: [entry("m_1", "judge", 100)] })
    const out = await run(f.dispatchTool, judgeHost({ m_1: verdict("m_1", "active", 0.2) }).host, { judge: "agent" })
    expect(f.calls.find(c => c.name === "app_state_list")?.inputs.appId).toBe("@agentproto/session-steward")
    expect(f.calls.find(c => c.name === "app_state_append")?.inputs.appId).toBe("@agentproto/session-steward")
    expect(out.report).not.toContain("verdict memory: off")
  })

  it("a bare appId name matches the scoped install", async () => {
    const f = fakeTools({ entries: [entry("m_1", "judge", 100)] })
    await run(f.dispatchTool, judgeHost({ m_1: verdict("m_1", "active", 0.2) }).host, { judge: "agent", appId: "session-steward" })
    expect(f.calls.find(c => c.name === "app_state_list")?.inputs.appId).toBe("@agentproto/session-steward")
  })

  it("a missing memory app degrades to no memory with a report note — no memory call, no failed step", async () => {
    const f = fakeTools({ entries: [entry("m_1", "judge", 100)], installedApps: ["@someone/else"] })
    const out = await run(f.dispatchTool, judgeHost({ m_1: verdict("m_1", "active", 0.2) }).host, { judge: "agent" })
    expect(f.calls.some(c => c.name === "app_state_list" || c.name === "app_state_append")).toBe(false)
    expect(out.report).toContain('verdict memory: off — no installed app "@agentproto/session-steward"')
  })

  it("appId: \"\" turns memory off explicitly", async () => {
    const f = fakeTools({ entries: [entry("m_1", "judge", 100)] })
    const out = await run(f.dispatchTool, judgeHost({ m_1: verdict("m_1", "active", 0.2) }).host, { judge: "agent", appId: "" })
    expect(f.calls.some(c => c.name === "app_state_list" || c.name === "app_state_append")).toBe(false)
    expect(out.report).toContain("verdict memory: off (appId empty)")
  })

  it("reports why there were 0 candidates when nothing is idle", async () => {
    const f = fakeTools({ entries: [], liveExtra: [busyRow("sess_busy")] })
    const out = await run(f.dispatchTool, judgeHost({}).host, {})
    expect(out.report).toContain("0 candidates:")
    expect(out.report).toContain("1 busy")
  })
})
