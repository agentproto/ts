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
 * TODO: tighten the frontmatter schema once the AIP-36 fields are
 * decided. The skeleton accepts arbitrary extra keys via \`.loose()\`.
 */

import matter from "gray-matter"
import { z } from "zod"
import { defineSandbox } from "../define-sandbox.js"
import type { SandboxDefinition, SandboxHandle } from "../types.js"

export const sandboxManifestFrontmatterSchema = z
  .object({
    schema: z.literal("agentsandbox/v1").optional(),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
    description: z.string().min(1).max(2000),
    // TODO: spec-36 fields.
  })
  .loose()

export type SandboxManifestFrontmatter = z.infer<
  typeof sandboxManifestFrontmatterSchema
>

export interface SandboxManifest {
  frontmatter: SandboxManifestFrontmatter
  body: string
}

export function parseSandboxManifest(source: string): SandboxManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseSandboxManifest: missing or empty frontmatter")
  }
  const result = sandboxManifestFrontmatterSchema.safeParse(parsed.data)
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
