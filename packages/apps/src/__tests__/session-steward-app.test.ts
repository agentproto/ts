/**
 * `session-steward` is a hand-authored bundled app (`.agentproto/APP.md` +
 * `agents/` + `workflows/`), like `repo-maintenance`. This loads the REAL
 * on-disk files through `loadAppHandle` (the loader `app_install` uses), so a
 * frontmatter/schema mistake fails here instead of at install time.
 */

import { describe, it, expect } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadAppHandle } from "@agentproto/app-kit"

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "session-steward")
const ENTRY = join(APP_DIR, ".agentproto", "workflows", "session-steward", "entry.mjs")

type Step = { kind: string; tool?: unknown; steps?: unknown }
const toolsOf = (workflow: { steps: unknown }): Set<string> => {
  const tools = new Set<string>()
  const walk = (steps: ReadonlyArray<Step>) => {
    for (const s of steps) {
      if (s.kind === "tool" && typeof s.tool === "string") tools.add(s.tool)
      if (Array.isArray(s.steps)) walk(s.steps as never)
    }
  }
  walk(workflow.steps as never)
  return tools
}

describe("session-steward app", () => {
  it("loads through loadAppHandle with the expected identity and attachment", async () => {
    const app = await loadAppHandle(APP_DIR)
    expect(app.id).toBe("@agentproto/session-steward")
    expect(app.agents.map(a => a.agent.id)).toEqual(["@agentproto/session-steward-judge", "@agentproto/session-steward-analyst"])
    expect(app.workflows.map(w => w.id)).toEqual(["session-steward", "session-steward-classify", "session-steward-analyze", "session-steward-act"])
    expect(app.agents[0]!.agent.workflows).toContainEqual({ ref: "session-steward" })
    expect(app.agents[1]!.agent.workflows).toContainEqual({ ref: "session-steward-analyze" })
  })

  it("scopes the judge's gateway to the one read-only evidence tool", async () => {
    const app = await loadAppHandle(APP_DIR)
    const { agent } = app.agents[0]!
    expect(agent.tools).toEqual(["session_evidence"])
    expect(agent.model).toBe("role:judge.session")
  })

  it("routes every SESSION mutation through session_wrapup_apply — the app_state ledger is the only other write", async () => {
    const app = await loadAppHandle(APP_DIR)
    const tools = toolsOf(app.workflows.find(w => w.id === "session-steward")!)
    expect([...tools].sort()).toEqual([
      "agent_prompt",
      "app_list",
      "app_state_append",
      "app_state_list",
      "host_load",
      "model_roles",
      "session_evidence",
      "session_judge_jev",
      "session_list",
      "session_monitor",
      "session_wrapup_apply",
      "session_wrapup_plan",
      "tool_calls_list",
    ])
    // The only session-closing tool is session_wrapup_apply; the only other
    // write is the append-only verdict-memory ledger (never a session).
    expect(tools.has("session_wrapup_apply")).toBe(true)
    expect(tools.has("app_state_append")).toBe(true)
    expect(tools.has("agent_kill")).toBe(false)
    expect(tools.has("session_restart")).toBe(false)
  })

  it("the two-step workflows keep the mutation boundary: classify/analyze never touch a session", async () => {
    const app = await loadAppHandle(APP_DIR)
    const SESSION_MUTATORS = ["session_wrapup_apply", "agent_kill", "session_archive", "session_restart", "session_continue_fresh", "agent_prompt"]
    const classify = toolsOf(app.workflows.find(w => w.id === "session-steward-classify")!)
    const analyze = toolsOf(app.workflows.find(w => w.id === "session-steward-analyze")!)
    const act = toolsOf(app.workflows.find(w => w.id === "session-steward-act")!)
    // classify/analyze/act all read & write the snapshot through the app data dir.
    for (const t of [classify, analyze, act]) expect(t.has("app_data_read") || t.has("app_data_write")).toBe(true)
    // analyze is read-only on sessions: evidence in, snapshot out.
    expect(SESSION_MUTATORS.filter(m => analyze.has(m))).toEqual([])
    // classify only mutates in its one-shot `apply` half, which is the same act graph.
    expect([...classify].filter(t => SESSION_MUTATORS.includes(t)).sort()).toEqual([...act].filter(t => SESSION_MUTATORS.includes(t)).sort())
    // the act half uses only the closed set of daemon verbs.
    expect(SESSION_MUTATORS.filter(m => act.has(m)).sort()).toEqual(["agent_kill", "agent_prompt", "session_archive", "session_continue_fresh", "session_restart", "session_wrapup_apply"].sort())
  })

  describe("judge model comes from the judge.session role", () => {
    const loadEntry = async () =>
      (await import(ENTRY)) as {
        resolveSettings: (input: unknown, modelRoles?: unknown) => { judgeModel?: string }
        default: { steps: Array<{ id: string; tool?: string; inputs?: unknown; steps?: Array<{ id: string; model?: unknown }> }> }
      }

    it("asks model_roles for judge.session with the explicit judgeModel as its top layer", async () => {
      const { default: wf } = await loadEntry()
      const step = wf.steps.find(s => s.id === "modelRoles")!
      expect(step.tool).toBe("model_roles")
      expect(step.inputs).toEqual({ roles: ["judge.session"], inputs: { "judge.session": "$input.judgeModel" } })
    })

    it("defaults judgeModel to the resolved role", async () => {
      const { resolveSettings } = await loadEntry()
      expect(resolveSettings({}, { models: { "judge.session": "cfg-judge" } }).judgeModel).toBe("cfg-judge")
      expect(resolveSettings({ judgeModel: "  " }, { models: { "judge.session": "cfg-judge" } }).judgeModel).toBe("cfg-judge")
    })

    it("an explicit judgeModel input wins over the role", async () => {
      const { resolveSettings } = await loadEntry()
      expect(resolveSettings({ judgeModel: "in-judge" }, { models: { "judge.session": "cfg-judge" } }).judgeModel).toBe("in-judge")
    })

    it("has no hard-coded fallback: no role resolution leaves the judge AGENT.md model in charge", async () => {
      const { resolveSettings } = await loadEntry()
      expect(resolveSettings({}).judgeModel).toBeUndefined()
    })

    it("the judge step's model selector reads settings.judgeModel", async () => {
      const { default: wf } = await loadEntry()
      const judge = wf.steps.find(s => s.id === "judge")!
      const sel = judge.steps!.find(s => s.id === "judgeOne")!.model as (b: unknown) => string | undefined
      expect(sel({ steps: { settings: { judgeModel: "cfg-judge" } } })).toBe("cfg-judge")
    })
  })
})
