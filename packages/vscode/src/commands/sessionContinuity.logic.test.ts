import { describe, it, expect } from "vitest"
import {
  canCompactSession,
  canContinueSessionFresh,
  contextContinuityStatusFor,
  describeContextPct,
} from "./sessionContinuity.logic.js"
import type { SessionDescriptor } from "../client/types.js"

const baseDesc = (overrides?: Partial<SessionDescriptor>): SessionDescriptor => ({
  id: "sess_1",
  kind: "agent-cli",
  workspaceSlug: "ws",
  command: "claude",
  pid: 123,
  status: "running",
  startedAt: new Date().toISOString(),
  ...overrides,
}) as SessionDescriptor

describe("sessionContinuity.logic", () => {
  it("canCompactSession only for live agent-cli", () => {
    expect(canCompactSession(baseDesc())).toBe(true)
    expect(canCompactSession(baseDesc({ status: "exited" }))).toBe(false)
    expect(canCompactSession(baseDesc({ kind: "terminal" }))).toBe(false)
  })

  it("canContinueSessionFresh only for live agent-cli", () => {
    expect(canContinueSessionFresh(baseDesc())).toBe(true)
    expect(canContinueSessionFresh(baseDesc({ status: "killed" }))).toBe(false)
  })

  it("describeContextPct returns hard stop when flagged", () => {
    expect(describeContextPct(baseDesc({ contextContinuityHardStopped: true }))).toBe("hard stop")
  })

  it("describeContextPct returns pct when telemetry exists", () => {
    expect(describeContextPct(baseDesc({ contextSize: 1000, contextUsed: 650 }))).toBe("65% context")
  })

  it("contextContinuityStatusFor reflects thresholds", () => {
    const desc = baseDesc({
      contextSize: 1000,
      contextUsed: 760,
      contextContinuity: {
        mode: "auto",
        warnAtPct: 55,
        compactAtPct: 65,
        continueFreshAtPct: 75,
        hardStopAtPct: 90,
        goal: true,
        plan: true,
        decisions: true,
        changedFiles: true,
        gitStatus: true,
        tests: true,
        errors: true,
        risks: true,
        nextStep: true,
        config: true,
        label: "auto",
      },
    })
    const chip = contextContinuityStatusFor(desc)
    expect(chip.state).toBe("continue-fresh")
    expect(chip.label).toContain("76%")
    expect(chip.tooltip).toContain("continue 75%")
  })
})
