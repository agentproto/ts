import { describe, expect, it } from "vitest"
import { defineRef } from "../index.js"

/**
 * AIP-27 conformance: round-trip identity. For every supported kind,
 * `defineRef(defineRef(x).compact).value` MUST deep-equal `defineRef(x).value`.
 */

const fixtures: Array<{ name: string; compact: string }> = [
  { name: "local", compact: "local:engagements/acme/proposal.md" },
  {
    name: "local with sha",
    compact:
      "local:engagements/acme/proposal.md#sha256=ab1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
  },
  { name: "url", compact: "url:https://example.com/x.pdf" },
  {
    name: "url with sha",
    compact:
      "url:https://example.com/x.pdf#sha256=ab1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
  },
  {
    name: "git",
    compact:
      "git:https%3A%2F%2Fgitlab.example%2Fteam%2Frepo.git@v1.2.3:src/lib",
  },
  { name: "github full", compact: "github:agentik/studio@main:packages/ref" },
  { name: "github bare", compact: "github:agentik/studio" },
  { name: "github with ref only", compact: "github:agentik/studio@v1.0.0" },
  { name: "github with path only", compact: "github:agentik/studio:README.md" },
  {
    name: "ipfs",
    compact: "ipfs:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  },
  {
    name: "ipfs with path",
    compact:
      "ipfs:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi:nested/file.json",
  },
  { name: "email", compact: "email:jeremy@agentik.net" },
  { name: "operator", compact: "operator:atlas" },
  { name: "operator with workspace", compact: "operator:atlas@acme-co" },
  { name: "user", compact: "user:abc123" },
  { name: "user with workspace", compact: "user:abc123@acme-co" },
  { name: "persona", compact: "persona:atlas" },
  {
    name: "eth_tx mainnet",
    compact:
      "eth_tx:1:0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34",
  },
  {
    name: "ots wrapping local",
    compact: "ots:local:engagements/acme/_chain/anchors/247.ots",
  },
  {
    name: "ots wrapping url",
    compact: "ots:url:https://anchor.example/proofs/247.ots",
  },
]

describe("AIP-27 round-trip conformance", () => {
  for (const { name, compact } of fixtures) {
    it(name, () => {
      const first = defineRef(compact)
      const second = defineRef(first.compact)
      expect(second.compact).toBe(first.compact)
      expect(second.value).toEqual(first.value)
      expect(first.equals(second)).toBe(true)
    })
  }
})

describe("defineRef accepts both compact and object forms", () => {
  it("compact == object value", () => {
    const fromString = defineRef("github:agentik/studio@main:packages/ref")
    const fromObject = defineRef({
      kind: "github",
      owner: "agentik",
      repo: "studio",
      ref: "main",
      path: "packages/ref",
    })
    expect(fromString.compact).toBe(fromObject.compact)
    expect(fromString.equals(fromObject)).toBe(true)
  })
})
