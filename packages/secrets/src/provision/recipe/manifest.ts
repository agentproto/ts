/**
 * `.md` authoring path for a provision recipe — parse a frontmatter manifest
 * into a frozen handle. Mirrors `parseSecretsManifest`: gray-matter splits the
 * frontmatter, the shared zod validates it, `defineProvisionRecipe` builds the
 * handle so the `.md` and TS-literal paths converge on one validated shape.
 *
 * The package ships its builtin recipes as TS literals (they bundle with zero
 * fs); this parser is for a HOST that reads its own external `.md` recipes and
 * registers them — the extension seam.
 */

import matter from "gray-matter"
import {
  provisionRecipeFrontmatterSchema,
  type ProvisionRecipeFrontmatter,
} from "./schema.js"
import { defineProvisionRecipe } from "./define-recipe.js"
import type { ProvisionRecipe, ProvisionRecipeDefinition } from "./types.js"

export interface ProvisionRecipeManifest {
  frontmatter: ProvisionRecipeFrontmatter
  body: string
}

export function parseRecipeManifestRaw(
  source: string,
): ProvisionRecipeManifest {
  const parsed = matter(source)
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("parseRecipeManifest: missing or empty frontmatter")
  }
  const result = provisionRecipeFrontmatterSchema.safeParse(parsed.data)
  if (!result.success) {
    throw new Error(
      `parseRecipeManifest: invalid frontmatter — ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return { frontmatter: result.data, body: parsed.content }
}

/** Parse a recipe `.md` straight to a frozen handle (frontmatter →
 *  `defineProvisionRecipe`). */
export function parseRecipeManifest(source: string): ProvisionRecipe {
  const { frontmatter } = parseRecipeManifestRaw(source)
  return defineProvisionRecipe(
    frontmatter as unknown as ProvisionRecipeDefinition,
  )
}
