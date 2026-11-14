/**
 * `launched-by.ts`: the pure derivation behind the `LAUNCHED BY` column and
 * `session_list`'s `launchedBy` text. Precedence, empty-as-absent, and the
 * `via` rules are all pinned here so the two surfaces cannot drift.
 */

import { describe, it, expect } from "vitest"
import { launchedByOf, launchedByText } from "../launched-by.js"

describe("launchedByOf", () => {
  const all = {
    parentSessionId: "sess_parent",
    callerSessionId: "sess_caller",
    operatorLabel: "ops",
    origin: "vscode",
  }

  it("prefers parent over caller over operator over origin", () => {
    expect(launchedByOf(all)).toEqual({ kind: "session", sessionId: "sess_parent", via: "vscode" })
    expect(launchedByOf({ ...all, parentSessionId: undefined })).toEqual({
      kind: "session",
      sessionId: "sess_caller",
      via: "vscode",
    })
    expect(
      launchedByOf({ ...all, parentSessionId: undefined, callerSessionId: undefined }),
    ).toEqual({ kind: "operator", via: "vscode" })
    expect(
      launchedByOf({
        ...all,
        parentSessionId: undefined,
        callerSessionId: undefined,
        operatorLabel: undefined,
      }),
    ).toEqual({ kind: "origin", origin: "vscode" })
  })

  it("returns each kind when it is the only field set", () => {
    expect(launchedByOf({ parentSessionId: "sess_parent" })).toEqual({
      kind: "session",
      sessionId: "sess_parent",
    })
    expect(launchedByOf({ callerSessionId: "sess_caller" })).toEqual({
      kind: "session",
      sessionId: "sess_caller",
    })
    expect(launchedByOf({ operatorLabel: "ops" })).toEqual({ kind: "operator" })
    expect(launchedByOf({ origin: "cron" })).toEqual({ kind: "origin", origin: "cron" })
  })

  it("returns undefined when no field is set", () => {
    expect(launchedByOf({})).toBeUndefined()
  })

  it("treats empty strings as absent everywhere", () => {
    expect(launchedByOf({ parentSessionId: "", callerSessionId: "", operatorLabel: "", origin: "" })).toBeUndefined()
    expect(launchedByOf({ parentSessionId: "", callerSessionId: "sess_caller" })).toEqual({
      kind: "session",
      sessionId: "sess_caller",
    })
    expect(launchedByOf({ parentSessionId: "", operatorLabel: "ops" })).toEqual({ kind: "operator" })
    expect(launchedByOf({ operatorLabel: "", origin: "cron" })).toEqual({ kind: "origin", origin: "cron" })
  })

  it("keeps a whitespace-only value as given", () => {
    expect(launchedByOf({ parentSessionId: " " })).toEqual({ kind: "session", sessionId: " " })
    expect(launchedByOf({ origin: " " })).toEqual({ kind: "origin", origin: " " })
  })

  it("adds via only for session and operator kinds, and only when origin is non-empty", () => {
    expect(launchedByOf({ parentSessionId: "sess_parent", origin: "codex" })).toEqual({
      kind: "session",
      sessionId: "sess_parent",
      via: "codex",
    })
    expect(launchedByOf({ parentSessionId: "sess_parent", origin: "" })).toEqual({
      kind: "session",
      sessionId: "sess_parent",
    })
    expect(launchedByOf({ operatorLabel: "ops", origin: "" })).toEqual({ kind: "operator" })
    expect(launchedByOf({ origin: "cron" })).not.toHaveProperty("via")
  })
})

describe("launchedByText", () => {
  it("returns an empty string for undefined", () => {
    expect(launchedByText(undefined)).toBe("")
  })

  it("renders a session with and without a label, and with and without via", () => {
    expect(launchedByText({ kind: "session", sessionId: "sess_1" })).toBe("session sess_1")
    expect(launchedByText({ kind: "session", sessionId: "sess_1" }, () => "brain")).toBe(
      "session sess_1 (brain)",
    )
    expect(launchedByText({ kind: "session", sessionId: "sess_1" }, () => "")).toBe("session sess_1")
    expect(launchedByText({ kind: "session", sessionId: "sess_1" }, () => undefined)).toBe(
      "session sess_1",
    )
    expect(launchedByText({ kind: "session", sessionId: "sess_1", via: "pygmalion" })).toBe(
      "session sess_1 via pygmalion",
    )
    expect(launchedByText({ kind: "session", sessionId: "sess_1", via: "pygmalion" }, () => "brain")).toBe(
      "session sess_1 (brain) via pygmalion",
    )
  })

  it("renders an operator with and without via", () => {
    expect(launchedByText({ kind: "operator" })).toBe("operator")
    expect(launchedByText({ kind: "operator", via: "vscode" })).toBe("operator via vscode")
  })

  it("renders an origin as the origin string", () => {
    expect(launchedByText({ kind: "origin", origin: "cron" })).toBe("cron")
  })
})
