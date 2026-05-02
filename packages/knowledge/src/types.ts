/**
 * AIP-10 KnowledgeDefinition + KnowledgeHandle.
 *
 * `KnowledgeDefinition` was generated from
 * `resources/aip-10/draft/KNOWLEDGE.schema.json` via json-schema-to-typescript.
 * `KnowledgeHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-10 entry, source, or workspace manifest. The doctype is selected via the `schema` discriminator: 'knowledge.entry/v1' (curated, mutable), 'knowledge.source/v1' (raw, immutable), or 'knowledge.workspace/v1' (workspace manifest or per-context view).
 */
export type KnowledgeDefinition = Entry | Source | Workspace
/**
 * Workspace manifest doctype. Used both as the root manifest of a wiki (no `extends`) and as a per-consumer view (with `extends`). The same schema validates both modes; the host distinguishes by checking whether `extends` is set.
 */
export type Workspace = {
  [k: string]: unknown
} & {
  /**
   * Discriminator for the workspace manifest doctype.
   */
  schema: "knowledge.workspace/v1"
  /**
   * Stable kebab-case identifier for the workspace or view.
   */
  name: string
  /**
   * Human-readable workspace title.
   */
  title: string
  /**
   * One-paragraph statement of purpose: what this workspace (or view) is for and who uses it.
   */
  description: string
  /**
   * Semantic version of the WORKSPACE shape. Bump on entityTypes / lints / source / curation changes. Independent of the wiki's content version.
   */
  version: string
  /**
   * OPTIONAL — relative path to a parent KNOWLEDGE.md. Presence of this field makes the manifest a VIEW; absence makes it a WORKSPACE ROOT. Recursive composition: parents may themselves declare `extends`. Maximum chain depth is 8.
   */
  extends?: string
  /**
   * OPTIONAL — list of consumers this VIEW adapts the workspace for. Hosts MUST refuse the view if any binding does not resolve. Not inherited; views declare their own scope.
   */
  appliesTo?: string[]
  /**
   * OPTIONAL — AIP-9 operator that curates this workspace. The host activates this operator for ingest, curation, and lint passes.
   */
  curator?: string
  /**
   * OPTIONAL — AIP-7 policy or audit binding. May be a path to an AIP-7 policy file or a ws:// ref. Schema-poisoning mitigations and source-mutation audits flow through this ref.
   */
  governance?: string
  /**
   * Entity types this workspace recognizes. Merge-by-name against the extends parent: a child entry with the same name replaces the parent's; new names are appended.
   */
  entityTypes?: {
    /**
     * PascalCase type name. Merge key when composing with extends parent.
     */
    name: string
    /**
     * Canonical fields for this entity type. Child views append fields to parent's set.
     */
    fields?: string[]
    /**
     * OPTIONAL — display hint, typically a single emoji.
     */
    icon?: string
    /**
     * OPTIONAL — prose describing what entries of this type capture.
     */
    description?: string
    /**
     * OPTIONAL — name of another LOCAL entity type that this one extends. Used for subtyping (e.g. Investor extends Person).
     */
    parent?: string
  }[]
  /**
   * Lint rules. Merge-by-id against the extends parent: a child entry with the same id replaces the parent's; new ids are appended.
   */
  lints?: {
    /**
     * Stable kebab-case lint id. Merge key when composing with extends parent.
     */
    id: string
    /**
     * Lint algorithm. 'custom' delegates to a host-defined check identified by `id`.
     */
    kind: "require-source" | "max-age" | "min-confidence" | "broken-ref" | "orphan" | "custom"
    /**
     * Entity type name (e.g. 'Concept') or '*' for all entries.
     */
    appliesTo: string
    /**
     * Lint severity. Child views may soften (warn -> info) but governance policies may forbid that.
     */
    severity: "error" | "warn" | "info"
    /**
     * Kind-specific parameters. e.g. { days: 90 } for 'max-age'; { min: 0.6 } for 'min-confidence'.
     */
    params?: {
      [k: string]: unknown
    }
  }[]
  /**
   * Source registry policy. Each leaf field overrides independently across the extends chain.
   */
  sources?: {
    /**
     * Source retention. 'forever' (default) or 'days:<n>' for time-limited.
     */
    retention?: string
    /**
     * Whether sources must carry an AIP-7 signature. Composes with AIP-7 governance.
     */
    signing?: "required" | "optional" | "none"
    /**
     * Default content-hash algorithm for new sources.
     */
    hashAlgo?: "sha256" | "sha512" | "blake3"
    /**
     * Default authority assigned to new sources when defineSource omits the field.
     */
    authorityDefault?: "primary" | "secondary" | "rumour"
  }
  /**
   * Curation policy. Each leaf field overrides independently across the extends chain.
   */
  curation?: {
    /**
     * Free-form tone hint for the curator agent (e.g. 'academic', 'sales', 'neutral').
     */
    tone?: string
    /**
     * How exhaustive the curator agent should be when distilling sources into entries.
     */
    depth?: "shallow" | "medium" | "deep"
    /**
     * Auto-linking policy: 'byName' walks bodies for entity names and inserts wikilinks; 'manual' leaves links to the agent; 'off' disables auto-linking entirely.
     */
    autoLink?: "byName" | "manual" | "off"
    /**
     * How the curator agent resolves contradictions when sources disagree.
     */
    conflictResolution?: "defer" | "recency" | "authority" | "observation-count" | "keep-both"
    /**
     * Prose hint for when to promote a mention into a full entry (vs leaving it as a body reference).
     */
    newEntryThreshold?: string
  }
  /**
   * Hints for how consumers should retrieve from this view.
   */
  queryHints?: {
    /**
     * When ranking results, weight recency higher.
     */
    preferRecent?: boolean
    /**
     * When ranking results, weight authority='primary' higher.
     */
    preferAuthoritative?: boolean
    /**
     * Default query scope — entity types this view focuses on. Replaced wholesale by child if present.
     */
    scopeTo?: string[]
  }
  /**
   * Display hints for UIs that render the workspace. Runtime-agnostic.
   */
  display?: {
    /**
     * OPTIONAL — slug of the entry to use as the workspace landing page.
     */
    homePage?: string
    /**
     * Default _index.md grouping.
     */
    defaultGrouping?: "kind" | "tag" | "source"
  }
  /**
   * Vendor-specific extensions, namespaced under <vendor>. Deep-merged across the extends chain.
   */
  metadata?: {
    [k: string]: unknown
  }
}

