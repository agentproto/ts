import { describe, it, expect } from "vitest"
import { hasRequiredFailure, runChecks, selectSteps, summarize } from "./run.js"
import type { OnboardingStep, StepStatus } from "./types.js"
import { createFakeContext } from "./__fixtures__/fake-context.js"

function step(id: string, status: StepStatus, required = true): OnboardingStep {
  return { id, title: id, required, detect: async () => [{ id: `${id}.x`, title: "x", status }] }
}

describe("runChecks", () => {
  it("a throwing step becomes one broken check and the others still run", async () => {
    const boom: OnboardingStep = {
      id: "boom",
      title: "Boom",
      required: false,
      detect: async () => {
        throw new Error("kaboom")
      },
    }
    const reports = await runChecks([step("a", "ok"), boom, step("b", "ok")], createFakeContext())
    expect(reports.map((r) => r.id)).toEqual(["a", "boom", "b"])
    expect(reports[1]?.checks).toEqual([{ id: "boom.error", title: "Boom", status: "broken", detail: "kaboom" }])
    expect(reports[2]?.checks[0]?.status).toBe("ok")
  })

  it("a step past its timeout becomes a warn 'not checked'", async () => {
    const slow: OnboardingStep = {
      id: "slow",
      title: "Slow",
      required: true,
      detect: () => new Promise(() => undefined),
    }
    const [report] = await runChecks([slow], createFakeContext(), { timeoutMs: 20 })
    expect(report?.checks[0]?.status).toBe("warn")
    expect(report?.checks[0]?.detail).toContain("not checked")
  })

  it("--only / --skip filter in registry order", async () => {
    const steps = [step("a", "ok"), step("b", "ok"), step("c", "ok")]
    expect(selectSteps(steps, { only: ["c", "a"] }).map((s) => s.id)).toEqual(["a", "c"])
    expect(selectSteps(steps, { skip: ["b"] }).map((s) => s.id)).toEqual(["a", "c"])
    const reports = await runChecks(steps, createFakeContext(), { only: ["b"] })
    expect(reports.map((r) => r.id)).toEqual(["b"])
  })
})

describe("exit rules", () => {
  it("missing/broken in a required step fails; warn and optional steps never do", async () => {
    const ctx = createFakeContext()
    expect(hasRequiredFailure(await runChecks([step("a", "warn")], ctx))).toBe(false)
    expect(hasRequiredFailure(await runChecks([step("a", "broken", false)], ctx))).toBe(false)
    expect(hasRequiredFailure(await runChecks([step("a", "missing")], ctx))).toBe(true)
    expect(hasRequiredFailure(await runChecks([step("a", "broken")], ctx))).toBe(true)
  })

  it("summary counts every status but skipped", async () => {
    const reports = await runChecks(
      [step("a", "ok"), step("b", "warn"), step("c", "skipped"), step("d", "missing")],
      createFakeContext(),
    )
    expect(summarize(reports)).toEqual({ ok: 1, warn: 1, missing: 1, broken: 0 })
  })
})
