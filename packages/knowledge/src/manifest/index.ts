/**
 * AIP-10 KNOWLEDGE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineKnowledge` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-10/draft/KNOWLEDGE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { knowledgeFrontmatterSchema, type KnowledgeFrontmatter } from "../schema.js"
import { defineKnowledge } from "../define-knowledge.js"
import type { KnowledgeDefinition, KnowledgeHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/knowledge/manifest" or directly from "@@agentproto/knowledge/schema".
export { knowledgeFrontmatterSchema, type KnowledgeFrontmatter }

export interface KnowledgeManifest {
  frontmatter: KnowledgeFrontmatter
  body: string
}

export function parseKnowledgeManifest(source: string): KnowledgeManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseKnowledgeManifest: missing or empty frontmatter")
  }
  const result = knowledgeFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseKnowledgeManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function knowledgeFromManifest(manifest: KnowledgeManifest): KnowledgeHandle {
  // The zod-validated frontmatter is structurally compatible with
  // KnowledgeDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineKnowledge(manifest.frontmatter as unknown as KnowledgeDefinition)
}
