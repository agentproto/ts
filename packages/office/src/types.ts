/**
 * AIP-22 OfficeDefinition + OfficeHandle.
 *
 * `OfficeDefinition` was generated from
 * `resources/aip-22/draft/OFFICE.schema.json` via json-schema-to-typescript.
 * `OfficeHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-22 OFFICE.md (workspace root or per-context view). The single doctype 'office.workspace/v1' is used in both modes; the host distinguishes by checking whether `extends` is set. Per-item-kind schemas are delegated to AIP-18 (COLLECTION.md / ITEM.md).
 */
export type OfficeDefinition = {
  [k: string]: unknown
} & {
  /**
   * Discriminator for the AIP-22 workspace doctype.
   */
  schema: "office.workspace/v1"
  /**
   * Stable kebab-case identifier for the company or view.
   */
  name: string
  /**
   * Human-readable company title.
   */
  title: string
  /**
   * One-paragraph statement of purpose: what this company is, who it serves.
   */
  description: string
  /**
   * Semantic version of the WORKSPACE shape. Bump on collection / orgTree / lint / defaults changes. Independent of the company's content version.
   */
  version: string
  /**
   * OPTIONAL — relative path to a parent OFFICE.md. Presence makes the manifest a VIEW; absence makes it a WORKSPACE ROOT. Recursive composition; maximum chain depth is 8.
   */
  extends?: string
  /**
   * OPTIONAL — list of consumers this VIEW adapts the company for. Hosts MUST refuse the view if any binding does not resolve. Not inherited; views declare their own scope.
   */
  appliesTo?: string[]
  /**
   * Organisation identity fields. Each leaf field independently overridable via merge; a divisional view MAY narrow `jurisdiction` while inheriting `mission` from the parent.
   */
  identity?: {
    /**
     * OPTIONAL — registered legal name of the entity, if it differs from the title.
     */
    legalName?: string
    /**
     * OPTIONAL — ws:// ref to the legal entity OFFICE.md (self-ref if this manifest IS the legal entity; parent ref if this is a subsidiary view).
     */
    legalEntity?: string
    /**
     * OPTIONAL — ISO 3166-1 alpha-2 country code for primary jurisdiction (e.g. US, FR, DE, GB).
     */
    jurisdiction?: string
    /**
     * OPTIONAL — ISO 8601 date the entity was founded.
     */
    foundedAt?: string
    /**
     * OPTIONAL — one-paragraph mission statement.
     */
    mission?: string
    /**
     * OPTIONAL — ISO 4217 default currency code (e.g. USD, EUR, GBP).
     */
    defaultCurrency?: string
    /**
     * OPTIONAL — tax / VAT identifier.
     */
    taxId?: string
  }
  /**
   * OPTIONAL — AIP-9 default org-level operator. The host activates this operator for company-level prompts when no more-specific operator applies.
   */
  executor?: string
  /**
   * OPTIONAL — AIP-7 policy or audit binding. May be a path to an AIP-7 policy file or a ws:// ref. Org-level approvals (role creation, reporting reassignment, jurisdiction change) flow through this ref. Subject to the office_signing_downgrade one-way switch when the bound policy declares signing.required=true.
   */
  governance?: string
  /**
   * OPTIONAL — AIP-20 work tracker the company runs. Cross-references on items resolve against the bound work workspace by default.
   */
  work?: string
  /**
   * OPTIONAL — AIP-21 agency context. Set when the company also operates as a commercial agency selling services to external counterparties.
   */
  agency?: string
  /**
   * OPTIONAL — AIP-10 KNOWLEDGE.md ref. The institutional wiki — runbooks, onboarding docs, decision logs.
   */
  knowledge?: string
  /**
   * OPTIONAL — AIP-12 active playbook governing culture, values, and operating rhythm.
   */
  playbook?: string
  /**
   * Collections enabled by this organisation. Three forms supported: inline (full COLLECTION.md frontmatter), file ref, or registry import. Merge-by-effective-name (alias if set, otherwise the collection's name) across the extends chain.
   */
  collections?: CollectionEntry[]
  /**
   * Org-tree declaration — the AIP-22 distinctive concept. Containment governs the structural tree; reporting governs the authority graph.
   */
  orgTree?: {
    /**
     * Org-tree containment axis. AIP-22's distinctive concept: which collection kinds nest under which, how deep the tree goes.
     */
    containment?: {
      /**
       * Whether org-tree containment is active. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false (would orphan items). Refusal: office_orgtree_disable (HARD).
       */
      enabled?: boolean
      /**
       * Item field name carrying the org-parent ref. Defaults to AIP-18's universal-ish 'parent'.
       */
      field?: string
      /**
       * OPTIONAL containment rules.
       */
      rules?: {
        /**
         * OPTIONAL — collection names that participate in the org tree. Items in collections NOT listed here are outside the tree (e.g. policies, objectives) and must not carry containment refs.
         */
        allowedKinds?: string[]
        /**
         * OPTIONAL — containment matrix. Keys are CHILD collection names; values are arrays of allowed PARENT collection names. The host enforces this at item-write time. Per-item violations: office_orgtree_invalid_parent_kind (HARD).
         */
        allowedParentKinds?: {
          [k: string]: string[]
        }
        /**
         * OPTIONAL — maximum org-tree depth. ONE-WAY SWITCH on widening: once set at any ancestor, descendants may narrow (smaller value) but MUST NOT widen. Refusal: office_orgtree_depth_widen (HARD).
         */
        maxDepth?: number
      }
    }
    /**
     * Reporting / authority graph. Logically separate from containment; a role's manager is independent from its containment parent.
     */
    reporting?: {
      /**
       * Whether the reporting graph is active. When false, the host does not validate reportsTo refs.
       */
      enabled?: boolean
      /**
       * Item field name carrying the reporting (manager) ref. Distinct from the containment field — a role's manager is logically separate from its containment parent.
       */
      field?: string
      /**
       * Reporting cardinality. 'single' (typical) = one manager per role; 'multiple' = matrixed (role MAY report to multiple managers, the field becomes an array).
       */
      cardinality?: "single" | "multiple"
      /**
       * Reporting graph constraints.
       */
      rules?: {
        /**
         * Collection name the report target MUST resolve to. Typically 'role' (a role reports to another role). The host MUST refuse a reportsTo ref pointing at a different kind.
         */
        mustResolveTo?: string
        /**
         * Whether reporting cycles are banned. Default true. The host MUST walk the reportsTo chain on every write and refuse a write that would close a cycle (office_orgtree_circular_report, HARD).
         */
        circularBan?: boolean
      }
    }
  }
  /**
   * Workspace-spanning lints. Merge-by-id vs parent.
   */
  lints?: {
    /**
     * Stable kebab-case lint id. Merge key when composing with extends parent.
     */
    id: string
    /**
     * Workspace-spanning lint algorithm. AIP-18 per-collection lints (missing-owner, overdue, required-field, etc.) live on COLLECTION.md and are NOT redeclared here. 'custom' delegates to a host-defined check identified by `id`.
     */
    kind: "orphan-role" | "broken-report" | "missing-manager" | "unassigned-objective" | "stale-objective" | "custom"
    /**
     * Lint severity. Children may soften; governance policies MAY forbid softening below `error`.
     */
    severity: "error" | "warn" | "info"
    /**
     * Kind-specific parameters. e.g. { collections: [role] } for orphan-role; { days: 30 } for stale-objective.
     */
    params?: {
      [k: string]: unknown
    }
  }[]
  /**
   * Routine workflow defaults. Composes with AIP-15.
   */
  defaults?: {
    /**
     * OPTIONAL — default AIP-15 WORKFLOW.md path or ref. Routine workflow run against company items (e.g. monthly reporting-graph integrity sweep).
     */
    workflow?: string
    /**
     * Approval class for mutations. 'auto' = no gate; 'always' = every mutation requires approval; 'on-mutate' = approval on field-level mutations; 'policy:<ref>' = delegate to an AIP-7 policy.
     */
    approvalClass?: string
    /**
     * Whether mutations are audited. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false. Refusal: office_audit_downgrade (HARD).
     */
    auditMutations?: boolean
  }
  /**
   * Display hints for UIs that render the company. Runtime-agnostic.
   */
  display?: {
    /**
     * OPTIONAL — id of the item to use as the company landing page (e.g. a top-level department or the founder role).
     */
    homePage?: string
    /**
     * Default grouping for list views.
     */
    defaultGrouping?: "kind" | "department" | "parent"
    /**
     * Default rendering mode. 'tree' is the typical pick — org charts render naturally as trees.
     */
    defaultView?: "list" | "tree" | "board"
  }
  /**
   * Vendor-specific extensions, namespaced under <vendor>. Deep-merged across the extends chain. MUST NOT change the meaning of any spec field.
   */
  metadata?: {
    [k: string]: unknown
  }
}
/**
 * One collection declaration. Either an inline AIP-18 collection schema, or a ref (path or ws:// URI) optionally aliased and version-pinned.
 */
