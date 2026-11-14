import matter from "gray-matter"
import type { SkillEntry } from "./entry.js"

/**
 * Render a SKILL.md. The frontmatter is the handle as agentskills.io spells it
 * (AIP-3 is a profile of it, so no top-level `schema` key); the dispatch tag
 * under `metadata.aip3.schema` is written as the canonical `skill/v1`, never
 * the legacy `skills/v1`.
 */
export function renderSkillMd(entry: SkillEntry): string {
  const data = JSON.parse(JSON.stringify(entry.skill)) as {
    metadata?: { aip3?: { schema?: string } }
  }
  const aip3 = data.metadata?.aip3
  if (aip3?.schema === "skills/v1") aip3.schema = "skill/v1"
  return matter.stringify(`\n${entry.body.trim()}\n`, data)
}
