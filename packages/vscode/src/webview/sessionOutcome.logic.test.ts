import { describe, expect, it } from "vitest"

import type { SessionOutcome } from "../client/types.js"
import { OUTCOME_HINT_MAX, failureCauseFor, outcomeCardFor, outcomeHintFor } from "./sessionOutcome.logic.js"

const base = (over: Partial<SessionOutcome> = {}): SessionOutcome => ({
  source: "derived",
  status: "produced",
  summary: "Done.",
  termination: { status: "exited", exitCode: 0 },
  recordedAt: "2026-09-26T10:00:00Z",
  ...over,
})

describe("outcomeCardFor", () => {
  it("is null without an outcome (live session, or older than the feature)", () => {
    expect(outcomeCardFor({})).toBeNull()
    expect(outcomeCardFor(undefined)).toBeNull()
  })

  it("names the termination per reason, keeping it apart from the outcome status", () => {
    const term = (termination: SessionOutcome["termination"]) => outcomeCardFor({ outcome: base({ termination }) })!.termination
    expect(term({ status: "killed" })).toBe("killed")
    expect(term({ status: "killed", midTurn: true })).toBe("killed · mid-turn")
    expect(term({ status: "killed", reason: "idle-reaped" })).toBe("idle-reaped")
    expect(term({ status: "killed", reason: "daemon-restart", midTurn: true })).toBe("killed · daemon restart · mid-turn")
    expect(term({ status: "killed", reason: "crashed" })).toBe("crashed")
    expect(term({ status: "exited", exitCode: 2 })).toBe("exited · code 2")
    expect(term({ status: "killed", reason: "workflow-released" })).toBe("killed · workflow released")
  })

  it("tones: produced exit ok, operator kill warn, error/crash red, empty muted", () => {
    const tone = (o: Partial<SessionOutcome>) => outcomeCardFor({ outcome: base(o) })!.tone
    expect(tone({})).toBe("ok")
    expect(tone({ termination: { status: "killed" } })).toBe("warn")
    expect(tone({ termination: { status: "killed", reason: "idle-reaped" } })).toBe("ok")
    expect(tone({ termination: { status: "error" } })).toBe("error")
    expect(tone({ termination: { status: "killed", reason: "crashed" } })).toBe("error")
    expect(tone({ status: "empty", summary: undefined, termination: { status: "killed" } })).toBe("muted")
  })

  it("formats duration, cost and tokens", () => {
    const card = outcomeCardFor({
      outcome: base({ cost: { usd: 1.234, tokensIn: 12_300, tokensOut: 800, durationMs: 45_000 } }),
    })!
    expect(card.duration).toBe("45s")
    expect(card.cost).toBe("$1.23")
    expect(card.tokens).toBe("12.3k in · 800 out")
    expect(outcomeCardFor({ outcome: base({ cost: { durationMs: 3 * 3600_000 + 60_000 } }) })!.duration).toBe("3h 1m")
    expect(outcomeCardFor({ outcome: base({ cost: { durationMs: 90_000 } }) })!.duration).toBe("1m 30s")
    expect(outcomeCardFor({ outcome: base({ cost: { tokensIn: 1_240_000 } }) })!.tokens).toBe("1.2M in")
    expect(outcomeCardFor({ outcome: base() })!.cost).toBeUndefined()
  })

  it("maps artifacts and links to chips; only http(s) and sessions are clickable", () => {
    const card = outcomeCardFor({
      outcome: base({
        artifacts: [
          { type: "pr", ref: "https://github.com/o/r/pull/12" },
          { type: "commit", ref: "0123456789abcdef" },
          { type: "url", ref: "javascript:alert(1)" },
        ],
        links: [
          { rel: "run", ref: "run_1", title: "maintain/reviewOne" },
          { rel: "parent", ref: "sess_p" },
          { rel: "review", ref: "rev_9" },
        ],
      }),
    })!
    expect(card.artifacts).toEqual([
      { label: "PR #12", title: "https://github.com/o/r/pull/12", open: "external", target: "https://github.com/o/r/pull/12" },
      { label: "commit 0123456", title: "0123456789abcdef" },
      { label: "javascript:alert(1)", title: "javascript:alert(1)" },
    ])
    expect(card.links.map(l => [l.label, l.open])).toEqual([
      ["wf:maintain/reviewOne → run_1", undefined],
      ["parent sess_p", "session"],
      ["review rev_9", undefined],
    ])
  })

  it("marks only long summaries collapsible", () => {
    expect(outcomeCardFor({ outcome: base() })!.collapsible).toBe(false)
    expect(outcomeCardFor({ outcome: base({ summary: "a".repeat(300) }) })!.collapsible).toBe(true)
    expect(outcomeCardFor({ outcome: base({ summary: "a\nb\nc\nd" }) })!.collapsible).toBe(true)
  })

  it("survives injection by value (self-contained)", () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const injected = new Function(`${outcomeCardFor.toString()}; return outcomeCardFor`)() as typeof outcomeCardFor
    expect(injected({ outcome: base({ termination: { status: "killed", midTurn: true } }) })!.termination).toBe("killed · mid-turn")
  })
})

