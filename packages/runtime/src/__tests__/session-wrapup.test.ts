import { describe, expect, it } from "vitest"
import type { SessionDescriptor } from "../sessions.js"
import {
  planSessionWrapup,
  type SessionWrapupSignals,
  type PlanSessionWrapupInput,
} from "../session-wrapup.js"

/** A base agent-cli row, idle since `00:00:00`, resumable. Override per case. */
function row(over: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: 1234,
    status: "running",
    startedAt: "2026-07-23T00:00:00Z",
    lastActivityAt: "2026-07-23T00:00:00Z",
    adapterSlug: "claude-code",
    adapterSessionId: `acp-${over.id}`,
    cwd: "/tmp",
    ...over,
  }
}

// 45 minutes after the default `lastActivityAt` — clears the default 20min
// threshold.
const NOW = Date.parse("2026-07-23T00:45:00Z")
const IDLE_MINUTES_THRESHOLD = 20

function plan(
  sessions: SessionDescriptor[],
  signals: ReadonlyMap<string, SessionWrapupSignals> = new Map(),
  extra: Partial<PlanSessionWrapupInput> = {},
) {
  return planSessionWrapup({
    sessions,
    nowMs: NOW,
    idleMinutes: IDLE_MINUTES_THRESHOLD,
    signals,
    ...extra,
  })
}

function signalsFor(id: string, signals: SessionWrapupSignals): Map<string, SessionWrapupSignals> {
  return new Map([[id, signals]])
}

describe("planSessionWrapup — class: close", () => {
  it("idle past threshold + worktreeMerged + no pending tool call + not keepAlive ⇒ close", () => {
    const entries = plan([row({ id: "a" })], signalsFor("a", { worktreeMerged: true }))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.class).toBe("close")
    expect(entries[0]!.idleMinutes).toBe(45)
    expect(entries[0]!.reasons).toContain("worktreeMerged")
  })

  it("idle past threshold + parentEnded (no worktreeMerged) ⇒ close", () => {
    const entries = plan([row({ id: "a" })], signalsFor("a", { parentEnded: true }))
    expect(entries[0]!.class).toBe("close")
  })

  it("carries rssBytes through from the descriptor when present", () => {
    const entries = plan([row({ id: "a", rssBytes: 12_345 })], signalsFor("a", { worktreeMerged: true }))
    expect(entries[0]!.rssBytes).toBe(12_345)
  })
})

describe("planSessionWrapup — class: stuck", () => {
  it("status:starting, stuckStarting signal ⇒ stuck, regardless of idle span", () => {
    const entries = plan(
      [row({ id: "a", status: "starting", pid: null, lastActivityAt: undefined })],
      signalsFor("a", { stuckStarting: true }),
    )
    expect(entries[0]!.class).toBe("stuck")
  })
})

describe("planSessionWrapup — class: keep (not idle long enough yet)", () => {
  it("idle below threshold ⇒ keep, even with a worktreeMerged signal", () => {
    const entries = plan(
      [row({ id: "a", lastActivityAt: "2026-07-23T00:40:00Z" })], // 5min idle
      signalsFor("a", { worktreeMerged: true }),
    )
    expect(entries[0]!.class).toBe("keep")
    expect(entries[0]!.reasons).toContain("idle 5m < 20m")
  })

  it("idle below threshold, running, no signals at all ⇒ keep, not judge", () => {
    const entries = plan([row({ id: "a", lastActivityAt: "2026-07-23T00:44:00Z" })]) // 1min idle
    expect(entries[0]!.class).toBe("keep")
  })
})

