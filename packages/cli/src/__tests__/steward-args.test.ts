/**
 * `agentproto steward` argument parsing — flags → the session-steward
 * workflow's input.
 */

import { describe, it, expect } from "vitest"
import { parseStewardArgs } from "../commands/steward.js"

describe("parseStewardArgs", () => {
  it("defaults to a dry run with no overrides", () => {
    const r = parseStewardArgs([], {})
    expect(r).toEqual({ ok: true, value: { input: { apply: false, askSessions: false }, wait: false, json: false } })
  })

  it("maps every flag onto the workflow input", () => {
    const r = parseStewardArgs(
      ["--apply", "--idle", "45", "--min-confidence", "0.9", "--judge", "agent", "--ask-sessions", "--wait", "--json"],
      {},
    )
    expect(r).toEqual({
      ok: true,
      value: {
        input: { apply: true, idleMinutes: 45, minConfidence: 0.9, judge: "agent", askSessions: true },
        wait: true,
        json: true,
      },
    })
  })

  it("passes the calling session as callerSessionId", () => {
    const r = parseStewardArgs([], { AGENTPROTO_SESSION_ID: "sess_me" })
    expect(r.ok && r.value.input.callerSessionId).toBe("sess_me")
  })

  it("rejects bad values and unknown flags", () => {
    for (const args of [
      ["--idle", "0"],
      ["--idle", "abc"],
      ["--min-confidence", "1.5"],
      ["--judge", "gpt"],
      ["--bogus"],
      ["positional"],
    ]) {
      expect(parseStewardArgs(args, {}).ok).toBe(false)
    }
  })
})
