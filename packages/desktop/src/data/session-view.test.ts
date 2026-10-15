import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "./types"
import { sessionHandle, sessionMatchesFilter, sessionTitle } from "./session-view"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess_abc123",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude-code --print",
    status: "running",
    ...over,
  }
}

describe("sessionHandle", () => {
  it("prefers the unique human slug over the machine id", () => {
    expect(sessionHandle(session({ slug: "fix-login-bug" }))).toBe("fix-login-bug")
  })

  it("falls back to the id when no slug was minted", () => {
    expect(sessionHandle(session({ slug: undefined }))).toBe("sess_abc123")
  })
})

describe("sessionMatchesFilter", () => {
  it("accepts a slug as a session reference", () => {
    const s = session({ slug: "fix-login-bug", title: "Fix the login bug" })
    expect(sessionMatchesFilter(s, "fix-login-bug")).toBe(true)
    // A partial reference narrows too, like the free-text rail filter expects.
    expect(sessionMatchesFilter(s, "login")).toBe(true)
  })

  it("still accepts the id and the display title", () => {
    const s = session({ slug: "fix-login-bug", title: "Fix the login bug" })
    expect(sessionMatchesFilter(s, "sess_abc123")).toBe(true)
    expect(sessionMatchesFilter(s, "Fix the login bug")).toBe(true)
  })

  it("matches everything on an empty query and nothing on an unrelated one", () => {
    const s = session({ slug: "fix-login-bug" })
    expect(sessionMatchesFilter(s, "")).toBe(true)
    expect(sessionMatchesFilter(s, "unrelated")).toBe(false)
  })
})

describe("sessionTitle (unchanged display chain)", () => {
  it("does not put the slug into the display title", () => {
    expect(sessionTitle(session({ slug: "fix-login-bug", title: "Fix the login bug" }))).toBe(
      "Fix the login bug",
    )
  })
})
