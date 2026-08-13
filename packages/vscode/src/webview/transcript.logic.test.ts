import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"

import {
  appendStreamLines,
  applySessionUpdate,
  classifySendFailure,
  createTranscriptModel,
  describePromptSource,
  formatCostLine,
  formatSubtitle,
  formatTitle,
  isExited,
  sendFailureTitle,
  toolIoDocumentName,
  watcherBannerFor,
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
    expect(formatTitle({ label: "abc", id: "s1", kind: "agent-cli" })).toBe("abc")
  })

  it("falls back to the friendly adapter · id name when neither label nor title is set", () => {
    // FIX D: no bare `sess_…` id — the fallback names the session by adapter
    // (or kind) + a short id.
    expect(formatTitle({ id: "s1", kind: "agent-cli" })).toBe("agent-cli · s1")
    expect(formatTitle({ id: "s1", kind: "agent-cli", adapterSlug: "claude-code" })).toBe(
      "claude-code · s1",
    )
  })

  it("prefers label over title", () => {
    expect(
      formatTitle({ label: "abc", title: "Fix the login bug", id: "s1", kind: "agent-cli" }),
    ).toBe("abc")
  })

  it("falls back to title when label is unset", () => {
    expect(formatTitle({ title: "Fix the login bug", id: "s1", kind: "agent-cli" })).toBe(
      "Fix the login bug",
    )
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

  it("classifies an AbortSignal.timeout TimeoutError as timeout", () => {
    // What AbortSignal.timeout's TimeoutError DOMException actually says.
    expect(classifySendFailure("The operation was aborted due to timeout")).toBe("timeout")
    expect(classifySendFailure("The operation timed out")).toBe("timeout")
    expect(sendFailureTitle("timeout")).toBe("Session is slow to respond")
  })

  it("classifies a plain abort as timeout — the client gave up, the daemon may still land the send", () => {
    expect(classifySendFailure("This operation was aborted")).toBe("timeout")
  })

  it("keeps real daemon answers ahead of the timeout fallback", () => {
    // A 409 mid-turn mentioning no timeout words still wins; a not-alive with
    // 'aborted' in the payload still classifies as not-alive, never timeout.
    expect(
      classifySendFailure('HTTP 409 enqueuePrompt: session "s1" is mid-turn — wait for it to finish or cancel'),
    ).toBe("busy")
    expect(classifySendFailure('HTTP 409 {"error":"session_not_alive","detail":"turn aborted"}')).toBe(
      "not-alive",
    )
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

describe("describePromptSource", () => {
  it("returns undefined for a missing/empty source (the human case)", () => {
    expect(describePromptSource(undefined)).toBeUndefined()
    expect(describePromptSource("")).toBeUndefined()
  })

  it("describes an agent:<sessionId> source with a short id badge + full-id tooltip", () => {
    const d = describePromptSource("agent:sess_b248ee25")
    expect(d?.label).toBe("⇄ from 48ee25")
    expect(d?.tooltip).toBe("Injected by session sess_b248ee25 via agent_prompt")
  })

  it("keeps a short session id whole in the badge", () => {
    const d = describePromptSource("agent:abc123")
    expect(d?.label).toBe("⇄ from abc123")
    expect(d?.tooltip).toContain("abc123")
  })

  it("renders any OTHER non-empty source raw rather than dropping it", () => {
    const d = describePromptSource("cron:daily-digest")
    expect(d?.label).toBe("⇄ cron:daily-digest")
    expect(d?.tooltip).toBe("Prompt source: cron:daily-digest")
  })
})

describe("watcherBannerFor", () => {
  it("announces an increase with the post-change count", () => {
    expect(watcherBannerFor(0, 1)).toBe("A watcher attached — 1 waiting on this session")
    expect(watcherBannerFor(1, 3)).toBe("A watcher attached — 3 waiting on this session")
  })

  it("treats an absent previous count as 0", () => {
    expect(watcherBannerFor(undefined, 2)).toBe("A watcher attached — 2 waiting on this session")
  })

  it("announces the last watcher leaving (decrease to 0)", () => {
    expect(watcherBannerFor(1, 0)).toBe("Watcher detached")
    expect(watcherBannerFor(4, 0)).toBe("Watcher detached")
  })

  it("stays silent on a partial decrease (one of several watchers left)", () => {
    expect(watcherBannerFor(3, 1)).toBeUndefined()
    expect(watcherBannerFor(2, 1)).toBeUndefined()
  })

  it("stays silent when nothing changed", () => {
    expect(watcherBannerFor(0, 0)).toBeUndefined()
    expect(watcherBannerFor(2, 2)).toBeUndefined()
    expect(watcherBannerFor(undefined, undefined)).toBeUndefined()
  })

  it("names the newest watcher + wait condition when identity is available", () => {
    const detail = { watcherSessionId: "sup1", watcherLabel: "orchestrator-lead", event: "turn-end", since: "t0" }
    expect(watcherBannerFor(0, 1, { nextDetails: [detail] })).toBe(
      "A watcher attached — orchestrator-lead — until turn-end",
    )
  })

  it("includes the timeout in the wait condition when the daemon reported one", () => {
    const detail = { watcherLabel: "supervisor", event: "any", timeoutMs: 7_200_000, since: "t0" }
    expect(watcherBannerFor(0, 1, { nextDetails: [detail] })).toBe(
      "A watcher attached — supervisor — for any change, 2h timeout",
    )
  })

  it("falls back to a session id when no label was resolved", () => {
    const detail = { watcherSessionId: "sess_abc123", event: "awaiting-input", since: "t0" }
    expect(watcherBannerFor(0, 1, { nextDetails: [detail] })).toBe(
      "A watcher attached — sess_abc123 — until it asks for input",
    )
  })

  it("appends a total when more than one watcher is attached", () => {
    const a = { watcherLabel: "first", event: "exited", since: "t0" }
    const b = { watcherLabel: "second", event: "turn-end", since: "t1" }
    expect(watcherBannerFor(1, 2, { nextDetails: [a, b] })).toBe(
      "A watcher attached — second — until turn-end (2 waiting total)",
    )
  })

  it("falls back to bare-count wording for an anonymous waiter (no identity)", () => {
    const detail = { event: "turn-end", since: "t0" }
    expect(watcherBannerFor(0, 1, { nextDetails: [detail] })).toBe("A watcher attached — 1 waiting on this session")
    expect(watcherBannerFor(0, 1)).toBe("A watcher attached — 1 waiting on this session")
  })

  it("names the departing watcher when exactly one was attached before the drop to zero", () => {
    const detail = { watcherLabel: "orchestrator-lead", event: "turn-end", since: "t0" }
    expect(watcherBannerFor(1, 0, { prevDetails: [detail] })).toBe("Watcher detached — orchestrator-lead")
  })

  it("stays generic on the last-watcher-leaving banner when there were several (can't say who)", () => {
    const a = { watcherLabel: "first", event: "turn-end", since: "t0" }
    const b = { watcherLabel: "second", event: "turn-end", since: "t1" }
    expect(watcherBannerFor(2, 0, { prevDetails: [a, b] })).toBe("Watcher detached")
  })
})
