import { describe, it, expect } from "vitest"
import { isResumable, type SessionDescriptor } from "../sessions.js"

/**
 * Truth table for the in-place-resume eligibility predicate (§5 of the
 * session-survivability contract). The base predicate is deliberately
 * reason-agnostic: it gates on kind + the resume essentials
 * (adapterSlug/adapterSessionId/cwd) + not-archived, so the lazy
 * resume-on-prompt path honours an operator's deliberate prompt to any killed
 * row. The eager boot pass (PR-4) layers `endedReason === "daemon-restart"` on
 * top — that clause is NOT tested here because it isn't part of this predicate.
 */
describe("isResumable", () => {
  const base = (over: Partial<SessionDescriptor> = {}): SessionDescriptor => ({
    id: "sess_x",
    kind: "agent-cli",
    workspaceSlug: "default",
    command: "claude (agent)",
    pid: null,
    status: "killed",
    startedAt: "2026-07-23T00:00:00Z",
    adapterSlug: "claude-code",
    adapterSessionId: "acp-abc",
    cwd: "/tmp",
    ...over,
  })

  it("agent-cli with adapterSlug + adapterSessionId + cwd, not archived → resumable", () => {
    expect(isResumable(base())).toBe(true)
  })

  it("resumable regardless of endedReason (reason-agnostic base predicate)", () => {
    // A user-killed row (no daemon-restart reason) is still resumable via the
    // lazy path — a deliberate prompt is explicit operator intent (§5).
    expect(isResumable(base({ endedReason: undefined }))).toBe(true)
    expect(isResumable(base({ endedReason: "daemon-restart" }))).toBe(true)
  })

  it("PTY session → never resumable", () => {
    expect(isResumable(base({ kind: "terminal", pty: true }))).toBe(false)
  })

  it("command session → never resumable", () => {
    expect(isResumable(base({ kind: "command" }))).toBe(false)
  })

  it("archived row → never resumable", () => {
    expect(isResumable(base({ archived: true }))).toBe(false)
  })

  it("missing adapterSessionId → not resumable (nothing for loadSession to rehydrate)", () => {
    expect(isResumable(base({ adapterSessionId: undefined }))).toBe(false)
  })

  it("missing adapterSlug → not resumable (no adapter to re-spawn)", () => {
    expect(isResumable(base({ adapterSlug: undefined }))).toBe(false)
  })

  it("missing cwd → not resumable (nowhere to re-spawn the adapter)", () => {
    expect(isResumable(base({ cwd: undefined }))).toBe(false)
  })
})
