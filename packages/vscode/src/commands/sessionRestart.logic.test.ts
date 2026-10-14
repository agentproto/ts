import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import { canRestart, describeNotATerminal, describeRestart, parseRestartFailure, parseRestartResult, restartFailureActionLabel, restartFailureMessage, restartSpawnOptions, restartedSessionView } from "./sessionRestart.logic.js"

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

  it("is TRUE for a terminal-status session still flagged awaiting input (contextValueFor gates on status first)", () => {
    expect(canRestart(session({ status: "exited", awaitingInput: true }))).toBe(true)
  })

  it("is TRUE for a daemon-restart ghost — restart-fresh (new id) stays valid alongside resume-in-place", () => {
    // Such a row renders as session-interrupted (resume-in-place is the primary
    // action), but restarting it to a NEW id is still a legitimate choice.
    expect(canRestart(session({ status: "killed", endedReason: "daemon-restart" }))).toBe(true)
  })
})

describe("restartedSessionView", () => {
  it("opens native and plain PTY restarts in the usable terminal", () => {
    expect(restartedSessionView({ id: "s2", kind: "terminal", pty: true })).toBe("terminal")
    expect(restartedSessionView({ id: "s2", kind: "agent-cli", pty: true })).toBe("terminal")
  })

  it("keeps ACP restarts in the conversation panel", () => {
    expect(restartedSessionView({ id: "s2", kind: "agent-cli", pty: false })).toBe("transcript")
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
  it("names the new session id and resume path", () => {
    const before = session({ id: "sess_old1", label: "before-label", status: "exited" })
    const message = describeRestart(before, {
      id: "sess_new1",
      label: "after-label",
      resumeVia: "claude --resume",
    })
    expect(message).toBe(
      "agentproto: restarted before-label → new session sess_new1 via claude --resume.",
    )
  })

  it("omits the via clause when resumeVia is absent", () => {
    const before = session({ id: "sess_old1", status: "exited" })
    const message = describeRestart(before, { id: "sess_new1" })
    expect(message).toBe("agentproto: restarted sess_old1 → new session sess_new1.")
  })

  it("does not stutter when the daemon phrases resumeVia as a full clause", () => {
    // Live daemon returns resumeVia: "resumed via ACP" — naively prefixing our
    // own "via" produced "via resumed via ACP". Caught by a live e2e, not by
    // the unit suite, so it's pinned here.
    const before = session({ id: "sess_old1", label: "worker", status: "killed" })
    const message = describeRestart(before, { id: "sess_new1", resumeVia: "resumed via ACP" })
    expect(message).toBe("agentproto: restarted worker → new session sess_new1 via ACP.")
    expect(message).not.toContain("via resumed via")
  })

  it("names the new id even when the label carries over unchanged", () => {
    // Restart copies label+name onto the new session, so a label-only message
    // would read "restarted worker as worker" and hide what actually changed.
    const before = session({ id: "sess_old1", label: "worker", status: "exited" })
    const message = describeRestart(before, { id: "sess_new1", label: "worker" })
    expect(message).toContain("sess_new1")
  })

  it("calls out the pty-native category flip for a restarted agent-cli session", () => {
    const before = session({ id: "sess_old1", kind: "agent-cli", status: "exited" })
    const message = describeRestart(before, { id: "sess_new1", pty: true, resumeVia: "pty-native" })
    expect(message).toContain(
      "Resumed as a terminal session (pty-native). Its provider transcript remains available via Open Transcript.",
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

describe("nativeResumeDecline parsing + describeNotATerminal", () => {
  it("round-trips a well-formed decline, with and without probedDir", () => {
    expect(
      parseRestartResult({
        id: "sess_new1",
        nativeResumeDecline: { reason: "transcript-not-found", probedDir: "/iso/projects/-my-proj" },
      })?.nativeResumeDecline,
    ).toEqual({ reason: "transcript-not-found", probedDir: "/iso/projects/-my-proj" })

    expect(
      parseRestartResult({ id: "sess_new1", nativeResumeDecline: { reason: "no-resume-id" } })
        ?.nativeResumeDecline,
    ).toEqual({ reason: "no-resume-id" })
  })

  it("drops a malformed or unknown-reason decline instead of throwing", () => {
    expect(
      parseRestartResult({ id: "sess_new1", nativeResumeDecline: { reason: "weird-new-reason" } })
        ?.nativeResumeDecline,
    ).toBeUndefined()
    expect(
      parseRestartResult({ id: "sess_new1", nativeResumeDecline: "transcript-not-found" })
        ?.nativeResumeDecline,
    ).toBeUndefined()
  })

  it("transcript-not-found / no-resume-id name the probed directory when known", () => {
    expect(
      describeNotATerminal({ reason: "transcript-not-found", probedDir: "/iso/projects/-my-proj" }),
    ).toBe("the provider transcript was not found (probed /iso/projects/-my-proj) — the daemon fell back to ACP resume.")
    expect(describeNotATerminal({ reason: "no-resume-id" })).toBe(
      "the provider transcript was not found — the daemon fell back to ACP resume.",
    )
  })

  it("capability-missing and no-decline-info get their own honest messages", () => {
    expect(describeNotATerminal({ reason: "capability-missing" })).toContain(
      "no nativeTerminalResume capability",
    )
    expect(describeNotATerminal(undefined)).toBe(
      "the restart did not request (or the daemon did not report) a native terminal — it resumed via ACP instead.",
    )
  })
})

describe("parseRestartFailure", () => {
  const MCP_PAYLOAD = JSON.stringify({
    error: {
      code: "sandbox_gone",
      reason: "The box this session ran in is gone, so the session can't be resumed where it was.",
      message:
        'restartAgentSession: sandbox "sbx_1" expired or is unreachable (provider "e2b") — spawn a fresh session.',
      action: { kind: "spawn-on-branch", branch: "wt/restart-typed-errors-ui" },
    },
    message:
      'restartAgentSession: sandbox "sbx_1" expired or is unreachable (provider "e2b") — spawn a fresh session.',
    status: 500,
    ok: false,
    sessionId: "sess_old",
  })

  it("parses the MCP session_restart payload from the thrown message", () => {
    const failure = parseRestartFailure(new Error(MCP_PAYLOAD))
    expect(failure?.code).toBe("sandbox_gone")
    expect(failure?.reason).toMatch(/is gone/)
    expect(failure?.detail).toMatch(/sbx_1/)
    expect(failure?.action).toEqual({ kind: "spawn-on-branch", branch: "wt/restart-typed-errors-ui" })
  })

  it("parses the same payload embedded after an HTTP status line", () => {
    const failure = parseRestartFailure(
      new Error(`POST /sessions/s1/restart failed: HTTP 500 ${MCP_PAYLOAD}`),
    )
    expect(failure?.code).toBe("sandbox_gone")
    expect(failure?.action).toEqual({ kind: "spawn-on-branch", branch: "wt/restart-typed-errors-ui" })
  })

  it("returns undefined for a raw, uncoded message (today's toast stays)", () => {
    expect(
      parseRestartFailure(
        new Error(
          'restartAgentSession: sandbox "sbx_1" expired or is unreachable (provider "e2b") — spawn a fresh session.',
        ),
      ),
    ).toBeUndefined()
    expect(parseRestartFailure(new Error("HTTP 500: something exploded"))).toBeUndefined()
    expect(parseRestartFailure(undefined)).toBeUndefined()
  })

  it("returns undefined for the uncoded restart_failed fallback body", () => {
    expect(
      parseRestartFailure(new Error(JSON.stringify({ error: "restart_failed", message: "boom" }))),
    ).toBeUndefined()
  })

  it("keeps the three action spellings and drops unknown ones", () => {
    const payload = (action: unknown) =>
      JSON.stringify({ error: { code: "sandbox_gone", reason: "gone", ...(action ? { action } : {}) } })
    expect(parseRestartFailure(new Error(payload({ kind: "spawn-fresh" })))?.action).toEqual({
      kind: "spawn-fresh",
    })
    expect(
      parseRestartFailure(new Error(payload({ kind: "fix-config", detail: "configure a provider" })))?.action,
    ).toEqual({ kind: "fix-config", detail: "configure a provider" })
    expect(parseRestartFailure(new Error(payload({ kind: "mystery" })))?.action).toBeUndefined()
    expect(parseRestartFailure(new Error(payload(undefined)))?.action).toBeUndefined()
  })
})

describe("restartFailureMessage / restartFailureActionLabel", () => {
  it("shows the human reason, never the raw provider string", () => {
    const failure = parseRestartFailure(
      new Error(
        JSON.stringify({
          error: {
            code: "sandbox_unreachable",
            reason: "The box this session ran in isn't answering, so the session can't be resumed there right now.",
            message:
              'restartAgentSession: sandbox "sbx_2" expired or is unreachable (provider "e2b") — spawn a fresh session. <provider error>',
          },
        }),
      ),
    )!
    expect(restartFailureMessage(failure)).toBe(
      "The box this session ran in isn't answering, so the session can't be resumed there right now.",
    )
    expect(restartFailureMessage(failure)).not.toContain("sbx_2")
  })

  it("appends a fix-config remediation to the sentence", () => {
    const failure = parseRestartFailure(
      new Error(
        JSON.stringify({
          error: {
            code: "sandbox_provider_missing",
            reason: "This daemon can't reach the sandbox provider that ran this session.",
            message: "restartAgentSession: sandbox provider \"e2b\" not found",
            action: { kind: "fix-config", detail: "set up sandbox provider \"e2b\"" },
          },
        }),
      ),
    )!
    expect(restartFailureMessage(failure)).toBe(
      'This daemon can\'t reach the sandbox provider that ran this session. set up sandbox provider "e2b".',
    )
    // A fix-config hint has no one-click spawn — nothing to press.
    expect(restartFailureActionLabel(failure)).toBeUndefined()
  })

  it("labels the two spawn recoveries as the buttons the UI shows", () => {
    const withAction = (action: unknown) =>
      parseRestartFailure(
        new Error(JSON.stringify({ error: { code: "sandbox_gone", reason: "gone", action } })),
      )!
    expect(restartFailureActionLabel(withAction({ kind: "spawn-on-branch", branch: "wt/foo" }))).toBe(
      "Start a new session on wt/foo",
    )
    expect(restartFailureActionLabel(withAction({ kind: "spawn-fresh" }))).toBe(
      "Start a fresh session",
    )
    expect(restartFailureActionLabel(withAction(undefined))).toBeUndefined()
  })
})

describe("restartSpawnOptions", () => {
  it("pins the recorded work branch as the spawn's worktree slug", () => {
    expect(
      restartSpawnOptions({ kind: "spawn-on-branch", branch: "wt/restart-typed-errors-ui" }),
    ).toEqual({ worktree: { slug: "restart-typed-errors-ui" } })
    // The daemon's provisioner cuts branch `wt/<slug>`, so a branch outside
    // the sandbox prefix is passed through untouched.
    expect(restartSpawnOptions({ kind: "spawn-on-branch", branch: "feature/x" })).toEqual({
      worktree: { slug: "feature/x" },
    })
  })

  it("leaves a fresh spawn un-pinned and never invents a worktree", () => {
    expect(restartSpawnOptions({ kind: "spawn-fresh" })).toBeUndefined()
    expect(restartSpawnOptions({ kind: "fix-config", detail: "set up a provider" })).toBeUndefined()
    expect(restartSpawnOptions(undefined)).toBeUndefined()
  })
})