export interface Entry {
  /**
   * Discriminator for curated wiki entries. Mutable doctype.
   */
  schema: "knowledge.entry/v1"
  /**
   * Stable kebab-case identifier. Used as the wikilink target ([[slug]]) and as the entry's path stem.
   */
  slug: string
  /**
   * Entry kind. The wiki's KNOWLEDGE.md (entityTypes) and AGENTS.md schema together define the allowed values; common ones are 'entity', 'concept', 'summary', 'comparison', 'timeline'.
   */
  kind: string
  /**
   * Human-readable page title.
   */
  title: string
  /**
   * Provenance — list of source ids that back the claims in this entry's body.
   */
  sources?: string[]
  /**
   * Curation agent's confidence in the entry's claims. Advisory; downstream consumers may weight it against source authority and recency.
   */
  confidence?: number
  /**
   * ISO 8601 timestamp of the last patch to this entry. MUST be set on every write.
   */
  updated_at: string
  /**
   * Slugs of earlier entries that this one replaces. Resolution rules live in the wiki's KNOWLEDGE.md curation.conflictResolution policy.
   */
  supersedes?: string[]
  /**
   * Slugs of entries whose claims conflict with this one and that the contradiction policy could not auto-resolve. Surfaces in lint.
   */
  contradicts?: string[]
  /**
   * OPTIONAL hint to the link resolver — slugs this entry links to. The resolver also walks the body for [[slug]] and markdown links; this field is for entries whose links are computed.
   */
  links?: string[]
  /**
   * Free-form tags; consumed by retrieval, search, and grouping in _index.md.
   */
  tags?: string[]
  /**
   * Vendor-specific extensions. Hosts MUST tolerate unknown keys; the spec's normative fields MUST NOT change meaning.
   */
  metadata?: {
    [k: string]: unknown
  }
}
export interface Source {
  /**
   * Discriminator for raw sources. Immutable doctype — once registered, the host MUST refuse mutations to the file's bytes.
   */
  schema: "knowledge.source/v1"
  /**
   * Stable kebab-case source id, ISO-prefixed when possible (e.g. '2026-04-27-investor-call'). Entries reference sources by id, never by path.
   */
  id: string
  /**
   * Path to the raw bytes, relative to the wiki root. MUST start with 'sources/'. The host pins this file once defineSource succeeds.
   */
  path: string
  /**
   * Human-readable source title.
   */
  title: string
  /**
   * ISO 8601 timestamp of when the source entered the wiki.
   */
  captured_at: string
  /**
   * OPTIONAL — author or operator who pinned the source. May be a user identifier, an agent id, or an upstream system name.
   */
  captured_by?: string
  /**
   * Cryptographic hash of the file bytes. sha256 is required by the spec; other algorithms MAY appear in additional sidecar fields. Once set, the file is pinned.
   */
  content_hash: string
  /**
   * Source authority class. 'primary' = first-party document or recording; 'secondary' = derived analysis; 'rumour' = unverified claim. Consumed by contradiction policy.
   */
  authority?: "primary" | "secondary" | "rumour"
  /**
   * OPTIONAL — BCP-47 language code of the source. Useful for ingest pipelines that pick a translator.
   */
  language?: string
  /**
   * OPTIONAL — id of a newer source that replaces this one. The host writes this; agents do not edit the source file's bytes to 'correct' it. Tombstones the source for contradiction-policy purposes while preserving the original bytes.
   */
  superseded_by?: string
  tags?: string[]
  /**
   * Vendor-specific extensions. Hosts MUST tolerate unknown keys.
   */
  metadata?: {
    [k: string]: unknown
  }
}

export type KnowledgeHandle = Readonly<KnowledgeDefinition>
