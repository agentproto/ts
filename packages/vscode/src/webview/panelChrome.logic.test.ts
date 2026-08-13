import { describe, expect, it } from "vitest"

import {
  accessIdentity,
  contextGauge,
  contextRingLevel,
  formatCostShort,
  harnessGlyph,
  postureLabel,
  projectPlan,
  titleStatusState,
} from "./panelChrome.logic.js"
import type { PlanEntry } from "./conversation.js"
import type { SessionDescriptor } from "../client/types.js"

describe("harnessGlyph", () => {
  it("maps known harness families to distinct marks", () => {
    expect(harnessGlyph("claude-code").glyph).toBe("❋")
    expect(harnessGlyph("codex").glyph).toBe("⬡")
    expect(harnessGlyph("openai-responses").glyph).toBe("⬡")
    expect(harnessGlyph("hermes").glyph).toBe("☿")
    expect(harnessGlyph("gemini-cli").glyph).toBe("♊")
  })

  it("matches on a substring of a lowercased slug so variants resolve", () => {
    expect(harnessGlyph("Claude-Code-Gateway").glyph).toBe("❋")
  })

  it("carries the raw slug as the tooltip label", () => {
    expect(harnessGlyph("claude-code").label).toBe("claude-code")
  })

  it("falls back to a generic mark for an unknown or absent slug", () => {
    expect(harnessGlyph("some-new-harness").glyph).toBe("◆")
    expect(harnessGlyph(undefined)).toEqual({ glyph: "◆", label: "harness" })
    expect(harnessGlyph("")).toEqual({ glyph: "◆", label: "harness" })
  })
})

describe("accessIdentity", () => {
  it("prefers the named profile's label", () => {
    expect(
      accessIdentity({
        accessProfile: { profileRef: "work", label: "Work wallet", vendor: "anthropic", method: "oauth-bearer" },
      }),
    ).toBe("Work wallet")
  })

  it("falls back to the profileRef when the profile has no label", () => {
    expect(
      accessIdentity({
        accessProfile: { profileRef: "personal", vendor: "anthropic", method: "api-key" },
      }),
    ).toBe("personal")
  })

  it("falls back to the raw auth method when no named profile is echoed", () => {
    expect(accessIdentity({ auth: { mode: "subscription", fingerprint: "abc" } })).toBe("subscription")
  })

  it("returns an em dash when neither profile nor auth is present", () => {
    expect(accessIdentity({})).toBe("—")
    expect(accessIdentity(undefined)).toBe("—")
  })
})

describe("postureLabel", () => {
  it("renders a canonical posture as-is", () => {
    expect(postureLabel("plan")).toBe("plan")
    expect(postureLabel("bypass")).toBe("bypass")
  })

  it("renders a raw harness-mode posture's id", () => {
    expect(postureLabel({ harnessModeId: "custom-mode" })).toBe("custom-mode")
  })

  it("returns an empty string when absent", () => {
    expect(postureLabel(undefined)).toBe("")
  })
})

describe("contextGauge", () => {
  it("returns ratio, rounded pct, and a color level", () => {
    expect(contextGauge(200_000, 1_000_000)).toEqual({ ratio: 0.2, pct: 20, level: "low" })
  })

  it("buckets the color level at 70% and 90%", () => {
    expect(contextGauge(69, 100)!.level).toBe("low")
    expect(contextGauge(70, 100)!.level).toBe("mid")
    expect(contextGauge(89, 100)!.level).toBe("mid")
    expect(contextGauge(90, 100)!.level).toBe("high")
  })

  it("clamps a runaway used>size to a full ring, not overflow", () => {
    expect(contextGauge(1500, 1000)).toEqual({ ratio: 1, pct: 100, level: "high" })
  })

  it("returns null when size is missing, zero, or non-numeric", () => {
    expect(contextGauge(100, 0)).toBeNull()
    expect(contextGauge(100, undefined)).toBeNull()
    expect(contextGauge(undefined, 1000)).toBeNull()
  })
})

