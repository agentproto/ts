/**
 * AIP-41 doctype spec — fed to `@agentproto/manifest.createVerbs`
 * to derive create / load / list / update / resolve / delete in one
 * place. Plugs into `@agentproto/mcp-server` so a routine library
 * lives at `<workspace>/.routines/<id>/ROUTINE.md`.
 */

import { createVerbs, type DoctypeSpec } from "@agentproto/manifest"
import { defineRoutine } from "./define-routine.js"
import { parseRoutineManifest } from "./manifest/index.js"
import type { RoutineDefinition, RoutineHandle } from "./types.js"

export const routineSpec: DoctypeSpec<RoutineDefinition, RoutineHandle> = {
  name: "routine",
  aip: 41,
  schemaLiteral: "routine/v1",
  pathOf: (h) => `.routines/${h.id}/ROUTINE.md`,
  define: defineRoutine,
  parse: (source) => {
    const m = parseRoutineManifest(source)
    return {
      frontmatter: m.frontmatter as unknown as Record<string, unknown>,
      body: m.body,
    }
  },
}

export const routineVerbs = createVerbs(routineSpec)
