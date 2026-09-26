import { describe, expect, it } from "vitest"
import { formatOutcomeBlock } from "../commands/sessions.js"

describe("sessions show — OUTCOME block", () => {
  it("prints status, termination, summary, artifacts, links and cost", () => {
    const text = formatOutcomeBlock({
      source: "derived",
      status: "produced",
      summary: "Opened the PR, waiting on CI.",
      termination: { status: "killed", reason: "idle-reaped", midTurn: true },
      cost: { usd: 0.4213, tokensIn: 1200, tokensOut: 300, durationMs: 90_000 },
      artifacts: [{ type: "pr", ref: "https://github.com/o/r/pull/42", title: "#42" }],
      links: [{ rel: "run", ref: "wfrun_1", title: "maintain/review" }],
      recordedAt: "2026-09-26T00:00:00.000Z",
    })
    expect(text).toContain("OUTCOME  produced  (ended: killed · idle-reaped · mid-turn)")
    expect(text).toContain("summary:  Opened the PR, waiting on CI.")
    expect(text).toContain("pr:       https://github.com/o/r/pull/42  #42")
    expect(text).toContain("run:      wfrun_1  maintain/review")
    expect(text).toContain("cost:     $0.42 · 1200 in · 300 out")
  })

  it("an empty outcome prints just its header", () => {
    const text = formatOutcomeBlock({
      source: "derived",
      status: "empty",
      termination: { status: "exited", exitCode: 0 },
      recordedAt: "2026-09-26T00:00:00.000Z",
    })
    expect(text).toBe("OUTCOME  empty  (ended: exited · exit 0)\n")
  })
})
