/**
 * Provision-recipe registry — id → recipe lookup, pre-seeded with the builtins.
 *
 * Mirrors the host-side OAuth-provider registry shape: a module-level Map a
 * caller resolves by id at provision time, plus a `registerRecipe` seam so a
 * host can add recipes parsed from its own `.md` (`parseRecipeManifest`)
 * without editing this package. Re-registering an id overrides it — last write
 * wins, so a host can shadow a builtin.
 */

import { BUILTIN_RECIPES } from "./builtins.js"
import type { ProvisionRecipe, RecipeMethod } from "./types.js"

const _registry = new Map<string, ProvisionRecipe>()
for (const r of BUILTIN_RECIPES) _registry.set(r.id, r)

export function registerRecipe(recipe: ProvisionRecipe): void {
  _registry.set(recipe.id, recipe)
}

export function getRecipe(id: string): ProvisionRecipe | undefined {
  return _registry.get(id)
}

export function listRecipes(): ProvisionRecipe[] {
  return [..._registry.values()]
}

export function listRecipeIds(): string[] {
  return [..._registry.keys()]
}

/**
 * Resolve a recipe + one of its methods. `methodId` selects among the recipe's
 * flavors; omitted picks the first (default). Throws a caller-friendly error
 * naming the available methods when the id is unknown or ambiguous.
 */
export function resolveRecipeMethod(
  id: string,
  methodId?: string,
): { recipe: ProvisionRecipe; method: RecipeMethod } {
  const recipe = getRecipe(id)
  if (!recipe) {
    throw new Error(
      `unknown provider '${id}' — known: ${listRecipeIds().join(", ") || "(none)"}`,
    )
  }
  if (!methodId) {
    return { recipe, method: recipe.methods[0] }
  }
  const method = recipe.methods.find((m) => m.id === methodId)
  if (!method) {
    throw new Error(
      `provider '${id}' has no method '${methodId}' — methods: ${recipe.methods
        .map((m) => m.id)
        .join(", ")}`,
    )
  }
  return { recipe, method }
}
