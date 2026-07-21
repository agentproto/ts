/**
 * Unit tests for `sessionDisplayName` (session-title.ts) — the daemon-side
 * source of truth for the display-name precedence. Hand-mirrored by the VS
 * Code `sessionName.ts`; the two suites assert the SAME chain.
 */

import { describe, expect, it } from "vitest"

import { sessionDisplayName, shortSessionId, type SessionNameFields } from "../session-title.js"

function session(over: Partial<SessionNameFields> = {}): SessionNameFields {
  return { id: "s1", kind: "agent-cli", ...over }
}

describe("sessionDisplayName — user-renamed-label > title > spawn-label > fallback", () => {
  it("prefers a USER-renamed label over the derived title", () => {
    expect(
      sessionDisplayName(session({ label: "sales", title: "Fix bug", renamedByUser: true })),
    ).toBe("sales")
  })

  it("lets the derived title outrank a SPAWN label (renamedByUser: false)", () => {
    expect(
      sessionDisplayName(
        session({
          label: "auto-title-precedence-fix",
          title: "Fix session auto-titling",
          renamedByUser: false,
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
    expect(
      sessionDisplayName(session({ label: "My Old Rename", title: "derived", renamedByUser: undefined })),
    ).toBe("My Old Rename")
  })

  it("falls back to the derived title when there is no label", () => {
    expect(sessionDisplayName(session({ title: "Fix the login bug" }))).toBe("Fix the login bug")
  })

  it("falls back to `adapterSlug · short-id` when neither label nor title is set", () => {
    expect(sessionDisplayName(session({ adapterSlug: "claude-code" }))).toBe("claude-code · s1")
  })

  it("uses `kind` when there is no adapterSlug", () => {
    expect(sessionDisplayName(session())).toBe("agent-cli · s1")
  })

  it("shortens a long real session id to its last 6 chars in the fallback", () => {
    expect(sessionDisplayName(session({ id: "sess_abcdef123456", adapterSlug: "hermes" }))).toBe(
      "hermes · 123456",
    )
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
