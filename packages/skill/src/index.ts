/**
 * @agentproto/skill — AIP-3 SKILL.md `defineSkill` reference impl.
 *
 * A markdown + frontmatter format for distributing reusable agent skills as portable, version-controlled files.
 *
 * Spec: https://agentproto.sh/docs/aip-3
 *
 * Authoring paths:
 *   - TS:  `defineSkill({...})` → `SkillHandle`
 *   - MD:  `parseSkillManifest(src) → skillFromManifest({...})` → `SkillHandle`
 */

export const SPEC_NAME = "agentskill/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineSkill } from "./define-skill.js"
export type { SkillDefinition, SkillHandle } from "./types.js"
