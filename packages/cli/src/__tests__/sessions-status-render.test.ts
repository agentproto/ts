/**
 * Unit tests for the pure status-rendering helpers in `commands/sessions.ts`
 * (`isStaleRunning` / `statusBadge` / `statusLabel` / `statusColour`) — the
 * bits that decide how the dashboard shows busy/idle and a `running` status
 * whose process has actually died.
 */

import { describe, it, expect } from "vitest"
import {
  isStaleRunning,
  statusBadge,
  statusLabel,
  statusColour,
} from "../commands/sessions.js"

describe("isStaleRunning", () => {
  it("is true only for status=running with a confirmed-dead process", () => {
    expect(isStaleRunning({ status: "running", processAlive: false })).toBe(true)
  })

  it("is false when the process is alive", () => {
    expect(isStaleRunning({ status: "running", processAlive: true })).toBe(false)
  })

  it("is false when processAlive is unknown (no pid to check)", () => {
    expect(isStaleRunning({ status: "running", processAlive: undefined })).toBe(false)
  })

  it("is false for non-running statuses even with a dead pid", () => {
    expect(isStaleRunning({ status: "exited", processAlive: false })).toBe(false)
    expect(isStaleRunning({ status: "killed", processAlive: false })).toBe(false)
  })
})

describe("statusBadge", () => {
  it("prioritises the stale warning over busy/awaitingInput", () => {
    expect(
      statusBadge({
        status: "running",
        processAlive: false,
        busy: true,
        awaitingInput: false,
      }),
    ).toBe("⚠")
  })

  it("shows the busy dot for a running, busy session", () => {
    expect(
      statusBadge({ status: "running", processAlive: true, busy: true, awaitingInput: false }),
    ).toBe("●")
  })

  it("shows a question mark when awaiting input", () => {
    expect(
      statusBadge({
        status: "running",
        processAlive: true,
        busy: false,
        awaitingInput: true,
      }),
    ).toBe("?")
  })

  it("is empty for a healthy idle running session", () => {
    expect(
      statusBadge({ status: "running", processAlive: true, busy: false, awaitingInput: false }),
    ).toBe("")
  })

  it("is empty for non-running statuses", () => {
    expect(
      statusBadge({ status: "exited", processAlive: false, busy: false, awaitingInput: false }),
    ).toBe("")
  })
})

describe("statusLabel", () => {
  it("appends the badge to the bare status when present", () => {
    expect(
      statusLabel({ status: "running", processAlive: false, busy: false, awaitingInput: false }),
    ).toBe("running ⚠")
  })

  it("returns the bare status when there is no badge", () => {
    expect(
      statusLabel({ status: "running", processAlive: true, busy: false, awaitingInput: false }),
    ).toBe("running")
    expect(
      statusLabel({ status: "exited", processAlive: false, busy: false, awaitingInput: false }),
    ).toBe("exited")
  })
})

describe("statusColour", () => {
  it("renders a stale running session in amber, not the healthy green", () => {
    const stale = statusColour({ status: "running", processAlive: false })
    const healthy = statusColour({ status: "running", processAlive: true })
    expect(stale).not.toBe(healthy)
    expect(stale).toBe("\x1b[33m")
    expect(healthy).toBe("\x1b[32m")
  })

  it("keeps killed/error red and exited dim", () => {
    expect(statusColour({ status: "killed", processAlive: false })).toBe("\x1b[31m")
    expect(statusColour({ status: "error", processAlive: false })).toBe("\x1b[31m")
    expect(statusColour({ status: "exited", processAlive: false })).toBe("\x1b[2m")
  })
})
