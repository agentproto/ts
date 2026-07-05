import { describe, it, expect } from "vitest"
import { resolveStoreRef, readStoreRefWithFallback } from "../resolve-ref.js"
import { MemoryStore } from "../memory-store.js"
import type { TokenStoreSpec } from "../../types.js"

const spec: TokenStoreSpec = { keychain: "acme-svc", account: "{server}" }
const server = "https://api.example"

describe("resolveStoreRef", () => {
  it("leaves the path unprefixed when no audience is declared (today's behavior)", () => {
    expect(resolveStoreRef(spec, server)).toEqual({
      path: "acme-svc",
      account: server,
    })
  })

  it("prefixes the path with the audience when declared", () => {
    expect(resolveStoreRef(spec, server, "tunnel")).toEqual({
      path: "tunnel:acme-svc",
      account: server,
    })
  })

  it("uses a different prefix per audience, so they don't collide", () => {
    const a = resolveStoreRef(spec, server, "tunnel")
    const b = resolveStoreRef(spec, server, "api")
    expect(a.path).not.toBe(b.path)
  })
})

describe("readStoreRefWithFallback", () => {
  it("reads straight through when ref and legacyRef are the same (no audience)", async () => {
    const store = new MemoryStore()
    const ref = resolveStoreRef(spec, server)
    await store.write(ref, { value: "tok", kind: "pat" })

    const stored = await readStoreRefWithFallback(store, ref, ref)
    expect(stored).toEqual({ value: "tok", kind: "pat" })
  })

  it("prefers the audience-prefixed path when a credential lives there", async () => {
    const store = new MemoryStore()
    const ref = resolveStoreRef(spec, server, "tunnel")
    const legacyRef = resolveStoreRef(spec, server)
    await store.write(ref, { value: "tok-prefixed", kind: "pat" })
    await store.write(legacyRef, { value: "tok-legacy", kind: "pat" })

    const stored = await readStoreRefWithFallback(store, ref, legacyRef)
    expect(stored).toEqual({ value: "tok-prefixed", kind: "pat" })
  })

  it("falls back once to the unprefixed legacy path on a miss", async () => {
    const store = new MemoryStore()
    const ref = resolveStoreRef(spec, server, "tunnel")
    const legacyRef = resolveStoreRef(spec, server)
    // Simulate a credential written before this provider adopted an audience.
    await store.write(legacyRef, { value: "tok-legacy", kind: "pat" })

    const stored = await readStoreRefWithFallback(store, ref, legacyRef)
    expect(stored).toEqual({ value: "tok-legacy", kind: "pat" })
  })

  it("returns undefined when neither the prefixed nor legacy path has a credential", async () => {
    const store = new MemoryStore()
    const ref = resolveStoreRef(spec, server, "tunnel")
    const legacyRef = resolveStoreRef(spec, server)

    const stored = await readStoreRefWithFallback(store, ref, legacyRef)
    expect(stored).toBeUndefined()
  })
})
