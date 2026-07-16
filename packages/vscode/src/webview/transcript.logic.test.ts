import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"

import {
  appendStreamLines,
  applySessionUpdate,
  classifySendFailure,
  createTranscriptModel,
  formatCostLine,
  formatSubtitle,
  formatTitle,
  isExited,
  sendFailureTitle,
  toolIoDocumentName,
} from "./transcript.logic.js"

function session(over: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "s1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "cmd",
    pid: 1,
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...over,
  }
}

describe("createTranscriptModel", () => {
  it("derives label from session label", () => {
    const model = createTranscriptModel(session({ label: "my-session" }))
    expect(model.sessionLabel).toBe("my-session")
    expect(model.sessionId).toBe("s1")
  })

  it("falls back to id when label is absent", () => {
    const model = createTranscriptModel(session())
    expect(model.sessionLabel).toBe("s1")
  })

  it("marks exited sessions as exited", () => {
    const model = createTranscriptModel(session({ status: "exited" }))
    expect(model.exited).toBe(true)
  })
})

describe("applySessionUpdate", () => {
  it("updates cost and tokens", () => {
    const model = createTranscriptModel(session())
    const next = applySessionUpdate(
      model,
      session({ costUsd: 0.1234, tokensIn: 100, tokensOut: 200 }),
    )
    expect(next.costUsd).toBe(0.1234)
    expect(next.tokensIn).toBe(100)
    expect(next.tokensOut).toBe(200)
  })

  it("updates status and exited flag", () => {
    const model = createTranscriptModel(session({ status: "running" }))
    const next = applySessionUpdate(model, session({ status: "killed" }))
    expect(next.status).toBe("killed")
    expect(next.exited).toBe(true)
  })

  it("preserves appended lines", () => {
    let model = createTranscriptModel(session())
    model = appendStreamLines(model, [{ line: "hello" }])
    const next = applySessionUpdate(model, session({ busy: true }))
    expect(next.lines).toHaveLength(1)
    expect(next.busy).toBe(true)
  })
})

describe("appendStreamLines", () => {
  it("appends lines to the model", () => {
    const model = createTranscriptModel(session())
    const next = appendStreamLines(model, [
      { line: "one", stream: "stdout" },
      { line: "two", stream: "stderr" },
    ])
    expect(next.lines).toEqual([
      { line: "one", stream: "stdout" },
      { line: "two", stream: "stderr" },
    ])
  })

  it("returns the same model when no lines are given", () => {
    const model = createTranscriptModel(session())
    expect(appendStreamLines(model, [])).toBe(model)
  })
})

describe("isExited", () => {
  it("returns true for terminal statuses", () => {
    expect(isExited("exited")).toBe(true)
    expect(isExited("killed")).toBe(true)
    expect(isExited("error")).toBe(true)
  })

  it("returns false for live statuses", () => {
    expect(isExited("running")).toBe(false)
    expect(isExited("starting")).toBe(false)
  })
})

describe("formatCostLine", () => {
  it("formats cost and tokens", () => {
    expect(formatCostLine({ costUsd: 0.1234, tokensIn: 10, tokensOut: 20 })).toBe(
      "$0.1234 · in 10 · out 20",
    )
  })

  it("omits missing fields", () => {
    expect(formatCostLine({ tokensOut: 5 })).toBe("out 5")
  })

  it("returns em dash when nothing is available", () => {
    expect(formatCostLine({})).toBe("—")
  })
})

describe("formatTitle", () => {
  it("uses label when available", () => {
    expect(formatTitle({ label: "abc", id: "s1" })).toBe("abc")
  })

  it("falls back to id", () => {
    expect(formatTitle({ id: "s1" })).toBe("s1")
  })
})

describe("formatSubtitle", () => {
  it("joins adapter and model", () => {
    expect(formatSubtitle({ adapterSlug: "claude-code", model: "claude-sonnet-4" })).toBe(
      "claude-code · claude-sonnet-4",
    )
  })

  it("returns empty string when neither is present", () => {
    expect(formatSubtitle({})).toBe("")
  })
})

describe("classifySendFailure", () => {
  it("classifies the daemon's mid-turn 409 as busy — typing while the agent works is not an error", () => {
    // The exact string a user hit: POST .../prompt?wait=false failed: HTTP 409
    // enqueuePrompt: session "sess_be75fcdd" is mid-turn — wait for it to finish or cancel
    const msg =
      'POST /sessions/sess_be75fcdd/prompt?wait=false failed: HTTP 409 enqueuePrompt: session "sess_be75fcdd" is mid-turn — wait for it to finish or cancel'
    expect(classifySendFailure(msg)).toBe("busy")
    expect(sendFailureTitle("busy")).toBe("Agent is mid-turn")
  })

  it("does NOT treat every 409 as busy", () => {
    expect(classifySendFailure("HTTP 409 session_not_alive")).toBe("not-alive")
    expect(classifySendFailure("HTTP 409 something else entirely")).toBe("other")
  })

  it("classifies a dead session", () => {
    expect(classifySendFailure('failed: HTTP 409 {"error":"session_not_alive","status":"killed"}')).toBe(
      "not-alive",
    )
    expect(sendFailureTitle("not-alive")).toBe("Session is no longer running")
  })

  it("falls back to other for an unrecognised failure", () => {
    expect(classifySendFailure("ECONNREFUSED 127.0.0.1:18790")).toBe("other")
    expect(sendFailureTitle("other")).toBe("Send failed")
  })

  it("does not mistake a session id containing 409 for a busy rejection", () => {
    expect(classifySendFailure("POST /sessions/sess_409abc/prompt failed: HTTP 500 boom")).toBe("other")
  })
})

describe("toolIoDocumentName", () => {
  it("names the tab after the tool, the side, and a stable id suffix", () => {
    expect(toolIoDocumentName("Bash", "output", "tool-toolu_01ab9c3f", false)).toBe(
      "Bash output (ab9c3f).log",
    )
    expect(toolIoDocumentName("Bash", "input", "tool-toolu_01ab9c3f", true)).toBe(
      "Bash input (ab9c3f).json",
    )
  })

  it("survives a tool name that is a file path — it becomes a URI segment", () => {
    // agentproto tool names embed their target ("read: /Volumes/…/index.ts").
    // Left raw, the slashes would fabricate extra URI path segments and the
    // tab would be titled "index.ts".
    const name = toolIoDocumentName("read: /Volumes/SSD/Code/src/index.ts", "output", "seg-12", false)
    expect(name).not.toContain("/")
    expect(name).toMatch(/\.log$/)
  })

  it("caps a very long name and still falls back when there is no name at all", () => {
    const long = toolIoDocumentName("x".repeat(300), "input", "seg-1", false)
    // An untruncated name renders as an unreadable tab.
    expect(long.length).toBeLessThan(70)
    expect(toolIoDocumentName(undefined, "input", "seg-1", false)).toBe("tool input (seg1).log")
    expect(toolIoDocumentName("///", "input", "seg-1", false)).toBe("tool input (seg1).log")
  })
})
