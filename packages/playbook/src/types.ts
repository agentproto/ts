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
   * @minItems 1
   */
  targets: [Target, ...Target[]]
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
   * Optional — the specific operator (per AIP-9) this playbook is bound to. Narrower than targets[].
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
