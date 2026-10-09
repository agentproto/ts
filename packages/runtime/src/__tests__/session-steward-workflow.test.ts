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
import { G11_REAL_TAILS } from "./fixtures/session-steward-g11-tails.js"

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
  stewardEntry = (await import(ENTRY_PATH)) as never
})

const ENTRY_PATH = join(dirname(CRON_RULES_PATH), "entry.mjs")
let stewardEntry: {
  resolveSettings: (input: Record<string, unknown>) => Record<string, unknown>
  worktreeHasNothingToLose: (evidence: unknown) => boolean
  buildAskQueue: (verdicts: unknown[], settings: Record<string, unknown>) => Array<{ sessionId: string }>
}

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
  lastTurnErroredAt?: string
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
  /** Extra `session_evidence` fields per session id (worktree / pullRequests); `"throw"` fails the lookup. */
  evidenceExtra?: Record<string, Record<string, unknown> | "throw">
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
        ...(e.lastTurnErroredAt ? { lastTurnErroredAt: e.lastTurnErroredAt } : {}),
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
      const extra = opts.evidenceExtra?.[id]
      if (extra === "throw") throw new Error("evidence lookup failed")
      return mcpResult({
        ...(extra ?? {}),
        sessionId: id,
        label: `label-${id}`,
        cwd: `/tmp/${id}`,
        status: "running",
        keepAlive: opts.keepAlive?.has(id) ?? false,
        awaitingInput: false,
        busy: false,
        turns: (extra as { turns?: unknown[] } | undefined)?.turns ?? [
          { role: "user", text: "do the thing" },
          { role: "assistant", text: askText ?? "working on it" },
        ],
      })
    }
    if (name === "session_wrapup_apply") {
      // Like the real tool: no `wait: true` ⇒ a slow close outlasts the 25 s
      // default `waitMs` and only a running jobId comes back.
      if (inputs.wait !== true) return mcpResult({ jobId: "swa_test", status: "running" })
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
    relabel: Array<{ sessionId: string; proposedVerdict: string; reason: string }>
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
      "relabelEvidenceQueue:transform",
      "relabelEvidence:map",
      "relabelFinal:transform",
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
    // A dry run writes nothing — not even verdict memory — but still reads it.
    expect(calls.some(c => c.name === "app_state_append")).toBe(false)
    expect(calls.some(c => c.name === "app_state_list")).toBe(true)
    expect(out.report).toContain("verdict memory was read but not written (dry run)")
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
    expect(byId.get("close_1")).toEqual({ sessionIds: ["close_1"], verdict: "done", note: "steward-rules: idle 90m; worktree merged", wait: true })
    expect(byId.get("stuck_1")).toEqual({ sessionIds: ["stuck_1"], verdict: "abandoned", note: "stuck starting, never ran", wait: true })

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

  describe("keepAlive sessions and the ask path", () => {
    const CLEAN = { worktree: { branch: "wt/x", dirty: false, ahead: 0, behind: 3, pr: { state: "fresh" } } }
    const lowActive = (id: string) => verdict(id, "active", 0.3)

    async function runAsk(
      sessions: Array<{ id: string; idle: number; extra?: Record<string, unknown>; keepAlive?: boolean }>,
      input: Record<string, unknown> = {},
    ) {
      const entries = sessions.map(x => entry(x.id, "judge", 100, { idleMinutes: x.idle }))
      const { dispatchTool, calls } = fakeTools({
        entries,
        keepAlive: new Set(sessions.filter(x => x.keepAlive !== false).map(x => x.id)),
        evidenceExtra: Object.fromEntries(sessions.filter(x => x.extra).map(x => [x.id, x.extra!])),
        askReplies: Object.fromEntries(sessions.map(x => [x.id, "STEWARD: DONE shipped"])),
      })
      const j = judgeHost(Object.fromEntries(sessions.map(x => [x.id, lowActive(x.id)])))
      const out = await run(dispatchTool, j.host, { apply: true, askSessions: true, ...input })
      const asked = calls.filter(c => c.name === "agent_prompt").map(c => c.inputs.sessionId as string).sort()
      return { out, calls, asked }
    }

    it("on demand, asks a clean keepAlive session with no idle delay, and a declared DONE closes it", async () => {
      const { calls, asked } = await runAsk([{ id: "ka_clean", idle: 45, extra: CLEAN }])
      expect(asked).toEqual(["ka_clean"])
      const apply = calls.find(c => c.name === "session_wrapup_apply" && (c.inputs.sessionIds as string[])[0] === "ka_clean")!
      expect(apply.inputs).toMatchObject({ verdict: "done", judgedBy: "steward-ask:ka_clean" })
    })

    it("asks a keepAlive session whose PR is merged (the signal that already makes a plain session close)", async () => {
      const merged = { worktree: { branch: "wt/x", dirty: true, ahead: 4, pr: { state: "merged" } } }
      expect((await runAsk([{ id: "ka_merged", idle: 300, extra: merged }])).asked).toEqual(["ka_merged"])
    })

    it("never asks a keepAlive session with uncommitted work, commits ahead of base, or no worktree info", async () => {
      const dirty = { worktree: { branch: "wt/x", dirty: true, ahead: 0, pr: { state: "local-only" } } }
      const ahead = { worktree: { branch: "wt/x", dirty: false, ahead: 10, pr: { state: "local-only" } } }
      const { asked, calls } = await runAsk([
        { id: "ka_dirty", idle: 300, extra: dirty },
        { id: "ka_ahead", idle: 300, extra: ahead },
        { id: "ka_nowt", idle: 300 },
      ])
      expect(asked).toEqual([])
      expect(calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
    })

    it("a recurring run waits keepAliveAskAfterMinutes (default 24 h) before asking a keepAlive session", async () => {
      expect((await runAsk([{ id: "ka_night", idle: 600, extra: CLEAN }], { recurring: true })).asked).toEqual([])
      expect((await runAsk([{ id: "ka_old", idle: 1500, extra: CLEAN }], { recurring: true })).asked).toEqual(["ka_old"])
    })

    it("a recurring run honors a configured keepAliveAskAfterMinutes, and 0 disables the keepAlive ask", async () => {
      const sessions = [{ id: "ka_mid", idle: 180, extra: CLEAN }]
      expect((await runAsk(sessions, { recurring: true, keepAliveAskAfterMinutes: 120 })).asked).toEqual(["ka_mid"])
      expect((await runAsk(sessions, { recurring: true, keepAliveAskAfterMinutes: 240 })).asked).toEqual([])
      expect((await runAsk([{ id: "ka_ancient", idle: 99999, extra: CLEAN }], { recurring: true, keepAliveAskAfterMinutes: 0 })).asked).toEqual([])
    })

    it("an on-demand run ignores keepAliveAskAfterMinutes entirely", async () => {
      const sessions = [{ id: "ka_recent", idle: 40, extra: CLEAN }]
      expect((await runAsk(sessions, { keepAliveAskAfterMinutes: 0 })).asked).toEqual(["ka_recent"])
      expect((await runAsk(sessions, { keepAliveAskAfterMinutes: 5000 })).asked).toEqual(["ka_recent"])
    })

    it("the worktree guard applies to recurring runs too", async () => {
      const dirty = { worktree: { branch: "wt/x", dirty: true, ahead: 0, pr: { state: "local-only" } } }
      expect((await runAsk([{ id: "ka_dirty", idle: 5000, extra: dirty }], { recurring: true })).asked).toEqual([])
    })

    it("does not widen a plain session's ask: a non-keepAlive session is asked regardless of idle or worktree", async () => {
      const dirty = { worktree: { branch: "wt/x", dirty: true, ahead: 2, pr: { state: "local-only" } } }
      const { asked } = await runAsk([{ id: "plain", idle: 60, extra: dirty, keepAlive: false }])
      expect(asked).toEqual(["plain"])
    })

    it("without askSessions a keepAlive session is never asked, however idle and clean", async () => {
      const { asked } = await runAsk([{ id: "ka_clean", idle: 900, extra: CLEAN }], { askSessions: false })
      expect(asked).toEqual([])
    })

    it("a keepAlive session answering NOT-DONE stays open", async () => {
      const entries = [entry("ka_busy", "judge", 100, { idleMinutes: 300 })]
      const { dispatchTool, calls } = fakeTools({
        entries,
        keepAlive: new Set(["ka_busy"]),
        evidenceExtra: { ka_busy: CLEAN },
        askReplies: { ka_busy: "STEWARD: NOT-DONE still supervising" },
      })
      await run(dispatchTool, judgeHost({ ka_busy: lowActive("ka_busy") }).host, { apply: true, askSessions: true })
      expect(calls.filter(c => c.name === "agent_prompt")).toHaveLength(1)
      expect(calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
    })

    it("worktreeHasNothingToLose: merged signal, merged PR, or clean+level; unknown is not clean", () => {
      const f = stewardEntry.worktreeHasNothingToLose
      expect(f({ signals: { worktreeMerged: true } })).toBe(true)
      expect(f({ worktree: { dirty: true, ahead: 3, pr: { state: "merged" } } })).toBe(true)
      expect(f({ worktree: { dirty: false, ahead: 0, pr: null } })).toBe(true)
      expect(f({ worktree: { dirty: false, pr: null } })).toBe(false)
      expect(f({ worktree: { dirty: false, ahead: 1, pr: { state: "open" } } })).toBe(false)
      expect(f({ worktree: null })).toBe(false)
      expect(f({})).toBe(false)
    })

    it("buildAskQueue still skips a busy or awaiting-input keepAlive session that otherwise qualifies", () => {
      const settings = stewardEntry.resolveSettings({ askSessions: true })
      const row = (id: string, extra: Record<string, unknown>) => ({
        entry: { sessionId: id },
        confidence: 0.2,
        evidence: { keepAlive: true, idleMinutes: 600, worktree: { dirty: false, ahead: 0, pr: null }, ...extra },
      })
      const queue = stewardEntry.buildAskQueue(
        [row("ok", {}), row("busy", { busy: true }), row("waiting", { awaitingInput: true })],
        settings,
      )
      expect(queue).toEqual([{ sessionId: "ok" }])
      expect(settings.recurring).toBe(false)
      expect(settings.keepAliveAskAfterMinutes).toBe(1440)
      const recurring = stewardEntry.resolveSettings({ askSessions: true, recurring: true })
      expect(stewardEntry.buildAskQueue([row("ok", { idleMinutes: 600 })], recurring)).toEqual([])
      expect(stewardEntry.buildAskQueue([row("ok", { idleMinutes: 1440 })], recurring)).toEqual([{ sessionId: "ok" }])
    })
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

  it("demotes a rule-certain close whose last turn errored to the judge list (never auto-closed as done)", async () => {
    const f = fakeTools({
      entries: [
        entry("err_close", "close", 100, { lastTurnErroredAt: new Date(Date.now() - 3_600_000).toISOString() }),
        entry("ok_close", "close", 100),
      ],
    })
    const j = judgeHost({ err_close: verdict("err_close", "abandoned", 0.9) })
    const out = await run(f.dispatchTool, j.host, { apply: true })
    expect(out.candidates.close.map(e => e.sessionId)).toEqual(["ok_close"])
    expect(out.candidates.judge.map(e => e.sessionId)).toContain("err_close")
    const applies = f.calls.filter(c => c.name === "session_wrapup_apply").map(c => c.inputs)
    expect(applies.find(a => (a.sessionIds as string[])[0] === "ok_close")).toMatchObject({ verdict: "done" })
    // judged, not rule-closed: if it is closed at all it carries the judge's own verdict, never `done`
    const err = applies.find(a => (a.sessionIds as string[])[0] === "err_close")
    expect(err?.verdict).not.toBe("done")
    expect(err).toHaveProperty("judgedBy")
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

  // One shared instant for every row: calling Date.now() per row lets rows built
  // in the same expression land on different ms, flipping the endedMs sort (and the
  // per-verdict order of the report) between runs.
  const rowsNow = Date.now()
  const hoursAgo = (h: number) => new Date(rowsNow - h * 3_600_000).toISOString()
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
    expect(out.relabel).toEqual([expect.objectContaining({ sessionId: "sess_term", proposedVerdict: "unknown" })])
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
    expect(lines[0]).toContain("new_merged → unknown")
    expect(out.report).toContain("31 ended in the last 24h (82 without an outcome in all) — unknown: 31")
    expect(out.report).toContain("… and 62 more (older/omitted)")
    expect(out.report).not.toContain("old_0")
  })

  describe("relabel evidence (PR / worktree)", () => {
    const prRow = (id: string, nums: number[], over: Record<string, unknown> = {}) =>
      terminalRow(id, hoursAgo(1), {
        openedPrs: nums.map(number => ({ adapter: "claude-code", number, url: `https://github.com/o/r/pull/${number}`, openedAt: hoursAgo(2) })),
        outcome: { status: "produced", verdict: null, artifacts: nums.map(n => ({ type: "pr", ref: `https://github.com/o/r/pull/${n}`, title: `#${n}` })) },
        ...over,
      })
    const relabelOf = async (rows: unknown[], evidenceExtra?: Record<string, Record<string, unknown> | "throw">) => {
      const f = fakeTools({ entries: [entry("idle_1", "judge", 100)], liveExtra: rows as never, evidenceExtra })
      const out = await run(f.dispatchTool, judgeHost({ idle_1: verdict("idle_1", "active", 0.2) }).host, {})
      return { out, calls: f.calls, byId: Object.fromEntries(out.relabel.map(r => [r.sessionId, r])) }
    }

    it("recorded PRs on the list row → unknown, repo-qualified (G3), never done", async () => {
      const { byId, out } = await relabelOf([prRow("sess_prs", [1740, 1738]), prRow("sess_one", [1743]), terminalRow("sess_none", hoursAgo(1))])
      expect(byId.sess_prs).toMatchObject({ proposedVerdict: "unknown", reason: "PRs o/r#1738, o/r#1740 recorded, state unknown" })
      expect(byId.sess_one).toMatchObject({ proposedVerdict: "unknown", reason: "PR o/r#1743 recorded, state unknown" })
      expect(byId.sess_none).toMatchObject({ proposedVerdict: "unknown", reason: "terminal, no PR recorded — outcome unknown" })
      expect(out.report).toContain("- sess_prs → unknown — PRs o/r#1738, o/r#1740 recorded, state unknown")
      expect(out.report).toContain("unknown: 3")
    })

    it("a merged PR the session recorded itself → done; a merged shared-worktree PR it never recorded → unknown (G2)", async () => {
      const { byId } = await relabelOf(
        [prRow("sess_merged", [1738, 1740]), terminalRow("sess_wt", hoursAgo(2))],
        {
          sess_merged: { worktree: { branch: "wt/x", pr: { state: "merged", number: 1738, url: "https://github.com/agentik/agentik-studio/pull/1738" } }, pullRequests: { opened: 2, merged: 1, state: "merged" } },
          sess_wt: { worktree: { branch: "wt/y", pr: { state: "merged", number: 9 } }, pullRequests: { opened: 0, merged: 1, state: "merged" } },
        },
      )
      expect(byId.sess_merged).toMatchObject({ proposedVerdict: "done", reason: "PR agentik/agentik-studio#1738 merged" })
      expect(byId.sess_wt).toMatchObject({ proposedVerdict: "unknown", reason: "worktree PR #9 merged, not recorded by this session (shared worktree)" })
    })

    it("a merged PR whose session left a question in its last message → needs-follow-up, not done (G1)", async () => {
      const merged = { worktree: { branch: "wt/x", pr: { state: "merged", number: 31 } }, pullRequests: { opened: 1, merged: 1, state: "merged" } }
      const withTurns = (text: string) => ({ ...merged, turns: [{ role: "user", text: "go" }, { role: "assistant", text }] })
      const { byId } = await relabelOf(
        [prRow("sess_clean", [31]), prRow("sess_ask", [31])],
        { sess_clean: withTurns("Merged and verified. Nothing left to do."), sess_ask: withTurns("Merged. Should I also delete the branch?") },
      )
      expect(byId.sess_clean).toMatchObject({ proposedVerdict: "done" })
      expect(byId.sess_ask?.proposedVerdict).toBe("needs-follow-up")
      expect(byId.sess_ask?.reason).toContain("remaining work: question to the user")
    })

    it("an OPEN PR the session recorded → needs-follow-up (never done); an open PR it did not record → unknown (G1)", async () => {
      const { byId } = await relabelOf(
        [prRow("sess_29762d5d", [505]), terminalRow("sess_other", hoursAgo(2)), terminalRow("sess_nothing", hoursAgo(3))],
        {
          sess_29762d5d: { worktree: { branch: "wt/z", pr: { state: "open", number: 505, url: "https://github.com/agentik/agentik-studio/pull/505" } }, pullRequests: { opened: 1, merged: 0, state: "open" } },
          sess_other: { worktree: { branch: "wt/z", pr: { state: "open", number: 505 } }, pullRequests: { opened: 0, merged: 0, state: "open" } },
        },
      )
      expect(byId.sess_29762d5d).toMatchObject({ proposedVerdict: "needs-follow-up", reason: "PR agentik/agentik-studio#505 open — awaiting review/merge" })
      expect(byId.sess_other).toMatchObject({ proposedVerdict: "unknown", reason: "worktree PR #505 open, not recorded by this session" })
      expect(byId.sess_nothing).toMatchObject({ proposedVerdict: "unknown" })
    })

    it("no PR: abandoned only with positive evidence (errored last turn / no completed turn); a sibling's merged PR is not credited to an errored session", async () => {
      const { byId } = await relabelOf(
        [terminalRow("sess_err", hoursAgo(1)), terminalRow("sess_fine", hoursAgo(2)), terminalRow("sess_sibling", hoursAgo(3))],
        {
          sess_err: { turnsCompleted: 2, lastTurnError: "Upstream request failed", pullRequests: { opened: 0, merged: 0, state: null } },
          sess_fine: { turnsCompleted: 4, pullRequests: { opened: 0, merged: 0, state: null } },
          sess_sibling: { turnsCompleted: 1, lastTurnError: "Endpoint is unavailable", worktree: { branch: "wt/s", pr: { state: "merged", number: 1737 } }, pullRequests: { opened: 0, merged: 1, state: "merged" } },
        },
      )
      expect(byId.sess_err).toMatchObject({ proposedVerdict: "abandoned" })
      expect(byId.sess_fine).toMatchObject({ proposedVerdict: "unknown" })
      expect(byId.sess_sibling).not.toMatchObject({ proposedVerdict: "done" })
    })

    it("a failed evidence lookup keeps the list-row proposal", async () => {
      const { byId } = await relabelOf([prRow("sess_x", [5]), terminalRow("sess_y", hoursAgo(2))], { sess_x: "throw", sess_y: "throw" })
      expect(byId.sess_x).toMatchObject({ proposedVerdict: "unknown", reason: "PR o/r#5 recorded, state unknown" })
      expect(byId.sess_y).toMatchObject({ proposedVerdict: "unknown" })
    })

    it("looks up session_evidence only for the newest 20, never every terminal session", async () => {
      const rows = Array.from({ length: 40 }, (_, i) => terminalRow(`new_${i}`, hoursAgo(1 + i * 0.5)))
      const { calls } = await relabelOf(rows)
      const looked = calls.filter(c => c.name === "session_evidence" && String(c.inputs.sessionId).startsWith("new_"))
      expect(looked).toHaveLength(20)
      expect(new Set(looked.map(c => c.inputs.sessionId)).has("new_0")).toBe(true)
      expect(new Set(looked.map(c => c.inputs.sessionId)).has("new_39")).toBe(false)
    })
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
    const out = await run(f2.dispatchTool, j2.host, { judge: "agent", apply: true })
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
    const out = await run(f.dispatchTool, judgeHost({ m_1: verdict("m_1", "active", 0.2) }).host, { judge: "agent", apply: true })
    expect(f.calls.find(c => c.name === "app_state_list")?.inputs.appId).toBe("@agentproto/session-steward")
    expect(f.calls.find(c => c.name === "app_state_append")?.inputs.appId).toBe("@agentproto/session-steward")
    expect(out.report).not.toContain("verdict memory: off")
  })

  it("a dry run writes no verdict memory; the same pass with apply: true does", async () => {
    const dry = fakeTools({ entries: [entry("m_1", "judge", 100)] })
    const dryOut = await run(dry.dispatchTool, judgeHost({ m_1: verdict("m_1", "active", 0.2) }).host, { judge: "agent" })
    expect(dry.calls.some(c => c.name === "app_state_append")).toBe(false)
    expect(dryOut.report).toContain("verdict memory was read but not written (dry run)")

    const real = fakeTools({ entries: [entry("m_1", "judge", 100)] })
    const realOut = await run(real.dispatchTool, judgeHost({ m_1: verdict("m_1", "active", 0.2) }).host, { judge: "agent", apply: true })
    const writes = real.calls.filter(c => c.name === "app_state_append")
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w.inputs.event).toMatchObject({ stage: "session-steward", kind: "note" })
    expect(realOut.report).not.toContain("not written")
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

  it("breaks the excluded count down per reason, never lumping cron sessions in (G6)", async () => {
    const rows = [
      busyRow("sess_pinned", { pinned: true }),
      busyRow("sess_pty", { pty: true }),
      busyRow("sess_arch", { archived: true }),
      busyRow("sess_ka", { keepAlive: true }),
      busyRow("sess_ka2", { keepAlive: true }),
      busyRow("sess_cron_other", { origin: "cron:other-job" }),
    ]
    const f = fakeTools({ entries: [], liveExtra: rows })
    const out = await run(f.dispatchTool, judgeHost({}).host, { callerSessionId: SELF })
    const by = (out.scan.counts as unknown as { excludedByReason: Record<string, number> }).excludedByReason
    expect(by).toEqual({ pinned: 1, pty: 1, archived: 1, keepAlive: 2 })
    expect(out.report).toContain("5 excluded (")
    expect(out.report).toContain("2 keepAlive")
    expect(out.report).toContain("1 archived")
    expect(out.report).not.toContain("self/cron")
    // another cron job's session is NOT excluded: it is a normal busy session.
    expect(out.scan.counts.busy).toBe(1)
  })

  it("reports why there were 0 candidates when nothing is idle", async () => {
    const f = fakeTools({ entries: [], liveExtra: [busyRow("sess_busy")] })
    const out = await run(f.dispatchTool, judgeHost({}).host, {})
    expect(out.report).toContain("0 candidates:")
    expect(out.report).toContain("1 busy")
  })
})

// ── G11: never close a session that still owes something ────────────────

describe("session-steward workflow — remaining-work guard (G11)", () => {
  const PARENT = "sess_b54a2eb5"
  /** The 7 children of the dead parent, each carrying its REAL last message. */
  const children = Object.entries(G11_REAL_TAILS).map(([id, tail]) =>
    entry(`sess_${id}`, "close", 100, {
      origin: undefined,
      parentSessionId: PARENT,
      reasons: ["parent session ended", "idle 120m"],
      signals: { parentEnded: true, lastAssistantTail: tail },
    }),
  )
  const appliesOf = (calls: Array<{ name: string; inputs: Record<string, unknown> }>) =>
    calls.filter(c => c.name === "session_wrapup_apply").map(c => c.inputs)

  it("flags (needs-input) all 7 real children of an ended parent, with their last words — closes none", async () => {
    const { dispatchTool, calls } = fakeTools({ entries: children })
    const out = await run(dispatchTool, judgeHost({}).host, { apply: true })
    const applies = appliesOf(calls)
    expect(applies).toHaveLength(7)
    for (const a of applies) {
      expect(a.verdict).toBe("needs-input")
      expect(a.judgedBy).toBeUndefined()
      expect(String(a.note)).toContain("remaining work")
      expect(String(a.note)).toContain("last message: «")
    }
    expect(out.report).toContain("7 would-be close(s) downgraded to a flag")
    expect(out.report).not.toContain("close (règle certaine)")
  })

  it("a dry run shows the same downgrade and mutates nothing", async () => {
    const { dispatchTool, calls } = fakeTools({ entries: children })
    const out = await run(dispatchTool, judgeHost({}).host, {})
    expect(calls.some(c => c.name === "session_wrapup_apply")).toBe(false)
    expect(out.report).toContain("flag (remaining work: ")
    expect(out.report).toContain("(dry run)")
  })

  it("a child whose last message is a clean final report is still closed", async () => {
    const clean = entry("sess_clean", "close", 100, {
      origin: undefined,
      parentSessionId: PARENT,
      signals: { parentEnded: true, lastAssistantTail: "Done. PR merged, gate green (exit 0). Nothing left to do." },
    })
    const noTail = entry("sess_notail", "close", 100, { origin: undefined, parentSessionId: PARENT, signals: { parentEnded: true } })
    const { dispatchTool, calls } = fakeTools({ entries: [clean, noTail, children[0]!] })
    await run(dispatchTool, judgeHost({}).host, { apply: true })
    const byId = new Map(appliesOf(calls).map(a => [(a.sessionIds as string[])[0], a]))
    expect(byId.get("sess_clean")).toMatchObject({ verdict: "done" })
    expect(byId.get("sess_notail")).toMatchObject({ verdict: "done" })
    expect(byId.get(children[0]!.sessionId)).toMatchObject({ verdict: "needs-input" })
  })

  it("an open worktree PR keeps a would-be close as a flag", async () => {
    const open = entry("sess_openpr", "close", 100, { origin: "cron:job", signals: { worktreePrOpen: true, lastAssistantTail: "All set." } })
    const { dispatchTool, calls } = fakeTools({ entries: [open] })
    await run(dispatchTool, judgeHost({}).host, { apply: true })
    expect(appliesOf(calls)[0]).toMatchObject({ verdict: "needs-input" })
    expect(String(appliesOf(calls)[0]!.note)).toContain("open PR awaiting review/merge")
  })

  it("a confident judged done with a question in the last message is flagged; a declared STEWARD: DONE is trusted", async () => {
    const ask = entry("judged_q", "judge", 100, { origin: undefined, parentSessionId: PARENT, signals: { lastAssistantTail: "Should I also open a PR for this?" } })
    const { dispatchTool, calls } = fakeTools({ entries: [ask] })
    await run(dispatchTool, judgeHost({ judged_q: verdict("judged_q", "done", 0.99, "finished") }).host, { apply: true })
    expect(appliesOf(calls)[0]).toMatchObject({ verdict: "needs-input" })
    expect(String(appliesOf(calls)[0]!.note)).toContain("remaining work")

    const decl = fakeTools({ entries: [ask], askReplies: { judged_q: "Yes.\nSTEWARD: DONE nothing more" } })
    await run(decl.dispatchTool, judgeHost({ judged_q: verdict("judged_q", "done", 0.3) }).host, { apply: true, askSessions: true })
    expect(appliesOf(decl.calls).find(a => a.judgedBy === "steward-ask:judged_q")).toMatchObject({ verdict: "done" })
  })

  it("a stuck-starting session is never downgraded; a user-origin close keeps the origin reason", async () => {
    const stuck = entry("sess_stuck", "stuck", 10, { signals: { lastAssistantTail: "Should I?" } })
    const user = entry("sess_user", "close", 10, { origin: "chat-starter", signals: { lastAssistantTail: "Should I?" } })
    const { dispatchTool, calls } = fakeTools({ entries: [stuck, user] })
    await run(dispatchTool, judgeHost({}).host, { apply: true })
    const byId = new Map(appliesOf(calls).map(a => [(a.sessionIds as string[])[0], a]))
    expect(byId.get("sess_stuck")).toMatchObject({ verdict: "abandoned" })
    expect(byId.get("sess_user")).toMatchObject({ verdict: "needs-input", note: "flag (origine utilisateur)" })
  })
})
