import { describe, it, expect } from "vitest"
import { definePack } from "../src/define-pack.js"
import {
  parsePackManifest,
  packFromManifest,
} from "../src/manifest/index.js"
import type { PackDefinition } from "../src/types.js"

function validPack(overrides: Partial<PackDefinition> = {}): PackDefinition {
  return {
    schema: "pack/v1",
    name: "the-agentic-coder",
    title: "The Agentic Coder",
    description: "An agentic coding bundle.",
    version: "1.0.0",
    plugin: { inline: true },
    pricing: { bundle: 29 },
    ...overrides,
  } as PackDefinition
}

describe("definePack", () => {
  it("returns status 'ready' for a valid minimal inline pack with a priced bundle", () => {
    const handle = definePack(validPack())
    expect(handle.status).toBe("ready")
    expect(handle.name).toBe("the-agentic-coder")
    expect(handle.schema).toBe("pack/v1")
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("returns status 'assembling' for a pack that merges published includes (no inline)", () => {
    const handle = definePack(
      validPack({ plugin: { includes: ["@agentproto/skill-pack-coder"] } }),
    )
    expect(handle.status).toBe("assembling")
  })

  it("returns status 'gated' for a pack with non-empty blockers regardless of plugin shape", () => {
    const inline = definePack(
      validPack({ blockers: ["await legal review"] }),
    )
    const includes = definePack(
      validPack({
        plugin: { includes: ["@agentproto/skill-pack-coder"] },
        blockers: ["await trademark filing"],
      }),
    )
    expect(inline.status).toBe("gated")
    expect(includes.status).toBe("gated")
  })

  it("throws when neither plugin.inline nor a non-empty plugin.includes is set", () => {
    expect(() => definePack(validPack({ plugin: {} }))).toThrowError(
      /definePack \(AIP-52\): plugin requires either `inline: true` or a non-empty `includes` list/,
    )
  })

  it("throws when pricing is present and pricing.bundle <= 0", () => {
    expect(() =>
      definePack(validPack({ pricing: { bundle: 0 } })),
    ).toThrowError(/definePack \(AIP-52\): pricing\.bundle must be > 0/)
  })
})

describe("parsePackManifest", () => {
  it("round-trips a PACK.md-style string with YAML frontmatter and a body", () => {
    const source = `---
schema: pack/v1
name: the-agentic-coder
title: The Agentic Coder
description: An agentic coding bundle.
version: 1.0.0
plugin:
  inline: true
pricing:
  bundle: 29
---

# The Agentic Coder

Everything you need to ship code agentically.
`

    const manifest = parsePackManifest(source)
    expect(manifest.frontmatter.schema).toBe("pack/v1")
    expect(manifest.frontmatter.name).toBe("the-agentic-coder")
    expect(manifest.frontmatter.plugin.inline).toBe(true)
    expect(manifest.frontmatter.pricing?.bundle).toBe(29)
    expect(manifest.body).toContain("# The Agentic Coder")

    const handle = packFromManifest(manifest)
    expect(handle.status).toBe("ready")
    expect(handle.title).toBe("The Agentic Coder")
  })
})