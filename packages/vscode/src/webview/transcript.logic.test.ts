import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"

import {
  appendStreamLines,
  applySessionUpdate,
  createTranscriptModel,
  formatCostLine,
  formatSubtitle,
  formatTitle,
  isExited,
  statusChip,
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

describe("statusChip", () => {
  it("shows exited for terminal statuses", () => {
    expect(statusChip({ status: "exited", busy: false, awaitingInput: false })).toBe("exited")
    expect(statusChip({ status: "killed", busy: false, awaitingInput: false })).toBe("exited")
  })

  it("prioritises busy over awaiting-input and running", () => {
    expect(statusChip({ status: "running", busy: true, awaitingInput: false })).toBe("busy")
  })

  it("shows awaiting-input when not busy", () => {
    expect(statusChip({ status: "running", busy: false, awaitingInput: true })).toBe(
      "awaiting-input",
    )
  })

  it("shows running otherwise", () => {
    expect(statusChip({ status: "running", busy: false, awaitingInput: false })).toBe("running")
  })

  it("falls back to status for starting", () => {
    expect(statusChip({ status: "starting", busy: false, awaitingInput: false })).toBe("starting")
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