export type CollectionEntry = CollectionInline | CollectionRef
/**
 * Full AIP-18 collection.schema/v1 frontmatter, parsed in-place. The host registers the collection directly via AIP-18's defineCollection without loading a separate file.
 */
export type Schema = {
  [k: string]: unknown
} & {
  /**
   * Discriminator for a collection definition.
   */
  schema: "collection.schema/v1"
  /**
   * Stable kebab-case identifier. Items reference this name via their `collection:` field.
   */
  name: string
  /**
   * Human-readable collection title.
   */
  title: string
  /**
   * One-paragraph statement of purpose: what this collection captures and when an item belongs here vs another collection.
   */
  description: string
  /**
   * Semantic version of the SHAPE. Bump on field/status/lint changes. Independent of the collection's content.
   */
  version: string
  /**
   * OPTIONAL — relative path to a parent COLLECTION.md. Recursive composition; maximum chain depth is 8.
   */
  extends?: string
  /**
   * OPTIONAL — list of consumers this collection adapts for. Hosts MUST refuse if any binding does not resolve. Not inherited; each child declares its own scope.
   */
  appliesTo?: string[]
  /**
   * Item field schema. Merge-by-name vs parent: a child entry with the same `name` replaces the parent's (subject to type-drift refusal); new names are appended.
   */
  fields?: FieldDef[]
  /**
   * Status state machine. Merge-by-id vs parent. Children may add statuses, mark inherited statuses terminal, or narrow `transitionsTo`; they MUST NOT remove an inherited status.
   */
  statuses?: {
    /**
     * Stable kebab-case status id. Merge key when composing.
     */
    id: string
    /**
     * Human-readable status label.
     */
    label: string
    /**
     * Whether items in this status are considered closed. Lints like `overdue` typically skip terminal statuses.
     */
    terminal?: boolean
    /**
     * OPTIONAL — allowed next status ids. If omitted, all transitions are permitted.
     */
    transitionsTo?: string[]
  }[]
  /**
   * OPTIONAL — default status assigned to new items. MUST refer to a status declared (locally or inherited) by this collection.
   */
  initialStatus?: string
  /**
   * Ownership rules. Each leaf field overrides independently across the chain.
   */
  ownership?: {
    /**
     * How many owners an item may carry. `none` = no ownership concept; `single` = one owner; `multiple` = list of owners.
     */
    cardinality?: "none" | "single" | "multiple"
    /**
     * Item field name that holds the owner ref.
     */
    role?: string
    /**
     * Whether items MUST declare an owner.
     */
    required?: boolean
  }
  /**
   * Deadline rules. Each leaf field overrides independently.
   */
  deadline?: {
    /**
     * Deadline shape. `none` = no deadline concept; `target-date` = single date; `window` = start+end; `recurrent` = repeating.
     */
    kind?: "none" | "target-date" | "window" | "recurrent"
    /**
     * Whether items MUST declare a deadline value.
     */
    required?: boolean
    /**
     * Item field name that holds the deadline value.
     */
    fieldName?: string
  }
  /**
   * Lint rules. Merge-by-id vs parent.
   */
  lints?: {
    /**
     * Stable kebab-case lint id. Merge key when composing.
     */
    id: string
    /**
     * Lint algorithm. `custom` delegates to a host-defined check identified by `id`.
     */
    kind: "missing-owner" | "overdue" | "orphan" | "broken-ref" | "stale" | "required-field" | "custom"
    /**
     * Always '*' — items belong to one collection, so the lint always applies to all items of this collection. The field is preserved for symmetry with AIP-10's lint shape.
     */
    appliesTo: "*"
    /**
     * Lint severity. Children may soften; governance policies MAY forbid softening below `error`.
     */
    severity: "error" | "warn" | "info"
    /**
     * Kind-specific parameters. e.g. { days: 30 } for `stale`; { field: 'severity' } for `required-field`.
     */
    params?: {
      [k: string]: unknown
    }
  }[]
  /**
   * Item identity & filing rules.
   */
  identity?: {
    /**
     * How to derive an item's slug. Either a field name (e.g. 'title'), the literal 'random', the literal 'sequence', or 'hash:<comma-separated-source-fields>' (e.g. 'hash:title,createdAt').
     */
    slugSource?: string
    /**
     * Template for where items are filed on disk. Tokens: {collection}, {slug}, {year}, {month}. e.g. 'items/{collection}/{slug}.md'.
     */
    filingPath?: string
  }
  /**
   * Vendor-specific extensions, namespaced under <vendor>. Deep-merged across the extends chain.
   */
  metadata?: {
    [k: string]: unknown
  }
}

