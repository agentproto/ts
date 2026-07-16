import { describe, expect, it } from "vitest"

import { isPendingSession, makePendingSession, PENDING_ID_PREFIX } from "./pending.logic.js"

const STARTED_AT = "2026-07-16T12:00:00.000Z"

describe("makePendingSession", () => {
  it("wears the label the operator chose", () => {
    const row = makePendingSession({ label: "reviewer", adapterSlug: "claude-code" }, 1, STARTED_AT)
    expect(row.label).toBe("reviewer")
  })

  it("falls back to the adapter, then to a generic name", () => {
    expect(makePendingSession({ adapterSlug: "claude-code" }, 1, STARTED_AT).label).toBe("claude-code")
    expect(makePendingSession({}, 1, STARTED_AT).label).toBe("agent")
  })

  it("is 'starting' — the state that paints a spinner, and the true one", () => {
    expect(makePendingSession({}, 1, STARTED_AT).status).toBe("starting")
  })

  it("carries the draft through so the row reads like the session it will become", () => {
    const row = makePendingSession(
      { label: "reviewer", adapterSlug: "claude-code", model: "opus", cwd: "/tmp/x", workspaceSlug: "ws" },
      1,
      STARTED_AT,
    )
    expect(row.adapterSlug).toBe("claude-code")
    expect(row.model).toBe("opus")
    expect(row.cwd).toBe("/tmp/x")
    expect(row.workspaceSlug).toBe("ws")
  })

  it("has no pid, because there is no process yet", () => {
    expect(makePendingSession({}, 1, STARTED_AT).pid).toBeNull()
  })

  it("gives each spawn its own id", () => {
    const a = makePendingSession({}, 1, STARTED_AT)
    const b = makePendingSession({}, 2, STARTED_AT)
    expect(a.id).not.toBe(b.id)
  })
})

describe("isPendingSession", () => {
  it("recognises a row we invented", () => {
    expect(isPendingSession(makePendingSession({}, 1, STARTED_AT))).toBe(true)
    expect(isPendingSession({ id: `${PENDING_ID_PREFIX}9` })).toBe(true)
  })

  it("does not claim a real daemon session", () => {
    expect(isPendingSession({ id: "sess_79ef158f" })).toBe(false)
  })
})
