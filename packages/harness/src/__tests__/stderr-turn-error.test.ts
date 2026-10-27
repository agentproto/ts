/**
 * A provider that retries internally (opencode's 429 / usage-cap loop) never
 * resolves `session/prompt`, so the daemon sees a silent, 0-token, busy
 * session forever. opencode logs the reason ONLY to stderr as a structured
 * logfmt line; these tests pin the parser that turns that line into the
 * turn's error, and the `promptTurn` wiring that surfaces it instead of
 * hanging.
 */

import { describe, it, expect, vi } from "vitest"
import { parseStderrStreamError, promptTurn } from "../session-controls.js"
import type { AgentCliClient, StreamEvent } from "../types.js"

/** The live incident's line, verbatim (opencode acp --print-logs). */
const STREAM_ERROR_LINE =
  'timestamp=2026-10-02T12:20:59.007Z level=ERROR run=f897ee16 message="stream error" ' +
  "providerID=opencode-go modelID=glm-5.3-flash session.id=ses_x small=false agent=build " +
  'error.error="AI_APICallError: Go usage limit exceeded"'

describe("parseStderrStreamError", () => {
  it("extracts the provider message from a real build-turn stream error", () => {
    expect(parseStderrStreamError(STREAM_ERROR_LINE)).toBe(
      "Go usage limit exceeded",
    )
  })

  it("ignores the background title generator (small=true / agent=title)", () => {
    const line = STREAM_ERROR_LINE.replace("small=false", "small=true").replace(
      "agent=build",
      "agent=title",
    )
    expect(parseStderrStreamError(line)).toBeUndefined()
  })

  it("ignores a non-ERROR log level", () => {
    expect(
      parseStderrStreamError(STREAM_ERROR_LINE.replace("level=ERROR", "level=INFO")),
    ).toBeUndefined()
  })

  it("ignores stderr lines that aren't a stream error", () => {
    expect(
      parseStderrStreamError("npm warn deprecated opencode-ai@1.0.0"),
    ).toBeUndefined()
  })

  it("returns the raw text when there is no error-class prefix to strip", () => {
    const line = STREAM_ERROR_LINE.replace(
      'error.error="AI_APICallError: Go usage limit exceeded"',
      'error.error="plain failure"',
    )
    expect(parseStderrStreamError(line)).toBe("plain failure")
  })
})

/** An arm whose event stream never yields and never resolves — the exact
 *  shape of opencode stuck in its internal retry loop. The test drives
 *  stderr lines through the live subscription. */
function stuckArm() {
  let listener: ((line: string) => void) | undefined
  const cancel = vi.fn(async (_turnId: string) => {})
  const arm: AgentCliClient = {
    sessionId: "ses_test",
    async connect() {},
    async send() {},
    async *events() {
      await new Promise<void>(() => {})
    },
    async cancel(turnId) {
      await cancel(turnId)
    },
    async close() {},
    _stderrTail: () => "last stderr",
    _onStderrLine(l) {
      listener = l
      return () => {
        listener = undefined
      }
    },
  }
  return { arm, cancel, emit: (line: string) => listener?.(line) }
}

describe("promptTurn stderr surfacing", () => {
  it("ends the turn with the parsed provider error instead of hanging", async () => {
    const { arm, cancel, emit } = stuckArm()
    const events: StreamEvent[] = []
    const turn = (async () => {
      for await (const evt of promptTurn(arm, "t1", "go", parseStderrStreamError)) {
        events.push(evt)
      }
    })()

    // Subscription is armed synchronously inside promptTurn; let `send`
    // resolve before injecting the line.
    await new Promise(resolve => setTimeout(resolve, 0))
    emit(STREAM_ERROR_LINE)
    await turn

    expect(cancel).toHaveBeenCalledWith("t1")
    const error = events.find(e => e.kind === "error")
    expect(error).toBeDefined()
    expect(error && error.kind === "error" ? error.error.message : undefined).toBe(
      "Go usage limit exceeded",
    )
    const end = events.find(e => e.kind === "turn-end")
    expect(end && end.kind === "turn-end" ? end.reason : undefined).toBe("error")
  })
})
