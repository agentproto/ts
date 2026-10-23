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

describe("pr-fix: sandbox + free model, never local", () => {
  const spec = USAGE_PRESETS["pr-fix"]!
  it("first candidate is free", () => {
    expect(isFreeCandidate(spec.candidates[0]!)).toBe(true)
  })
  it("resolves to a free model in the sandbox", () => {
    const plan = resolveUsagePlan("pr-fix", { freeLocalInUse: 0 })
    expect(plan.place).toBe("sandbox")
    expect(plan.resolvedModel).toBe("opencode/glm-5.3-flash-free")
    expect(plan.sandbox).toEqual({ provider: "computer" })
    expect(plan.spawn).toMatchObject({
      adapter: "opencode",
      model: "opencode/glm-5.3-flash-free",
      access: { profileRef: "opencode-api-zen-ws03" },
      sandbox: { provider: "computer" },
      meta: { usage: "pr-fix", place: "sandbox" },
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
    expect(plan.resolvedModel).toBe("opencode-go/glm-5.3")
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
    expect(plan.resolvedModel).toBe("opencode-go/glm-5.3")
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
        { ...CANDIDATES.localGlmFree, free: true },
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
      expect(msg).toContain("opencode/glm-5.3-flash-free")
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
    // the local-declared deepseek one — free is fine inside the box, the IP
    // that bled was the local one.
    const selected = USAGE_PRESETS["explore"]!.candidates[plan.fallbackUsed]!
    expect(selected).toBe(CANDIDATES.sandboxGlmFree)
    expect(isFreeCandidate(selected)).toBe(true)
    expect(plan.resolvedModel).toBe("opencode/glm-5.3-flash-free")
    expect(plan.spawn.sandbox).toEqual({ provider: "computer" })
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
    expect(plan.resolvedModel).toBe("opencode/deepseek-v4.1-flash-free")
    expect(plan.spawn.sandbox).toEqual({ provider: "computer" })
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
