/**
 * AIP-36 SANDBOX.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineSandbox` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-36/draft/SANDBOX.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { sandboxFrontmatterSchema, type SandboxFrontmatter } from "../schema.js"
import { defineSandbox } from "../define-sandbox.js"
import type { SandboxDefinition, SandboxHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/sandbox/manifest" or directly from "@@agentproto/sandbox/schema".
export { sandboxFrontmatterSchema, type SandboxFrontmatter }

export interface SandboxManifest {
  frontmatter: SandboxFrontmatter
  body: string
}

export function parseSandboxManifest(source: string): SandboxManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseSandboxManifest: missing or empty frontmatter")
  }
  const result = sandboxFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseSandboxManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function sandboxFromManifest(manifest: SandboxManifest): SandboxHandle {
  // The zod-validated frontmatter is structurally compatible with
  // SandboxDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineSandbox(manifest.frontmatter as unknown as SandboxDefinition)
}
