/**
 * AIP-11 LESSON.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineLesson` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-11/draft/LESSON.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { lessonFrontmatterSchema, type LessonFrontmatter } from "../schema.js"
import { defineLesson } from "../define-lesson.js"
import type { LessonDefinition, LessonHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/lesson/manifest" or directly from "@@agentproto/lesson/schema".
export { lessonFrontmatterSchema, type LessonFrontmatter }

export interface LessonManifest {
  frontmatter: LessonFrontmatter
  body: string
}

export function parseLessonManifest(source: string): LessonManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseLessonManifest: missing or empty frontmatter")
  }
  const result = lessonFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseLessonManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function lessonFromManifest(manifest: LessonManifest): LessonHandle {
  // The zod-validated frontmatter is structurally compatible with
  // LessonDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineLesson(manifest.frontmatter as unknown as LessonDefinition)
}
