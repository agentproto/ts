import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import { canArchive, canUnarchive } from "./sessionArchive.logic.js"

function session(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 123,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("canArchive", () => {
  it("is true for a terminal-status, non-archived session", () => {
    expect(canArchive(session({ status: "exited" }))).toBe(true)
    expect(canArchive(session({ status: "killed" }))).toBe(true)
    expect(canArchive(session({ status: "error" }))).toBe(true)
  })

  it("is false for running/starting — only a terminal-status session may be archived", () => {
    expect(canArchive(session({ status: "running" }))).toBe(false)
    expect(canArchive(session({ status: "starting" }))).toBe(false)
  })

  it("is false for a session already archived", () => {
    expect(canArchive(session({ status: "exited", archived: true }))).toBe(false)
  })
})

describe("canUnarchive", () => {
  it("is true only when archived is exactly true", () => {
    expect(canUnarchive(session({ status: "exited", archived: true }))).toBe(true)
    expect(canUnarchive(session({ status: "exited", archived: false }))).toBe(false)
    expect(canUnarchive(session({ status: "exited" }))).toBe(false)
  })

  it("doesn't care about status — an archived row is always unarchivable", () => {
    // Not a real reachable combination (archive guards on terminal-only),
    // but the predicate itself has no status opinion — only unarchive lacks
    // a status guard by design (see the daemon's session_unarchive doc).
    expect(canUnarchive(session({ status: "running", archived: true }))).toBe(true)
  })
})
