/**
 * AIP-24 ASSEMBLY.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineAssembly` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-24/draft/ASSEMBLY.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { assemblyFrontmatterSchema, type AssemblyFrontmatter } from "../schema.js"
import { defineAssembly } from "../define-assembly.js"
import type { AssemblyDefinition, AssemblyHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/assembly/manifest" or directly from "@@agentproto/assembly/schema".
export { assemblyFrontmatterSchema, type AssemblyFrontmatter }

export interface AssemblyManifest {
  frontmatter: AssemblyFrontmatter
  body: string
}

export function parseAssemblyManifest(source: string): AssemblyManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseAssemblyManifest: missing or empty frontmatter")
  }
  const result = assemblyFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseAssemblyManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function assemblyFromManifest(manifest: AssemblyManifest): AssemblyHandle {
  // The zod-validated frontmatter is structurally compatible with
  // AssemblyDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineAssembly(manifest.frontmatter as unknown as AssemblyDefinition)
}
