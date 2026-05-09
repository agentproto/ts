/**
 * AIP-3 SKILL.md frontmatter zod schema.
 *
 * Mirrors `resources/aip-3/draft/SKILL.schema.json` field-for-field.
 * AIP-3 is a profile of agentskills.io — top-level fields are the
 * canonical agentskills.io frontmatter; AIP-3 extensions live under
 * `metadata.aip3.*` so a skill authored against AIP-3 remains a valid
 * agentskills.io skill in any conformant runtime.
 *
 * Both authoring paths (`define-skill.ts` for TS-authored skills and
 * `manifest/index.ts` for SKILL.md parsing) validate against this
 * schema, so every field-level constraint runs in both paths from a
 * single source of truth.
 *
 * Cross-field rules (variant=executable ⇒ execution required;
 * variant=composite ⇒ uses non-empty) live in `define-skill.ts`'s
 * `validate(def)` body — they're harder to encode in a flat zod
 * schema and want a single error path.
 */

import { z } from "zod"

/** agentskills.io `name` rule: 1–64, kebab, no leading/trailing/consecutive `-`. */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/
const TAG_PATTERN = /^[a-z][a-z0-9-]*$/

const executionSchema = z
  .object({
    language: z
      .enum(["typescript", "javascript", "python", "shell"])
      .describe("Implementation language. Runtimes MAY refuse languages they don't support."),
    code: z
      .union([
        z
          .object({
            file: z
              .string()
              .min(1)
              .describe(
                "Relative path to the entry file. SHOULD live under `scripts/`. Path traversal segments escaping the skill dir MUST be rejected.",
              ),
          })
          .strict(),
        z
          .object({
            inline: z
              .string()
              .describe("Inline source. Runtimes MUST sandbox before executing."),
          })
          .strict(),
      ])
      .describe("Exactly one of { file } or { inline }. File paths are relative to SKILL.md."),
    entrypoint: z.string().min(1).optional(),
    runtime: z
      .object({
        provider: z.string().optional(),
        timeout: z.number().int().positive().optional(),
        memory: z.string().optional(),
      })
      .strict()
      .optional(),
    artifacts: z
      .object({
        patterns: z.array(z.string()).min(1),
      })
      .strict()
      .optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .describe("Executable bindings. Required when variant=executable.")

export const aip3ExtensionsSchema = z
  .object({
    schema: z
      .literal("skills/v1")
      .describe("Schema dispatch tag. Required for AIP-3 conformance."),
    variant: z
      .enum(["instruction", "executable", "composite"])
      .default("instruction")
      .describe(
        "Skill variant. `instruction` is prose-only (default); `executable` bundles runnable code via `execution`; `composite` references other skills via `uses`.",
      ),
    version: z
      .string()
      .regex(SEMVER_PATTERN)
      .optional()
      .describe("Semver. Bump on breaking changes to the skill's behavior or required tools."),
    tags: z
      .array(z.string().regex(TAG_PATTERN))
      .max(12)
      .default([])
      .describe("Catalog tags. Lowercase kebab-case; no leading symbols. 3–6 tags is typical."),
    category: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Coarse grouping (e.g. 'productivity', 'creative', 'development'). Free-form; runtimes SHOULD NOT enumerate.",
      ),
    requires: z
      .array(z.number().int().positive())
      .default([])
      .describe(
        "Other AIPs this skill depends on (e.g. `[9]` for the operator runtime). Runtimes MAY warn when a declared dependency is unsupported.",
      ),
    author: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Optional. Conventional shape: 'Name <email>' or stable handle. Mirrors agentskills.io's `metadata.author` convention; if both are present, `metadata.aip3.author` wins for AIP-3 runtimes.",
      ),
    title: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Optional human-readable display title. Headless runtimes that can't render the body H1 MAY use this. The body H1 is preferred.",
      ),
    uses: z
      .array(z.string().regex(NAME_PATTERN))
      .default([])
      .describe(
        "Skill names this skill composes with. Required and non-empty when variant=composite.",
      ),
    execution: executionSchema.optional(),
  })
  .loose()

export const skillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(NAME_PATTERN)
      .describe(
        "Machine identifier. 1–64 chars, lowercase alphanumeric and hyphens only, no leading/trailing/consecutive hyphens. MUST equal the parent directory name. Inherited verbatim from agentskills.io.",
      ),
    description: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "One-paragraph purpose. SHOULD describe both what the skill does and when to use it. Inherited from agentskills.io (1024-char cap).",
      ),
    license: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Optional. License identifier (SPDX or pointer to a bundled license file). Inherited from agentskills.io.",
      ),
    compatibility: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Optional. Free-form environment requirements: intended product, system packages, network access, etc. Most skills omit this.",
      ),
    "allowed-tools": z
      .string()
      .optional()
      .describe(
        "Optional. Space-separated list of pre-approved tool patterns (e.g. 'Bash(git:*) Read'). Experimental upstream — runtimes MAY ignore. The field is a request, not a grant.",
      ),
    metadata: z
      .object({ aip3: aip3ExtensionsSchema.optional() })
      .loose()
      .default({})
      .describe(
        "Free-form key-value mapping. Hosts and standards stash extension fields under namespaced keys (e.g. `metadata.aip3.*`, `metadata.acme.*`). Inherited from agentskills.io.",
      ),
  })
  .loose()
  .describe(
    "Validates the YAML frontmatter portion of an AIP-3 SKILL.md manifest. AIP-3 is a profile of agentskills.io.",
  )

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>
export type Aip3Extensions = z.infer<typeof aip3ExtensionsSchema>
