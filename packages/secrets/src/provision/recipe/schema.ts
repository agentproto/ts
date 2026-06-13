/**
 * Provision-recipe frontmatter / literal zod schema.
 *
 * Single source of truth for both authoring paths: `defineProvisionRecipe`
 * (TS literal) and `parseRecipeManifest` (.md) run this same schema, so a
 * malformed literal and a malformed manifest fail identically — mirrors how
 * `secretsFrontmatterSchema` backs both `defineSecrets` and
 * `parseSecretsManifest`.
 *
 * Hand-written rather than scaffold-aip-generated: a recipe is not yet a
 * numbered-AIP artifact. Promote to a generated schema if it gets its own spec.
 */

import { z } from "zod"

/** Exactly one of file / env / keychain / prompt. `value` is explicitly
 *  forbidden — a recipe carries locations, never secrets. */
export const credentialSourceSpecSchema = z
  .union([
    z
      .object({
        file: z.string().min(1),
        jsonPath: z.string().min(1).optional(),
      })
      .strict(),
    z.object({ env: z.string().min(1) }).strict(),
    z
      .object({
        keychain: z.string().min(1),
        account: z.string().min(1).optional(),
        jsonPath: z.string().min(1).optional(),
      })
      .strict(),
    z.object({ prompt: z.string().min(1) }).strict(),
  ])
  .describe(
    "Where a method's credential is read on the origin machine: a file (optionally a JSON field), an env var, the macOS Keychain, or an interactive prompt. Never a literal value.",
  )

/** A method's source: a single spec or an ordered fallback chain (first that
 *  resolves wins). */
export const methodSourceSchema = z.union([
  credentialSourceSpecSchema,
  z.array(credentialSourceSpecSchema).min(1),
])

export const recipeMethodSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    source: methodSourceSchema,
  })
  .strict()

export const provisionRecipeFrontmatterSchema = z
  .object({
    id: z.string().min(2).max(80),
    description: z.string().min(1).max(2000),
    methods: z.array(recipeMethodSchema).min(1),
    label: z.string().min(1).optional(),
  })
  .strict()
  .describe(
    "A credential-provision recipe: for one provider, the installable flavors (methods) and where each flavor's credential lives locally. Holds locations, never values.",
  )

export type ProvisionRecipeFrontmatter = z.infer<
  typeof provisionRecipeFrontmatterSchema
>
