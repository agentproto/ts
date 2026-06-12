/**
 * @agentproto/secrets/provision/recipe — the credential-provider recipe
 * doctype: declare WHERE a provider's credential lives locally and WHICH auth
 * method it installs as, once, so the provision flow resolves `--provider <id>`
 * instead of hand-passed source flags.
 *
 *   defineProvisionRecipe(def)     author a recipe as a TS literal
 *   parseRecipeManifest(md)        author/extend via a .md frontmatter manifest
 *   getRecipe / resolveRecipeMethod  resolve a provider (+ flavor) at call time
 *   resolveSourceSpec(source)      read the selected method's credential
 *
 * Builtins (claude-code-oauth, codex, gemini) are pre-registered. A host adds
 * its own with `registerRecipe(parseRecipeManifest(md))`.
 */

export type {
  CredentialSourceSpec,
  RecipeMethod,
  ProvisionRecipe,
  ProvisionRecipeDefinition,
} from "./types.js"
export {
  provisionRecipeFrontmatterSchema,
  recipeMethodSchema,
  credentialSourceSpecSchema,
  type ProvisionRecipeFrontmatter,
} from "./schema.js"
export { defineProvisionRecipe } from "./define-recipe.js"
export {
  parseRecipeManifest,
  parseRecipeManifestRaw,
  type ProvisionRecipeManifest,
} from "./manifest.js"
export {
  BUILTIN_RECIPES,
  claudeCodeOauthRecipe,
  codexRecipe,
  geminiRecipe,
} from "./builtins.js"
export {
  registerRecipe,
  getRecipe,
  listRecipes,
  listRecipeIds,
  resolveRecipeMethod,
} from "./registry.js"
export {
  resolveSourceSpec,
  type ResolveSourceOptions,
} from "./resolve.js"
