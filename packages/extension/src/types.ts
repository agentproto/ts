/**
 * AIP-40 ExtensionDefinition + ExtensionHandle.
 *
 * `ExtensionDefinition` was generated from
 * `resources/aip-40/draft/EXTENSION.schema.json` via json-schema-to-typescript.
 * `ExtensionHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-40 EXTENSION.md manifest. An extension declares a workspace-local doctype that inherits a public AIP's schema and may add fields, tighten constraints, set defaults, and override the path convention.
 */
export interface ExtensionDefinition {
  /**
   * Pins the spec version this manifest conforms to.
   */
  schema: "agentproto/extension/v1"
  /**
   * Namespaced identifier — `<namespace>:<name>`. Lowercase, digits, dashes; single colon separator. Example: `acme:deal`.
   */
  slug: string
  /**
   * Human-readable display name.
   */
  title: string
  /**
   * One-paragraph statement of the extension's purpose.
   */
  description: string
  /**
   * Extension's own semver. Bump on breaking change.
   */
  version: string
  /**
   * Extensions are perpetually Local — they never enter the public registry's Draft/Review/Final lifecycle.
   */
  status: "Local"
  /**
   * Parent AIP this extension inherits from, or `none` for a root doctype.
   */
  extends: string | "none"
  /**
   * Schema-level additions: new properties + new required entries.
   */
  add_fields?: {
    /**
     * JSON Schema property definitions to merge into the parent's properties. Collisions are an error — use `tighten` to narrow an existing field.
     */
    properties?: {
      [k: string]: unknown
    }
    /**
     * Field names that become required in addition to parent's required[]. Unioned with parent's required, never replaces.
     */
    required?: string[]
  }
  /**
   * Per-field constraint overrides. Each entry MUST tighten (not loosen) the parent's constraints; runtimes verify monotonicity at registration.
   */
  tighten?: {
    [k: string]: {
      pattern?: string
      enum?: unknown[]
      minLength?: number
      maxLength?: number
      minimum?: number
      maximum?: number
    }
  }
  /**
   * Default values applied when a field is omitted. Layered on top of parent's defaults; extension's value wins on the same key.
   */
  defaults?: {
    [k: string]: unknown
  }
  /**
   * Filesystem convention template, e.g. `"deals/<slug>/DEAL.md"`. Tokens: `<slug>` (doctype identity), `<DOCTYPE>` (extension's slug name part). Falls back to parent's convention when omitted.
   */
  path_convention?: string
  /**
   * Parent property names this extension REMOVES from the inherited
   * schema. GUARDED: a field in the parent's `required[]` MUST NOT be
   * removed (removing it would invalidate parent-validated instances;
   * mirrors AIP-18's "children MUST NOT remove an inherited status").
   * Runtimes MUST refuse registration when the guard is violated.
   */
  remove_fields?: string[]
  /**
   * Per-aspect selection — choose which aspects of the parent compose,
   * instead of v1's wholesale merge. Omitted keys default to true
   * (backwards compatible with v1: wholesale inheritance).
   */
  inherit?: {
    /** Inherit the parent's schema (minus `remove_fields`). Default true. */
    schema?: boolean
    /** Layer the parent's defaults under the extension's. Default true. */
    defaults?: boolean
    /** Reuse the parent's manifest parser. When false, the extension MUST supply its own parser at registration. Default true. */
    parse?: boolean
    /** Fall back to the parent's pathOf. When false, `path_convention` becomes REQUIRED. Default true. */
    path?: boolean
  }
  /**
   * Public AIPs the extension depends on, in addition to its parent.
   */
  requires?: number[]
  /**
   * Free-form vendor extensions under namespaced keys (`metadata.<vendor>.<field>`).
   */
  metadata?: {
    [k: string]: unknown
  }
}

export type ExtensionHandle = Readonly<ExtensionDefinition>
