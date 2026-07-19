import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "./types.js"
import { sessionDisplayName, shortSessionId } from "./sessionName.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude-code --print",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("sessionDisplayName (FIX D — the one name source of truth)", () => {
  it("prefers label over everything", () => {
    expect(
      sessionDisplayName(session({ label: "sales", title: "Fix bug", adapterSlug: "claude-code" })),
    ).toBe("sales")
  })

  it("falls back to the derived title when label is unset", () => {
    expect(sessionDisplayName(session({ label: undefined, title: "Fix the login bug" }))).toBe(
      "Fix the login bug",
    )
  })

  it("falls back to `adapterSlug · short-id` when both label and title are unset", () => {
    expect(
      sessionDisplayName(session({ label: undefined, title: undefined, adapterSlug: "claude-code" })),
    ).toBe("claude-code · s1")
  })

  it("uses `kind` when there is no adapterSlug", () => {
    expect(sessionDisplayName(session({ label: undefined, title: undefined }))).toBe(
      "agent-cli · s1",
    )
  })

  it("shortens a long real session id to its last 6 chars in the fallback", () => {
    expect(
      sessionDisplayName(
        session({ id: "sess_abcdef123456", label: undefined, title: undefined, adapterSlug: "hermes" }),
      ),
    ).toBe("hermes · 123456")
  })
})

describe("shortSessionId", () => {
  it("returns short ids whole", () => {
    expect(shortSessionId("s1")).toBe("s1")
    expect(shortSessionId("12345678")).toBe("12345678")
  })
  it("collapses a long id to its last 6 chars", () => {
    expect(shortSessionId("sess_abcdef123456")).toBe("123456")
  })
})
