import { describe, it, expect } from "vitest"
import {
  driverFromManifest,
  parseDriverManifest,
} from "../manifest/index.js"

const SAMPLE_MD = `---
schema: agentproto/driver/v1
id: gh-cli
name: GitHub CLI driver
description: Drives the gh CLI to call selected GitHub tools.
version: 1.0.0
kind: cli
implements:
  - tool: ./tools/list-prs/TOOL.md
    version: ^1.0.0
    metadata:
      argv: ["pr", "list", "--json", "number,title"]
  - tool: ./tools/view-pr/TOOL.md
    version: ^1.0.0
network:
  egress: ["api.github.com"]
region: ["global"]
policy_tags: ["read-only"]
tags: [github, cli]
metadata:
  vendor.namespace: gh
---

# GitHub CLI driver
Body content.
`

describe("parseDriverManifest", () => {
  it("parses required and optional fields", () => {
    const m = parseDriverManifest(SAMPLE_MD)
    expect(m.frontmatter.id).toBe("gh-cli")
    expect(m.frontmatter.kind).toBe("cli")
    expect(m.frontmatter.implements).toHaveLength(2)
    expect(m.frontmatter.implements[0]?.tool).toBe("./tools/list-prs/TOOL.md")
    expect(m.frontmatter.network?.egress).toEqual(["api.github.com"])
    expect(m.body).toContain("# GitHub CLI driver")
  })

  it("rejects missing frontmatter", () => {
    expect(() => parseDriverManifest("body only")).toThrow(
      /missing or empty frontmatter/,
    )
  })

  it("requires at least one implements[] entry", () => {
    const bad = `---
id: no-impls
name: No impls
description: x
version: 1.0.0
kind: cli
implements: []
---
`
    expect(() => parseDriverManifest(bad)).toThrow(/implements/)
  })

  it("rejects invalid kind", () => {
    const bad = `---
id: bad-kind
name: Bad
description: x
version: 1.0.0
kind: telepathy
implements:
  - { tool: x, version: ^1.0.0 }
---
`
    expect(() => parseDriverManifest(bad)).toThrow(/kind/)
  })
})

describe("driverFromManifest", () => {
  it("produces a frozen DriverHandle wired to caller-supplied execute bodies", () => {
    const manifest = parseDriverManifest(SAMPLE_MD)
    const calls: string[] = []
    const handle = driverFromManifest({
      manifest,
      execute: {
        "list-prs": async () => {
          calls.push("list-prs")
          return { ok: true }
        },
        "view-pr": async () => {
          calls.push("view-pr")
          return { ok: true }
        },
      },
    })

    expect(handle.id).toBe("gh-cli")
    expect(handle.kind).toBe("cli")
    expect(handle.implements).toHaveLength(2)
    expect(handle.network.egress).toEqual(["api.github.com"])
    expect(handle.region).toEqual(["global"])
    expect(handle.policyTags).toEqual(["read-only"])
    expect(handle.tags).toEqual(["github", "cli"])
    expect(Object.keys(handle.execute).sort()).toEqual(["list-prs", "view-pr"])
    expect(Object.isFrozen(handle)).toBe(true)
  })

  it("AIP-30 implements ↔ execute consistency: missing body raises", () => {
    const manifest = parseDriverManifest(SAMPLE_MD)
    expect(() =>
      driverFromManifest({
        manifest,
        execute: {
          "list-prs": async () => ({}),
          // 'view-pr' missing
        },
      }),
    ).toThrow(/no execute\['view-pr'\] body provided/)
  })

  it("AIP-30 implements ↔ execute consistency: extra body raises", () => {
    const manifest = parseDriverManifest(SAMPLE_MD)
    expect(() =>
      driverFromManifest({
        manifest,
        execute: {
          "list-prs": async () => ({}),
          "view-pr": async () => ({}),
          ghost: async () => ({}),
        },
      }),
    ).toThrow(/'ghost' is not in implements/)
  })

  it("normalises ./tools/<name>/TOOL.md refs to bare ids in the execute map", () => {
    const manifest = parseDriverManifest(SAMPLE_MD)
    const handle = driverFromManifest({
      manifest,
      execute: {
        "list-prs": async () => ({}),
        "view-pr": async () => ({}),
      },
    })
    expect(handle.execute["list-prs"]).toBeTypeOf("function")
    expect(handle.execute["view-pr"]).toBeTypeOf("function")
  })
})
