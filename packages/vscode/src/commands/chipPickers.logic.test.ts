import { describe, expect, it } from "vitest"

import {
  chipSwitchKind,
  inPlaceSwitchToast,
  restartConfirmMessage,
  resumeBadge,
} from "./chipPickers.logic.js"

describe("chipSwitchKind", () => {
  it("model/posture/effort switch in place; wallet/harness/route are restart-bound", () => {
    expect(chipSwitchKind("model")).toBe("in-place")
    expect(chipSwitchKind("posture")).toBe("in-place")
    expect(chipSwitchKind("effort")).toBe("in-place")
    expect(chipSwitchKind("wallet")).toBe("restart-bound")
    expect(chipSwitchKind("harness")).toBe("restart-bound")
    expect(chipSwitchKind("route")).toBe("restart-bound")
  })
})

describe("restartConfirmMessage", () => {
  it("promises carry-over for a restart-bound axis and names the target", () => {
    const msg = restartConfirmMessage("wallet", "Claude Subs Agentik")!
    expect(msg).toContain("Claude Subs Agentik")
    expect(msg).toContain("restarts the session")
    expect(msg).toContain("conversation carries over")
  })
  it("is undefined for an in-place axis (no confirm)", () => {
    expect(restartConfirmMessage("model", "opus-5")).toBeUndefined()
  })
})

describe("resumeBadge", () => {
  it("reports full context from a resumeVia with no fallback", () => {
    expect(resumeBadge("resumed via ACP")).toEqual({ label: "resumed: full context", fidelity: "full" })
  })
  it("reports summary when the daemon fell back", () => {
    expect(resumeBadge("resumed via ACP", true)).toEqual({ label: "resumed: summary", fidelity: "summary" })
  })
  it("reports no context when no continuity was established", () => {
    expect(resumeBadge("")).toEqual({ label: "resumed: no context", fidelity: "none" })
    expect(resumeBadge(undefined)).toEqual({ label: "resumed: no context", fidelity: "none" })
  })
})

describe("inPlaceSwitchToast", () => {
  it("is silent on success (the chip already updated)", () => {
    expect(inPlaceSwitchToast("model", { applied: true })).toBeUndefined()
  })
  it("names the axis and the daemon's reason on rejection", () => {
    expect(inPlaceSwitchToast("effort", { applied: false, reason: "model rejected it" })).toBe(
      "Couldn't switch effort (model rejected it) — reverted.",
    )
    expect(inPlaceSwitchToast("posture", { applied: false })).toBe("Couldn't switch mode — reverted.")
  })
})
