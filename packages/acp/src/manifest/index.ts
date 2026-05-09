/**
 * AIP-44 ACP.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/skill/manifest`: the .md provides metadata;
 * the TS module supplies any runtime bits the manifest can't carry.
 * Both inputs end up in `defineAcp` so the cross-AIP invariants run
 * uniformly.
 */

import matter from "gray-matter"
import { acpFrontmatterSchema, type AcpFrontmatter } from "../schema.js"
import { defineAcp } from "../define-acp.js"
import type { AcpDefinition, AcpHandle } from "../types.js"

export { acpFrontmatterSchema, type AcpFrontmatter }

export interface AcpManifest {
  frontmatter: AcpFrontmatter
  body: string
}

export function parseAcpManifest(source: string): AcpManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseAcpManifest: missing or empty frontmatter")
  }
  const result = acpFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseAcpManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function acpFromManifest(manifest: AcpManifest): AcpHandle {
  return defineAcp(manifest.frontmatter as unknown as AcpDefinition)
}
