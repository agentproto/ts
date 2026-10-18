/**
 * AIP-20 WorkDefinition + WorkHandle.
 *
 * `WorkDefinition` was generated from
 * `resources/aip-20/draft/WORK.schema.json` via json-schema-to-typescript.
 * `WorkHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter of an AIP-20 WORK.md — the work manifest of one AIP-34 workspace node (or a coordinator scratch root). There is no view mode: `extends` and `appliesTo` are not allowed. Item schemas are AIP-18 collections extending the normative `work-item` base collection.
 */
export type WorkDefinition = {
  [k: string]: unknown
} & {
  /**
   * Discriminator for the AIP-20 work manifest.
   */
  schema: "work.workspace/v2"
  /**
   * Stable kebab-case identifier of this work root.
   */
  name: string
  /**
   * Human-readable workspace title.
   */
  title: string
  /**
   * One-paragraph statement of what this work root tracks.
   */
  description: string
  /**
   * Collections tracked in this root. Every entry MUST resolve to `work-item` or a collection extending it. Two entries with the same effective name (alias, else name) are refused (work_collection_alias_conflict).
   */
  collections?: CollectionEntry[]
  containment?: {
    /**
     * Child collection -> allowed parent collections. Empty list = no parent allowed; absent key = any enabled collection.
     */
    allowedParents?: {
      [k: string]: string[]
    }
    maxDepth?: number
  }
  statusRollup?: {
    enabled?: boolean
    /**
     * Evaluated in order, first match wins. The result is exposed as a derived `rolledCategory`, never stored as status.
     */
    rules?: {
      when: string
      category: "todo" | "active" | "waiting" | "done" | "failed" | "cancelled"
    }[]
  }
  coordination?: {
    /**
     * 0 = liveness-only leases released by the issuing host; >0 = any coordinator may release a lease not renewed for this long.
     */
    leaseTtlSeconds?: number
    /**
     * Age after which a lock file may be broken.
     */
    lockStaleSeconds?: number
  }
  lints?: {
    id: string
    kind: "orphan" | "stale" | "broken-ref" | "dangling-dependency" | "custom"
    severity: "error" | "warn" | "info"
    params?: {}
  }[]
  defaults?: {
    /**
     * OPTIONAL AIP-15 routine workflow for this root.
     */
    workflow?: string
    /**
     * Append an AIP-7 audit-event per applied write. false is allowed only for scratch roots.
     */
    auditMutations?: boolean
  }
  /**
   * Saved queries. The first is the default view.
   */
  views?: {
    id: string
    title: string
    filter?: {
      collection?: string | string[]
      status?: string | string[]
      category?:
        | ("todo" | "active" | "waiting" | "done" | "failed" | "cancelled")
        | ("todo" | "active" | "waiting" | "done" | "failed" | "cancelled")[]
      owner?: string
      parent?: string
      blocked?: boolean
      includeClosed?: boolean
    }
    groupBy?: "category" | "status" | "owner" | "parent" | "collection"
    layout?: "list" | "board" | "tree" | "timeline"
  }[]
  /**
   * OPTIONAL — AIP-9 default executor operator. The host activates this operator when an item with no explicit assignee surfaces.
   */
  executor?: string
  /**
   * OPTIONAL — AIP-7 policy or audit binding. May be a path to an AIP-7 policy file or a ws:// ref. Status-transition approvals, owner-change audits, and scope-widening interventions flow through this ref.
   */
  governance?: string
  /**
   * OPTIONAL — AIP-10 KNOWLEDGE.md ref. Lets cross-references on items resolve against the bound wiki by default.
   */
  knowledge?: string
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
     * OPTIONAL protocol class of the status. When set, `terminal` MUST be true exactly for done, failed and cancelled. Consumer AIPs (AIP-20) may require it.
     */
    category?: "todo" | "active" | "waiting" | "done" | "failed" | "cancelled"
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
 * Definition of one field on a collection's item schema (an entry in `fields[]`). Merge-by-name. Type drift between parent and child is HARD refused. Identical to `fieldShape` plus a REQUIRED `name`; keep the two property lists in sync.
 */
export type FieldDef = {
  [k: string]: unknown
} & {
  /**
   * kebab-or-camel-case field name. Merge key when composing.
   */
  name: string
  /**
   * Field type. Drift across composition (parent string -> child number) is HARD refused (`collection_field_type_drift`).
   */
  type: "string" | "number" | "boolean" | "enum" | "date" | "datetime" | "text" | "url" | "ref" | "array" | "object"
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
  items?: FieldShape
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
 * Required when type=array. Recursive shape — describes the inner item type. Carries no `name` (see `fieldShape`).
 */
export type FieldShape = {
  [k: string]: unknown
} & {
  /**
   * Field type. Drift across composition (parent string -> child number) is HARD refused (`collection_field_type_drift`).
   */
  type: "string" | "number" | "boolean" | "enum" | "date" | "datetime" | "text" | "url" | "ref" | "array" | "object"
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
  items?: FieldShape1
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
 * Required when type=array. Recursive shape — describes the inner item type. Carries no `name` (see `fieldShape`).
 */
export type FieldShape1 = {
  [k: string]: unknown
} & {
  /**
   * Field type. Drift across composition (parent string -> child number) is HARD refused (`collection_field_type_drift`).
   */
  type: "string" | "number" | "boolean" | "enum" | "date" | "datetime" | "text" | "url" | "ref" | "array" | "object"
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
  items?: FieldShape1
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
 * Inline collection declaration. Full AIP-18 schema embedded; hosts MUST validate it against the AIP-18 COLLECTION schema before registration.
 */
export interface CollectionInline {
  inline: Schema
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
   * OPTIONAL — workspace-local name to expose the collection under. Items in this workspace reference the alias, not the upstream name. Two collections resolving to the same effective name (alias or upstream) is a HARD failure: work_collection_alias_conflict.
   */
  alias?: string
  /**
   * OPTIONAL — semver range (e.g. "1.x", "^1.2", "1.2.0"). When set, schema bumps outside the range fail with collection_item_schema_pinned_drift (HARD) at item load time.
   */
  version?: string
}

export type WorkHandle = Readonly<WorkDefinition>
