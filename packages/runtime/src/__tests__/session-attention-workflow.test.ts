/**
 * Loads the REAL shipped `session-attention` workflow (WORKFLOW.md + entry.mjs)
 * the way the daemon does via `workflow_run_file` and runs it end to end
 * against a fake `dispatchTool` and a fake judge host — no daemon, no real
 * session touched. Pins the read-only contract and the three dogfood cases
 * (looping+errored idle session, finished-but-waiting-on-you, blocked-on-a-token).
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
  "session-steward",
  ".agentproto",
  "workflows",
  "session-attention",
  "WORKFLOW.md",
)
const JUDGE_REF = "@agentproto/session-attention-judge"
const SELF = "sess_self"

const mcpResult = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })

interface Fixture {
  row: Record<string, unknown>
  evidence: Record<string, unknown>
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const loopSentence = "I will now proceed to update the roadmap file with the next set of MCP events tasks."
const WATCHDOG_TEXT = Array.from({ length: 12 }, () => loopSentence).join(" ")

function fixtures(): Fixture[] {
  return [
    {
      row: { id: "sess_watchdog", label: "chat 04:14:05", title: "chat 04:14:05", status: "running", busy: false, lastActivityAt: minutesAgo(300) },
      evidence: {
        sessionId: "sess_watchdog",
        idleMinutes: 300,
        busy: false,
        awaitingInput: false,
        tokensIn: 5000,
        tokensOut: 3000,
        lastTurnErroredAt: minutesAgo(299),
        lastTurnError: "provider overloaded",
        turns: [
          { role: "user", text: "Watchdog : assure la suite du plan MCP Events" },
          { role: "assistant", text: WATCHDOG_TEXT },
        ],
      },
    },
    {
      row: { id: "sess_audit", label: "audit-1.10-supervisor", status: "running", busy: false, lastActivityAt: minutesAgo(25 * 60) },
      evidence: {
        sessionId: "sess_audit",
        idleMinutes: 25 * 60,
        busy: false,
        awaitingInput: false,
        tokensIn: 90000,
        tokensOut: 20000,
        turns: [
          { role: "user", text: "audit 1.10" },
          { role: "assistant", text: "CI report: PRs #1700 and #1691 are green and approved. Nothing was merged." },
        ],
      },
    },
    {
      row: { id: "sess_pyg", label: "pyg-cos2-supervisor-2", status: "running", busy: false, lastActivityAt: minutesAgo(10 * 60) },
      evidence: {
        sessionId: "sess_pyg",
        idleMinutes: 10 * 60,
        busy: false,
        awaitingInput: false,
        tokensIn: 70000,
        tokensOut: 15000,
        turns: [
          { role: "user", text: "ship it" },
          { role: "assistant", text: "Stopped right after that; the deploy is still pending on the repo access." },
        ],
      },
    },
    {
      row: { id: "sess_busy", label: "worker", status: "running", busy: true, lastActivityAt: minutesAgo(1) },
      evidence: {
        sessionId: "sess_busy",
        idleMinutes: 1,
        busy: true,
        awaitingInput: false,
        tokensIn: 1000,
        tokensOut: 800,
        turns: [{ role: "user", text: "go" }],
      },
    },
    {
      row: { id: "sess_asker", label: "reviewer", status: "running", busy: false, lastActivityAt: minutesAgo(45) },
      evidence: {
        sessionId: "sess_asker",
        idleMinutes: 45,
        busy: false,
        awaitingInput: false,
        tokensIn: 4000,
        tokensOut: 2000,
        turns: [
          { role: "user", text: "review" },
          { role: "assistant", text: "I found two options for the migration. Do you want me to keep the old column or drop it?" },
        ],
      },
    },
  ]
}

function fakeTools(fx: Fixture[], extraRows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ name: string; inputs: Record<string, unknown> }> = []
  const dispatchTool: DispatchTool = vi.fn(async (name, inputs) => {
    calls.push({ name, inputs })
    if (name === "model_roles") return mcpResult({ models: {} })
    if (name === "session_list") return mcpResult({ items: [...fx.map(f => f.row), ...extraRows] })
    if (name === "session_evidence") {
      const found = fx.find(f => f.row.id === inputs.sessionId)
      return mcpResult(found?.evidence ?? { sessionId: inputs.sessionId, turns: [] })
    }
    throw new Error(`attention workflow must stay read-only; unexpected tool '${name}'`)
  })
  return { dispatchTool, calls }
}

function judgeHost(replies: Record<string, string>) {
  const prompts = new Map<string, string>()
  const released: string[] = []
  let n = 0
  const host: AgentSessionHost = {
    spawn: vi.fn(async () => `judge_${++n}`),
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
  return { host, prompts, released }
}

interface AttentionOutput {
  report: string
  text: string
  counts: Record<string, number>
  items: Array<{ sessionId: string; title: string; verdict: string; waitingOnYou?: boolean; reason: string; source: string }>
  scan: { counts: Record<string, number> }
}

async function run(dispatchTool: DispatchTool, host: AgentSessionHost, input: Record<string, unknown> = {}) {
  const handle = await loadWorkflowHandle(WORKFLOW_PATH)
  const compiled = compileWorkflow(handle, {
    ...createDaemonToolRegistry(handle, dispatchTool),
    agentRefs: { [JUDGE_REF]: { adapter: "mock-agent" } },
  })
  const { output } = await runWorkflow({ workflow: compiled, agents: host, input })
  return output as AttentionOutput
}

const judgeJson = (sessionId: string, verdict: string, confidence: number, waitingOnYou: boolean, reason: string) =>
  JSON.stringify({ sessionId, verdict, confidence, waitingOnYou, reason })

describe("session-attention workflow — shape", () => {
  it("loads and compiles with the expected top-level step sequence", async () => {
    const handle = await loadWorkflowHandle(WORKFLOW_PATH)
    expect(handle.id).toBe("session-attention")
    expect(handle.steps.map(s => `${s.id}:${s.kind}`)).toEqual([
      "modelRoles:tool",
      "settings:transform",
      "liveSessions:tool",
      "scan:transform",
      "evidence:map",
      "entries:transform",
      "judgeQueue:transform",
      "judge:map",
      "items:transform",
      "digest:transform",
    ])
  })
})

describe("session-attention workflow — run (fake tools + fake judge)", () => {
  const replies = () => ({
    sess_audit: judgeJson("sess_audit", "done", 0.9, true, "Reported #1700 and #1691 green; waiting for you to merge."),
    sess_pyg: judgeJson("sess_pyg", "blocked", 0.85, true, "Deploy blocked on GitHub token access."),
    sess_asker: judgeJson("sess_asker", "needs-reply", 0.95, true, "Asks whether to keep or drop the old column."),
  })

  it("classifies the dogfood cases, uses the real title, and orders by urgency", async () => {
    const { dispatchTool } = fakeTools(fixtures())
    const j = judgeHost(replies())
    const out = await run(dispatchTool, j.host, { callerSessionId: SELF })
    const byId = Object.fromEntries(out.items.map(i => [i.sessionId, i]))

    expect(byId.sess_watchdog!.verdict).toBe("stuck")
    expect(byId.sess_watchdog!.title).toBe("Watchdog : assure la suite du plan MCP Events")
    expect(byId.sess_watchdog!.source).toBe("rules")
    expect(byId.sess_audit!.verdict).toBe("done")
    expect(byId.sess_audit!.waitingOnYou).toBe(true)
    expect(byId.sess_pyg!.verdict).toBe("blocked")
    expect(byId.sess_asker!.verdict).toBe("needs-reply")
    expect(byId.sess_busy!.verdict).toBe("active")

    expect(out.items.map(i => i.sessionId)).toEqual(["sess_asker", "sess_watchdog", "sess_pyg", "sess_audit", "sess_busy"])
    expect(out.report).not.toContain("sess_busy")
    expect(out.report).toContain("Needs you")
    expect(out.text.length).toBeLessThanOrEqual(3500)
  })

  it("only the ambiguous sessions reach the judge; rule-certain and busy ones never do", async () => {
    const { dispatchTool } = fakeTools(fixtures())
    const j = judgeHost(replies())
    await run(dispatchTool, j.host)
    const judged = [...j.prompts.values()].map(p => /"sessionId": "([^"]+)"/.exec(p)?.[1]).sort()
    expect(judged).toEqual(["sess_asker", "sess_audit", "sess_pyg"])
    expect(j.released).toHaveLength(3)
  })

  it("is read-only: only model_roles, session_list and session_evidence are ever called", async () => {
    const { dispatchTool, calls } = fakeTools(fixtures())
    await run(dispatchTool, judgeHost(replies()).host)
    expect([...new Set(calls.map(c => c.name))].sort()).toEqual(["model_roles", "session_evidence", "session_list"])
  })

  it("never trusts a judge that answers `active` or replies garbage: the idle session lands as parked", async () => {
    const { dispatchTool } = fakeTools(fixtures())
    const j = judgeHost({
      sess_audit: judgeJson("sess_audit", "active", 0.99, false, "still working"),
      sess_pyg: "probably blocked, not sure",
    })
    const out = await run(dispatchTool, j.host)
    const byId = Object.fromEntries(out.items.map(i => [i.sessionId, i]))
    expect(byId.sess_audit!.verdict).toBe("parked")
    expect(byId.sess_pyg!.verdict).toBe("parked")
  })

  it("judge: rules spawns no judge at all", async () => {
    const { dispatchTool } = fakeTools(fixtures())
    const j = judgeHost(replies())
    const out = await run(dispatchTool, j.host, { judge: "rules" })
    expect(j.host.spawn).not.toHaveBeenCalled()
    expect(out.items.find(i => i.sessionId === "sess_audit")!.verdict).toBe("parked")
  })

  it("never triages the calling session", async () => {
    const fx = fixtures()
    const self: Fixture = {
      row: { id: SELF, label: "me", status: "running", busy: false, lastActivityAt: minutesAgo(60) },
      evidence: { sessionId: SELF, idleMinutes: 60, busy: false, tokensIn: 10, tokensOut: 10, turns: [{ role: "assistant", text: "Should I continue?" }] },
    }
    const { dispatchTool } = fakeTools([...fx, self])
    const out = await run(dispatchTool, judgeHost(replies()).host, { callerSessionId: SELF })
    expect(out.items.some(i => i.sessionId === SELF)).toBe(false)
  })
})
