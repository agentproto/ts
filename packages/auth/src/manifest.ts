/**
 * `.md` authoring path for an auth-provider — parse a frontmatter manifest
 * into a frozen handle. Mirrors `parseRecipeManifest` from AIP-19: gray-matter
 * splits the frontmatter, the shared Zod validates it, `defineAuthProvider`
 * builds the handle so both authoring paths converge on one validated shape.
 *
 * This parser is the extension seam: a host reads its own external `.md`
 * manifests (e.g. vendor-shipped `guilde.auth.md`) and registers them without
 * editing this package.
 */

import matter from "gray-matter"
import {
  authProviderFrontmatterSchema,
  type AuthProviderFrontmatter,
} from "./schema.js"
import { defineAuthProvider } from "./define-auth-provider.js"
import type { AuthProviderHandle } from "./types.js"

export interface AuthProviderManifest {
  frontmatter: AuthProviderFrontmatter
  body: string
}

export function parseAuthProviderManifestRaw(
  source: string,
): AuthProviderManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseAuthProviderManifest: missing or empty frontmatter")
  }
  const result = authProviderFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseAuthProviderManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

/** Parse an auth-provider `.md` straight to a frozen handle. */
export function parseAuthProviderManifest(source: string): AuthProviderHandle {
  const { frontmatter } = parseAuthProviderManifestRaw(source)
  return defineAuthProvider(frontmatter)
}
