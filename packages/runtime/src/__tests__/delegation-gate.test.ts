import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  decideDelegation,
  delegationReport,
  recordDelegation,
  resetDelegationObservations,
  resolveManifestDelegatesTo,
  DEFAULT_DELEGATION_GATE_MODE,
  type DelegationGateMode,
} from "../delegation-gate.js"

describe("decideDelegation", () => {
  it("returns no_caller when no trusted caller session is known", () => {
    expect(
      decideDelegation({
        callerSessionId: undefined,
        callerAgent: "executor",
        callerDelegatesTo: [],
        childAgent: "supervisor",
      }),
    ).toBe("no_caller")
  })

  it("returns unbound when a caller session exists but names no resolvable agent", () => {
    expect(
      decideDelegation({
        callerSessionId: "sess_parent",
        callerAgent: undefined,
        callerDelegatesTo: undefined,
        childAgent: "executor",
      }),
    ).toBe("unbound")
  })

  it("treats an explicit empty delegatesTo as declared, so a denial is would_deny", () => {
    expect(
      decideDelegation({
        callerSessionId: "sess_parent",
        callerAgent: "executor",
        callerDelegatesTo: [],
        childAgent: "executor",
      }),
    ).toBe("would_deny")
  })

  it("treats undefined delegatesTo as undeclared", () => {
    expect(
      decideDelegation({
        callerSessionId: "sess_parent",
        callerAgent: "planner",
        callerDelegatesTo: undefined,
        childAgent: "executor",
      }),
    ).toBe("undeclared")
  })

  it("allows a supervisor to spawn executor", () => {
    expect(
      decideDelegation({
        callerSessionId: "sess_parent",
        callerAgent: "supervisor",
        callerDelegatesTo: ["supervisor", "executor"],
        childAgent: "executor",
      }),
    ).toBe("allowed")
  })

  it("never counts a child the caller does not name", () => {
    expect(
      decideDelegation({
        callerSessionId: "sess_parent",
        callerAgent: "executor",
        callerDelegatesTo: [],
        childAgent: "supervisor",
      }),
    ).toBe("would_deny")
  })
})

describe("resolveManifestDelegatesTo", () => {
  it("treats an absent, non-array, object or empty field as declaring nothing", () => {
    expect(resolveManifestDelegatesTo(undefined)).toEqual({ kind: "none" })
    expect(resolveManifestDelegatesTo("x")).toEqual({ kind: "none" })
    expect(resolveManifestDelegatesTo({})).toEqual({ kind: "none" })
    expect(resolveManifestDelegatesTo([])).toEqual({ kind: "none" })
  })

  it("resolves bare agent ids and role names, in order", () => {
    expect(resolveManifestDelegatesTo(["planner", "executor"])).toEqual({
      kind: "agents",
      agents: ["planner", "executor"],
    })
  })

  it("strips an @owner/ prefix and dedupes, keeping the first occurrence's order", () => {
    expect(resolveManifestDelegatesTo(["@acme/planner", "planner"])).toEqual({
      kind: "agents",
      agents: ["planner"],
    })
  })

  it("resolves a { ref } entry", () => {
    expect(resolveManifestDelegatesTo([{ ref: "planner" }])).toEqual({
      kind: "agents",
      agents: ["planner"],
    })
  })

  it("trims an identity candidate", () => {
    expect(resolveManifestDelegatesTo([" planner "])).toEqual({ kind: "agents", agents: ["planner"] })
  })

  it.each([
    ["./agents/p/AGENT.md"],
    ["p.md"],
    ["a/b"],
    ["C:\\x"],
    [{ file: "x" }],
    [{ inline: {} }],
    [{ ref: "a", file: "b" }],
    [""],
    [3],
  ])("returns unresolved for %j", entry => {
    expect(resolveManifestDelegatesTo([entry])).toEqual({
      kind: "unresolved",
      entry: JSON.stringify(entry),
    })
  })

  it("makes the whole list unresolved when one entry is unresolvable", () => {
    expect(resolveManifestDelegatesTo(["planner", { file: "x.md" }, "executor"])).toEqual({
      kind: "unresolved",
      entry: JSON.stringify({ file: "x.md" }),
    })
  })
})

