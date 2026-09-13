/**
 * Parity with openagentik router's `packages/core/src/routing/virtual-resolve.ts`
 * — `resolveStickyServedModel` → `resolveChain`, `StickyVirtualModel` → `Chain`.
 *
 * The original's `fnv1a32` + `serializeStablePrefix` are reimplemented
 * independently ("original*" below, copy-pasted rather than imported — the
 * point of the test) so this package's `fnv1a32` / `stablePrefix` can be
 * checked bit-for-bit against a second, independent implementation of the
 * same formula, not just against itself.
 */
import { describe, expect, it } from "vitest"
import { defineChain, resolveChain, stablePrefixHash } from "../sticky.js"
import type { RoutableMessage, RoutableRequest } from "../types.js"

// ── independent reimplementation of virtual-resolve.ts, for cross-checking ──

function originalFnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}
function originalSerializeStablePrefix(req: RoutableRequest): string {
  const systemMessages = req.messages.filter((m) => m.role === "system")
  const firstUser = req.messages.find((m) => m.role === "user")
  return JSON.stringify([systemMessages, firstUser ?? null])
}
function originalResolveStickyServedModel(
  virtual: { id: string; chain: readonly string[] },
  req: RoutableRequest,
  isKnownRef: (ref: string) => boolean
): { virtualId: string; modelRef: string } | null {
  const chain = virtual.chain.filter(isKnownRef)
  if (chain.length === 0) return null
  const hash = originalFnv1a32(originalSerializeStablePrefix(req))
  const served = chain[hash % chain.length]
  if (served === undefined) return null
  return { virtualId: virtual.id, modelRef: served }
}

// ── fixtures ──────────────────────────────────────────────────────────────

const knownRefs = new Set(["openai/gpt-4o", "anthropic/claude-sonnet-5", "z-ai/glm-5.2", "moonshot/kimi-k2.6"])
const isKnownRef = (ref: string) => knownRefs.has(ref)

function conversation(firstUserText: string, extraTurns = 0): RoutableRequest {
  const messages: RoutableMessage[] = [
    { role: "system", content: "you are a helpful assistant" } as any,
    { role: "user", content: firstUserText } as any,
  ]
  for (let i = 0; i < extraTurns; i++) {
    messages.push({ role: "assistant", content: `reply ${i}` } as any, { role: "user", content: `turn ${i}` } as any)
  }
  return { messages }
}

describe("parity: openagentik virtual-resolve.ts", () => {
  const virtual = { id: "virtual-coder", chain: ["openai/gpt-4o", "anthropic/claude-sonnet-5", "z-ai/glm-5.2"] }

  it("agrees bit-for-bit with an independent reimplementation of the same formula", () => {
    for (const text of ["hello", "write me a sorting function", "🎉 unicode too", ""]) {
      const req = conversation(text)
      const ours = resolveChain(virtual, req, isKnownRef)
      const original = originalResolveStickyServedModel(virtual, req, isKnownRef)
      expect(ours).toEqual(
        original && { id: original.virtualId, servedKey: original.modelRef }
      )
    }
  })

  it("one conversation sticks to one served model across turns and hosts (determinism law)", () => {
    const req0 = conversation("plan a trip to Kyoto")
    const req5 = conversation("plan a trip to Kyoto", 5)
    expect(resolveChain(virtual, req0, isKnownRef)).toEqual(resolveChain(virtual, req5, isKnownRef))
    // "and across hosts" — recomputing stablePrefixHash independently, with
    // no shared storage, reproduces the same value.
    expect(stablePrefixHash(req0)).toBe(stablePrefixHash(req5))
  })

  it("distributes different conversations across the chain (not all pinned to one candidate)", () => {
    const served = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => resolveChain(virtual, conversation(s), isKnownRef)?.servedKey)
    )
    expect(served.size).toBeGreaterThan(1)
  })

  it("empty filtered chain -> null, never an arbitrary candidate", () => {
    expect(resolveChain(virtual, conversation("x"), () => false)).toBeNull()
  })

  it("chain filtered to refs, not chains — virtual-to-virtual is impossible by construction here too", () => {
    // Reconstructing "isKnownRef binds to real model resolution only": a
    // predicate that happens to also recognize another virtual id would let
    // one chain point at another at REQUEST time — exactly what §5 forbids.
    // The fix, both in the original and here, is that `isKnownRef` must never
    // be built to return true for a chain id — enforced at chain declaration
    // via `defineChain`, not by `resolveChain` itself (which stays a pure,
    // generic predicate filter with no opinion on what "known" means).
    const chainIds = new Set(["virtual-coder", "virtual-b"])
    expect(() => defineChain({ id: "virtual-b", chain: ["virtual-coder", "openai/gpt-4o"] }, chainIds)).toThrow()
  })
})
