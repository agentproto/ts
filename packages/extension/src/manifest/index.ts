/**
 * AIP-40 EXTENSION.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineExtension` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-40/draft/EXTENSION.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { extensionFrontmatterSchema, type ExtensionFrontmatter } from "../schema.js"
import { defineExtension } from "../define-extension.js"
import type { ExtensionDefinition, ExtensionHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/extension/manifest" or directly from "@@agentproto/extension/schema".
export { extensionFrontmatterSchema, type ExtensionFrontmatter }

export interface ExtensionManifest {
  frontmatter: ExtensionFrontmatter
  body: string
}

export function parseExtensionManifest(source: string): ExtensionManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseExtensionManifest: missing or empty frontmatter")
  }
  const result = extensionFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseExtensionManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function extensionFromManifest(manifest: ExtensionManifest): ExtensionHandle {
  // The zod-validated frontmatter is structurally compatible with
  // ExtensionDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineExtension(manifest.frontmatter as unknown as ExtensionDefinition)
}
