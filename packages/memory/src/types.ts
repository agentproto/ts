/**
 * AIP-72 memory/v1 document types.
 *
 * Hand-tuned on top of the shape `json-schema-to-typescript` generates
 * from `resources/aip-72/draft/MEMORY.schema.json`: the `$defs` get
 * `Memory*` names, and the document carries its markdown `body` as a
 * required string (the schema's `body` property stands for the text
 * after the closing frontmatter fence).
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const
/** The closed memory type set (`type`, and `kind` on a memory/v1 item). */
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const MEMORY_STATUSES = ["active", "superseded", "archived"] as const
/** Lifecycle status. Absent means `active` (AIP-72 rule 9). */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export interface MemoryAnchor {
  kind: "global" | "project" | "task" | "session" | "pr" | "contact" | "agent"
  /** Anchor target slug (project, contact, agent). */
  slug?: string
  /** Anchor target id (task, session). */
  id?: string
  /** Repository `owner/name` for a pr anchor. */
  repo?: string
  /** Pull-request number for a pr anchor. */
  number?: number
}

export interface MemoryLifetime {
  kind: "durable" | "until" | "while" | "session"
  /** Expiry timestamp, REQUIRED for kind `until`. */
  at?: string
  /** Governing anchor, REQUIRED for kind `while`. */
  anchor?: MemoryAnchor
}

export interface MemoryDecidedBy {
  rule?: string
  source?: string
}

export interface MemoryProvenance {
  source?: string
  /** Omitted, never empty, when the source has no session. */
  sessionId?: string
  /** Omitted, never empty, when the source has none. */
  ref?: string
  quote?: string
  at?: string
  extractorVersion?: string
}

export interface MemoryCapture {
  mode?: "live" | "batch"
  producer?: string
  capturedAt?: string
}

export interface MemoryEvidence {
  sourceKind?: string
  trust?: string
  explicitness?: string
  corroborations?: number
  contradictsActive?: boolean
  impact?: string
  lifetime?: MemoryLifetime
  anchorsResolved?: string[]
  ageHours?: number
  flags?: string[]
}

/**
 * The YAML frontmatter of a memory/v1 item. Every field is optional at
 * the type level: the schema accepts either the canonical AIP-10 base
 * fields (`schema`, `slug`, `kind`, `title`, `updated_at`) or the legacy
 * trio (`id`, `name`, `type`), which `validateMemory` checks.
 */
export interface MemoryFrontmatter {
  schema?: "memory/v1"
  slug?: string
  kind?: string
  title?: string
  updated_at?: string
  id?: string
  name?: string
  type?: MemoryType
  description?: string
  tags?: string[]
  polarity?: "do" | "dont"
  lifetime?: MemoryLifetime
  status?: MemoryStatus
  created?: string
  written?: string
  decidedBy?: MemoryDecidedBy
  provenance?: MemoryProvenance
  evidence?: MemoryEvidence
  capture?: MemoryCapture
}

/** One memory/v1 item: frontmatter fields plus the markdown body. */
export interface MemoryDocument extends MemoryFrontmatter {
  body: string
}

/** `defineMemory` input: `body` may be omitted for an item with no prose. */
export type MemoryDefinition = MemoryFrontmatter & { body?: string }

/** The frozen item `defineMemory` returns, with `status` made explicit. */
export type MemoryHandle = Readonly<MemoryDocument & { status: MemoryStatus }>

/**
 * One validation finding. `path` is the dot path of the offending field
 * (`provenance.sessionId`, `lifetime.at`, `tags.0`), `""` for the whole
 * document. `rule` is `schema` for a MEMORY.schema.json constraint,
 * `section-2` for the memory/v1 `kind` set, or `rule-<n>` for AIP-72
 * conformance rule n.
 */
export interface MemoryIssue {
  path: string
  message: string
  rule: string
}

export interface MemoryValidationResult {
  ok: boolean
  errors: MemoryIssue[]
  /** SHOULD-level findings (rule 8). Never make `ok` false. */
  warnings: MemoryIssue[]
}
