/**
 * AIP-12 PLAYBOOK.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `definePlaybook` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-12/draft/PLAYBOOK.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { playbookFrontmatterSchema, type PlaybookFrontmatter } from "../schema.js"
import { definePlaybook } from "../define-playbook.js"
import type { PlaybookDefinition, PlaybookHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/playbook/manifest" or directly from "@@agentproto/playbook/schema".
export { playbookFrontmatterSchema, type PlaybookFrontmatter }

export interface PlaybookManifest {
  frontmatter: PlaybookFrontmatter
  body: string
}

export function parsePlaybookManifest(source: string): PlaybookManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parsePlaybookManifest: missing or empty frontmatter")
  }
  const result = playbookFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parsePlaybookManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function playbookFromManifest(manifest: PlaybookManifest): PlaybookHandle {
  // The zod-validated frontmatter is structurally compatible with
  // PlaybookDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return definePlaybook(manifest.frontmatter as unknown as PlaybookDefinition)
}
