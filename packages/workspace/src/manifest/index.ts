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
 * TODO: tighten the frontmatter schema once the AIP-34 fields are
 * decided. The skeleton accepts arbitrary extra keys via \`.loose()\`.
 */

import matter from "gray-matter"
import { z } from "zod"
import { defineWorkspace } from "../define-workspace.js"
import type { WorkspaceDefinition, WorkspaceHandle } from "../types.js"

export const workspaceManifestFrontmatterSchema = z
  .object({
    schema: z.literal("agentworkspace/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    description: z.string().min(1).max(2000),
    // TODO: spec-34 fields.
  })
  .loose()

export type WorkspaceManifestFrontmatter = z.infer<
  typeof workspaceManifestFrontmatterSchema
>

export interface WorkspaceManifest {
  frontmatter: WorkspaceManifestFrontmatter
  body: string
}

export function parseWorkspaceManifest(source: string): WorkspaceManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseWorkspaceManifest: missing or empty frontmatter")
  }
  const result = workspaceManifestFrontmatterSchema.safeParse(parsed.data)
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
