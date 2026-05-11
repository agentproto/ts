/**
 * AIP-47 RoleDefinition + RoleHandle.
 *
 * `RoleDefinition` was generated from
 * `resources/aip-47/draft/ROLE.schema.json` via json-schema-to-typescript.
 * `RoleHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-47 ROLE.md manifest. Single-doc, no oneOf — every role is the same shape. The body is markdown and not validated by this schema.
 */
export interface RoleDefinition {
  /**
   * Schema dispatch tag. MUST be 'role/v1' for this version of AIP-47.
   */
  schema: "role/v1"
  /**
   * Machine identifier. Lowercase, digits, dashes. Must start with a letter, end with a letter or digit. Unique within the registry that hosts the role.
   */
  name: string
  /**
   * Human-readable display title, sentence case.
   */
  title: string
  /**
   * One-paragraph job description. The role's purpose, audience, and shape.
   */
  description: string
  /**
   * Semver. Bump on breaking change to responsibilities, KPIs, tools, or seniority.
   */
  version: string
  /**
   * Relative path to a parent ROLE.md. Triggers composition. Path MUST end in 'ROLE.md'.
   */
  extends?: string
  /**
   * Department slug. Lowercase kebab-case. Recommended values listed in AIP-47 §Departments; free-form to accept domain-specific values.
   */
  department?: string
  /**
   * Role-to-role reporting link. Conventionally a 'ws://roles/<slug>' ref. Schema does not validate scheme; the loader resolves.
   */
  reports_to?: string
  /**
   * Seniority level of the job. Operator instances inherit this; a promotion is re-binding the operator to a higher-seniority role.
   */
  seniority: "intern" | "junior" | "mid" | "senior" | "lead" | "principal" | "executive"
  /**
   * One-paragraph mission, markdown. The reason the role exists.
   */
  mission: string
  /**
   * Ordered imperative clauses. At least one. Lineage accumulates under 'extends' (append-and-dedupe).
   *
   * @minItems 1
   */
  responsibilities: [string, ...string[]]
  /**
   * Competences this role is expected to have. Append-and-dedupe across 'extends'.
   */
  capabilities?: string[]
  /**
   * AIP-14 tool refs the role declares as intended. Append-and-dedupe across 'extends'. Governance (AIP-7) gates effect.
   */
  tools?: string[]
  /**
   * AIP-3 skill refs the role expects to load. Append-and-dedupe across 'extends'.
   */
  skills?: string[]
  /**
   * Scorer slugs (forward AIP) — KPIs evaluated against operators in this role. Append-and-dedupe across 'extends'.
   */
  kpis?: string[]
  /**
   * Job-side strengths in prose. Append-and-dedupe across 'extends'.
   */
  strengths?: string[]
  /**
   * What the role explicitly does NOT do. Append-and-dedupe across 'extends'.
   */
  antiPatterns?: string[]
  /**
   * AIP-39 action ref fired on promotion INTO this role.
   */
  onPromotion?: string
  /**
   * AIP-39 action ref fired on demotion OUT of this role.
   */
  onDemotion?: string
  /**
   * AIP-39 action ref fired on first assignment of this role.
   */
  onAssign?: string
  /**
   * Cross-AIP bindings — restrict the role to specific operators. Local-only under 'extends' (NOT inherited).
   */
  appliesTo?: string[]
  /**
   * AIP-25 PERSONA ref recommended for operators adopting this role. Advisory; the operator's own 'persona' field overrides.
   */
  defaultPersona?: string
  /**
   * AIP-23 IDENTITY ref recommended for operators adopting this role. Advisory; the operator's own 'identity' field overrides.
   */
  defaultIdentity?: string
  /**
   * AIP-38 POLICY ref recommended for operators adopting this role. ADVISORY ONLY — role declares intent, policy decides effect. The runtime MUST NOT apply defaultPolicy to an operator without the operator's own 'policy:' field or a governance signature attesting the binding. See AIP-47 §Role vs Policy vs Governance.
   */
  defaultPolicy?: string
  /**
   * Catalog tags. Lowercase kebab-case. Append-and-dedupe across 'extends'.
   */
  tags?: string[]
  /**
   * Vendor extensions, namespaced under '<vendor>'. Hosts MUST tolerate unknown vendor namespaces; they MUST NOT honour metadata that overrides AIP-defined fields.
   */
  metadata?: Record<string, unknown>
}

export type RoleHandle = Readonly<RoleDefinition>
