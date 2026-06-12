/**
 * `defineProvisionRecipe` — the TS-literal authoring path for a recipe.
 *
 * Built on `createDoctype` so a recipe gets the same cross-AIP invariants as
 * every other doctype: id-pattern check, ≤2000-char description, frozen handle,
 * canonical "defineProvisionRecipe (AIP-19): …" error prefix. Field-level
 * validation runs the shared zod from `./schema.ts`, so a malformed literal
 * fails with the same diagnostic as a malformed `.md`.
 */

import { createDoctype } from "@agentproto/define-doctype"
import { provisionRecipeFrontmatterSchema } from "./schema.js"
import type {
  ProvisionRecipe,
  ProvisionRecipeDefinition,
} from "./types.js"

export const defineProvisionRecipe = createDoctype<
  ProvisionRecipeDefinition,
  ProvisionRecipe
>({
  aip: 19,
  name: "provisionRecipe",
  validate(def) {
    const result = provisionRecipeFrontmatterSchema.safeParse(def)
    if (!result.success) {
      throw new Error(
        `defineProvisionRecipe (AIP-19): ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      )
    }
  },
  build(def) {
    return {
      ...def,
      methods: def.methods.map((m) => Object.freeze({ ...m })) as ProvisionRecipe["methods"],
    }
  },
})
