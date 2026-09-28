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

describe("session-steward app", () => {
  it("loads through loadAppHandle with the expected identity and attachment", async () => {
    const app = await loadAppHandle(APP_DIR)
    expect(app.id).toBe("@agentproto/session-steward")
    expect(app.agents.map(a => a.agent.id)).toEqual(["@agentproto/session-steward-judge"])
    expect(app.workflows.map(w => w.id)).toEqual(["session-steward"])
    expect(app.agents[0]!.agent.workflows).toContainEqual({ ref: "session-steward" })
  })

  it("scopes the judge's gateway to the one read-only evidence tool", async () => {
    const app = await loadAppHandle(APP_DIR)
    const { agent } = app.agents[0]!
    expect(agent.tools).toEqual(["session_evidence"])
    expect(agent.model).toBe("claude-haiku-4-5-20251001")
  })

  it("routes every mutation through session_wrapup_apply — nowhere else", async () => {
    const app = await loadAppHandle(APP_DIR)
    const [workflow] = app.workflows
    const tools = new Set<string>()
    const walk = (steps: ReadonlyArray<{ kind: string; tool?: unknown; steps?: unknown }>) => {
      for (const s of steps) {
        if (s.kind === "tool" && typeof s.tool === "string") tools.add(s.tool)
        if (Array.isArray(s.steps)) walk(s.steps as never)
      }
    }
    walk(workflow!.steps as never)
    expect([...tools].sort()).toEqual([
      "agent_prompt",
      "session_evidence",
      "session_judge_jev",
      "session_monitor",
      "session_wrapup_apply",
      "session_wrapup_plan",
    ])
  })
})