describe("formatCostShort", () => {
  it("renders two decimals and an em dash for no figure", () => {
    expect(formatCostShort(20.5734)).toBe("$20.57")
    expect(formatCostShort(0)).toBe("$0.00")
    expect(formatCostShort(undefined)).toBe("—")
    expect(formatCostShort(Number.NaN)).toBe("—")
  })
})

describe("contextRingLevel", () => {
  it("follows the contextContinuity thresholds: grey → amber(warn) → red(compact)", () => {
    expect(contextRingLevel(10, 60, 85)).toBe("grey")
    expect(contextRingLevel(60, 60, 85)).toBe("amber")
    expect(contextRingLevel(84, 60, 85)).toBe("amber")
    expect(contextRingLevel(85, 60, 85)).toBe("red")
  })
  it("falls back to 70/90 when no policy is resolved", () => {
    expect(contextRingLevel(69)).toBe("grey")
    expect(contextRingLevel(70)).toBe("amber")
    expect(contextRingLevel(90)).toBe("red")
  })
})

describe("titleStatusState", () => {
  const s = (over: Partial<SessionDescriptor>): SessionDescriptor => ({
    id: "s", kind: "agent-cli", workspaceSlug: "w", command: "c", pid: 1, status: "running", startedAt: "t", ...over,
  })
  it("applies the precedence awaiting > stalled > busy > delegating > parked > quiet", () => {
    // Awaiting your input outranks everything — including a busy flag and a
    // busy subtree — because it's the one state that genuinely needs YOU.
    expect(titleStatusState(s({ busy: true, childrenBusy: 2, awaitingInput: true }))).toBe("awaiting")
    expect(titleStatusState(s({ busy: false, childrenBusy: 1, awaitingInput: true }))).toBe("awaiting")
    expect(titleStatusState(s({ busy: false, awaitingInput: true, watchers: 3 }))).toBe("awaiting")
    // A busy session flagged by the turn-liveness watchdog (#601-adjacent) is
    // "stalled", not "busy" — it stopped masquerading as working.
    expect(titleStatusState(s({ busy: true, stalledSinceMs: 1_000 }))).toBe("stalled")
    expect(titleStatusState(s({ busy: true }))).toBe("busy")
    expect(titleStatusState(s({ status: "starting" }))).toBe("busy")
    expect(titleStatusState(s({ busy: false, childrenBusy: 1 }))).toBe("delegating")
    expect(titleStatusState(s({ busy: false, watchers: 1 }))).toBe("parked")
    expect(titleStatusState(s({ busy: false }))).toBe("quiet")
  })
})

describe("projectPlan", () => {
  const e = (status: string, content = status): PlanEntry => ({ content, priority: "medium", status })
  it("collapses done, keeps failed, and windows upcoming to current + next 3", () => {
    const proj = projectPlan([
      e("completed", "a"), e("completed", "b"),
      e("failed", "boom"),
      e("in_progress", "now"),
      e("pending", "p1"), e("pending", "p2"), e("pending", "p3"), e("pending", "p4"), e("pending", "p5"),
    ])
    expect(proj.doneCount).toBe(2)
    expect(proj.doneItems.map(x => x.content)).toEqual(["a", "b"])
    expect(proj.failed.map(x => x.content)).toEqual(["boom"])
    expect(proj.current?.content).toBe("now")
    expect(proj.upcoming.map(x => x.content)).toEqual(["p1", "p2", "p3"])
    expect(proj.moreCount).toBe(2)
  })
  it("has no current and no more when nothing is in flight or queued deep", () => {
    const proj = projectPlan([e("completed"), e("pending", "only")])
    expect(proj.current).toBeUndefined()
    expect(proj.upcoming.map(x => x.content)).toEqual(["only"])
    expect(proj.moreCount).toBe(0)
  })
})
