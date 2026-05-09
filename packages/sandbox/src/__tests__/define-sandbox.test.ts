import { describe, it, expect } from "vitest"
import { defineSandbox } from "../define-sandbox.js"

describe("defineSandbox (AIP-36)", () => {
  it("imports cleanly", () => {
    expect(typeof defineSandbox).toBe("function")
  })

  it("accepts a minimal manifest", () => {
    const handle = defineSandbox({
      provider: "local",
      config: {},
    })
    expect(handle.provider).toBe("local")
  })

  // ── AIP-43 runtime slots ────────────────────────────────────────────

  describe("AIP-43 runtime slots", () => {
    it("accepts factory + capabilities and surfaces them on the handle", () => {
      type FactoryFn = (cfg: unknown) => string
      const factory: FactoryFn = () => "fake-sandbox"
      const handle = defineSandbox<FactoryFn>({
        provider: "local-daemon",
        config: { endpoint: "http://127.0.0.1:18790" },
        factory,
        capabilities: { pairsWith: ["local-daemon"] },
      })
      expect(handle.factory).toBe(factory)
      expect(handle.capabilities?.pairsWith).toEqual(["local-daemon"])
    })

    it("freezes capabilities", () => {
      const handle = defineSandbox({
        provider: "e2b",
        config: {},
        capabilities: { bridgeable: true, transport: "fuse" },
      })
      expect(Object.isFrozen(handle.capabilities)).toBe(true)
    })

    it("omits both slots when not provided", () => {
      const handle = defineSandbox({ provider: "local", config: {} })
      expect(handle.factory).toBeUndefined()
      expect(handle.capabilities).toBeUndefined()
    })
  })
})