describe("delegation observations", () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetDelegationObservations()
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    resetDelegationObservations()
  })

  it("defaults to observe", () => {
    expect(DEFAULT_DELEGATION_GATE_MODE).toBe("observe")
  })

  it("counts every verdict", () => {
    const mode: DelegationGateMode = "observe"
    recordDelegation("allowed", { mode, callerAgent: "supervisor", childAgent: "executor", surface: "scoped" })
    recordDelegation("would_deny", { mode, callerAgent: "executor", childAgent: "supervisor", surface: "mcp" })
    recordDelegation("undeclared", { mode, callerAgent: "planner", childAgent: "executor", surface: "mcp" })
    recordDelegation("unbound", { mode, childAgent: "executor", surface: "mcp" })
    recordDelegation("no_caller", { mode, childAgent: "executor", surface: "mcp" })

    const report = delegationReport(mode)
    expect(report.counts).toEqual({
      allowed: 1,
      would_deny: 1,
      undeclared: 1,
      unbound: 1,
      no_caller: 1,
    })
  })

  it("sorts the would_deny pairs by count and cuts the list to 50", () => {
    const mode: DelegationGateMode = "observe"
    for (let i = 0; i < 55; i++) {
      recordDelegation("would_deny", {
        mode,
        callerAgent: `caller-${i}`,
        childAgent: `child-${i}`,
        surface: "mcp",
      })
    }
    for (let i = 0; i < 3; i++) {
      recordDelegation("would_deny", {
        mode,
        callerAgent: "caller-hot",
        childAgent: "child-hot",
        surface: "mcp",
      })
    }

    const report = delegationReport(mode)
    expect(report.wouldDeny).toHaveLength(50)
    expect(report.wouldDeny[0]).toMatchObject({ callerAgent: "caller-hot", childAgent: "child-hot", count: 3 })
    expect(report.counts.would_deny).toBe(58)
  })

  it("caps the pair map at 200 distinct pairs but still counts the verdict", () => {
    const mode: DelegationGateMode = "observe"
    for (let i = 0; i < 250; i++) {
      recordDelegation("would_deny", {
        mode,
        callerAgent: `caller-${i}`,
        childAgent: `child-${i}`,
        surface: "mcp",
      })
    }
    // A tracked pair keeps counting; a pair first seen past the cap never appears.
    for (let n = 0; n < 5; n++) {
      recordDelegation("would_deny", { mode, callerAgent: "caller-0", childAgent: "child-0", surface: "mcp" })
    }
    for (let n = 0; n < 10; n++) {
      recordDelegation("would_deny", { mode, callerAgent: "caller-249", childAgent: "child-249", surface: "mcp" })
    }
    const report = delegationReport(mode)
    expect(report.counts.would_deny).toBe(265)
    expect(report.wouldDeny).toHaveLength(50)
    expect(report.wouldDeny[0]).toMatchObject({ callerAgent: "caller-0", count: 6 })
    expect(report.wouldDeny.some(row => row.callerAgent === "caller-249")).toBe(false)
  })

  it("caps the undeclared-agent map at 200 distinct agents but still counts the verdict", () => {
    const mode: DelegationGateMode = "observe"
    for (let i = 0; i < 250; i++) {
      recordDelegation("undeclared", { mode, callerAgent: `agent-${i}`, childAgent: "executor", surface: "mcp" })
    }
    for (let n = 0; n < 10; n++) {
      recordDelegation("undeclared", { mode, callerAgent: "agent-249", childAgent: "executor", surface: "mcp" })
    }
    const report = delegationReport(mode)
    expect(report.counts.undeclared).toBe(260)
    expect(report.undeclaredAgents).toHaveLength(50)
    expect(report.undeclaredAgents.some(row => row.agent === "agent-249")).toBe(false)
  })

  it("writes exactly one warn line per would_deny and none for other verdicts", () => {
    const mode: DelegationGateMode = "observe"
    recordDelegation("would_deny", { mode, callerAgent: "executor", childAgent: "supervisor", surface: "scoped" })
    recordDelegation("allowed", { mode, callerAgent: "supervisor", childAgent: "executor", surface: "scoped" })
    recordDelegation("undeclared", { mode, callerAgent: "planner", childAgent: "executor", surface: "mcp" })
    recordDelegation("unbound", { mode, childAgent: "executor", surface: "mcp" })
    recordDelegation("no_caller", { mode, childAgent: "executor", surface: "mcp" })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      '[delegation-gate] observe: agent "executor" would not be allowed to spawn "supervisor" (surface scoped)',
    )
    expect(String(warn.mock.calls[0]?.[0] ?? "")).not.toMatch(/sess_|session-/)
  })

  it("reports unbound and undeclared callers by agent slug or (none)", () => {
    const mode: DelegationGateMode = "observe"
    recordDelegation("undeclared", { mode, callerAgent: "planner", childAgent: "executor", surface: "mcp" })
    recordDelegation("undeclared", { mode, callerAgent: "planner", childAgent: "executor", surface: "mcp" })
    recordDelegation("unbound", { mode, childAgent: "executor", surface: "mcp" })

    const report = delegationReport(mode)
    expect(report.undeclaredAgents).toEqual([
      { agent: "planner", count: 2 },
      { agent: "(none)", count: 1 },
    ])
  })

  it("resetDelegationObservations zeroes every counter and clears the lists", () => {
    const mode: DelegationGateMode = "observe"
    recordDelegation("would_deny", { mode, callerAgent: "executor", childAgent: "supervisor", surface: "mcp" })
    recordDelegation("undeclared", { mode, callerAgent: "planner", childAgent: "executor", surface: "mcp" })

    resetDelegationObservations()
    const report = delegationReport(mode)
    expect(report.counts).toEqual({ allowed: 0, would_deny: 0, undeclared: 0, unbound: 0, no_caller: 0 })
    expect(report.wouldDeny).toEqual([])
    expect(report.undeclaredAgents).toEqual([])
  })

  it("reports the mode it is given and an ISO since timestamp", () => {
    const report = delegationReport("enforce")
    expect(report.mode).toBe("enforce")
    expect(Number.isNaN(Date.parse(report.since))).toBe(false)
  })
})
