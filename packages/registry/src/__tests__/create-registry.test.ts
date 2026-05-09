import { describe, it, expect } from "vitest"
import {
  createRegistry,
  RegistryDuplicateError,
  RegistryKeyError,
  RegistryNotFoundError,
} from "../index.js"

// Synthetic handle types for the tests — mirror the shapes
// `defineStorage` / `defineExtension` / `createDoctype` produce so
// the default `keyBy` resolution matches reality.
interface StorageLike {
  provider: string
  capabilities?: { bridgeable?: boolean; pairsWith?: string[] }
}
interface ExtensionLike {
  slug: string
  parent: string
}
interface IdHandle {
  id: string
}

describe("createRegistry — AIP-43 invariants", () => {
  describe("identity selection (§ Identity)", () => {
    it("prefers handle.id over provider/slug", () => {
      const r = createRegistry<{ id: string; provider?: string; slug?: string }>({
        family: "mixed",
      })
      r.register({ id: "primary", provider: "secondary", slug: "tertiary" })
      expect(r.has("primary")).toBe(true)
      expect(r.has("secondary")).toBe(false)
      expect(r.has("tertiary")).toBe(false)
    })

    it("falls back to provider when id is absent", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      expect(r.get("s3")?.provider).toBe("s3")
    })

    it("falls back to slug when id and provider are absent", () => {
      const r = createRegistry<ExtensionLike>({ family: "extension" })
      r.register({ slug: "acme:deal", parent: "aip-13" })
      expect(r.get("acme:deal")?.parent).toBe("aip-13")
    })

    it("uses an explicit keyBy when provided, overriding defaults", () => {
      const r = createRegistry<{ id: string; provider: string }>({
        family: "by-provider",
        keyBy: h => h.provider,
      })
      r.register({ id: "ignored", provider: "wins" })
      expect(r.has("wins")).toBe(true)
      expect(r.has("ignored")).toBe(false)
    })

    it("throws RegistryKeyError when no key field is present and no keyBy provided", () => {
      const r = createRegistry<{ name?: string }>({ family: "anonymous" })
      expect(() => r.register({ name: "no-id" })).toThrow(RegistryKeyError)
    })

    it("throws RegistryKeyError when keyBy returns empty string", () => {
      const r = createRegistry<{ id: string }>({
        family: "trim",
        keyBy: () => "",
      })
      expect(() => r.register({ id: "x" })).toThrow(RegistryKeyError)
    })

    it("throws RegistryKeyError when keyBy itself throws", () => {
      const r = createRegistry<{ id: string }>({
        family: "explode",
        keyBy: () => {
          throw new Error("nope")
        },
      })
      expect(() => r.register({ id: "x" })).toThrow(RegistryKeyError)
    })
  })

  describe("duplicate-registration refusal (§ Operations)", () => {
    it("throws RegistryDuplicateError on second register with same key", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      expect(() => r.register({ provider: "s3" })).toThrow(RegistryDuplicateError)
    })

    it("permits register after unregister", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      expect(r.unregister("s3")).toBe(true)
      expect(() =>
        r.register({ provider: "s3", capabilities: { bridgeable: true } }),
      ).not.toThrow()
      expect(r.get("s3")?.capabilities?.bridgeable).toBe(true)
    })

    it("does not silently overwrite — error message includes id and family", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      try {
        r.register({ provider: "s3" })
        expect.unreachable("expected RegistryDuplicateError")
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryDuplicateError)
        expect((err as Error).message).toContain("storage")
        expect((err as Error).message).toContain("s3")
      }
    })
  })

  describe("operations (§ Operations)", () => {
    it("list() preserves insertion order", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      r.register({ provider: "gcs" })
      r.register({ provider: "azure-blob" })
      expect(r.list().map(h => h.provider)).toEqual([
        "s3",
        "gcs",
        "azure-blob",
      ])
    })

    it("entries() yields [id, handle] pairs in insertion order", () => {
      const r = createRegistry<IdHandle>({ family: "tools" })
      r.register({ id: "first" })
      r.register({ id: "second" })
      expect(r.entries()).toEqual([
        ["first", { id: "first" }],
        ["second", { id: "second" }],
      ])
    })

    it("count() reflects size after register/unregister", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      expect(r.count()).toBe(0)
      r.register({ provider: "s3" })
      r.register({ provider: "gcs" })
      expect(r.count()).toBe(2)
      r.unregister("s3")
      expect(r.count()).toBe(1)
    })

    it("has() returns true for registered ids only", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      expect(r.has("s3")).toBe(true)
      expect(r.has("gcs")).toBe(false)
    })

    it("get() returns undefined for unknown ids", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      expect(r.get("missing")).toBeUndefined()
    })

    it("unregister() returns false for unknown ids", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      expect(r.unregister("missing")).toBe(false)
    })

    it("replace() swaps an existing handle in place", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      r.replace({ provider: "s3", capabilities: { bridgeable: true } })
      expect(r.get("s3")?.capabilities?.bridgeable).toBe(true)
      expect(r.count()).toBe(1)
    })

    it("replace() throws RegistryNotFoundError when no handle is present", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      expect(() =>
        r.replace({ provider: "ghost" }),
      ).toThrow(RegistryNotFoundError)
    })
  })

  describe("capability lookup (§ Capability metadata namespace)", () => {
    it("lookup() filters by an arbitrary predicate", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3", capabilities: { bridgeable: true } })
      r.register({ provider: "google-drive", capabilities: { bridgeable: false } })
      r.register({
        provider: "local-daemon",
        capabilities: { bridgeable: true },
      })
      const bridgeable = r.lookup(
        h => h.capabilities?.bridgeable === true,
      )
      expect(bridgeable.map(h => h.provider).sort()).toEqual([
        "local-daemon",
        "s3",
      ])
    })

    it("lookup() returns insertion-ordered results", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "first", capabilities: { bridgeable: true } })
      r.register({ provider: "skip" })
      r.register({ provider: "second", capabilities: { bridgeable: true } })
      expect(
        r.lookup(h => h.capabilities?.bridgeable === true).map(h => h.provider),
      ).toEqual(["first", "second"])
    })

    it("lookup() supports cross-handle pairing queries (pairsWith)", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({
        provider: "s3",
        capabilities: { pairsWith: ["e2b"] },
      })
      r.register({
        provider: "local-daemon",
        capabilities: { pairsWith: ["local-daemon"] },
      })
      const compatibleWithE2b = r.lookup(h =>
        Array.isArray(h.capabilities?.pairsWith) &&
        h.capabilities!.pairsWith.includes("e2b"),
      )
      expect(compatibleWithE2b.map(h => h.provider)).toEqual(["s3"])
    })

    it("treats absent capabilities as opaque (no validation)", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "no-caps" })
      // The registry does not require a `capabilities` field —
      // handles without one are still queryable.
      expect(r.get("no-caps")?.capabilities).toBeUndefined()
      expect(r.lookup(() => true)).toHaveLength(1)
    })
  })

  describe("type-parametric reuse (§ same impl, every doctype family)", () => {
    it("works as a STORAGE registry (keyed by provider)", () => {
      const r = createRegistry<StorageLike>({ family: "storage" })
      r.register({ provider: "s3" })
      expect(r.list()[0]?.provider).toBe("s3")
    })

    it("works as an EXTENSION registry (keyed by slug)", () => {
      const r = createRegistry<ExtensionLike>({ family: "extension" })
      r.register({ slug: "acme:deal", parent: "aip-13" })
      expect(r.list()[0]?.slug).toBe("acme:deal")
    })

    it("works for arbitrary id-shaped handles", () => {
      const r = createRegistry<IdHandle>({ family: "any" })
      r.register({ id: "a-tool" })
      expect(r.has("a-tool")).toBe(true)
    })
  })
})
