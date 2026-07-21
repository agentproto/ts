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
  it("prefers a USER-renamed label over the derived title", () => {
    expect(
      sessionDisplayName(
        session({ label: "sales", title: "Fix bug", renamedByUser: true, adapterSlug: "claude-code" }),
      ),
    ).toBe("sales")
  })

  it("lets the derived title outrank a SPAWN label (renamedByUser: false)", () => {
    expect(
      sessionDisplayName(
        session({
          label: "auto-title-precedence-fix",
          title: "Fix session auto-titling",
          renamedByUser: false,
          adapterSlug: "claude-code",
        }),
      ),
    ).toBe("Fix session auto-titling")
  })

  it("shows a spawn label when there is no derived title to prefer", () => {
    expect(
      sessionDisplayName(session({ label: "worker-3", title: undefined, renamedByUser: false })),
    ).toBe("worker-3")
  })

  it("treats a pre-flag labelled session (no renamedByUser) as user-renamed for back-compat", () => {
    // An old persisted session: a `label`, no flag. The pre-flag rename path
    // also wrote `label`, so we can't tell an old rename from an old spawn slug
    // — keep the label winning so no prior rename is silently lost.
    expect(
      sessionDisplayName(session({ label: "My Old Rename", title: "derived", renamedByUser: undefined })),
    ).toBe("My Old Rename")
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
