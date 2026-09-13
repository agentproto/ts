/**
 * AIP-52 PACK.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/playbook/manifest`: the .md provides metadata;
 * the TS module supplies any spec-specific runtime bits that can't live
 * in frontmatter. Both inputs end up in `definePack` so the cross-AIP
 * invariants run uniformly.
 */

import matter from "gray-matter"
import { packFrontmatterSchema, type PackFrontmatter } from "../schema.js"
import { definePack } from "../define-pack.js"
import type { PackDefinition, PackHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@agentproto/pack/manifest" or directly from "@agentproto/pack/schema".
export { packFrontmatterSchema, type PackFrontmatter }

export interface PackManifest {
  frontmatter: PackFrontmatter
  body: string
}

export function parsePackManifest(source: string): PackManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parsePackManifest: missing or empty frontmatter")
  }
  const result = packFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parsePackManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function packFromManifest(manifest: PackManifest): PackHandle {
  // The zod-validated frontmatter is structurally compatible with
  // PackDefinition; the cast pins the typing once the manifest schema
  // and the TS interface diverge (e.g. handle has a derived status a
  // literal config doesn't carry yet).
  return definePack(manifest.frontmatter as unknown as PackDefinition)
}