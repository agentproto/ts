import { describe, it, expect } from "vitest"
import type { PolicyDefinition } from "@agentproto/policy"
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

describe("defineStorage: AIP-38 policy block (parse-and-surface)", () => {
  // Annotated so `schema` keeps the "policy/v1" literal type (matches
  // PolicyDefinition's discriminated union arm).
  const inlinePolicy: PolicyDefinition = {
    schema: "policy/v1",
    version: "1.0.0",
    default: "deny" as const,
    grants: [
      {
        principal: "role://operator",
        actions: [{ action: "storage:commit" }],
      },
    ],
  }

  it("surfaces an inline policy object on the handle", () => {
    const handle = defineStorage({
      provider: "cloud-bucket",
      config: {},
      policy: inlinePolicy,
    })
    expect(handle.policy).toEqual(inlinePolicy)
  })

  it("accepts { ref } / { file } pointer entries without AIP-38 validation", () => {
    const handle = defineStorage({
      provider: "cloud-bucket",
      config: {},
      policy: [{ ref: "@acme/policies/storage" }, { file: "./policies.md" }],
    })
    expect(handle.policy).toEqual([
      { ref: "@acme/policies/storage" },
      { file: "./policies.md" },
    ])
  })

  it("freezes the policy block (single entry + array form)", () => {
    const single = defineStorage({
      provider: "cloud-bucket",
      config: {},
      policy: inlinePolicy,
    })
    expect(Object.isFrozen(single.policy as object)).toBe(true)

    const multi = defineStorage({
      provider: "cloud-bucket",
      config: {},
      policy: [inlinePolicy, { ref: "@acme/other" }],
    }) as { policy: object[] }
    expect(Object.isFrozen(multi.policy)).toBe(true)
    for (const entry of multi.policy) expect(Object.isFrozen(entry)).toBe(true)
  })

  it("rejects a malformed inline policy entry via @agentproto/policy", () => {
    expect(() =>
      defineStorage({
        provider: "cloud-bucket",
        config: {},
        // version is not semver — fails the shared AIP-38 frontmatter schema
        policy: { schema: "policy/v1", version: "not-semver" },
      }),
    ).toThrow(/defineStorage \(AIP-35\): policy block/)
  })

  it("omits policy from the handle when not provided", () => {
    const handle = defineStorage({
      provider: "cloud-bucket",
      config: {},
    })
    expect(handle.policy).toBeUndefined()
  })
})
