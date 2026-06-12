/**
 * Provision-recipe doctype — types.
 *
 * A recipe declares, for one credential provider (claude-code-oauth, codex,
 * gemini, …), WHERE its credential lives on an origin machine and WHICH auth
 * method id it installs as. It is the manifest the `provision` flow resolves
 * against so a caller writes `--provider codex` instead of hand-passing
 * `--from-file / --json-path / --method`.
 *
 * A recipe holds LOCATIONS, never VALUES — the schema forbids a `value` field
 * so nobody can stuff a live secret into a recipe. The plaintext is read only
 * at provision time, sealed immediately, and never printed.
 *
 * Hand-written (not scaffold-aip-generated): a recipe is AIP-19-adjacent
 * config, not yet a numbered spec artifact. If it earns its own AIP later,
 * promote `schema.ts` to a generated frontmatter schema then.
 */

/**
 * Where a method's credential is read on the origin machine. Discriminated by
 * the present key; exactly one of file / env / prompt.
 *
 *  - file   read a file (`~` expands); optionally extract a JSON string field.
 *  - env    read a process env var.
 *  - prompt read interactively (e.g. a website password for a remote browser);
 *           never on disk, never logged. Needs an injected prompt impl.
 */
export type CredentialSourceSpec =
  | { file: string; jsonPath?: string }
  | { env: string }
  | { prompt: string }

/** One installable flavor of a provider's credential. The first method in a
 *  recipe is the default when `--method` is omitted. */
export interface RecipeMethod {
  /** Auth-method id this flavor installs as (e.g. "subscription-token",
   *  "api-key"). Becomes the vault connector's methodId. */
  id: string
  /** Human label for this flavor; falls back to the recipe label. */
  label?: string
  /** Where to read the credential for this flavor. */
  source: CredentialSourceSpec
}

export interface ProvisionRecipeDefinition {
  /** Provider id — kebab/dot, 2–80 chars (the cross-AIP id pattern). */
  id: string
  /** LLM/human-facing prose; ≤2000 chars. */
  description: string
  /** Installable flavors; ≥1, first = default. */
  methods: [RecipeMethod, ...RecipeMethod[]]
  /** Default connector label; a method's own label overrides. */
  label?: string
}

export type ProvisionRecipe = Readonly<ProvisionRecipeDefinition>