/**
 * Inline collection declaration. Full AIP-18 schema embedded; hosts MUST validate it against the AIP-18 COLLECTION schema before registration.
 */
export interface CollectionInline {
  inline: Schema
}
/**
 * Definition of one field on a collection's item schema. Merge-by-name. Type drift between parent and child is HARD refused.
 */
export interface FieldDef {
  /**
   * kebab-or-camel-case field name. Merge key when composing.
   */
  name: string
  /**
   * Field type. Drift across composition (parent string -> child number) is HARD refused (`collection_field_type_drift`).
   */
  type: "string" | "number" | "boolean" | "enum" | "date" | "datetime" | "text" | "url" | "ref" | "array"
  /**
   * Whether items MUST declare this field. A child may narrow false -> true; loosening true -> false is permitted (it removes a constraint without invalidating instances).
   */
  required?: boolean
  /**
   * Prose describing what the field captures.
   */
  description?: string
  /**
   * Required when type=enum. Children may narrow to a subset; widening to a superset is permitted (it does not invalidate instances).
   */
  enum?: string[]
  items?: FieldDef1
  /**
   * Required when type=ref. The target collection's `name`. Hosts validate that ref values point at items of this collection.
   */
  refKind?: string
  /**
   * OPTIONAL regex constraint. Only valid when type=string.
   */
  pattern?: string
  /**
   * OPTIONAL minimum. For type=number: minimum value. For type=array: minimum length.
   */
  min?: number
  /**
   * OPTIONAL maximum. For type=number: maximum value. For type=array: maximum length.
   */
  max?: number
  /**
   * OPTIONAL named format. Common values: email, uri, semver, uuid, slug. Only valid when type=string. Hosts MAY interpret unknown formats as advisory.
   */
  format?: string
  /**
   * OPTIONAL deprecation flag. A child may set false to mark an inherited field deprecated; the host preserves the field in the resolved schema (so existing items still validate) but flags new uses via lint. Setting enabled:false on a field a child does not inherit is invalid.
   */
  enabled?: boolean
}
/**
 * Required when type=array. Recursive shape — describes the inner item type.
 */
