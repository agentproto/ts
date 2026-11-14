/**
 * AIP-3 doctype spec — fed to `@agentproto/manifest.createVerbs` to derive
 * create / load / list / update / resolve / delete in one place. A skill
 * lives at `<dir>/skills/<name>/SKILL.md`.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import matter from "gray-matter"
import { defineSkill } from "./define-skill.js"
import { parseSkillManifest } from "./manifest/index.js"
import { renderSkillMd } from "./render.js"
import type { SkillDefinition, SkillHandle } from "./types.js"

export const skillSpec: DoctypeSpec<SkillDefinition, SkillHandle> = {
  name: "skill",
  aip: 3,
  schemaLiteral: "skill/v1",
  pathOf: (h) => `skills/${h.name}/SKILL.md`,
  define: defineSkill,
  render: (handle, body) => renderSkillMd({ skill: handle, body: body ?? "" }),
  parse: (source) => {
    const m = parseSkillManifest(source)
    // Validated above; the file's own fields come back, so an update does not
    // write schema defaults into a file that never carried them.
    return { frontmatter: structuredClone(matter(source).data), body: m.body }
  },
}

export const skillVerbs = createVerbs(skillSpec)
