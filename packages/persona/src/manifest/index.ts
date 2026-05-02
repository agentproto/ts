/**
 * AIP-25 PERSONA.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `definePersona` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-25/draft/PERSONA.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { personaFrontmatterSchema, type PersonaFrontmatter } from "../schema.js"
import { definePersona } from "../define-persona.js"
import type { PersonaDefinition, PersonaHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/persona/manifest" or directly from "@@agentproto/persona/schema".
export { personaFrontmatterSchema, type PersonaFrontmatter }

export interface PersonaManifest {
  frontmatter: PersonaFrontmatter
  body: string
}

export function parsePersonaManifest(source: string): PersonaManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parsePersonaManifest: missing or empty frontmatter")
  }
  const result = personaFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parsePersonaManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function personaFromManifest(manifest: PersonaManifest): PersonaHandle {
  // The zod-validated frontmatter is structurally compatible with
  // PersonaDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return definePersona(manifest.frontmatter as unknown as PersonaDefinition)
}
