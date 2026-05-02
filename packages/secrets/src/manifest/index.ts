/**
 * AIP-19 SECRETS.md sidecar parser + manifest-to-handle constructor.
 *
 * Mirror of `@agentproto/tool/manifest` and `@agentproto/driver/manifest`:
 * the .md provides metadata; the TS module supplies any spec-specific
 * runtime bits (schemas, execute bodies, …) that can't live in
 * frontmatter. Both inputs end up in `defineSecrets` so the cross-AIP
 * invariants run uniformly.
 *
 *
 * The frontmatter zod schema below was generated from
 * `resources/aip-19/draft/SECRETS.schema.json` via json-schema-to-zod.
 * Re-run scaffold-aip to refresh after spec changes (or hand-tune
 * any constraint the converter doesn't capture cleanly).
 */

import matter from "gray-matter"
import { secretsFrontmatterSchema, type SecretsFrontmatter } from "../schema.js"
import { defineSecrets } from "../define-secrets.js"
import type { SecretsDefinition, SecretsHandle } from "../types.js"

// Re-export so consumers can import the schema + inferred type either
// from "@@agentproto/secrets/manifest" or directly from "@@agentproto/secrets/schema".
export { secretsFrontmatterSchema, type SecretsFrontmatter }

export interface SecretsManifest {
  frontmatter: SecretsFrontmatter
  body: string
}

export function parseSecretsManifest(source: string): SecretsManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseSecretsManifest: missing or empty frontmatter")
  }
  const result = secretsFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseSecretsManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

export function secretsFromManifest(manifest: SecretsManifest): SecretsHandle {
  // The zod-validated frontmatter is structurally compatible with
  // SecretsDefinition; the cast pins the typing once the manifest
  // schema and the TS interface diverge (e.g. handle has frozen fields
  // a literal config doesn't carry yet).
  return defineSecrets(manifest.frontmatter as unknown as SecretsDefinition)
}