export interface FieldDef1 {
  /**
   * kebab-or-camel-case field name. Merge key when composing.
   */
  name: string
  /**
   * Field type. Drift across composition (parent string -> child number) is HARD refused (`collection_field_type_drift`).
   */
  type: "string" | "number" | "boolean" | "enum" | "date" | "datetime" | "text" | "url" | "ref" | "array"
  /**
   * Whether items MUST declare this field. A child may narrow false -> true; loosening true -> false is permitted (it removes a constraint without invalidating instances).
   */
  required?: boolean
  /**
   * Prose describing what the field captures.
   */
  description?: string
  /**
   * Required when type=enum. Children may narrow to a subset; widening to a superset is permitted (it does not invalidate instances).
   */
  enum?: string[]
  items?: FieldDef1
  /**
   * Required when type=ref. The target collection's `name`. Hosts validate that ref values point at items of this collection.
   */
  refKind?: string
  /**
   * OPTIONAL regex constraint. Only valid when type=string.
   */
  pattern?: string
  /**
   * OPTIONAL minimum. For type=number: minimum value. For type=array: minimum length.
   */
  min?: number
  /**
   * OPTIONAL maximum. For type=number: maximum value. For type=array: maximum length.
   */
  max?: number
  /**
   * OPTIONAL named format. Common values: email, uri, semver, uuid, slug. Only valid when type=string. Hosts MAY interpret unknown formats as advisory.
   */
  format?: string
  /**
   * OPTIONAL deprecation flag. A child may set false to mark an inherited field deprecated; the host preserves the field in the resolved schema (so existing items still validate) but flags new uses via lint. Setting enabled:false on a field a child does not inherit is invalid.
   */
  enabled?: boolean
}
/**
 * Collection ref declaration. Either a file path (./.. /COLLECTION.md) or a registry URI (ws://collections/<slug>).
 */
export interface CollectionRef {
  /**
   * Either a relative path to a COLLECTION.md (file ref) or a ws://collections/<slug> URI (registry import). The host loads the referenced collection via AIP-18 and registers it under its name (or the alias, if set).
   */
  ref: string
  /**
   * OPTIONAL — workspace-local name to expose the collection under. Items in this organisation reference the alias, not the upstream name. Two collections resolving to the same effective name (alias or upstream) is a HARD failure: office_collection_alias_conflict.
   */
  alias?: string
  /**
   * OPTIONAL — semver range (e.g. "1.x", "^1.2", "1.2.0"). When set, schema bumps outside the range fail with collection_item_schema_pinned_drift (HARD) at item load time.
   */
  version?: string
}

export type OfficeHandle = Readonly<OfficeDefinition>
