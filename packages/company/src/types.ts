/**
 * AIP-6 CompanyDefinition + CompanyHandle.
 *
 * `CompanyDefinition` was generated from
 * `resources/aip-6/draft/COMPANY.schema.json` via json-schema-to-typescript.
 * `CompanyHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of any agentcompanies/v1 doctype file. The `doctype` field discriminates between company / role / objective; each branch enforces the doctype-specific shape. Operator doctype is sketched here but the normative definition lives in AIP-8 — only company / role / objective are normative under AIP-6.
 */
export type CompanyDefinition = {
  /**
   * Format identifier. MUST be the literal string `agentcompanies/v1`.
   */
  schema: "agentcompanies/v1"
  /**
   * Discriminator. Selects the doctype-specific branch under `oneOf`.
   */
  doctype: "company" | "role" | "objective"
  /**
   * Slug identifier. Lowercase, digits, dashes. Stable across renames; references use this, never database IDs.
   */
  id: string
  /**
   * Spec version of THIS file. Bump on breaking change.
   */
  version?: string
  /**
   * Human-readable display name.
   */
  name?: string
  /**
   * One-paragraph purpose.
   */
  description?: string
  tags?: string[]
  /**
   * Vendor-specific extensions. Authors stash hints under namespaced keys `metadata.<vendor>.…`; other readers MUST tolerate unknown keys.
   */
  metadata?: {
    [k: string]: unknown
  }
} & (Company | Role | Objective)

export interface Company {
  doctype: "company"
  /**
   * One-paragraph mission. Read by every operator at boot.
   */
  mission: string
  /**
   * Short value statements; surfaced in role prompts.
   */
  values?: string[]
  structure?: {
    /**
     * Slugs of the company's seats — each typically materialized as an operator under `operators/<slug>/OPERATOR.md`. A position is a seat one operator holds; several positions may share one AIP-47 catalog role. See AIP-47 §Role vs Position vs Access role.
     */
    positions?: string[]
    /**
     * @deprecated Alias of `positions`. Readers accept both; `positions` wins. Use `companyPositions()` to read.
     */
    roles?: string[]
    /**
     * Slugs of top-level objectives defined under `objectives/<slug>/OBJECTIVE.md`.
     */
    objectives?: string[]
    /**
     * Map of position-slug → position-slug expressing the reporting tree. The key reports to the value. Positions not in the map are top-level.
     */
    reports_to?: {
      [k: string]: string | undefined
    }
  }
  /**
   * External roles or objectives pulled from a registry. Resolved by the adapter at load time.
   */
  imports?: Import[]
}
export interface Import {
  /**
   * Source ref. Format: `<registry>/<package>@<version>` or a relative path.
   */
  from: string
  /**
   * Imported doctype.
   */
  as: "role" | "objective"
  /**
   * Local slug to bind the import under.
   */
  id?: string
  /**
   * Override the import's local slug if it would collide.
   */
  alias?: string
}
export interface Role {
  doctype: "role"
  /**
   * One-paragraph statement of what this role is responsible for. Defines the role's bounded autonomy.
   */
  mandate: string
  /**
   * Slug of the parent role. Omit for top-level roles.
   */
  reports_to?: string
  scope?: {
    /**
     * Free-text list of resource classes this role owns (e.g. `outbound-email`, `q3-pipeline`).
     */
    owns?: string[]
    /**
     * Capability slugs the role grants — referenced by AIP-7 governance and AIP-8 operators.
     */
    capabilities?: string[]
  }
  /**
   * Slugs of objectives this role pursues. Each MUST resolve to an `objectives/<slug>/OBJECTIVE.md`.
   */
  objectives?: string[]
  /**
   * Slugs of AIP-14 tools the role may call. Adapter resolves against the host's tool catalog.
   */
  tools?: string[]
  /**
   * Slugs of AIP-15 workflows the role may execute.
   */
  workflows?: string[]
}
export interface Objective {
  doctype: "objective"
  /**
   * One-paragraph statement of the desired outcome.
   */
  statement: string
  /**
   * Slug of the role accountable for this objective.
   */
  owner?: string
  /**
   * Time horizon. Adapter MAY use this to surface stale objectives.
   */
  horizon?: "sprint" | "quarter" | "year" | "ongoing"
  status?: "proposed" | "active" | "paused" | "achieved" | "abandoned"
  key_results?: {
    id: string
    statement: string
    target?: string
    progress?: number
  }[]
  /**
   * Slug of the parent objective (for decomposition trees). Omit for top-level objectives.
   */
  parent?: string
  /**
   * Slugs of child sub-objectives. Adapter validates the parent/children edges agree.
   */
  children?: string[]
  /**
   * Slugs of objectives this one depends on.
   */
  depends_on?: string[]
}

export type CompanyHandle = Readonly<CompanyDefinition>
