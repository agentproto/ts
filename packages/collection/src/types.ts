/**
 * AIP-18 CollectionDefinition + CollectionHandle.
 *
 * `CollectionDefinition` was generated from
 * `resources/aip-18/draft/COLLECTION.schema.json` via json-schema-to-typescript.
 * `CollectionHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-18 collection schema or item. The doctype is selected via the `schema` discriminator: 'collection.schema/v1' (a COLLECTION.md, the schema for a class of records) or 'collection.item/v1' (an instance of one record validated against a named collection).
 */
export type CollectionDefinition = Schema | Item
/**
 * Collection schema doctype. Declares the shape of items (fields, statuses, ownership, deadline, lints, identity). Composes via `extends:` against another COLLECTION.md.
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
 * Definition of one field on a collection's item schema (an entry in `fields[]`). Merge-by-name. Type drift between parent and child is HARD refused. Identical to `fieldShape` plus a REQUIRED `name`; keep the two property lists in sync.
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
  /**
   * Required when type=array. Recursive shape — describes the inner item type. Carries no `name` (see `fieldShape`).
   */
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
 * Name-less field definition: the shape of an array field's `items:`. Identical to `fieldDef` minus `name` — an inner value type has no name of its own, and `name` is only meaningful (and required) for entries in `fields[]`. Keep the two property lists in sync.
 *
 * The canonical schema now generates two identical `items` types
 * (`FieldShape` for `FieldDef.items`, `FieldShape1` for its own recursive
 * `items`); collapsed here into one self-referential `FieldShape`. Unlike
 * `FieldDef`, it has no `name`.
 */
export interface FieldShape {
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
  /**
   * Required when type=array. Recursive shape — describes the inner item type. Carries no `name` (see `fieldShape`).
   */
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
 * Item instance doctype. Universal core (schema, collection, id, title) is the only set of MUST fields. Every other field shown here is OPTIONAL at the AIP-18 level — the resolved collection schema decides which become required for this collection's items. additionalProperties is true because collection-specific fields (declared in COLLECTION.md fields[]) appear flat at the item's top level.
 */
export interface Item {
  /**
   * Discriminator for an item instance.
   */
  schema: "collection.item/v1"
  /**
   * Reference to the COLLECTION.md this item validates against. Resolution order: inline (workspace root) → local file (<workspace>/collections/<name>/COLLECTION.md) → registry (ws://collections/<name>). Unresolvable → collection_unresolvable (HARD).
   */
  collection:
    | string
    | {
        name: string
        /**
         * Semver range (e.g. "1.x", "^1.2", "1.2.0"). When set, schema bumps outside the range fail with collection_item_schema_pinned_drift (HARD).
         */
        version?: string
      }
  /**
   * Unique identifier within the collection. May be kebab-case, prefixed (BUG-1234), or hashed; the collection's identity.slugSource controls how it's derived for new items.
   */
  id: string
  /**
   * Human-readable item title.
   */
  title: string
  /**
   * OPTIONAL — containment ref. May target another item or another collection.
   */
  parent?: string
  /**
   * OPTIONAL — owner ref(s). Single string or array depending on collection.ownership.cardinality.
   */
  owner?: string | string[]
  /**
   * OPTIONAL — current status. MUST be a status id declared (locally or inherited) by the collection.
   */
  status?: string
  /**
   * OPTIONAL — deadline value. Format depends on collection.deadline.kind: ISO date for target-date, ISO datetime for window, RRULE-like for recurrent. Same quoting rule as `createdAt`: producers SHOULD quote date and datetime values; consumers MAY accept a native date/timestamp.
   */
  dueAt?: string
  /**
   * OPTIONAL — list of attachment refs. Hosts resolve refs against the workspace's file registry.
   */
  attachments?: string[]
  /**
   * OPTIONAL — list of cross-references to other items, knowledge entries, or external URLs.
   */
  links?: string[]
  /**
   * OPTIONAL — free-form tags consumed by retrieval, search, and grouping.
   */
  tags?: string[]
  /**
   * OPTIONAL — ISO 8601 creation timestamp. Producers SHOULD write it as a quoted YAML string (createdAt: "2026-04-26T09:14:00Z"): some YAML 1.1 parsers resolve an unquoted ISO timestamp to a native timestamp, which is not a string. Consumers MAY accept a native timestamp and normalize it to an ISO 8601 string before validating.
   */
  createdAt?: string
  /**
   * OPTIONAL — ISO 8601 last-update timestamp. Same quoting rule as `createdAt`: producers SHOULD quote it; consumers MAY accept a native timestamp.
   */
  updatedAt?: string
  /**
   * Vendor-specific extensions, namespaced under <vendor>. Hosts MUST tolerate unknown keys; the spec's normative fields MUST NOT change meaning.
   */
  metadata?: {
    [k: string]: unknown
  }
  [k: string]: unknown
}

export type CollectionHandle = Readonly<CollectionDefinition>
