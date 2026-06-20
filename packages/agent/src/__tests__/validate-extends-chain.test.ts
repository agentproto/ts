import { describe, it, expect } from "vitest"
import {
  validateExtendsChain,
  EXTENDS_MAX_DEPTH,
  type ExtendsChainLoader,
  type ExtendsRef,
} from "../validate-extends-chain.js"

type MinAgent = { id: string; extends?: ExtendsRef | null }

/** Build a loader backed by an in-memory registry — no file I/O needed. */
function makeLoader(registry: Record<string, MinAgent>): ExtendsChainLoader {
  return {
    async loadParent(ref) {
      const key =
        typeof ref === "string"
          ? ref
          : typeof ref === "object" && "ref" in ref && typeof ref.ref === "string"
            ? ref.ref
            : null
      if (key === null) return null
      return registry[key] ?? null
    },
  }
}

describe("validateExtendsChain (AIP-42)", () => {
  it("resolves when there is no parent", async () => {
    await expect(
      validateExtendsChain({ id: "base" }, makeLoader({})),
    ).resolves.toBeUndefined()
  })

  it("resolves for a chain of exactly 1 level", async () => {
    const loader = makeLoader({ parent: { id: "parent" } })
    await expect(
      validateExtendsChain({ id: "child", extends: "parent" }, loader),
    ).resolves.toBeUndefined()
  })

  it(`resolves for a chain of exactly ${EXTENDS_MAX_DEPTH} levels`, async () => {
    // a0 → a1 → … → a5  (5 hops = max allowed)
    const registry: Record<string, MinAgent> = {}
    for (let i = 1; i < EXTENDS_MAX_DEPTH; i++) {
      registry[`a${i}`] = { id: `a${i}`, extends: `a${i + 1}` }
    }
    registry[`a${EXTENDS_MAX_DEPTH}`] = { id: `a${EXTENDS_MAX_DEPTH}` }
    await expect(
      validateExtendsChain({ id: "a0", extends: "a1" }, makeLoader(registry)),
    ).resolves.toBeUndefined()
  })

  it(`rejects a chain of depth ${EXTENDS_MAX_DEPTH + 1} (one beyond the limit)`, async () => {
    // a0 → a1 → … → a6  (6 hops, exceeds max of 5)
    const registry: Record<string, MinAgent> = {}
    for (let i = 1; i <= EXTENDS_MAX_DEPTH; i++) {
      registry[`a${i}`] = { id: `a${i}`, extends: `a${i + 1}` }
    }
    registry[`a${EXTENDS_MAX_DEPTH + 1}`] = { id: `a${EXTENDS_MAX_DEPTH + 1}` }
    await expect(
      validateExtendsChain({ id: "a0", extends: "a1" }, makeLoader(registry)),
    ).rejects.toThrow("exceeds maximum depth")
  })

  it("rejects a direct cycle A → B → A", async () => {
    const registry: Record<string, MinAgent> = {
      b: { id: "b", extends: "a" },
      // 'a' must be resolvable so the loader returns it for the cycle check
      a: { id: "a", extends: "b" },
    }
    await expect(
      validateExtendsChain({ id: "a", extends: "b" }, makeLoader(registry)),
    ).rejects.toThrow("circular extends chain")
  })

  it("rejects a longer cycle A → B → C → A", async () => {
    const registry: Record<string, MinAgent> = {
      b: { id: "b", extends: "c" },
      c: { id: "c", extends: "a" },
      a: { id: "a", extends: "b" },
    }
    await expect(
      validateExtendsChain({ id: "a", extends: "b" }, makeLoader(registry)),
    ).rejects.toThrow("circular extends chain")
  })

  it("stops traversal at an inline block and does not throw", async () => {
    // Inline refs have no external id — they cannot form registry cycles.
    await expect(
      validateExtendsChain(
        { id: "child", extends: { inline: { id: "inlined", description: "inlined parent" } } },
        makeLoader({}),
      ),
    ).resolves.toBeUndefined()
  })

  it("stops gracefully when a ref cannot be resolved (chain end)", async () => {
    // The loader returns null for unknown refs — not an error.
    await expect(
      validateExtendsChain(
        { id: "child", extends: "unknown-parent" },
        makeLoader({}),
      ),
    ).resolves.toBeUndefined()
  })

  it("error messages carry the defineAgent (AIP-42) prefix", async () => {
    const registry: Record<string, MinAgent> = {}
    for (let i = 1; i <= EXTENDS_MAX_DEPTH; i++) {
      registry[`a${i}`] = { id: `a${i}`, extends: `a${i + 1}` }
    }
    registry[`a${EXTENDS_MAX_DEPTH + 1}`] = { id: `a${EXTENDS_MAX_DEPTH + 1}` }
    await expect(
      validateExtendsChain({ id: "a0", extends: "a1" }, makeLoader(registry)),
    ).rejects.toThrow("defineAgent (AIP-42):")
  })
})
