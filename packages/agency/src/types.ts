/**
 * AIP-21 AgencyV2Definition + AgencyV2Handle.
 *
 * `AgencyV2Definition` was generated from
 * `resources/aip-21/draft/AGENCY.schema.json` via json-schema-to-typescript.
 * `AgencyV2Handle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-21 AGENCY.md (workspace root or per-context view). The single doctype 'agency.workspace/v2' is used in both modes; the host distinguishes by checking whether `extends` is set. Per-doctype schemas (service, engagement, agreement, deliverable, invoice, counterparty, procedure, pricing-model, routine, capacity) are delegated to AIP-18 (COLLECTION.md / ITEM.md).
 */
export type AgencyV2Definition = {
  [k: string]: unknown
} & {
  /**
   * Discriminator for the AIP-21 workspace doctype.
   */
  schema: "agency.workspace/v2"
  /**
   * Stable kebab-case identifier for the agency or view.
   */
  name: string
  /**
   * Human-readable agency title.
   */
  title: string
  /**
   * One-paragraph statement of purpose: what this agency does and who it serves.
   */
  description: string
  /**
   * Semantic version of the WORKSPACE shape. Bump on collection / scope / lifecycle / lint / defaults changes. Independent of the agency's content version.
   */
  version: string
  /**
   * OPTIONAL — relative path to a parent AGENCY.md. Presence makes the manifest a VIEW; absence makes it a WORKSPACE ROOT. Recursive composition; maximum chain depth is 8.
   */
  extends?: string
  /**
   * OPTIONAL — list of consumers this VIEW adapts the agency for. Hosts MUST refuse the view if any binding does not resolve. Not inherited; views declare their own scope.
   */
  appliesTo?: string[]
  /**
   * Commercial-flavored identity block. All fields optional; agencies operating as a sole operator with no counterparty billing may omit the block entirely.
   */
  identity?: {
    /**
     * OPTIONAL — AIP-6 ref to the company that legally signs agreements and issues invoices. When set, hosts SHOULD resolve this ref to populate legalName and taxId from the AIP-6 record.
     */
    legalEntity?: string
    /**
     * OPTIONAL — display string for the legal entity name. Used when legalEntity is absent or to override the AIP-6 record's legalName.
     */
    legalName?: string
    /**
     * OPTIONAL — tax identifier (VAT, EIN, GST, etc.). Hosts MUST treat this string as opaque; format validation belongs to per-jurisdiction tooling.
     */
    taxId?: string
    /**
     * OPTIONAL — primary jurisdiction the agency operates under, as ISO 3166-1 alpha-2 (e.g. FR, US, GB, DE).
     */
    jurisdiction?: string
    /**
     * OPTIONAL — default currency for new invoices, as ISO 4217 (e.g. EUR, USD, GBP). Per-engagement overrides take precedence.
     */
    defaultCurrency?: string
  }
  /**
   * OPTIONAL — AIP-9 default executor operator. The host activates this operator when an item with no explicit assignee surfaces.
   */
  executor?: string
  /**
   * OPTIONAL — AIP-7 policy or audit binding. May be a path to an AIP-7 policy file or a ws:// ref. Status-transition approvals, signature gates on agreements, and audit log routing flow through this ref. Agreements MUST be signed; the default policy lives here.
   */
  governance?: string
  /**
   * OPTIONAL — AIP-10 KNOWLEDGE.md ref. Wiki this agency refers to (case studies, prior-art, methodology).
   */
  knowledge?: string
  /**
   * OPTIONAL — AIP-20 work workspace binding. Items in `deliverable` MAY be tracked as work items in the bound workspace.
   */
  work?: string
  /**
   * OPTIONAL — AIP-12 active playbook. Governs the routine plays this agency runs.
   */
  playbook?: string
  /**
   * OPTIONAL — AIP-6 companies root. Resolution root for `counterparty` items: a counterparty's companyRef resolves under this binding.
   */
  companies?: string
  /**
   * Collections enabled by this agency. Three forms supported: inline (full COLLECTION.md frontmatter), file ref, or registry import. Merge-by-effective-name (alias if set, otherwise the collection's name) across the extends chain.
   */
  collections?: CollectionEntry[]
  /**
   * Engagement lifecycle helpers — workspace-level rules for cross-collection state propagation. The AIP-21 distinctive contribution.
   */
  lifecycle?: {
    /**
     * Whether cross-collection lifecycle propagation is active. When false, no lifecycle rules fire — items keep their stored statuses regardless of related items.
     */
    enabled?: boolean
    /**
     * Cross-collection lifecycle rules. Merge-by-id vs parent. Hosts MUST detect graph cycles in the (forCollection, sourceCollection) edge set and refuse with agency_lifecycle_cycle (HARD).
     */
    rules?: {
      /**
       * Stable kebab-case rule id. Merge key when composing across extends.
       */
      id: string
      /**
       * Predicate id from the recognised vocabulary. Custom predicates are host-defined keyed by `id`.
       */
      when: string
      /**
       * Effective name of the collection whose items receive the bubbled status. MUST appear in the workspace's merged collections array.
       */
      forCollection: string
      /**
       * Status id to set on the target item when the predicate holds. MUST exist on the forCollection's state machine.
       */
      bubbleStatus: string
      /**
       * Predicate parameters. Common keys: sourceCollection (collection whose items the predicate inspects), linkField (field on source items pointing at the target), terminalStatuses (subset of terminal statuses to count), statusEquals (specific status to match).
       */
      params?: {
        [k: string]: unknown
      }
    }[]
  }
  /**
   * Workspace-level scope axes — three orthogonal axes (containment / applicability / ownership) declared once per agency.
   */
  scope?: {
    /**
     * Containment axis (parent/child).
     */
    containment?: {
      /**
       * Whether the containment axis is active. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false (would orphan items). Refusal: agency_scope_disable (HARD).
       */
      enabled?: boolean
      /**
       * Item field name carrying the containment ref.
       */
      field?: string
      /**
       * OPTIONAL containment constraints.
       */
      rules?: {
        /**
         * OPTIONAL — collection names allowed as containment parents.
         */
        allowedKinds?: string[]
        /**
         * OPTIONAL — maximum containment depth.
         */
        maxDepth?: number
      }
    }
    /**
     * Applicability axis (who the item is about / scoped to).
     */
    applicability?: {
      /**
       * Whether the applicability axis is active.
       */
      enabled?: boolean
      /**
       * Item field name carrying the applicability ref list.
       */
      field?: string
      /**
       * Class of refs the field accepts. Recognised classes: client, market, service, company, role, role-and-company, operator. ONE-WAY SWITCH: once set at any ancestor, descendants MUST NOT change. Refusal: agency_scope_value_class_drift (HARD).
       */
      valueClass?: string
    }
    /**
     * Ownership axis (who is doing the item).
     */
    ownership?: {
      /**
       * Whether the ownership axis is active.
       */
      enabled?: boolean
      /**
       * Workspace-level default item field name carrying the ownership ref.
       */
      field?: string
      /**
       * Workspace-level ownership policy. 'strict' requires every collection's ownership.required to be true; 'inherit' delegates; 'open' permits any collection to omit ownership.
       */
      policy?: "strict" | "inherit" | "open"
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
    kind:
      | "stale-engagement"
      | "unsigned-agreement"
      | "overdue-invoice"
      | "broken-procedure-ref"
      | "orphan-across-collections"
      | "stale-tree"
      | "broken-parent-ref"
      | "scope-mismatch"
      | "custom"
    /**
     * Lint severity. Children may soften; governance policies MAY forbid softening below `error`.
     */
    severity: "error" | "warn" | "info"
    /**
     * Kind-specific parameters.
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
     * OPTIONAL — default AIP-15 WORKFLOW.md path or ref.
     */
    workflow?: string
    /**
     * Approval class for mutations. 'auto' = no gate; 'always' = every mutation requires approval; 'on-mutate' = approval on field-level mutations; 'policy:<ref>' = delegate to an AIP-7 policy.
     */
    approvalClass?: string
    /**
     * Whether mutations are audited. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false. Refusal: agency_audit_downgrade (HARD).
     */
    auditMutations?: boolean
  }
  /**
   * Engagement-specific terms (AIP-21 distinctive).
   */
  engagement?: {
    /**
     * Default commercial terms applied to new engagement and invoice items.
     */
    terms?: {
      /**
       * Whether engagement items require a corresponding agreement item. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false (commercial protection against engagements without paperwork). Refusal: agency_contract_required_downgrade (HARD).
       */
      contractRequired?: boolean
      /**
       * OPTIONAL — default payment terms for new invoices. Common values: net-15, net-30, net-60, due-on-receipt, prepaid. Custom kebab-case strings permitted.
       */
      defaultPaymentTerms?: string
      /**
       * OPTIONAL — default currency for engagement-derived invoices, as ISO 4217. Falls back to identity.defaultCurrency if unset.
       */
      defaultCurrency?: string
    }
  }
  /**
   * Display hints for UIs that render the agency. Runtime-agnostic.
   */
  display?: {
    /**
     * OPTIONAL — id of the item to use as the agency landing page.
     */
    homePage?: string
    /**
     * Default grouping for list views.
     */
    defaultGrouping?: "kind" | "status" | "counterparty" | "engagement"
    /**
     * Default rendering mode.
     */
    defaultView?: "list" | "board" | "timeline" | "dashboard"
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
 * Collection ref declaration. Either a file path or a registry URI.
 */
export interface CollectionRef {
  /**
   * Either a relative path to a COLLECTION.md (file ref) or a ws://collections/<slug> URI (registry import).
   */
  ref: string
  /**
   * OPTIONAL — workspace-local name to expose the collection under. Items in this workspace reference the alias, not the upstream name. Two collections resolving to the same effective name is a HARD failure: agency_collection_alias_conflict.
   */
  alias?: string
  /**
   * OPTIONAL — semver range (e.g. "1.x", "^1.2", "1.2.0"). When set, schema bumps outside the range fail with collection_item_schema_pinned_drift (HARD) at item load time.
   */
  version?: string
}

export type AgencyV2Handle = Readonly<AgencyV2Definition>
