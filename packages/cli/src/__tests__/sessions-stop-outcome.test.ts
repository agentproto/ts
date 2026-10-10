import { describe, it, expect } from "vitest"
import { buildStopBody } from "../commands/sessions.js"

describe("sessions stop — buildStopBody", () => {
  it("plain stop sends an empty body", () => {
    expect(buildStopBody({})).toEqual({ ok: true, body: {} })
  })

  it("--completed keeps the legacy reason body", () => {
    expect(buildStopBody({ completed: true })).toEqual({ ok: true, body: { reason: "completed" } })
  })

  it("outcome flags build a user-attributed outcome object", () => {
    const r = buildStopBody({
      outcome: "failed",
      reason: "quota exhausted",
      "error-kind": "quota",
      "next-step": "relaunch on another profile",
      note: "n",
    })
    expect(r).toEqual({
      ok: true,
      body: {
        outcome: {
          verdict: "failed",
          reason: "quota exhausted",
          errorKind: "quota",
          nextStep: "relaunch on another profile",
          note: "n",
          by: "user",
        },
      },
    })
  })

  it("rejects an unknown outcome or error kind", () => {
    expect(buildStopBody({ outcome: "nope" }).ok).toBe(false)
    expect(buildStopBody({ "error-kind": "nope" }).ok).toBe(false)
  })

  it("rejects --completed with a contradicting --outcome", () => {
    expect(buildStopBody({ completed: true, outcome: "failed" }).ok).toBe(false)
    expect(buildStopBody({ completed: true, outcome: "done" }).ok).toBe(true)
  })
})
