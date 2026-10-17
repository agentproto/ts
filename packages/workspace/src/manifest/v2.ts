/**
 * AIP-34 WORKSPACE.md v2 sidecar: .md ↔ object, both directions, one schema.
 *
 * `parseWorkspaceV2Manifest` / `workspaceV2FromManifest` mirror the v1
 * pair in `./index.ts`. `writeWorkspaceV2Manifest` is the new direction
 * v1 didn't need yet: a TS-authored `defineWorkspaceV2` handle →
 * WORKSPACE.md text, so the SDK's TS path and its .md path are true
 * round-trips of each other through `workspaceV2FrontmatterSchema` —
 * no second shape to keep in sync.
 */

import matter from "gray-matter"
import { workspaceV2FrontmatterSchema, type WorkspaceV2Frontmatter } from "../schema-v2.js"
import { defineWorkspaceV2 } from "../define-workspace-v2.js"
import type { WorkspaceDefinitionV2, WorkspaceHandleV2 } from "../types-v2.js"

export { workspaceV2FrontmatterSchema, type WorkspaceV2Frontmatter }

export interface WorkspaceV2Manifest {
  frontmatter: WorkspaceV2Frontmatter
  body: string
}

export function parseWorkspaceV2Manifest(source: string): WorkspaceV2Manifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseWorkspaceV2Manifest: missing or empty frontmatter")
  }
  const result = workspaceV2FrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseWorkspaceV2Manifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function workspaceV2FromManifest(manifest: WorkspaceV2Manifest): WorkspaceHandleV2 {
  return defineWorkspaceV2(manifest.frontmatter as unknown as WorkspaceDefinitionV2)
}

/**
 * The .ts → .md direction. Validates `def` through the SAME schema
 * (via `defineWorkspaceV2`, so an invalid definition throws the exact
 * diagnostic the TS path would) before serializing, so it's impossible
 * to write a WORKSPACE.md that the loader would then reject.
 */
export function writeWorkspaceV2Manifest(def: WorkspaceDefinitionV2, body = ""): string {
  const handle = defineWorkspaceV2(def)
  const { schema: _schema, ...frontmatter } = handle as Record<string, unknown>
  const ordered = { schema: handle.schema, ...frontmatter }
  return matter.stringify(body, ordered)
}