describe("outcomeHintFor", () => {
  it("is undefined for live sessions and sessions without an outcome", () => {
    expect(outcomeHintFor({ status: "exited" })).toBeUndefined()
    expect(outcomeHintFor({ status: "running", outcome: { status: "produced", summary: "x" } })).toBeUndefined()
  })

  it("clamps the summary for an ended session (full or compact outcome)", () => {
    const hint = outcomeHintFor({ status: "killed", outcome: { status: "produced", summary: "word ".repeat(40) } })!
    expect(hint.muted).toBe(false)
    expect(hint.text.length).toBe(OUTCOME_HINT_MAX)
    expect(hint.text.endsWith("…")).toBe(true)
  })

  it("says 'no output', muted, for an empty outcome", () => {
    expect(outcomeHintFor({ status: "exited", outcome: { status: "empty" } })).toEqual({ text: "no output", muted: true })
  })
})

describe("failureCauseFor", () => {
  it("maps a worktree setup hook failure to its command", () => {
    expect(
      failureCauseFor(
        "agent_start: worktree provisioning failed \u2014 worktree setup hook failed (exit 1): pnpm build\nnpm warn something",
      ),
    ).toBe("setup failed \u00b7 pnpm build")
  })

  it("maps an unknown adapter mode", () => {
    expect(
      failureCauseFor("agent_start: spawn failed \u2014 [unknown_mode at config.mode] Mode 'background' is not declared by adapter x"),
    ).toBe("spawn failed \u00b7 unknown mode 'background'")
  })

  it("maps an existing branch", () => {
    expect(failureCauseFor("agent_start: fatal: a branch named 'feat/x' already exists")).toBe("branch feat/x already exists")
  })

  it("skips .npmrc / NODE_AUTH_TOKEN warning lines and falls back to the first line, clamped", () => {
    expect(failureCauseFor("warn Unknown env config NODE_AUTH_TOKEN in .npmrc\nboom happened")).toBe("boom happened")
    const long = failureCauseFor("word ".repeat(60))!
    expect(long.length).toBe(OUTCOME_HINT_MAX)
    expect(long.endsWith("\u2026")).toBe(true)
  })

  it("is undefined when there is nothing meaningful", () => {
    expect(failureCauseFor(undefined)).toBeUndefined()
    expect(failureCauseFor("agent_start: \n.npmrc warning")).toBeUndefined()
  })
})

describe("outcomeHintFor \u2014 errored session", () => {
  it("shows the cause (not muted, error-flagged, full lastError as title) instead of 'no output'", () => {
    const lastError = "agent_start: spawn failed \u2014 Mode 'background' is not declared"
    expect(outcomeHintFor({ status: "error", lastError, outcome: { status: "empty" } })).toEqual({
      text: "spawn failed \u00b7 unknown mode 'background'",
      muted: false,
      error: true,
      title: lastError,
    })
  })

  it("keeps 'no output' when the error session has no lastError", () => {
    expect(outcomeHintFor({ status: "error", outcome: { status: "empty" } })).toEqual({ text: "no output", muted: true })
  })
})
