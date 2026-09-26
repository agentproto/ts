import { describe, it, expect } from "vitest"
import { agentLaneStatus, foldVerdict, meetsSeverity, type Finding, type LaneResult } from "../index.js"

const lane = (id: string, status: LaneResult["status"], blocking = true): LaneResult => ({
  id,
  kind: "command",
  status,
  blocking,
  findings: [],
  durationMs: 1,
})

const finding = (severity: Finding["severity"]): Finding => ({ severity, title: `a ${severity} finding`, detail: "" })

describe("foldVerdict — blocking vs advisory", () => {
  it("passes when every blocking lane passes", () => {
    expect(foldVerdict([lane("a", "pass"), lane("b", "pass")])).toBe("pass")
  })

  it("blocks when a blocking lane fails", () => {
    expect(foldVerdict([lane("a", "pass"), lane("b", "fail")])).toBe("block")
  })

  it("ignores an advisory lane's failure, timeout, or skip", () => {
    expect(foldVerdict([lane("a", "pass"), lane("lint", "fail", false)])).toBe("pass")
    expect(foldVerdict([lane("a", "pass"), lane("lint", "timeout", false)])).toBe("pass")
    expect(foldVerdict([lane("a", "pass"), lane("lint", "skipped", false)])).toBe("pass")
  })

  it("is incomplete — never pass — when a blocking lane timed out or was skipped", () => {
    expect(foldVerdict([lane("a", "pass"), lane("b", "timeout")])).toBe("incomplete")
    expect(foldVerdict([lane("a", "pass"), lane("b", "skipped")])).toBe("incomplete")
  })

  it("prefers block over incomplete when both apply", () => {
    expect(foldVerdict([lane("a", "fail"), lane("b", "timeout")])).toBe("block")
  })

  it("is incomplete when no lane is blocking", () => {
    expect(foldVerdict([lane("lint", "pass", false)])).toBe("incomplete")
    expect(foldVerdict([])).toBe("incomplete")
  })
})

describe("agentLaneStatus — blockOn severity", () => {
  it("blockOn high: only a high finding fails the lane", () => {
    expect(agentLaneStatus([finding("medium"), finding("low")], "high")).toBe("pass")
    expect(agentLaneStatus([finding("low"), finding("high")], "high")).toBe("fail")
  })

  it("blockOn medium: medium and high fail, low rides along", () => {
    expect(agentLaneStatus([finding("low")], "medium")).toBe("pass")
    expect(agentLaneStatus([finding("medium")], "medium")).toBe("fail")
    expect(agentLaneStatus([finding("high")], "medium")).toBe("fail")
  })

  it("blockOn low: any finding fails; no findings passes", () => {
    expect(agentLaneStatus([finding("low")], "low")).toBe("fail")
    expect(agentLaneStatus([], "low")).toBe("pass")
  })

  it("meetsSeverity orders high > medium > low", () => {
    expect(meetsSeverity("high", "low")).toBe(true)
    expect(meetsSeverity("low", "high")).toBe(false)
    expect(meetsSeverity("medium", "medium")).toBe(true)
  })
})
