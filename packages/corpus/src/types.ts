/**
 * @agentproto/corpus — public types.
 *
 * Frontmatter shapes here are deliberately loose (`Record<string,
 * unknown>`). Strict validation lives in `validate/validator.ts` —
 * keeping the reader weakly-typed lets it surface drift through the
 * validator's structured errors rather than failing on parse.
 */

export type FileKind =
  | "knowledge-workspace" // KNOWLEDGE.md at workspace root
  | "knowledge-source"    // sources/**/<id>.md
  | "knowledge-entry"     // entries/**/<slug>.md
  | "collection-schema"   // collections/<name>/COLLECTION.md
  | "collection-item"     // collections/<name>/<slug>/ITEM.md or <slug>.md
  | "playbook"            // playbooks/<slug>/PLAYBOOK.md
  | "operator"            // operators/<slug>/OPERATOR.md
  | "workflow"            // workflows/<slug>/WORKFLOW.md
  | "routine"             // routines/<slug>/ROUTINE.md
  | "unknown"             // .md we don't recognize — flagged but not failed

export interface ParsedFile {
  /** Workspace-relative path (e.g. "entries/principles/2026/foo.md"). */
  readonly path: string
  /** Classification by location. */
  readonly kind: FileKind
  /** Parsed YAML frontmatter. Empty object if frontmatter is missing. */
  readonly frontmatter: Readonly<Record<string, unknown>>
  /** Markdown body (everything after the closing `---`). */
  readonly body: string
  /** SHA-256 of the entire file contents — used as optimistic-concurrency versionToken. */
  readonly versionToken: string
}

export interface CorpusWorkspaceSnapshot {
  /** Root path passed to the reader (relative or absolute, host's choice). */
  readonly root: string
  /** The KNOWLEDGE.md file, if found. */
  readonly workspace: ParsedFile | null
  readonly sources: readonly ParsedFile[]
  readonly entries: readonly ParsedFile[]
  readonly collections: readonly ParsedFile[]       // COLLECTION.md files only
  readonly collectionItems: readonly ParsedFile[]   // ITEM.md files only
  readonly playbooks: readonly ParsedFile[]
  readonly operators: readonly ParsedFile[]
  readonly workflows: readonly ParsedFile[]
  readonly routines: readonly ParsedFile[]
  /** .md files we found but couldn't classify. */
  readonly unknown: readonly ParsedFile[]
}

/** Validator result per file, returned by `validate/validator.ts`. */
export interface ValidationIssue {
  readonly path: string
  readonly instancePath: string
  readonly message: string
  readonly severity: "error" | "warn" | "info"
}

export interface ValidationResult {
  readonly issues: readonly ValidationIssue[]
  readonly valid: boolean
}

/** Lint result, returned by `validate/linter.ts`. */
export interface LintIssue {
  readonly lintId: string
  readonly path: string
  readonly message: string
  readonly severity: "error" | "warn" | "info"
}

export interface LintReport {
  readonly issues: readonly LintIssue[]
  readonly errorCount: number
  readonly warnCount: number
  readonly infoCount: number
}

/** Event taxonomy emitted by the corpus to `_log.md`. */
export type CorpusEventKind =
  | "corpus.candidate.discovered"
  | "corpus.candidate.analyzed"
  | "corpus.candidate.approved"
  | "corpus.candidate.rejected"
  | "corpus.candidate.needs_work"
  | "corpus.entry.promoted"
  | "corpus.entry.deprecated"
  | "corpus.entry.archived"
  | "corpus.gap.opened"
  | "corpus.gap.resolved"
  | "playbook.shadow.registered"
  | "playbook.activated"
  | "playbook.archived"

export interface CorpusEvent {
  readonly kind: CorpusEventKind
  readonly at: string                      // ISO timestamp
  readonly actor: string                   // principal slug (from IdentityPort)
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * Per-state-transition attestation stored under
 * `metadata.corpus.attestations[]` on entries, candidates, and
 * playbooks. The audit chain that `_log.md` rolls up.
 *
 * `model` + `promptHash` are recorded when an AI agent produced the
 * transition (analyzed by analyst-bot, scored by reviewer-bot, …).
 * Human-driven transitions omit them. `signature` is reserved for
 * AIP-23 signing once the identity infra is wired — until then it
 * stays optional and the chain relies on principal + at + hash.
 */
export type AttestationKind =
  | "created"
  | "analyzed"
  | "reviewed"
  | "promoted"
  | "deprecated"
  | "archived"
  | "activated"
  | "evaluated"
  | "imported"
  | "tombstoned"   // GDPR right-to-be-forgotten

export interface Attestation {
  readonly kind: AttestationKind
  /** AIP-23-style identity ref. e.g. "ws://operators/corpus-curator". */
  readonly identity: string
  readonly at: string                  // ISO timestamp
  /** Optional model id for AI-produced transitions. */
  readonly model?: string
  /** Optional sha256 of the prompt + system prompt used. */
  readonly promptHash?: string
  /** Optional signature (AIP-23). Reserved until identity infra lands. */
  readonly signature?: string
  /** Free-form note — appears in curator UI tooltips. */
  readonly note?: string
}

/**
 * A reusable corpus starter — pure TS data, no filesystem dependency.
 *
 * Follows the @agentproto/role-catalog pattern: a preset is a
 * declarative bundle of file paths → file contents that a host writes
 * to a target workspace via the FsPort. The kit defines the
 * interface; individual packages under `@agentproto/corpus-presets/*`
 * ship per-vertical content.
 *
 * `files` keys are workspace-relative paths (no leading slash). The
 * host (e.g. corpus-cli's `init` command, or any embedding runtime)
 * is responsible for iterating + writing via FsPort.
 */
export interface CorpusPreset {
  readonly slug: string
  readonly title: string
  readonly description?: string
  readonly files: Readonly<Record<string, string>>
  /**
   * Optional bootstrap hook. Hosts that need to do more than write
   * files (e.g. seed _candidates.yaml sidecar, register a KB row)
   * implement this. The default `init` flow just writes `files`.
   */
  readonly bootstrap?: (ctx: CorpusPresetBootstrapContext) => Promise<void>
}

export interface CorpusPresetBootstrapContext {
  /** Workspace root within whatever fs the host has handed us. */
  readonly workspacePath: string
  /**
   * Write a single file relative to workspacePath. Implementations
   * typically just call FsPort.writeFile. Exposed as a callback so
   * the preset doesn't need to import FsPort directly (keeps presets
   * minimally typed).
   */
  readonly write: (relativePath: string, content: string) => Promise<void>
}
