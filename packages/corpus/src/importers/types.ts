/**
 * CorpusImporter — pluggable bootstrap contract.
 *
 * Real corpora are rarely born from blank fixtures — they come from
 * Notion workspaces, Drive folders, web crawls, PDFs, internal docs,
 * existing knowledge bases. Importers are how a corpus gets seeded
 * from reality without hand-authoring every file.
 *
 * The pattern is symmetric with IKnowledgeProvider / IEvaluator:
 *   1. Kit (this package) ships the contract + a reference impl
 *      (`LocalFilesImporter`).
 *   2. Adapter packages (Notion, Drive, web-crawl, …) implement the
 *      contract via their own SDKs/HTTP layer.
 *   3. The host (Guilde corpus-host) wires a registry + dispatch.
 *
 * Importers write to two places, atomically per source:
 *   - `sources/<importer-id>/<batch>/<slug>.md`  — archived AIP-10 source
 *   - `_candidates.yaml`                          — discovered candidate row
 *
 * Both writes go through CorpusWorkspaceWriter so versionToken /
 * transaction-lock semantics hold the same way as the rest of the
 * corpus lifecycle.
 */

import type { CandidateRow } from "../workspace/sidecar.js"

export interface ImporterTarget {
  /**
   * Stable importer instance id. Allows the same importer adapter to
   * run multiple times against different sources (e.g. two distinct
   * Notion workspaces). Reflected in the archive path:
   * `sources/<importerId>/<batch>/`.
   */
  readonly importerId: string
  /** Optional batch id — defaults to ISO timestamp on first archive. */
  readonly batchId?: string
  /** Importer-specific configuration (auth tokens, source spec, filters). */
  readonly config: Readonly<Record<string, unknown>>
}

/**
 * One source unit the importer produces. The host writes this to
 * `sources/<importerId>/<batchId>/<slug>.md` as AIP-10 frontmatter +
 * body, and appends a row to `_candidates.yaml`.
 */
export interface ImportedSource {
  /** Stable kebab-case slug for the source. */
  readonly slug: string
  /** Human-readable title. */
  readonly title: string
  /** sha256-prefixed content hash (importer responsibility — dedup gate). */
  readonly contentHash: string
  /** Source body (markdown). */
  readonly body: string
  /** Optional original URL. */
  readonly originalUrl?: string
  /** AIP-10 authority class. */
  readonly authority?: "primary" | "secondary" | "rumour"
  /** BCP-47 language code — drives the locale-matching retrieval filter. */
  readonly language?: string
  readonly tags?: readonly string[]
  /** Vendor extension fields go under metadata.corpus.* on the source frontmatter. */
  readonly corpusMetadata?: Readonly<Record<string, unknown>>
}

export interface BatchReport {
  /** Importer that produced the batch. */
  readonly importerId: string
  readonly batchId: string
  /** Sources archived this run. */
  readonly archivedSlugs: readonly string[]
  /** Sources skipped because contentHash already exists. */
  readonly duplicateSlugs: readonly string[]
  /** Candidate ids written to _candidates.yaml. */
  readonly candidateIds: readonly string[]
  /** Diagnostic messages (non-fatal warnings, dedup reasons, etc.). */
  readonly warnings: readonly string[]
}

/**
 * The contract concrete importers implement. Two methods:
 *   - `enumerate(target)` — yields ImportedSource objects.
 *     Caller iterates + decides what to do with each (run dedup,
 *     archive, append).
 *
 * The kit ships the "what to do with each" logic in
 * `ImporterRunner` — concrete importers focus ONLY on producing
 * `ImportedSource` from their data source.
 */
export interface CorpusImporter {
  /** Stable id, e.g. "local-files", "notion", "drive", "web-crawl". */
  readonly id: string
  /** Brief human-readable label (UI metadata). */
  readonly label: string
  /**
   * Yield sources for the configured target. Async iterator so the
   * host can stream + back-pressure on large imports. Each source
   * carries everything the runner needs to archive + materialize a
   * candidate.
   */
  enumerate(target: ImporterTarget): AsyncIterable<ImportedSource>
}

export interface ImporterRunnerOptions {
  /**
   * Build the candidate row from an ImportedSource. Lets callers
   * customize the corpusKind heuristic + add app-specific fields.
   * Default: maps to `corpusKind: "example"`.
   */
  readonly toCandidate?: (s: ImportedSource, sourceId: string) => CandidateRow
}
