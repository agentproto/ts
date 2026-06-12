/**
 * AIP-12 PlaybookDefinition + PlaybookHandle.
 *
 * `PlaybookDefinition` was generated from
 * `resources/aip-12/draft/PLAYBOOK.schema.json` via json-schema-to-typescript.
 * `PlaybookHandle` is the readonly view of the same shape; tighten it
 * by hand for fields that get defaults applied in build().
 */

/**
 * Validates the YAML frontmatter portion of an AIP-12 PLAYBOOK.md overlay manifest.
 */
export type PlaybookDefinition = {
  [k: string]: unknown
} & {
  schema: "playbooks/v1"
  slug: string
  title: string
  /**
   * Optional path to the entry file exposing definePlaybook. Defaults to playbook.ts.
   */
  entry?: string
  /**
   * @deprecated In favor of `selector`. Legacy axis-ambiguous binding —
   * runtimes compile it into a selector (see AIP-12 §Selector binding).
   * Kept valid forever. At least one of `targets` / `selector` is required.
   *
   * @minItems 1
   */
  targets?: [Target, ...Target[]]
  /**
   * Typed attachment binding evaluated against the subject's dimensions.
   * Short form: axis → ref | ref[] (AND across keys, OR within a list).
   * Long form: `allOf` / `anyOf` lists of `{axis, anyOf}` terms.
   * Wins over `targets`/`binds_operator` when present.
   */
  selector?: SelectorFrontmatter
  kind: "overlay" | "block-replacement"
  /**
   * Required when kind is 'block-replacement' — the named persona block to swap.
   */
  block?: string
  priority?: number
  /**
   * Locked persona traits this overlay MUST NOT modify. Author intent — runtime enforces independently.
   */
  lock_check: TraitId[]
  /**
   * Optional ISO 8601 duration. Auto-archives at updated_at + ttl.
   */
  ttl?: string
  /**
   * @minItems 1
   */
  evidence: [EvidenceItem, ...EvidenceItem[]]
  status: "shadow" | "active" | "archived"
  supersedes?: Slug[]
  /**
   * Append-only audit trail of deltas, promotions, and archivals applied to this playbook.
   */
  history?: HistoryEntry[]
  /**
   * @deprecated As a binding — provenance only when `selector` is present.
   * Without `selector`, runtimes compile it like a kind 'operator' target
   * (matches BOTH identity and role axes).
   */
  binds_operator?: string
  created_at?: string
  updated_at?: string
  tags?: string[]
  /**
   * Vendor extensions go under metadata.<vendor>.
   */
  metadata?: {
    [k: string]: unknown
  }
}
export type TraitId = string
export type Slug = string

/** Axis value slug, prefixed ref (e.g. 'role/sales-rep'), or '*' (any present value). */
export type SelectorRef = string
export interface SelectorTermFrontmatter {
  axis: string
  /**
   * @minItems 1
   */
  anyOf: [SelectorRef, ...SelectorRef[]]
}
/**
 * Short form: axis keys → ref | ref[]. Long form: explicit `allOf` /
 * `anyOf` term lists for OR across axes.
 */
export type SelectorFrontmatter = {
  allOf?: SelectorTermFrontmatter[]
  anyOf?: SelectorTermFrontmatter[]
} & {
  [axis: string]:
    | SelectorRef
    | SelectorRef[]
    | SelectorTermFrontmatter[]
    | undefined
}

export interface Target {
  kind: "operator" | "role" | "skill" | "runtime"
  /**
   * Slug, glob, or qualified path. Examples: 'role/companion', 'operator/alice', 'skill/research', 'operator/*'.
   */
  ref: string
}
export interface EvidenceItem {
  kind: "run" | "conversation" | "work-item" | "reflection" | "human"
  ref: string
  note?: string
}
export interface HistoryEntry {
  at: string
  kind: "created" | "delta" | "promoted" | "archived" | "superseded" | "lock-violation"
  summary: string
  /**
   * Pointer to the run/reflection/governance ticket that produced this entry.
   */
  source?: string
  /**
   * User id, agent id, or system identifier responsible for the entry.
   */
  by?: string
  /**
   * For kind='promoted', the gate that passed.
   */
  gate?: "a-b" | "scorer" | "human" | "governance"
}

export type PlaybookHandle = Readonly<PlaybookDefinition>
