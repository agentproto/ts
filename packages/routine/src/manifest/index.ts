/**
 * AIP-41 ROUTINE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineRoutine` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-41/draft/ROUTINE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { routineFrontmatterSchema, type RoutineFrontmatter } from "../schema.js"
import { defineRoutine } from "../define-routine.js"
import type { RoutineDefinition, RoutineHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/routine/manifest" or directly from "@@agentproto/routine/schema".
export { routineFrontmatterSchema, type RoutineFrontmatter }

export interface RoutineManifest {
  frontmatter: RoutineFrontmatter
  body: string
}

export function parseRoutineManifest(source: string): RoutineManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseRoutineManifest: missing or empty frontmatter")
  }
  const result = routineFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseRoutineManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function routineFromManifest(manifest: RoutineManifest): RoutineHandle {
  // The zod-validated frontmatter is structurally compatible with
  // RoutineDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineRoutine(manifest.frontmatter as unknown as RoutineDefinition)
}
