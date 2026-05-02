/**
 * AIP-23 IdentityDefinition + IdentityHandle.
 *
 * `IdentityDefinition` was generated from
 * `resources/aip-23/draft/IDENTITY.schema.json` via json-schema-to-typescript.
 * `IdentityHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-23 IDENTITY.md (workspace root or per-context view). The single doctype 'identity.workspace/v1' is used in both modes; the host distinguishes by checking whether `extends` is set. Per-layer-kind schemas are delegated to AIP-18 (COLLECTION.md / ITEM.md). Items in any layer collection MUST carry a `confidence` field in 0..1; that requirement is enforced at item-load time by the host, not by this schema (which validates the workspace manifest only).
 */
export type IdentityDefinition = {
  [k: string]: unknown
} & {
  /**
   * Discriminator for the AIP-23 workspace doctype.
   */
  schema: "identity.workspace/v1"
  /**
   * Stable kebab-case identifier for the identity or view.
   */
  name: string
  /**
   * Human-readable title of the identity.
   */
  title: string
  /**
   * One-paragraph statement of purpose: what this identity captures, who or what it is about.
   */
  description: string
  /**
   * Semantic version of the WORKSPACE shape. Bump on collection / artifact-tier / binding / lint / defaults changes. Independent of any individual layer item's version (AIP-18-side).
   */
  version: string
  /**
   * OPTIONAL — relative path to a parent IDENTITY.md. Presence makes the manifest a VIEW; absence makes it a WORKSPACE ROOT. Recursive composition; maximum chain depth is 8.
   */
  extends?: string
  /**
   * OPTIONAL — list of consumers this VIEW adapts the identity for. Hosts MUST refuse the view if any binding does not resolve. Not inherited; views declare their own scope.
   */
  appliesTo?: string[]
  /**
   * OPTIONAL — AIP-9 operator the identity is *about* or activates against. The host loads this operator when the identity is opened.
   */
  executor?: string
  /**
   * OPTIONAL — AIP-7 policy or audit binding. May be a path to an AIP-7 policy file or a ws:// ref. Identity-level approvals (layer mutations, confidence elevation, persona binding) flow through this ref.
   */
  governance?: string
  /**
   * OPTIONAL — AIP-20 work tracker the identity participates in (an operator's task queue, a company's program plan).
   */
  work?: string
  /**
   * OPTIONAL — AIP-10 KNOWLEDGE.md ref. The identity's narrative wiki, dossier, exemplars.
   */
  knowledge?: string
  /**
   * Layer collections enabled by this identity. Each entry is one AIP-18 collection describing ONE layer kind. Three forms supported: inline (full COLLECTION.md frontmatter), file ref, or registry import. Merge-by-effective-name (alias if set, otherwise the collection's name) across the extends chain.
   */
  collections?: CollectionEntry[]
  /**
   * Layer behaviour configuration. Confidence floor, versioning posture, temporal-entry contract.
   */
  layers?: {
    /**
     * OPTIONAL — minimum confidence (0..1) the workspace will store. New items below the floor are refused with identity_confidence_below_floor (HARD). Default is 0.0 (no floor). Workspaces with strict identity standards SHOULD set this to 0.5 or higher.
     */
    defaultConfidence?: number
    /**
     * Whether layer items carry an incrementing version on update. ONE-WAY SWITCH: once 'enabled' at any ancestor, descendants MUST NOT set 'disabled'. Refusal: identity_versioning_disable (HARD).
     */
    versioning?: "enabled" | "disabled"
    /**
     * Temporal-layer behaviour at the workspace level.
     */
    temporal?: {
      /**
       * OPTIONAL — whether temporal-entry companion items are supported for layers marked temporal: true on their own collection.
       */
      enabled?: boolean
      /**
       * OPTIONAL — field name on temporal-entry items carrying expiry. Hosts walk this field on read to exclude expired entries.
       */
      field?: string
      /**
       * Controlled vocabulary for temporal-entry.source. APPEND-ONLY across ancestors: descendants MAY add new values but MUST NOT remove existing ones.
       */
      sourceVocabulary?: string[]
    }
  }
  /**
   * Compression artifact policy. AIP-23's first distinctive contribution.
   */
  artifacts?: {
    /**
     * Whether the host generates compression artifacts for layer items.
     */
    enabled?: boolean
    /**
     * Compression tiers. Merge-by-id vs parent; child tier with same id overrides parent's. Monotonicity (strictly increasing maxTokens) is re-validated after merge.
     */
    tiers?: {
      /**
       * Stable kebab-case tier id. Conventional values: short, medium, full. Merge key vs parent.
       */
      id: string
      /**
       * Target maximum tokens for this tier's artifact. Tiers MUST be MONOTONIC: each tier's maxTokens MUST be strictly greater than the previous tier's. The host re-validates monotonicity after merge.
       */
      maxTokens: number
      /**
       * OPTIONAL — compression algorithm id. Conventional values: aaak, bullet-list, markdown, or a host-defined string.
       */
      strategy?: string
    }[]
    /**
     * Locales for which artifacts are generated. ISO 639-1 (e.g. 'en') with optional ISO 3166-1 region (e.g. 'en-US'). When non-empty, the host produces one artifact per (layer, tier, locale) triple.
     */
    locales?: string[]
    /**
     * When the host regenerates artifacts. on-write = immediately after layer item mutation (correctness); scheduled = host-defined cadence (cheap, eventually consistent); manual = no auto-refresh.
     */
    refreshPolicy?: "on-write" | "scheduled" | "manual"
  }
  /**
   * Junction policy. Which bearer entity kinds may bind layer items as their identity, and how exclusively.
   */
  binding?: {
    /**
     * Bearer entity kinds allowed to bind layer items. Workspaces narrow to fit their domain (companion-style: [user, persona]; operator-fleet style: [operator, company]). Cross-references: operator → AIP-9, company → AIP-22, persona → AIP-25, skill → AIP-3, user → host-defined.
     */
    allowedEntities?: ("operator" | "company" | "persona" | "user" | "skill")[]
    /**
     * Binding exclusivity rule. ONE-WAY SWITCH on relaxation: once 'per-entity-and-layer' (or stricter, when added) at any ancestor, descendants MUST NOT replace with a more permissive value. Refusal: identity_binding_loosen (HARD). Currently only 'per-entity-and-layer' is defined; future values may add stricter forms.
     */
    exclusivity?: "per-entity-and-layer"
    /**
     * Whether the host verifies the bearer entity exists before allowing the binding. ONE-WAY SWITCH on relaxation: once 'true' at any ancestor, descendants MUST NOT set false. Refusal: identity_binding_verify_relax (HARD). Setting false is permitted for ephemeral / sandbox deployments but SHOULD never be used in production.
     */
    verifyExistence?: boolean
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
      | "orphan-layer"
      | "low-confidence-pinned"
      | "stale-temporal"
      | "unbound-layer"
      | "missing-required-layer"
      | "custom"
    /**
     * Lint severity. Children may soften; governance policies MAY forbid softening below `error`.
     */
    severity: "error" | "warn" | "info"
    /**
     * Kind-specific parameters. e.g. { layers: [soul, personality] } for missing-required-layer; { days: 30 } for stale-temporal; { threshold: 0.5 } for low-confidence-pinned.
     */
    params?: {
      [k: string]: unknown
    }
  }[]
  /**
   * Default approval and audit posture.
   */
  defaults?: {
    /**
     * Approval class for layer mutations. 'auto' = no gate; 'always' = every mutation requires approval; 'on-mutate' = approval on field-level mutations; 'policy:<ref>' = delegate to an AIP-7 policy.
     */
    approvalClass?: string
    /**
     * Whether layer mutations are audited. ONE-WAY SWITCH: once true at any ancestor, descendants MUST NOT set false. Refusal: identity_audit_downgrade (HARD).
     */
    auditMutations?: boolean
  }
  /**
   * Display hints for UIs that render the identity. Runtime-agnostic.
   */
  display?: {
    /**
     * OPTIONAL — id of the layer or item to use as the identity landing page (e.g. SOUL-acme-founder).
     */
    homePage?: string
    /**
     * Default grouping for list views. 'layer' = one section per layer kind; 'entity' = one section per bearer entity.
     */
    defaultGrouping?: "layer" | "entity"
  }
  /**
   * Vendor-specific extensions, namespaced under <vendor>. Deep-merged across the extends chain. MUST NOT change the meaning of any spec field.
   */
  metadata?: {
    [k: string]: unknown
  }
}
/**
 * One layer-collection declaration. Either an inline AIP-18 collection schema, or a ref (path or ws:// URI) optionally aliased and version-pinned.
 */
