/**
 * Conformance fixtures — research preset.
 *
 * Validates the research reference fixture workspace against the actual
 * AgentProto JSON Schemas (resources/aip-XX/draft/*.schema.json). These
 * are the spec source-of-truth — the zod manifests in @agentproto/* are
 * reference implementations partially generated from them.
 *
 * The fixture workspace at `test/fixtures/research/` is the frozen
 * reference that ships with the `@agentproto/corpus-presets` research preset.
 * Mirrors the marketing conformance test exactly, generalized.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { describe, expect, it } from "vitest"

import { parseOperatorManifest } from "@agentproto/operator/manifest"
import { parseWorkflowManifest } from "@agentproto/workflow/manifest"
import { parseRoutineManifest } from "@agentproto/routine/manifest"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_ROOT = path.resolve(__dirname, "../../test/fixtures/research")

// Schemas live at `<repo>/specs/resources/aip-XX/draft/*.schema.json`.
// Override with CORPUS_SPECS_ROOT if loading from a different location.
const SPECS_ROOT =
  process.env["CORPUS_SPECS_ROOT"] ??
  path.resolve(__dirname, "../../../../specs/resources")

// ─── AJV setup ──────────────────────────────────────────────────────────────
const ajv = new Ajv2020({
  strict: false,            // schemas use $defs / oneOf — fine
  allErrors: true,
  allowUnionTypes: true,
})
addFormats(ajv)

// Pre-register every external schema the 6 AIPs we test might reference.
function registerExternalSchemas() {
  const externals: Array<[number, string]> = [
    [16, "IO"],
    [17, "RUNNER"],
  ]
  for (const [aip, doctype] of externals) {
    const file = path.join(SPECS_ROOT, `aip-${aip}`, "draft", `${doctype}.schema.json`)
    const schema = JSON.parse(readFileSync(file, "utf8"))
    if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema)
  }
}
registerExternalSchemas()

function loadSchema(aip: number, doctype: string): ValidateFunction {
  const file = path.join(SPECS_ROOT, `aip-${aip}`, "draft", `${doctype}.schema.json`)
  const schema = JSON.parse(readFileSync(file, "utf8"))
  return ajv.compile(schema)
}

const validators = {
  knowledge: loadSchema(10, "KNOWLEDGE"),
  collection: loadSchema(18, "COLLECTION"),
  operator: loadSchema(9, "OPERATOR"),
  workflow: loadSchema(15, "WORKFLOW"),
  routine: loadSchema(41, "ROUTINE"),
}

function readFrontmatter(relPath: string): Record<string, unknown> {
  const full = path.join(FIXTURES_ROOT, relPath)
  const src = readFileSync(full, "utf8")
  const parsed = matter(src)
  return parsed.data
}

function assertValid(validator: ValidateFunction, data: unknown, label: string) {
  const ok = validator(data)
  if (!ok) {
    const errs = (validator.errors || [])
      .map((e) => `${e.instancePath || "/"}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`)
      .join("\n  ")
    throw new Error(`${label} failed JSON-Schema validation:\n  ${errs}`)
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("research fixture workspace conformance", () => {
  describe("AIP-10 KNOWLEDGE (workspace + entries + source)", () => {
    it("workspace manifest validates", () => {
      const fm = readFrontmatter("KNOWLEDGE.md")
      assertValid(validators.knowledge, fm, "KNOWLEDGE.md (workspace)")
    })

    it("source validates", () => {
      const fm = readFrontmatter("sources/fresh/nature-review-2026-06.md")
      assertValid(validators.knowledge, fm, "nature-review-2026-06.md (source)")
    })

    it.each([
      "entries/principles/2026/primary-sources-beat-synthesis.md",
      "entries/patterns/2026/systematic-review-pattern.md",
      "entries/critiques/2026/selection-bias-failure.md",
    ])("entry %s validates", (rel) => {
      const fm = readFrontmatter(rel)
      assertValid(validators.knowledge, fm, rel)
    })

    // KNOWN GAP — @agentproto/knowledge/manifest currently uses z.any() stubs.
    // The actual validation runs above against the JSON Schema.
    it.skip("parseKnowledgeManifest accepts the workspace (blocked on zod regen)", () => {
      const src = readFileSync(path.join(FIXTURES_ROOT, "KNOWLEDGE.md"), "utf8")
      expect(src).toBeDefined()
    })
  })

  describe("AIP-18 COLLECTION (schema + item)", () => {
    it("COLLECTION.md validates", () => {
      const fm = readFrontmatter("collections/corpus-candidate/COLLECTION.md")
      assertValid(validators.collection, fm, "corpus-candidate/COLLECTION.md")
    })

    it("ITEM.md validates", () => {
      const fm = readFrontmatter(
        "collections/corpus-candidate/nature-review-2026-06/ITEM.md",
      )
      assertValid(validators.collection, fm, "nature-review-2026-06/ITEM.md")
    })

    // KNOWN GAP — @agentproto/collection/manifest zod is also a stub (z.any oneOf).
    it.skip("parseCollectionManifest accepts COLLECTION.md (blocked on zod regen)", () => {
      const src = readFileSync(
        path.join(FIXTURES_ROOT, "collections/corpus-candidate/COLLECTION.md"),
        "utf8",
      )
      expect(src).toBeDefined()
    })
  })

  describe("AIP-9 OPERATOR", () => {
    it("OPERATOR.md validates", () => {
      const fm = readFrontmatter("operators/research-analyst/OPERATOR.md")
      assertValid(validators.operator, fm, "research-analyst/OPERATOR.md")
    })

    it("parseOperatorManifest accepts it", () => {
      const src = readFileSync(
        path.join(FIXTURES_ROOT, "operators/research-analyst/OPERATOR.md"),
        "utf8",
      )
      expect(() => parseOperatorManifest(src)).not.toThrow()
    })
  })

  describe("AIP-15 WORKFLOW", () => {
    it("WORKFLOW.md validates", () => {
      const fm = readFrontmatter("workflows/analyze-candidate/WORKFLOW.md")
      assertValid(validators.workflow, fm, "analyze-candidate/WORKFLOW.md")
    })

    it("parseWorkflowManifest accepts it", () => {
      const src = readFileSync(
        path.join(FIXTURES_ROOT, "workflows/analyze-candidate/WORKFLOW.md"),
        "utf8",
      )
      expect(() => parseWorkflowManifest(src)).not.toThrow()
    })
  })

  describe("AIP-41 ROUTINE", () => {
    it("ROUTINE.md validates", () => {
      const fm = readFrontmatter("routines/source-scout/ROUTINE.md")
      assertValid(validators.routine, fm, "source-scout/ROUTINE.md")
    })

    it("parseRoutineManifest accepts it", () => {
      const src = readFileSync(
        path.join(FIXTURES_ROOT, "routines/source-scout/ROUTINE.md"),
        "utf8",
      )
      expect(() => parseRoutineManifest(src)).not.toThrow()
    })
  })

  // ─── Drift detection: tamper with one field, expect loud failure ─────────
  describe("drift detection (intentional schema breakage must fail)", () => {
    it("rejects KNOWLEDGE.md with bad authority enum on a source", () => {
      const fm = readFrontmatter("sources/fresh/nature-review-2026-06.md")
      const tampered = { ...fm, authority: "tertiary" } // valid enum is primary|secondary|rumour
      const ok = validators.knowledge(tampered)
      expect(ok).toBe(false)
    })

    it("rejects KNOWLEDGE.md with non-PascalCase entityTypes.name", () => {
      const fm = readFrontmatter("KNOWLEDGE.md") as { entityTypes: { name: string }[] }
      const tampered = {
        ...fm,
        entityTypes: [{ name: "principle" /* lowercase — must fail */ }],
      }
      const ok = validators.knowledge(tampered)
      expect(ok).toBe(false)
    })

    it("rejects an entry with unknown top-level field (additionalProperties: false)", () => {
      const fm = readFrontmatter(
        "entries/principles/2026/primary-sources-beat-synthesis.md",
      )
      const tampered = { ...fm, tier: "gold" } // tier is NOT in AIP-10 entry schema
      const ok = validators.knowledge(tampered)
      expect(ok).toBe(false)
    })
  })

  // ─── No corpus-specific fields leak above metadata.corpus.* ──────────────
  describe("metadata.corpus.* namespace discipline", () => {
    const CORPUS_KEYS = new Set([
      "qualityScore",
      "riskScore",
      "temporal",
      "retrievalBoosts",
      "retrievalDefaults",
      "autoPromote",
      "shadowMetrics",
      "shadowTrafficPct",
      "accessModes",
      "knowledgeViews",
      "overlays",
      "promotionMode",
      "promotedAt",
      "promotedBy",
      "archiveTier",
      "archivedBy",
      "snapshotPath",
      "originalUrl",
      "execution",
      "derivedFromGap",
      "archiveReason",
      "authoredBy",
      "domain",
      "channel",
      "funnelStage",
      "triggeredBy",
    ])

    function walkFixtures(dir: string, acc: string[] = []): string[] {
      for (const ent of readdirSync(dir)) {
        const full = path.join(dir, ent)
        const s = statSync(full)
        if (s.isDirectory()) walkFixtures(full, acc)
        else if (ent.endsWith(".md")) acc.push(full)
      }
      return acc
    }

    const allFixtures = walkFixtures(FIXTURES_ROOT)

    it("no corpus-specific keys live at top level of any fixture frontmatter", () => {
      const violations: string[] = []
      for (const file of allFixtures) {
        const fm = matter(readFileSync(file, "utf8")).data as Record<string, unknown>
        for (const key of Object.keys(fm)) {
          if (CORPUS_KEYS.has(key)) {
            violations.push(`${path.relative(FIXTURES_ROOT, file)}: top-level '${key}' should live under metadata.corpus.${key}`)
          }
        }
      }
      expect(violations).toEqual([])
    })

    it("found at least one fixture that uses metadata.corpus.* (proves we're testing the right thing)", () => {
      let found = false
      for (const file of allFixtures) {
        const fm = matter(readFileSync(file, "utf8")).data as {
          metadata?: { corpus?: unknown }
        }
        if (fm.metadata?.corpus) {
          found = true
          break
        }
      }
      expect(found).toBe(true)
    })
  })
})
