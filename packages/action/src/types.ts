/**
 * AIP-39 ActionDefinition + ActionHandle.
 *
 * `ActionDefinition` was generated from
 * `resources/aip-39/draft/ACTION.schema.json` via json-schema-to-typescript.
 * `ActionHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-39 ACTION.md manifest. The pivot primitive: TOOL implements it, POLICY grants on it, INTENT routes to it, WORKFLOW steps invoke it.
 */
export interface ActionDefinition {
  schema: "action/v1"
  /**
   * Machine identifier. Standard format `<target-kind>:<verb>` (e.g. `storage:commit`). Single colon only; multiple colons reserved for future namespacing.
   */
  id: string
  /**
   * One-paragraph purpose, written for the LLM caller.
   */
  description: string
  /**
   * Spec version of THIS file. Bump on breaking change to mutates / risk_level.
   */
  version?: string
  /**
   * Discovery category for catalog UIs. Common: filesystem, compute, messaging, vcs, payment, auth, lifecycle.
   */
  category?: string
  /**
   * The bare verb (e.g. `commit`, `execute`). Derived from `id` after the `:` if absent.
   */
  verb?: string
  /**
   * The resource kind this action operates on (e.g. `storage`, `sandbox`, `secrets`). Derived from `id` before the `:` if absent.
   */
  target_kind?: string
  /**
   * Resources the action may modify. Inherited by implementors (TOOL, DRIVER); they MAY add more, never drop.
   */
  mutates?: string[]
  /**
   * Capability requirements gated by AIP-7 governance. Implementors MAY add to this set; MUST NOT remove.
   */
  requires?: {
    network?: string[]
    secrets?: string[]
    tools?: string[]
  }
  /**
   * Approval class. Implementors MAY narrow (`auto` → `always` → `on-mutate`); MUST NOT widen.
   */
  approval?: ("auto" | "always" | "on-mutate") | string
  /**
   * 0=read-only, 1=scoped writes, 2=external side effects, 3=irreversible. Implementors MAY raise; MUST NOT lower.
   */
  risk_level?: number
  /**
   * AIP-37 LIFECYCLE event names this action fires when invoked. Subscribers (sync layers, audit) attach to these. Implementors MAY fire more events; MUST NOT drop any declared here.
   */
  fires_events?: string[]
  /**
   * OPTIONAL discovery hint — known implementations of this action. NOT authoritative — source of truth lives on implementors via their `implements:` field. Hosts populate from scanning.
   */
  implementations?: {
    /**
     * Kind of implementation.
     */
    kind: "tool" | "driver" | "ui" | "lifecycle"
    /**
     * Reference to the implementor (TOOL.md id, DRIVER.md id, UI surface name, etc.).
     */
    ref: string
  }[]
  /**
   * Free-form discovery tags.
   */
  tags?: string[]
  /**
   * Semantic examples (NOT input/output, since action has no schema). Each `{ name, scenario, note? }`.
   */
  examples?: {
    name: string
    scenario: string
    note?: string
  }[]
  /**
   * Free-form, namespaced. Authors MAY stash adapter-specific hints under namespaced keys.
   */
  metadata?: {
    [k: string]: unknown
  }
}

export type ActionHandle = Readonly<ActionDefinition>