export type CollectionEntry = CollectionInline | CollectionRef
/**
 * Full AIP-18 collection.schema/v1 frontmatter, parsed in-place. The host registers the layer collection directly via AIP-18's defineCollection without loading a separate file.
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
 * Inline layer-collection declaration. Full AIP-18 schema embedded; hosts MUST validate it against the AIP-18 COLLECTION schema before registration.
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
 * Layer-collection ref declaration. Either a file path (./.. /COLLECTION.md) or a registry URI (ws://collections/<slug>).
 */
export interface CollectionRef {
  /**
   * Either a relative path to a COLLECTION.md (file ref) or a ws://collections/<slug> URI (registry import). The host loads the referenced collection via AIP-18 and registers it under its name (or the alias, if set).
   */
  ref: string
  /**
   * OPTIONAL — workspace-local name to expose the layer collection under. Two collections resolving to the same effective name (alias or upstream) is a HARD failure: identity_collection_alias_conflict.
   */
  alias?: string
  /**
   * OPTIONAL — semver range (e.g. "1.x", "^1.2", "1.2.0"). When set, schema bumps outside the range fail with collection_item_schema_pinned_drift (HARD, AIP-18 vocabulary) at item load time.
   */
  version?: string
}

export type IdentityHandle = Readonly<IdentityDefinition>
