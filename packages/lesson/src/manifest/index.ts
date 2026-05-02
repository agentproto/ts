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
import { z } from "zod"
import { defineLesson } from "../define-lesson.js"
import type { LessonDefinition, LessonHandle } from "../types.js"

export const lessonManifestFrontmatterSchema = z.object({ "schema": z.literal("learning/v1").describe("Spec identifier. Must be the literal string 'learning/v1'."), "slug": z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$")).min(2).max(80).describe("Machine identifier, also the filename. Lowercase, digits, dashes. Imperative voice recommended."), "title": z.string().min(1).max(200).describe("One-sentence imperative title — what to do or avoid."), "trigger": z.object({ "description": z.string().min(1).max(1000).describe("Plain-text description of when this lesson applies."), "tags": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*$"))).max(12).describe("Retrieval keywords. Keep narrow; three is usually enough.").default([]), "targets": z.array(z.object({ "operator": z.string().optional(), "role": z.string().optional(), "skill": z.string().optional() }).strict()).describe("Operator / role / skill globs that scope retrieval. Empty means anyone.").default([]), "metadata": z.record(z.string(), z.any()).describe("Vendor-specific trigger predicates. Standard fields above MUST NOT be redefined here.").default({}) }).strict(), "outcome": z.enum(["success","failure","mixed"]).describe("Whether the source run succeeded, failed, or the lesson is conditional across runs."), "evidence": z.array(z.object({ "kind": z.enum(["run","conversation","work-item","audit","wiki-page"]).describe("What the evidence reference points to. 'audit' = AIP-7 governance record."), "ref": z.string().min(1).max(256).describe("Opaque id or path the host can resolve. Never free text."), "note": z.string().max(500).describe("One-line factual note about the event — not the lesson.").optional() }).strict()).min(1).describe("Provenance — at least one evidence entry MUST resolve to a real run, conversation, work item, audit, or wiki page in the host's indices."), "confidence": z.number().gte(0).lte(1).describe("Author's confidence in [0,1]. Default 0.5 at first sighting. Runtimes weigh this against observed counts.").default(0.5), "success_count": z.number().int().gte(0).describe("Times the lesson 'worked' when applied. Maintained by the runtime; author-supplied values are initial only.").default(0), "failure_count": z.number().int().gte(0).describe("Times the lesson's claim was contradicted. Maintained by the runtime; author-supplied values are initial only.").default(0), "supersedes": z.array(z.string().regex(new RegExp("^[a-z][a-z0-9-]*[a-z0-9]$"))).describe("Slugs of lessons this lesson replaces. Supersession is explicit, never silent. Each cited slug MUST exist on disk.").default([]), "expires_at": z.string().datetime({ offset: true }).describe("Soft TTL (ISO 8601). Past this instant, retrieval treats the lesson as absent by default.").optional(), "metadata": z.record(z.string(), z.any()).describe("Vendor-specific extensions under namespaced keys (metadata.<vendor>.<field>). Standard fields MUST NOT be redefined.").default({}) }).strict().and(z.any()).describe("Validates the YAML frontmatter portion of an AIP-11 LESSON.md file — one transferable lesson distilled from a completed run.")

export type LessonManifestFrontmatter = z.infer<
  typeof lessonManifestFrontmatterSchema
>

export interface LessonManifest {
  frontmatter: LessonManifestFrontmatter
  body: string
}

export function parseLessonManifest(source: string): LessonManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseLessonManifest: missing or empty frontmatter")
  }
  const result = lessonManifestFrontmatterSchema.safeParse(parsed.data)
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
