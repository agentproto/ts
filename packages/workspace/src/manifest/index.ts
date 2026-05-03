/**
 * AIP-34 WORKSPACE.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineWorkspace` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-34/draft/WORKSPACE.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { workspaceFrontmatterSchema, type WorkspaceFrontmatter } from "../schema.js"
import { defineWorkspace } from "../define-workspace.js"
import type { WorkspaceDefinition, WorkspaceHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/workspace/manifest" or directly from "@@agentproto/workspace/schema".
export { workspaceFrontmatterSchema, type WorkspaceFrontmatter }

export interface WorkspaceManifest {
  frontmatter: WorkspaceFrontmatter
  body: string
}

export function parseWorkspaceManifest(source: string): WorkspaceManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseWorkspaceManifest: missing or empty frontmatter")
  }
  const result = workspaceFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseWorkspaceManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function workspaceFromManifest(manifest: WorkspaceManifest): WorkspaceHandle {
  // The zod-validated frontmatter is structurally compatible with
  // WorkspaceDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineWorkspace(manifest.frontmatter as unknown as WorkspaceDefinition)
}
