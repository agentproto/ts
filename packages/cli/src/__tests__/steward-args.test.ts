/**
 * `agentproto steward` argument parsing — flags → the session-attention (default)
 * or session-steward (`--wrapup`) workflow's input.
 */

import { describe, it, expect } from "vitest"
import { parseStewardArgs } from "../commands/steward.js"

describe("parseStewardArgs", () => {
  it("defaults to the read-only attention mode with no overrides", () => {
    const r = parseStewardArgs([], {})
    expect(r).toEqual({ ok: true, value: { mode: "attention", input: {}, format: "markdown", wait: false, json: false } })
  })

  it("maps the attention flags onto the workflow input", () => {
    const r = parseStewardArgs(
      ["--idle", "20", "--judge", "rules", "--include-children", "--format", "text", "--wait", "--json"],
      {},
    )
    expect(r).toEqual({
      ok: true,
      value: {
        mode: "attention",
        input: { idleMinutes: 20, judge: "rules", includeChildren: true },
        format: "text",
        wait: true,
        json: true,
      },
    })
  })

  it("--wrapup selects the legacy mode and maps its flags", () => {
    const r = parseStewardArgs(
      ["--wrapup", "--apply", "--idle", "45", "--min-confidence", "0.9", "--judge", "jev", "--ask-sessions", "--wait"],
      {},
    )
    expect(r).toEqual({
      ok: true,
      value: {
        mode: "wrapup",
        input: { apply: true, idleMinutes: 45, minConfidence: 0.9, judge: "jev", askSessions: true },
        format: "markdown",
        wait: true,
        json: false,
      },
    })
  })

  it("--wrapup alone is a dry run", () => {
    const r = parseStewardArgs(["--wrapup"], {})
    expect(r.ok && r.value.input).toEqual({ apply: false, askSessions: false })
  })

  it("passes the calling session as callerSessionId", () => {
    const r = parseStewardArgs([], { AGENTPROTO_SESSION_ID: "sess_me" })
    expect(r.ok && r.value.input.callerSessionId).toBe("sess_me")
  })

  it("rejects close/flag flags without --wrapup instead of silently ignoring them", () => {
    for (const args of [["--apply"], ["--min-confidence", "0.9"], ["--ask-sessions"]]) {
      const r = parseStewardArgs(args, {})
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(/--wrapup/)
    }
  })

  it("rejects --include-children with --wrapup", () => {
    expect(parseStewardArgs(["--wrapup", "--include-children"], {}).ok).toBe(false)
  })

  it("validates --judge per mode", () => {
    expect(parseStewardArgs(["--judge", "jev"], {}).ok).toBe(false)
    expect(parseStewardArgs(["--judge", "auto"], {}).ok).toBe(false)
    expect(parseStewardArgs(["--wrapup", "--judge", "rules"], {}).ok).toBe(false)
    expect(parseStewardArgs(["--judge", "agent"], {}).ok).toBe(true)
    expect(parseStewardArgs(["--wrapup", "--judge", "auto"], {}).ok).toBe(true)
  })

  it("rejects bad values and unknown flags", () => {
    for (const args of [
      ["--idle", "0"],
      ["--idle", "abc"],
      ["--wrapup", "--min-confidence", "1.5"],
      ["--judge", "gpt"],
      ["--format", "html"],
      ["--bogus"],
      ["positional"],
    ]) {
      expect(parseStewardArgs(args, {}).ok).toBe(false)
    }
  })
})
