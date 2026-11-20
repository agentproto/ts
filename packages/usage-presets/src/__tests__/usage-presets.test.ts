import { describe, expect, it } from "vitest"
import {
  CANDIDATES,
  MAX_LOCAL_FREE_AGENTS,
  SensitivityRefusalError,
  UnknownUsageError,
  USAGE_PRESETS,
  isFreeCandidate,
  listUsageSlugs,
  resolveFromSpec,
  resolveUsagePlan,
} from "../index.js"
import type { UsageSpec } from "../index.js"

describe("usage registry (names the work, not the model)", () => {
  it("declares exactly the five usages", () => {
    expect([...listUsageSlugs()].sort()).toEqual([
      "deploy",
      "explore",
      "implement",
      "pr-fix",
      "review",
    ])
  })
  it("the cap constant is 2, as declared", () => {
    expect(MAX_LOCAL_FREE_AGENTS).toBe(2)
  })
})

describe("pr-fix: sandbox, never local", () => {
  const spec = USAGE_PRESETS["pr-fix"]!
  it("first candidate is the sandbox workhorse, on the subscription rail (not a free route)", () => {
    expect(spec.candidates[0]).toBe(CANDIDATES.sandboxGlmFlash)
    expect(isFreeCandidate(spec.candidates[0]!)).toBe(false)
  })
  it("resolves to the workhorse model in the sandbox", () => {
    const plan = resolveUsagePlan("pr-fix", { freeLocalInUse: 0 })
    expect(plan.place).toBe("sandbox")
    expect(plan.resolvedModel).toBe(CANDIDATES.sandboxGlmFlash.model)
    expect(plan.sandbox).toEqual({ provider: "computer" })
    expect(plan.spawn).toMatchObject({
      adapter: "opencode",
      model: CANDIDATES.sandboxGlmFlash.model,
      access: { profileRef: CANDIDATES.sandboxGlmFlash.profileRef },
      sandbox: "computer",
      label: "usage:pr-fix",
    })
  })
  it("counts no free-local budget even when the box is over", () => {
    const plan = resolveUsagePlan("pr-fix", { freeLocalInUse: 99 })
    expect(plan.place).toBe("sandbox")
    expect(plan.warning).toBeUndefined()
  })
  it("a paid-only sandbox candidate resolves paid, same place", () => {
    const plan = resolveFromSpec(
      { ...spec, candidates: [{ ...CANDIDATES.sandboxPaidStrong }] },
      { freeLocalInUse: 0 },
    )
    expect(plan.resolvedModel).toBe(CANDIDATES.localPaidStrong.model)
    expect(isFreeCandidate(spec.candidates[1]!)).toBe(false)
    expect(plan.place).toBe("sandbox")
  })
})

describe("sensitive usage (deploy): free models refused", () => {
  const spec = USAGE_PRESETS["deploy"]!
  it("the committed candidate list is clean of free models", () => {
    expect(spec.sensitive).toBe(true)
    for (const c of spec.candidates) expect(isFreeCandidate(c)).toBe(false)
  })
  it("resolves to the paid local rail", () => {
    const plan = resolveUsagePlan("deploy", { freeLocalInUse: 0 })
    expect(plan.resolvedModel).toBe(CANDIDATES.localPaidStrong.model)
    expect(plan.place).toBe("local")
    expect(isFreeCandidate({ ...CANDIDATES.localPaidStrong })).toBe(false)
  })
  it("an injected free candidate in a sensitive list refuses, naming the model", () => {
    const poisoned: UsageSpec = {
      slug: "deploy",
      label: "Déploiement",
      placePolicy: "local-paid",
      sensitive: true,
      candidates: [
        { ...CANDIDATES.localGlmFlash, free: true },
        ...spec.candidates,
      ],
    }
    try {
      resolveFromSpec(poisoned, { freeLocalInUse: 0 })
      expect.unreachable("should have refused")
    } catch (err) {
      expect(err).toBeInstanceOf(SensitivityRefusalError)
      const msg = (err as Error).message
      expect(msg).toContain("sensible")
      expect(msg).toContain(CANDIDATES.localGlmFlash.model)
    }
  })
})

describe("the 2-free-agents-local cap", () => {
  it("capacity under the cap resolves locally, silently", () => {
    for (const inUse of [0, 1]) {
      const plan = resolveUsagePlan("explore", { freeLocalInUse: inUse })
      expect(plan.place).toBe("local")
      expect(plan.warning).toBeUndefined()
    }
  })
  it("the THIRD free agent (cap already at 2) is redirected to sandbox with a clear message", () => {
    const plan = resolveUsagePlan("explore", { freeLocalInUse: 3 })
    expect(plan.place).toBe("sandbox")
    expect(plan.warning).toContain("Limite atteinte")
    expect(plan.warning).toContain("sandbox")
    expect(plan.warning).toContain("2")
    // The overflow picks the explicitly sandbox-capable free candidate, not
    // the local-declared deepseek one, free is fine inside the box, the IP
    // that bled was the local one.
    const selected = USAGE_PRESETS["explore"]!.candidates[plan.fallbackUsed]!
    expect(selected).toBe(CANDIDATES.sandboxDeepseekFree)
    expect(isFreeCandidate(selected)).toBe(true)
    expect(plan.resolvedModel).toBe(CANDIDATES.sandboxDeepseekFree.model)
    expect(plan.spawn.sandbox).toBe("computer")
  })
  it("a single-candidate free spec keeps its model but moves it into the box", () => {
    const spec: UsageSpec = {
      slug: "implement",
      label: "x",
      placePolicy: "local-preferred",
      candidates: [CANDIDATES.localDeepseekFree],
    }
    const plan = resolveFromSpec(spec, { freeLocalInUse: 2 })
    expect(plan.place).toBe("sandbox")
    expect(plan.resolvedModel).toBe(CANDIDATES.localDeepseekFree.model)
    expect(plan.spawn.sandbox).toBe("computer")
  })
})

describe("unknown usage refuses with the known list", () => {
  it("lists the usages in the message", () => {
    expect(() => resolveUsagePlan("toast", {})).toThrow(UnknownUsageError)
    try {
      resolveUsagePlan("toast", {})
      expect.unreachable()
    } catch (err) {
      const msg = (err as Error).message
      for (const slug of listUsageSlugs()) expect(msg).toContain(slug)
    }
  })
})
