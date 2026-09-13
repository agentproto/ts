import { describe, expect, it } from "vitest"
import { definePack } from "../pack.js"
import { defineChain, fnv1a32, resolveChain, resolveThroughChain, stablePrefixHash } from "../sticky.js"
import type { RoutableRequest } from "../types.js"

const req: RoutableRequest = {
  messages: [
    { role: "system", content: "you are a helpful assistant" } as any,
    { role: "user", content: "hello" } as any,
    { role: "assistant", content: "hi there" } as any,
    { role: "user", content: "second turn — must not affect the hash" } as any,
  ],
}

describe("stablePrefixHash — §5", () => {
  it("is a pure function of every system message plus the FIRST user message only", () => {
    const truncated: RoutableRequest = { messages: req.messages.slice(0, 2) } // system + first user only
    expect(stablePrefixHash(req)).toBe(stablePrefixHash(truncated))
  })

  it("changes when the system prompt or first user message changes", () => {
    const different: RoutableRequest = {
      messages: [{ role: "system", content: "a different system prompt" } as any, req.messages[1]!],
    }
    expect(stablePrefixHash(req)).not.toBe(stablePrefixHash(different))
  })
})

describe("resolveChain — §5 sticky selection", () => {
  const chain = { id: "virtual-coder", chain: ["openai/gpt-4o", "anthropic/claude-sonnet-5", "z-ai/glm-5.2"] }
  const allResolvable = () => true

  it("is deterministic: chain'[H(stablePrefix(req)) mod |chain'|]", () => {
    const hash = fnv1a32(JSON.stringify([req.messages.slice(0, 1), req.messages[1]]))
    const expectedIndex = hash % chain.chain.length
    const resolved = resolveChain(chain, req, allResolvable)
    expect(resolved).toEqual({ id: "virtual-coder", servedKey: chain.chain[expectedIndex] })
  })

  it("same conversation sticks across turns — appending messages after the first user turn is a no-op", () => {
    const turn1 = resolveChain(chain, { messages: req.messages.slice(0, 2) }, allResolvable)
    const turn3 = resolveChain(chain, req, allResolvable)
    expect(turn3).toEqual(turn1)
  })

  it("filters to resolvable refs before selecting — chain' not chain", () => {
    const onlyLast = (ref: string) => ref === "z-ai/glm-5.2"
    const resolved = resolveChain(chain, req, onlyLast)
    expect(resolved).toEqual({ id: "virtual-coder", servedKey: "z-ai/glm-5.2" })
  })

  it("an empty filtered chain resolves to no candidate, never an arbitrary one", () => {
    expect(resolveChain(chain, req, () => false)).toBeNull()
  })
})

describe("defineChain — chain-to-chain fails at configuration load (§5 Security Considerations)", () => {
  it("rejects a chain entry that is itself a known chain id", () => {
    expect(() => defineChain({ id: "a", chain: ["b", "gpt-4o"] }, ["a", "b"])).toThrow(/chain-to-chain/)
  })

  it("rejects self-reference", () => {
    expect(() => defineChain({ id: "a", chain: ["a"] }, [])).toThrow(/chain-to-chain/)
  })

  it("accepts a chain whose entries are all non-chain refs", () => {
    expect(() => defineChain({ id: "a", chain: ["gpt-4o", "claude-sonnet-5"] }, ["b", "c"])).not.toThrow()
  })
})

describe("resolveThroughChain — chain composed with a Pack", () => {
  const pack = definePack({
    id: "p",
    label: "P",
    keyspace: "model",
    routes: {
      "gpt-4o": { model: "gpt-4o", provider: "openai" },
      "claude-sonnet-5": { model: "claude-sonnet-5", provider: "anthropic" },
      gated: null,
    },
  })
  const chain = { id: "virtual", chain: ["gated", "gpt-4o", "claude-sonnet-5"] }

  it("excludes a gated pack entry from the candidate set — chain' resolves to a real Route only", () => {
    const resolved = resolveThroughChain(chain, pack, req, [])
    expect(resolved?.key).not.toBe("gated")
    expect(["gpt-4o", "claude-sonnet-5"]).toContain(resolved?.key)
  })

  it("reattaches identity exactly once: key is the served route, virtualKey is what the client addressed", () => {
    const resolved = resolveThroughChain(chain, pack, req, [])
    expect(resolved?.virtualKey).toBe("virtual")
    expect(resolved?.key).not.toBe("virtual")
    expect(resolved?.source).toBe("pack")
  })
})
