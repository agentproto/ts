import { describe, expect, it } from "vitest"
import { resolveAdapter, listHarnessCapabilities } from "../registry/resolve.js"

describe("resolveAdapter — capabilitiesStrategy pickup", () => {
  it("picks up hermes' exported hermesCapabilities as capabilitiesStrategy", async () => {
    const resolved = await resolveAdapter("hermes")
    expect(typeof resolved.capabilitiesStrategy).toBe("function")
  })

  it("picks up gemini's exported geminiCapabilities as capabilitiesStrategy", async () => {
    const resolved = await resolveAdapter("gemini")
    expect(typeof resolved.capabilitiesStrategy).toBe("function")
  })

  it("picks up mastracode's exported mastracodeCapabilities as capabilitiesStrategy", async () => {
    const resolved = await resolveAdapter("mastracode")
    expect(typeof resolved.capabilitiesStrategy).toBe("function")
  })

  it("leaves capabilitiesStrategy undefined for an adapter with no such export", async () => {
    // codex ships no <camelSlug>Capabilities export (out of Phase 1 scope) —
    // resolveAdapter must not fabricate one.
    const resolved = await resolveAdapter("codex")
    expect(resolved.capabilitiesStrategy).toBeUndefined()
  })
})

describe("listHarnessCapabilities", () => {
  it("resolves a single adapter's live capabilities when `adapter` is given", async () => {
    const capabilities = await listHarnessCapabilities({ adapter: "hermes" })
    expect(capabilities).toHaveLength(1)
    expect(capabilities[0]?.adapter).toBe("hermes")
    // No ~/.hermes/auth.json on the test box — best-effort discovery still
    // succeeds (empty providers), never throws.
    expect(capabilities[0]?.source).toBe("discovered")
    expect(capabilities[0]?.discoverable).toBe("live")
  })

  it("applies mastracode's application-contract override (argv-based model/posture)", async () => {
    const capabilities = await listHarnessCapabilities({ adapter: "mastracode" })
    expect(capabilities[0]?.application).toEqual({
      modelApply: "arg",
      postureApply: "arg",
      coupled: false,
    })
  })

  it("falls back to deriveDeclaredCapabilities for an adapter with no strategy", async () => {
    const capabilities = await listHarnessCapabilities({ adapter: "codex" })
    expect(capabilities).toHaveLength(1)
    expect(capabilities[0]?.source).toBe("manifest-fallback")
    expect(capabilities[0]?.discoverable).toBe("declared")
  })

  it("never leaks a raw credential value even when process.env carries one", async () => {
    const prev = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = "sk-or-v1-should-never-appear-in-output"
    try {
      const capabilities = await listHarnessCapabilities({ adapter: "hermes" })
      const serialized = JSON.stringify(capabilities)
      expect(serialized).not.toContain("sk-or-v1-should-never-appear-in-output")
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = prev
    }
  })

  it("lists every installed adapter when `adapter` is omitted", async () => {
    const capabilities = await listHarnessCapabilities()
    expect(capabilities.length).toBeGreaterThan(0)
    expect(capabilities.some((c) => c.adapter === "hermes")).toBe(true)
  })
})
