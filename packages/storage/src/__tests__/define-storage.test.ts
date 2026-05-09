import { describe, it, expect } from "vitest"
import { defineStorage } from "../define-storage.js"

describe("defineStorage (AIP-35)", () => {
  it("imports cleanly", () => {
    expect(typeof defineStorage).toBe("function")
  })

  it("accepts a minimal manifest", () => {
    const handle = defineStorage({
      provider: "cloud-bucket",
      config: { bucket: "test" },
    })
    expect(handle.provider).toBe("cloud-bucket")
    expect(handle.config).toEqual({ bucket: "test" })
  })

  it("rejects unknown manifest fields (.strict() catches typos)", () => {
    expect(() =>
      defineStorage({
        provider: "cloud-bucket",
        config: {},
        // @ts-expect-error intentionally invalid manifest field
        unknown: "field",
      }),
    ).toThrow(/defineStorage \(AIP-35\)/)
  })

  // ── AIP-43 runtime slots (factory + capabilities) ───────────────────

  describe("AIP-43 runtime slots", () => {
    it("strips factory + capabilities before AIP-35 schema validation", () => {
      // Without the strip-before-validate path, .strict() would reject
      // these fields and throw. They survive on the returned handle.
      type FactoryFn = (cfg: unknown) => string
      const factory: FactoryFn = () => "host-flavored-fs"
      const handle = defineStorage<FactoryFn>({
        provider: "local-daemon",
        config: { endpoint: "http://127.0.0.1:18790" },
        factory,
        capabilities: { bridgeable: true, transport: "mcp-runtime" },
      })
      expect(handle.factory).toBe(factory)
      expect(handle.capabilities?.bridgeable).toBe(true)
      expect(handle.capabilities?.transport).toBe("mcp-runtime")
    })

    it("preserves the manifest fields alongside the runtime slots", () => {
      const handle = defineStorage({
        provider: "s3",
        config: { bucket: "foo", region: "us-east-1" },
        capabilities: { bridgeable: true, transport: "fuse" },
      })
      expect(handle.provider).toBe("s3")
      expect(handle.config).toEqual({ bucket: "foo", region: "us-east-1" })
      expect(handle.capabilities?.transport).toBe("fuse")
    })

    it("freezes capabilities (registry consumers rely on immutability)", () => {
      const handle = defineStorage({
        provider: "local-daemon",
        config: {},
        capabilities: { bridgeable: true },
      })
      expect(Object.isFrozen(handle.capabilities)).toBe(true)
    })

    it("omits the slots from the handle when not provided", () => {
      const handle = defineStorage({
        provider: "cloud-bucket",
        config: { bucket: "default" },
      })
      expect(handle.factory).toBeUndefined()
      expect(handle.capabilities).toBeUndefined()
    })

    it("preserves the factory generic across the call", () => {
      type FactoryFn = (cfg: { bucket: string }) => { id: string }
      const handle = defineStorage<FactoryFn>({
        provider: "cloud-bucket",
        config: { bucket: "x" },
        factory: cfg => ({ id: `cb-${cfg.bucket}` }),
      })
      // Factory is retained with its declared type — invocable.
      expect(handle.factory?.({ bucket: "y" })).toEqual({ id: "cb-y" })
    })
  })
})
