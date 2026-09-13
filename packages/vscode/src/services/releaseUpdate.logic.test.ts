import { describe, expect, it } from "vitest"

import {
  buildUpdatePlan,
  decideUpdateFlow,
  decideUpdatePrompt,
  updateTargetFor,
  type ReleaseSnooze,
  type UpdatePlan,
} from "./releaseUpdate.logic.js"

const NOW = Date.parse("2026-08-16T12:00:00.000Z")
const TTL = 60 * 60 * 1000

function promptInput(over: Record<string, unknown> = {}) {
  return {
    localVersion: "0.14.0",
    latest: "0.15.0",
    state: "behind" as const,
    buildSource: "tarball" as const,
    snooze: null,
    nowMs: NOW,
    ...over,
  }
}

describe("decideUpdatePrompt", () => {
  it("prompts for a tarball when a newer release exists", () => {
    const d = decideUpdatePrompt(promptInput())
    expect(d).toEqual({ kind: "prompt", target: "tarball", latest: "0.15.0", localVersion: "0.14.0" })
  })
  it("prompts for a workspace rebuild when a newer release exists", () => {
    const d = decideUpdatePrompt(promptInput({ state: "workspace", buildSource: "workspace" }))
    expect(d).toEqual({ kind: "prompt", target: "workspace", latest: "0.15.0", localVersion: "0.14.0" })
  })
  it("is silent when already current (no update)", () => {
    const d = decideUpdatePrompt(promptInput({ latest: "0.14.0" }))
    expect(d).toEqual({ kind: "silent", reason: "no-update" })
  })
  it("is silent when state is unknown (offline / unverified)", () => {
    expect(decideUpdatePrompt(promptInput({ latest: null }))).toEqual({ kind: "silent", reason: "unknown" })
    expect(decideUpdatePrompt(promptInput({ localVersion: null }))).toEqual({ kind: "silent", reason: "unknown" })
  })
  it("is silent when current state would not mean an available update", () => {
    expect(decideUpdatePrompt(promptInput({ state: "current" }))).toEqual({ kind: "silent", reason: "no-update" })
  })
  it("honours the 'later' snooze (silent until next TTL)", () => {
    const snooze: ReleaseSnooze = { kind: "later", untilMs: NOW + TTL }
    expect(decideUpdatePrompt(promptInput({ snooze }))).toEqual({ kind: "silent", reason: "snoozed-later" })
  })
  it("honours the 'not now' snooze for THIS version", () => {
    const snooze: ReleaseSnooze = { kind: "version", version: "0.15.0" }
    expect(decideUpdatePrompt(promptInput({ snooze }))).toEqual({ kind: "silent", reason: "snoozed-version" })
  })
  it("a 'not now' snooze for one version still prompts when a NEWER one appears", () => {
    const snooze: ReleaseSnooze = { kind: "version", version: "0.15.0" }
    const d = decideUpdatePrompt(promptInput({ snooze, latest: "0.16.0" }))
    expect(d.kind).toBe("prompt")
    if (d.kind === "prompt") expect(d.latest).toBe("0.16.0")
  })
  it("an expired 'later' snooze prompts again", () => {
    const snooze: ReleaseSnooze = { kind: "later", untilMs: NOW - 1 }
    const d = decideUpdatePrompt(promptInput({ snooze }))
    expect(d.kind).toBe("prompt")
  })
})

describe("updateTargetFor", () => {
  it("maps workspace → workspace, anything else → tarball", () => {
    expect(updateTargetFor("workspace")).toBe("workspace")
    expect(updateTargetFor("tarball")).toBe("tarball")
    expect(updateTargetFor(null)).toBe("tarball")
  })
})

describe("buildUpdatePlan", () => {
  it("tarball: npm install the exact latest + a clean daemon restart", () => {
    const plan = buildUpdatePlan("tarball", "0.15.0")
    expect(plan.kind).toBe("tarball")
    expect((plan as Extract<UpdatePlan, { kind: "tarball" }>).installCommand).toBe("npm i -g @agentproto/cli@0.15.0")
    expect((plan as Extract<UpdatePlan, { kind: "tarball" }>).restartCommand).toBe("agentproto daemon restart")
  })
  it("workspace: pre-filled git+rebuild+restart commands and a risk note, never executed here", () => {
    const plan = buildUpdatePlan("workspace", "0.15.0")
    expect(plan.kind).toBe("workspace")
    const w = plan as Extract<UpdatePlan, { kind: "workspace" }>
    expect(w.commands).toEqual([
      "git -C projects/agentproto/ts pull",
      "pnpm --filter @agentproto/cli build",
      "agentproto daemon restart",
    ])
    expect(w.riskNote).toMatch(/working tree/)
    expect(w.riskNote).toMatch(/you/)
  })
})

describe("decideUpdateFlow — execution only ever follows an explicit 'update'", () => {
  it("Update now → a runnable plan and no snooze", () => {
    const flow = decideUpdateFlow("update", "0.15.0", NOW, TTL, "tarball")
    expect(flow.snooze).toBeNull()
    expect(flow.plan).not.toBeNull()
    expect(flow.plan?.kind).toBe("tarball")
  })
  it("Later → a snooze until the next TTL, and NO plan (nothing executable)", () => {
    const flow = decideUpdateFlow("later", "0.15.0", NOW, TTL, "tarball")
    expect(flow.plan).toBeNull()
    expect(flow.snooze).toEqual({ kind: "later", untilMs: NOW + TTL })
  })
  it("Not now → a version snooze and NO plan (nothing executable)", () => {
    const flow = decideUpdateFlow("not-now", "0.15.0", NOW, TTL, "tarball")
    expect(flow.plan).toBeNull()
    expect(flow.snooze).toEqual({ kind: "version", version: "0.15.0" })
  })
  it("ANY non-update decision produces no plan regardless of target", () => {
    for (const target of ["tarball", "workspace"] as const) {
      expect(decideUpdateFlow("later", "0.15.0", NOW, TTL, target).plan).toBeNull()
      expect(decideUpdateFlow("not-now", "0.15.0", NOW, TTL, target).plan).toBeNull()
    }
  })
})