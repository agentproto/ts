import type { SkillHandle } from "./types.js"

/**
 * A skill handle paired with its SKILL.md body (AIP-3). The body is the
 * instructions text, which is not frontmatter, so it travels with the handle
 * (same shape idea as AIP-42's `AgentEntry`, with the body mandatory).
 */
export interface SkillEntry {
  readonly skill: SkillHandle
  readonly body: string
}
