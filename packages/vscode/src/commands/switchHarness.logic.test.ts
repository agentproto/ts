import { describe, expect, it } from "vitest"

import type { SessionDescriptor } from "../client/types.js"
import { planHarnessSwitch } from "./switchHarness.logic.js"

function session(overrides: Partial<SessionDescriptor>): SessionDescriptor {
  return {
    id: "sess_1",
    kind: "agent-cli",
    workspaceSlug: "ws",
    command: "claude",
    pid: 1,
    status: "running",
    startedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  } as SessionDescriptor
}

describe("planHarnessSwitch", () => {
  it("switches an agent-cli session toward a terminal when a native resume id is already known", () => {
    const plan = planHarnessSwitch(
      session({
        adapterSlug: "claude-code",
        resumeMetadata: { claudeResumeId: "conv_123" },
      }),
    )

    expect(plan.target).toBe("terminal")
    expect(plan.disabledReason).toBeUndefined()
  })

  it("switches a PTY terminal toward conversation when a recoverable id and a safe override exist", () => {
    const plan = planHarnessSwitch(
      session({
        kind: "terminal",
        pty: true,
        adapterSlug: "claude-code",
        argv: ["claude", "--resume", "conv_123"],
        model: "claude-sonnet-4",
      }),
    )

    expect(plan.target).toBe("conversation")
    expect(plan.disabledReason).toBeUndefined()
    expect(plan.overrides).toEqual({ model: "claude-sonnet-4" })
  })

  it("refuses to switch a PTY terminal that has no recoverable resume id", () => {
    const plan = planHarnessSwitch(
      session({
        kind: "terminal",
        pty: true,
        adapterSlug: "claude-code",
        argv: ["claude"],
      }),
    )

    expect(plan.target).toBe("conversation")
    expect(plan.disabledReason).toContain("no recoverable resume id")
  })

  it("switches a claude-code agent session with only an adapterSessionId (no resume metadata)", () => {
    const plan = planHarnessSwitch(
      session({ adapterSlug: "claude-code", adapterSessionId: "uuid-abc" }),
    )

    expect(plan.target).toBe("terminal")
    expect(plan.disabledReason).toBeUndefined()
  })

  it("refuses to switch a claude-code agent session with neither resume metadata nor adapterSessionId", () => {
    const plan = planHarnessSwitch(session({ adapterSlug: "claude-code" }))

    expect(plan.target).toBe("terminal")
    expect(plan.disabledReason).toContain("no native resume id and no adapter session id")
  })

  it("refuses to switch a hermes agent session — no pty-native resume strategy exists", () => {
    const plan = planHarnessSwitch(
      session({
        adapterSlug: "hermes",
        resumeMetadata: { hermesResumeId: "conv_123" },
        adapterSessionId: "uuid-abc",
      }),
    )

    expect(plan.target).toBe("terminal")
    expect(plan.disabledReason).toContain("no provider-native PTY resume strategy")
  })
})

