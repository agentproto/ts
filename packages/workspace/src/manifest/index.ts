/**
 * AIP-34 WORKSPACE.md sidecar: .md ↔ object, both directions, one schema.
 *
 * `parseWorkspaceManifest` / `workspaceFromManifest` are the .md → object
 * path, mirroring `@agentproto/tool/manifest` and `@agentproto/driver/manifest`.
 * `writeWorkspaceManifest` is the .ts (TS-authored `defineWorkspace` handle)
 * → WORKSPACE.md text direction — load/export/verify are true round-trips
 * of each other through `workspaceFrontmatterSchema`, never a second shape
 * to keep in sync.
 */

import matter from "gray-matter"
import { workspaceFrontmatterSchema, type WorkspaceFrontmatter } from "../schema.js"
import { defineWorkspace } from "../define-workspace.js"
import type { WorkspaceDefinition, WorkspaceHandle } from "../types.js"

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
  return defineWorkspace(manifest.frontmatter as unknown as WorkspaceDefinition)
}

/**
 * The .ts → .md direction. Validates `def` through the SAME schema (via
 * `defineWorkspace`, so an invalid definition throws the exact diagnostic
 * the TS path would) before serializing, so it's impossible to write a
 * WORKSPACE.md that the loader would then reject.
 */
export function writeWorkspaceManifest(def: WorkspaceDefinition, body = ""): string {
  const handle = defineWorkspace(def)
  const { schema: _schema, ...frontmatter } = handle as Record<string, unknown>
  const ordered = { schema: handle.schema, ...frontmatter }
  return matter.stringify(body, ordered)
}