describe("planSessionWrapup — class: judge (ambiguous)", () => {
  it("idle past threshold but no merge/parent-ended signal ⇒ judge", () => {
    const entries = plan([row({ id: "a" })])
    expect(entries[0]!.class).toBe("judge")
  })

  it("pendingToolCall blocks close even with idle + merge signal", () => {
    const entries = plan(
      [row({ id: "a" })],
      signalsFor("a", { worktreeMerged: true, pendingToolCall: true }),
    )
    expect(entries[0]!.class).toBe("judge")
    expect(entries[0]!.reasons).toContain("pendingToolCall")
  })

  it("status:starting, not yet stuck (young) ⇒ judge", () => {
    const entries = plan([row({ id: "a", status: "starting", pid: null })])
    expect(entries[0]!.class).toBe("judge")
    expect(entries[0]!.reasons).toContain("starting")
  })

  it("keepAlive + worktreeMerged ⇒ judge, NOT close", () => {
    const entries = plan(
      [row({ id: "a", keepAlive: true })],
      signalsFor("a", { worktreeMerged: true }),
    )
    expect(entries[0]!.class).toBe("judge")
    expect(entries[0]!.reasons.some(r => r.includes("keepAlive"))).toBe(true)
  })
})

describe("planSessionWrapup — class: keep (always-keep guards)", () => {
  it("busy ⇒ keep", () => {
    const entries = plan(
      [row({ id: "a", busy: true })],
      signalsFor("a", { worktreeMerged: true }),
    )
    expect(entries[0]!.class).toBe("keep")
    expect(entries[0]!.reasons).toContain("busy")
  })

  it("awaitingInput ⇒ keep", () => {
    const entries = plan([row({ id: "a", awaitingInput: true })], signalsFor("a", { worktreeMerged: true }))
    expect(entries[0]!.class).toBe("keep")
  })

  it("awaitingPermission ⇒ keep", () => {
    const entries = plan([row({ id: "a", awaitingPermission: true })], signalsFor("a", { worktreeMerged: true }))
    expect(entries[0]!.class).toBe("keep")
  })

  it("archived ⇒ keep", () => {
    const entries = plan([row({ id: "a", archived: true })], signalsFor("a", { worktreeMerged: true }))
    expect(entries[0]!.class).toBe("keep")
  })

  it("pinned ⇒ keep", () => {
    const entries = plan([row({ id: "a", pinned: true })], signalsFor("a", { worktreeMerged: true }))
    expect(entries[0]!.class).toBe("keep")
  })

  it("childrenBusy > 0 ⇒ keep", () => {
    const entries = plan([row({ id: "a", childrenBusy: 1 })], signalsFor("a", { worktreeMerged: true }))
    expect(entries[0]!.class).toBe("keep")
  })

  it("a running parent ⇒ keep (don't orphan an active orchestration)", () => {
    const entries = plan(
      [
        row({ id: "parent", status: "running" }),
        row({ id: "child", parentSessionId: "parent", depth: 1 }),
      ],
      signalsFor("child", { worktreeMerged: true }),
    )
    const child = entries.find(e => e.sessionId === "child")!
    expect(child.class).toBe("keep")
    expect(child.reasons).toContain("parentRunning")
  })

  it("the caller's own session ⇒ keep", () => {
    const entries = plan(
      [row({ id: "a" })],
      signalsFor("a", { worktreeMerged: true }),
      { callerSessionId: "a" },
    )
    expect(entries[0]!.class).toBe("keep")
    expect(entries[0]!.reasons).toContain("callerSession")
  })
})

describe("planSessionWrapup — out of scope", () => {
  it("skips non-agent-cli kinds entirely (no entry)", () => {
    const entries = plan([row({ id: "pty", kind: "terminal", pty: true })])
    expect(entries).toEqual([])
  })

  it("skips already-terminal rows entirely (no entry)", () => {
    const entries = plan([row({ id: "done", status: "killed" })])
    expect(entries).toEqual([])
  })

  it("a gone/terminal parent no longer shields its idle child", () => {
    const entries = plan(
      [
        row({ id: "parent", status: "killed" }),
        row({ id: "child", parentSessionId: "parent", depth: 1 }),
      ],
      signalsFor("child", { worktreeMerged: true }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.sessionId).toBe("child")
    expect(entries[0]!.class).toBe("close")
  })
})
