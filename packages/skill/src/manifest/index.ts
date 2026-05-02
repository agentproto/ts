/**
 * AIP-3 SKILL.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineSkill` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-3/draft/SKILL.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { skillFrontmatterSchema, type SkillFrontmatter } from "../schema.js"
import { defineSkill } from "../define-skill.js"
import type { SkillDefinition, SkillHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/skill/manifest" or directly from "@@agentproto/skill/schema".
export { skillFrontmatterSchema, type SkillFrontmatter }

export interface SkillManifest {
  frontmatter: SkillFrontmatter
  body: string
}

export function parseSkillManifest(source: string): SkillManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseSkillManifest: missing or empty frontmatter")
  }
  const result = skillFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseSkillManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function skillFromManifest(manifest: SkillManifest): SkillHandle {
  // The zod-validated frontmatter is structurally compatible with
  // SkillDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineSkill(manifest.frontmatter as unknown as SkillDefinition)
}
