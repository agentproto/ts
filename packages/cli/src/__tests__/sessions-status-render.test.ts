/**
 * Unit tests for the pure status-rendering helpers in `commands/sessions.ts`
 * (`isStaleRunning` / `statusBadge` / `statusLabel` / `statusColour`) — the
 * bits that decide how the dashboard shows presence. The badges are now driven
 * by the SHARED four-state presence classifier (`presenceFor` in
 * @agentproto/runtime/session-presence): ● running (turning or just-finished,
 * still inside the grace window), ◐ tending (idle but busy through children /
 * background tasks), ?/!/✗ attention (something is waiting on the human), ○
 * quiet (parked). `isStaleRunning` stays a pure dead-pid lifecycle flag.
 */

import { describe, it, expect } from "vitest"
import {
  isStaleRunning,
  statusBadge,
  statusLabel,
  statusColour,
} from "../commands/sessions.js"

/** Bare live descriptor — turn idle, nothing pending, out of grace. */
const live = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "running",
  busy: false,
  ...over,
})

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

describe("statusBadge — shared presence classifier", () => {
  it("prioritises the stale warning over every presence state", () => {
    expect(
      statusBadge(live({ processAlive: false, busy: true, awaitingInput: true })),
    ).toBe("⚠")
  })

  it("shows the busy dot for a turning session", () => {
    expect(statusBadge(live({ busy: true }))).toBe("●")
  })

  it("shows the running dot for a session still inside the grace window after a turn", () => {
    expect(
      statusBadge(live({ lastActivityAt: new Date(Date.now() - 5_000).toISOString() })),
    ).toBe("●")
  })

  it("shows a question mark when awaiting input", () => {
    expect(statusBadge(live({ awaitingInput: true }))).toBe("?")
  })

  it("shows '!' for a held permission and prioritises it over busy/awaitingInput", () => {
    expect(statusBadge(live({ awaitingPermission: true }))).toBe("!")
    // A held permission is the strongest live signal — even mid-turn/awaiting.
    expect(statusBadge(live({ busy: true, awaitingInput: true, awaitingPermission: true }))).toBe("!")
  })

  it("shows the half dot (◐) for an idle session tending its busy children", () => {
    expect(statusBadge(live({ childrenBusy: 2 }))).toBe("◐")
  })

  it("shows the half dot (◐) for a session parked with background tasks pending", () => {
    expect(statusBadge(live({ pendingBgTasks: 1 }))).toBe("◐")
  })

  it("shows ✗ for the adapter's own last-turn in-band failure", () => {
    expect(
      statusBadge(live({ lastTurnErroredAt: new Date(Date.now() - 5_000).toISOString() })),
    ).toBe("✗")
  })

  it("shows the hollow dot for a parked (quiet) running session", () => {
    expect(statusBadge(live({}))).toBe("○")
    expect(statusBadge(live({ busy: true, awaitingPermission: true }))).not.toBe("○")
  })

  it("is empty for terminal statuses — the raw status word is shown instead", () => {
    expect(statusBadge(live({ status: "exited" }))).toBe("")
    expect(statusBadge(live({ status: "killed" }))).toBe("")
  })
})

describe("statusLabel", () => {
  it("appends the badge to the bare status for a live session", () => {
    expect(statusLabel(live({ busy: true }))).toBe("running ●")
    expect(statusLabel(live({ awaitingInput: true }))).toBe("running ?")
    expect(statusLabel(live({ childrenBusy: 1 }))).toBe("running ◐")
  })

  it("appends the stale warning when the process is dead", () => {
    expect(statusLabel(live({ processAlive: false }))).toBe("running ⚠")
  })

  it("returns the bare status for a terminal session", () => {
    expect(statusLabel(live({ status: "exited" }))).toBe("exited")
  })
})

describe("statusColour", () => {
  it("renders a stale running session in amber, not the healthy green", () => {
    expect(statusColour(live({ processAlive: false }))).toBe("\x1b[33m")
    expect(statusColour(live({ processAlive: true }))).toBe("\x1b[2m") // healthy quiet is dim
  })

  it("greens running and tending, ambers attention, dims quiet", () => {
    expect(statusColour(live({ busy: true }))).toBe("\x1b[32m")
    expect(statusColour(live({ childrenBusy: 1 }))).toBe("\x1b[32m")
    expect(statusColour(live({ awaitingInput: true }))).toBe("\x1b[33m")
    expect(statusColour(live({}))).toBe("\x1b[2m")
  })

  it("keeps killed/error red, starting yellow, exited dim", () => {
    expect(statusColour(live({ status: "killed" }))).toBe("\x1b[31m")
    expect(statusColour(live({ status: "error" }))).toBe("\x1b[31m")
    expect(statusColour(live({ status: "starting" }))).toBe("\x1b[33m")
    expect(statusColour(live({ status: "exited" }))).toBe("\x1b[2m")
  })
})
