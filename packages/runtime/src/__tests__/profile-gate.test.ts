import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionDescriptor } from "../sessions.js"
import {
  DEFAULT_PROFILE_GATE_MODE,
  callerProfileSet,
  decideProfileUse,
  profileReport,
  recordProfileUse,
  resetProfileObservations,
} from "../profile-gate.js"

const callerWith = (profileRef?: string) =>
  ({
    accessProfile:
      profileRef === undefined
        ? undefined
        : { profileRef, endpoint: "anthropic", method: "api-key" as const },
  }) as Pick<SessionDescriptor, "accessProfile">

describe("profile gate mode", () => {
  it("defaults to observe", () => {
    expect(DEFAULT_PROFILE_GATE_MODE).toBe("observe")
  })
})

describe("decideProfileUse", () => {
  it("no caller id is no_caller", () => {
    expect(
      decideProfileUse({
        callerSessionId: undefined,
        callerKnown: false,
        requested: ["p-other"],
        callerProfiles: [],
      }),
    ).toEqual({ verdict: "no_caller", denied: [] })
  })

  it("a trusted but unknown caller is caller_unknown", () => {
    expect(
      decideProfileUse({
        callerSessionId: "ghost",
        callerKnown: false,
        requested: ["p-other"],
        callerProfiles: ["p-own"],
      }),
    ).toEqual({ verdict: "caller_unknown", denied: [] })
  })

  it("an external caller is external: a label evaluated as anonymous, never denied", () => {
    expect(
      decideProfileUse({
        callerSessionId: "desk",
        callerKnown: true,
        callerExternal: true,
        requested: ["p-other"],
        callerProfiles: [],
      }),
    ).toEqual({ verdict: "external", denied: [] })
  })

  it("no caller id wins over external, an unknown caller wins over external", () => {
    expect(
      decideProfileUse({
        callerSessionId: undefined,
        callerKnown: false,
        callerExternal: true,
        requested: ["p-other"],
        callerProfiles: [],
      }).verdict,
    ).toBe("no_caller")
    expect(
      decideProfileUse({
        callerSessionId: "ghost",
        callerKnown: false,
        callerExternal: true,
        requested: ["p-other"],
        callerProfiles: [],
      }).verdict,
    ).toBe("caller_unknown")
  })

  it("names no profile is unnamed", () => {
    expect(
      decideProfileUse({
        callerSessionId: "caller",
        callerKnown: true,
        requested: [],
        callerProfiles: ["p-own"],
      }),
    ).toEqual({ verdict: "unnamed", denied: [] })
  })

  it("all requested profiles in the set is allowed", () => {
    expect(
      decideProfileUse({
        callerSessionId: "caller",
        callerKnown: true,
        requested: ["p-own"],
        callerProfiles: ["p-own", "p-shared"],
      }),
    ).toEqual({ verdict: "allowed", denied: [] })
  })

  it("one outside the set is would_deny with only that ref denied, request order, deduped", () => {
    expect(
      decideProfileUse({
        callerSessionId: "caller",
        callerKnown: true,
        requested: ["p-other", "p-own", "p-other", "p-else"],
        callerProfiles: ["p-own"],
      }),
    ).toEqual({ verdict: "would_deny", denied: ["p-other", "p-else"] })
  })

  it("the shared list admits a profile", () => {
    expect(
      decideProfileUse({
        callerSessionId: "caller",
        callerKnown: true,
        requested: ["p-shared"],
        callerProfiles: ["p-own", "p-shared"],
      }),
    ).toEqual({ verdict: "allowed", denied: [] })
  })
})

describe("callerProfileSet", () => {
  it("own profile only", () => {
    expect(callerProfileSet({ caller: callerWith("p-own"), shared: undefined })).toEqual(["p-own"])
  })

  it("own plus shared, deduped", () => {
    expect(
      callerProfileSet({ caller: callerWith("p-own"), shared: ["p-own", "p-shared", "p-shared"] }),
    ).toEqual(["p-own", "p-shared"])
  })

  it("no descriptor gives the shared list only", () => {
    expect(callerProfileSet({ caller: undefined, shared: ["p-shared"] })).toEqual(["p-shared"])
    expect(callerProfileSet({ caller: undefined, shared: undefined })).toEqual([])
  })
})

describe("profile observer", () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetProfileObservations()
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    resetProfileObservations()
  })

  it("counts every verdict", () => {
    recordProfileUse("allowed", { mode: "observe", callerProfiles: ["p-own"], denied: [], surface: "mcp" })
    recordProfileUse("unnamed", { mode: "observe", callerProfiles: [], denied: [], surface: "scoped" })
    recordProfileUse("no_caller", { mode: "observe", callerProfiles: [], denied: [], surface: "scoped" })
    recordProfileUse("caller_unknown", { mode: "observe", callerProfiles: [], denied: [], surface: "mcp" })
    recordProfileUse("external", { mode: "observe", callerProfiles: [], denied: [], surface: "mcp" })
    recordProfileUse("would_deny", {
      mode: "observe",
      callerProfiles: ["p-own"],
      denied: ["p-other"],
      surface: "mcp",
    })
    expect(profileReport("observe").counts).toEqual({
      allowed: 1,
      would_deny: 1,
      unnamed: 1,
      no_caller: 1,
      caller_unknown: 1,
      external: 1,
    })
  })

  it("a pair counted twice has count 2 and ONE warn line", () => {
    const ctx = { mode: "observe" as const, callerProfiles: ["p-own"], denied: ["p-other"], surface: "mcp" as const }
    recordProfileUse("would_deny", ctx)
    recordProfileUse("would_deny", ctx)
    const report = profileReport("observe")
    expect(report.counts.would_deny).toBe(2)
    expect(report.wouldDeny).toEqual([
      expect.objectContaining({ callerProfile: "p-own", requestedProfile: "p-other", count: 2 }),
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[profile-gate] observe: a session on profile "p-own" named profile "p-other"')
  })

  it("pairs are sorted most frequent first", () => {
    const ctx = (denied: string) => ({
      mode: "observe" as const,
      callerProfiles: ["p-own"],
      denied: [denied],
      surface: "mcp" as const,
    })
    recordProfileUse("would_deny", ctx("p-one"))
    recordProfileUse("would_deny", ctx("p-two"))
    recordProfileUse("would_deny", ctx("p-two"))
    expect(profileReport("observe").wouldDeny.map(p => p.requestedProfile)).toEqual(["p-two", "p-one"])
  })

  it("the 200-pair cap keeps counting verdicts but stops tracking new pairs", () => {
    for (let i = 0; i < 205; i++) {
      recordProfileUse("would_deny", {
        mode: "observe",
        callerProfiles: ["p-own"],
        denied: [`p-${i}`],
        surface: "mcp",
      })
    }
    const report = profileReport("observe")
    expect(report.counts.would_deny).toBe(205)
    expect(report.wouldDeny).toHaveLength(50)
  })

  it("resetProfileObservations clears the counters", () => {
    recordProfileUse("would_deny", {
      mode: "observe",
      callerProfiles: ["p-own"],
      denied: ["p-other"],
      surface: "mcp",
    })
    resetProfileObservations()
    expect(profileReport("observe")).toMatchObject({
      counts: { allowed: 0, would_deny: 0, unnamed: 0, no_caller: 0, caller_unknown: 0, external: 0 },
      wouldDeny: [],
    })
  })
})
