/**
 * AIP-39 ACTION.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineAction` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-39/draft/ACTION.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { actionFrontmatterSchema, type ActionFrontmatter } from "../schema.js"
import { defineAction } from "../define-action.js"
import type { ActionDefinition, ActionHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/action/manifest" or directly from "@@agentproto/action/schema".
export { actionFrontmatterSchema, type ActionFrontmatter }

export interface ActionManifest {
  frontmatter: ActionFrontmatter
  body: string
}

export function parseActionManifest(source: string): ActionManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseActionManifest: missing or empty frontmatter")
  }
  const result = actionFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseActionManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function actionFromManifest(manifest: ActionManifest): ActionHandle {
  // The zod-validated frontmatter is structurally compatible with
  // ActionDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineAction(manifest.frontmatter as unknown as ActionDefinition)
}
