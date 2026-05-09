import { describe, it, expect } from "vitest"
import { defineSkill } from "../define-skill.js"
import { parseSkillManifest } from "../manifest/index.js"
import type { SkillDefinition } from "../types.js"

const minimalDef = (
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition => ({
  name: "pdf-generator",
  description: "Generates PDF documents from templates with dynamic data.",
  ...overrides,
})

describe("defineSkill (AIP-3) — agentskills.io profile", () => {
  it("imports cleanly", () => {
    expect(typeof defineSkill).toBe("function")
  })

  describe("agentskills.io baseline", () => {
    it("accepts a minimal name + description skill", () => {
      const handle = defineSkill(minimalDef())
      expect(handle.name).toBe("pdf-generator")
      expect(handle.description).toMatch(/^Generates/)
    })

    it("accepts license, compatibility, allowed-tools", () => {
      const handle = defineSkill(
        minimalDef({
          license: "MIT",
          compatibility: "Requires Node 22+",
          "allowed-tools": "Bash(git:*) Read",
        }),
      )
      expect(handle.license).toBe("MIT")
      expect(handle["allowed-tools"]).toBe("Bash(git:*) Read")
    })

    it("rejects names with uppercase", () => {
      expect(() => defineSkill(minimalDef({ name: "PDF-Generator" }))).toThrow(
        /defineSkill \(AIP-3\)/,
      )
    })

    it("rejects names with leading hyphen", () => {
      expect(() => defineSkill(minimalDef({ name: "-pdf" }))).toThrow(
        /defineSkill \(AIP-3\)/,
      )
    })

    it("rejects names with consecutive hyphens", () => {
      expect(() =>
        defineSkill(minimalDef({ name: "pdf--generator" })),
      ).toThrow(/defineSkill \(AIP-3\)/)
    })

    it("rejects names longer than 64 chars", () => {
      const tooLong = "a".repeat(65)
      expect(() => defineSkill(minimalDef({ name: tooLong }))).toThrow(
        /defineSkill \(AIP-3\)/,
      )
    })

    it("rejects descriptions longer than 1024 chars", () => {
      expect(() =>
        defineSkill(minimalDef({ description: "x".repeat(1025) })),
      ).toThrow(/defineSkill \(AIP-3\)/)
    })

    it("preserves vendor-namespaced metadata verbatim", () => {
      const handle = defineSkill(
        minimalDef({
          metadata: {
            acme: { foo: "bar" },
          },
        }),
      )
      expect(handle.metadata?.acme).toEqual({ foo: "bar" })
    })
  })

  describe("AIP-3 extensions (metadata.aip3.*)", () => {
    it("accepts an instruction skill with full extensions", () => {
      const handle = defineSkill(
        minimalDef({
          metadata: {
            aip3: {
              schema: "skills/v1",
              variant: "instruction",
              version: "1.0.0",
              tags: ["pdf", "document"],
              category: "productivity",
              requires: [9],
            },
          },
        }),
      )
      expect(handle.metadata?.aip3?.variant).toBe("instruction")
      expect(handle.metadata?.aip3?.tags).toEqual(["pdf", "document"])
    })

    it("requires execution when variant=executable", () => {
      expect(() =>
        defineSkill(
          minimalDef({
            metadata: {
              aip3: { schema: "skills/v1", variant: "executable" },
            },
          }),
        ),
      ).toThrow(/execution is required/)
    })

    it("accepts an executable skill with execution.code.file", () => {
      const handle = defineSkill(
        minimalDef({
          metadata: {
            aip3: {
              schema: "skills/v1",
              variant: "executable",
              execution: {
                language: "typescript",
                code: { file: "scripts/generate.ts" },
                entrypoint: "generatePdf",
                runtime: { timeout: 30000 },
                artifacts: { patterns: ["*.pdf"] },
              },
            },
          },
        }),
      )
      expect(handle.metadata?.aip3?.execution?.entrypoint).toBe("generatePdf")
    })

    it("requires non-empty uses when variant=composite", () => {
      expect(() =>
        defineSkill(
          minimalDef({
            metadata: {
              aip3: { schema: "skills/v1", variant: "composite", uses: [] },
            },
          }),
        ),
      ).toThrow(/uses must be non-empty/)
    })

    it("rejects malformed semver in version", () => {
      expect(() =>
        defineSkill(
          minimalDef({
            metadata: {
              aip3: { schema: "skills/v1", version: "v1" },
            },
          }),
        ),
      ).toThrow(/defineSkill \(AIP-3\)/)
    })
  })

  describe("parseSkillManifest", () => {
    it("parses a minimal SKILL.md", () => {
      const md = `---
name: pdf-generator
description: Generates PDF documents from templates with dynamic data.
---

# PDF Generator

## Overview
`
      const { frontmatter, body } = parseSkillManifest(md)
      expect(frontmatter.name).toBe("pdf-generator")
      expect(body).toMatch(/PDF Generator/)
    })

    it("parses an executable AIP-3 skill", () => {
      const md = `---
name: pdf-generator
description: Generates PDF documents from templates with dynamic data.
license: MIT
metadata:
  aip3:
    schema: skills/v1
    variant: executable
    version: "1.0.0"
    execution:
      language: typescript
      code:
        file: scripts/generate.ts
      entrypoint: generatePdf
---

# PDF Generator
`
      const { frontmatter } = parseSkillManifest(md)
      expect(frontmatter.metadata?.aip3?.variant).toBe("executable")
      expect(frontmatter.metadata?.aip3?.execution?.entrypoint).toBe(
        "generatePdf",
      )
    })

    it("rejects a manifest with empty frontmatter", () => {
      expect(() => parseSkillManifest("# no frontmatter")).toThrow(
        /missing or empty frontmatter/,
      )
    })

    it("rejects a manifest with an invalid name", () => {
      const md = `---
name: PDF-Generator
description: bad name
---
body
`
      expect(() => parseSkillManifest(md)).toThrow(/parseSkillManifest/)
    })
  })
})
