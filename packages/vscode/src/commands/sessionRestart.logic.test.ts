import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import { canRestart, describeRestart, parseRestartResult } from "./sessionRestart.logic.js"

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

describe("canRestart", () => {
  it("is true for terminal statuses (exited/killed/error)", () => {
    expect(canRestart(session({ status: "exited" }))).toBe(true)
    expect(canRestart(session({ status: "killed" }))).toBe(true)
    expect(canRestart(session({ status: "error" }))).toBe(true)
  })

  it("is false for running/starting", () => {
    expect(canRestart(session({ status: "running" }))).toBe(false)
    expect(canRestart(session({ status: "starting" }))).toBe(false)
  })

  it("is false for a terminal-status session still awaiting input (contextValueFor gates on status first)", () => {
    expect(canRestart(session({ status: "exited", awaitingInput: true }))).toBe(true)
  })
})

describe("parseRestartResult", () => {
  it("parses a full agent-resume result", () => {
    const result = parseRestartResult({
      id: "sess_new1",
      label: "my-session",
      kind: "agent-cli",
      resumedFrom: "sess_old1",
      resumeVia: "claude --resume",
      pty: false,
    })
    expect(result).toEqual({
      id: "sess_new1",
      label: "my-session",
      kind: "agent-cli",
      resumedFrom: "sess_old1",
      resumeVia: "claude --resume",
      pty: false,
    })
  })

  it("tolerates missing optionals, keeping only id", () => {
    expect(parseRestartResult({ id: "sess_new1" })).toEqual({ id: "sess_new1" })
  })

  it("normalizes a boolean resumeFallback flag into a descriptive string", () => {
    const result = parseRestartResult({ id: "sess_new1", resumeFallback: true })
    expect(result?.resumeFallback).toBeTypeOf("string")
    expect(result?.resumeFallback?.length).toBeGreaterThan(0)
  })

  it("passes through a string resumeFallback unchanged", () => {
    const result = parseRestartResult({ id: "sess_new1", resumeFallback: "adapter rejected resume id" })
    expect(result?.resumeFallback).toBe("adapter rejected resume id")
  })

  it("ignores a false resumeFallback flag", () => {
    const result = parseRestartResult({ id: "sess_new1", resumeFallback: false })
    expect(result?.resumeFallback).toBeUndefined()
  })

  it("returns undefined when id is missing", () => {
    expect(parseRestartResult({ label: "no-id-here" })).toBeUndefined()
  })

  it("returns undefined when id is not a string", () => {
    expect(parseRestartResult({ id: 123 })).toBeUndefined()
  })

  it("returns undefined for non-object input", () => {
    expect(parseRestartResult("sess_new1")).toBeUndefined()
    expect(parseRestartResult(null)).toBeUndefined()
    expect(parseRestartResult(undefined)).toBeUndefined()
    expect(parseRestartResult(42)).toBeUndefined()
  })

  it("ignores fields with the wrong type instead of throwing", () => {
    const result = parseRestartResult({ id: "sess_new1", label: 42, pty: "yes" })
    expect(result).toEqual({ id: "sess_new1" })
  })
})

describe("describeRestart", () => {
  it("names the new session and resume path", () => {
    const before = session({ id: "sess_old1", label: "before-label", status: "exited" })
    const message = describeRestart(before, {
      id: "sess_new1",
      label: "after-label",
      resumeVia: "claude --resume",
    })
    expect(message).toBe("agentproto: restarted before-label as after-label via claude --resume.")
  })

  it("omits the via clause when resumeVia is absent", () => {
    const before = session({ id: "sess_old1", status: "exited" })
    const message = describeRestart(before, { id: "sess_new1" })
    expect(message).toBe("agentproto: restarted sess_old1 as sess_new1.")
  })

  it("calls out the pty-native category flip for a restarted agent-cli session", () => {
    const before = session({ id: "sess_old1", kind: "agent-cli", status: "exited" })
    const message = describeRestart(before, { id: "sess_new1", pty: true, resumeVia: "pty-native" })
    expect(message).toContain(
      "Resumed as a terminal session (pty-native) — its transcript is raw output, not a conversation.",
    )
  })

  it("does not mention the category flip for a session that was already terminal kind", () => {
    const before = session({ id: "sess_old1", kind: "terminal", status: "exited" })
    const message = describeRestart(before, { id: "sess_new1", pty: true })
    expect(message).not.toContain("terminal session (pty-native)")
  })

  it("mentions resumeFallback when present", () => {
    const before = session({ id: "sess_old1", status: "exited" })
    const message = describeRestart(before, {
      id: "sess_new1",
      resumeFallback: "adapter rejected resume id",
    })
    expect(message).toContain("Continuity was not achieved: adapter rejected resume id.")
  })

  it("combines the pty flip and resumeFallback when both apply", () => {
    const before = session({ id: "sess_old1", kind: "agent-cli", status: "exited" })
    const message = describeRestart(before, {
      id: "sess_new1",
      pty: true,
      resumeFallback: "adapter rejected resume id",
    })
    expect(message).toContain("terminal session (pty-native)")
    expect(message).toContain("Continuity was not achieved: adapter rejected resume id.")
  })
})
