/**
 * AIP-47 doctype spec — fed to `@agentproto/manifest.createVerbs` to derive
 * create / load / list / update / resolve / delete in one place. A role
 * lives at `<dir>/roles/<name>/ROLE.md`, the path AIP-6 and AIP-47 share.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import matter from "gray-matter"
import { defineRole } from "./define-role.js"
import { parseRoleManifest } from "./manifest/index.js"
import { renderRoleMd } from "./render.js"
import type { RoleDefinition, RoleHandle } from "./types.js"

export const roleSpec: DoctypeSpec<RoleDefinition, RoleHandle> = {
  name: "role",
  aip: 47,
  schemaLiteral: "role/v1",
  pathOf: (h) => `roles/${h.name}/ROLE.md`,
  define: defineRole,
  render: (handle, body) => renderRoleMd({ role: handle, body }),
  parse: (source) => {
    const m = parseRoleManifest(source)
    // Validated above; the file's own fields come back, so an update does not
    // write schema defaults into a file that never carried them.
    return { frontmatter: structuredClone(matter(source).data), body: m.body }
  },
}

export const roleVerbs = createVerbs(roleSpec)
