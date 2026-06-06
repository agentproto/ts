/**
 * ImporterRunner — drives a CorpusImporter to actually land files
 * + candidate rows in the workspace.
 *
 * Importers themselves are pure source-of-data — they yield
 * `ImportedSource`. The runner is where I/O lives: archives sources
 * to `sources/<importerId>/<batchId>/`, appends `_candidates.yaml`
 * rows, dedups against existing sources by `content_hash`, emits a
 * `corpus.candidate.discovered` event per imported source.
 *
 * Same fs+writer+emitter pattern as the rest of the corpus lifecycle.
 */

import matter from "gray-matter"
import { CorpusEventEmitter } from "../events/emitter.js"
import { CorpusWorkspaceReader } from "../workspace/reader.js"
import { CorpusWorkspaceWriter } from "../workspace/writer.js"
import { CandidatesSidecar } from "../workspace/sidecar.js"
import { isSourceSlug } from "../util/slug.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { FsPort } from "../ports/fs.port.js"
import type { IdentityPort } from "../ports/identity.port.js"
import type { CandidateRow } from "../workspace/sidecar.js"
import type {
  BatchReport,
  CorpusImporter,
  ImportedSource,
  ImporterRunnerOptions,
  ImporterTarget,
} from "./types.js"

const SIDECAR_PATH = "collections/corpus-candidate/_candidates.yaml"

export class ImporterRunner {
  constructor(
    private readonly opts: {
      readonly fs: FsPort
      readonly clock: ClockPort
      readonly identity: IdentityPort
      readonly workspacePath: string
      readonly runner?: ImporterRunnerOptions
    }
  ) {}

  /**
   * Run a single importer batch end-to-end.
   *
   *   1. Pre-load existing source content_hashes for dedup.
   *   2. For each source the importer yields:
   *      a. Skip if hash already exists in the workspace.
   *      b. Otherwise write AIP-10 source frontmatter + body to
   *         `sources/<importerId>/<batchId>/<slug>.md`.
   *      c. Append candidate row to `_candidates.yaml`.
   *   3. Emit `corpus.candidate.discovered` per archived source.
   *
   * Atomic per-source (each source archived + candidate written
   * inside one writer.transaction).
   */
  async run(
    importer: CorpusImporter,
    target: ImporterTarget
  ): Promise<BatchReport> {
    const fs = this.opts.fs
    const writer = new CorpusWorkspaceWriter({ fs })
    const reader = new CorpusWorkspaceReader({ fs })
    const sidecar = new CandidatesSidecar({
      fs,
      path: joinPath(this.opts.workspacePath, SIDECAR_PATH),
    })
    const emitter = new CorpusEventEmitter({
      fs,
      clock: this.opts.clock,
      identity: this.opts.identity,
      workspaceRoot: this.opts.workspacePath,
    })

    const batchId = target.batchId ?? this.opts.clock.now().toISOString().slice(0, 10)
    const archiveDirSegment = `sources/${target.importerId}/${batchId}`

    // Pre-load existing content_hashes for dedup. O(n) one-shot scan.
    const snapshot = await reader.read(this.opts.workspacePath)
    const existingHashes = new Set<string>()
    for (const file of snapshot.sources) {
      const h = file.frontmatter.content_hash
      if (typeof h === "string") existingHashes.add(h)
    }

    const archivedSlugs: string[] = []
    const duplicateSlugs: string[] = []
    const candidateIds: string[] = []
    const warnings: string[] = []

    for await (const source of importer.enumerate(target)) {
      if (!isSourceSlug(source.slug)) {
        warnings.push(`source skipped — invalid slug "${source.slug}"`)
        continue
      }
      if (existingHashes.has(source.contentHash)) {
        duplicateSlugs.push(source.slug)
        continue
      }
      existingHashes.add(source.contentHash) // dedup within batch too

      const sourcePath = joinPath(
        this.opts.workspacePath,
        `${archiveDirSegment}/${source.slug}.md`
      )
      const sourceContent = serializeSource(source, archiveDirSegment, this.opts.clock)
      // Create-only — if the slug somehow collides with an existing file,
      // surface it as a warning and skip.
      try {
        await writer.writeFile(sourcePath, sourceContent, null)
      } catch (err) {
        warnings.push(
          `source "${source.slug}" — slug collision in ${archiveDirSegment} (${
            err instanceof Error ? err.message : "unknown"
          }); skipped`
        )
        continue
      }
      archivedSlugs.push(source.slug)

      // Append candidate row. Use the importer's optional toCandidate
      // mapper if provided; otherwise default to corpusKind=example.
      const toCandidate =
        this.opts.runner?.toCandidate ?? defaultToCandidate
      const sourceId = source.slug
      const row = toCandidate(source, sourceId)
      try {
        await sidecar.append(row)
        candidateIds.push(row.id)
      } catch (err) {
        warnings.push(
          `candidate "${row.id}" — sidecar append failed (${
            err instanceof Error ? err.message : "unknown"
          })`
        )
      }

      // Audit event per archived source.
      await emitter
        .emit("corpus.candidate.discovered", {
          id: row.id,
          importerId: target.importerId,
          batchId,
          contentHash: source.contentHash,
          provenanceKind: `imported-from-${target.importerId}`,
        })
        .catch(() => undefined)
    }

    return Object.freeze({
      importerId: target.importerId,
      batchId,
      archivedSlugs: Object.freeze(archivedSlugs),
      duplicateSlugs: Object.freeze(duplicateSlugs),
      candidateIds: Object.freeze(candidateIds),
      warnings: Object.freeze(warnings),
    })
  }
}

// ── Defaults + helpers ─────────────────────────────────────────────

function defaultToCandidate(
  s: ImportedSource,
  sourceId: string
): CandidateRow {
  return {
    id: sourceId,
    status: "discovered",
    corpusKind: "example",
    sourcePath: undefined, // filled in by archiver via path mapping
    sourceUrl: s.originalUrl,
    contentHash: s.contentHash,
    title: s.title,
    summary: undefined,
    discoveredAt: new Date().toISOString(),
    discoveredBy: "ws://operators/importer-runner",
    provenanceKind: "imported",
  }
}

function serializeSource(
  source: ImportedSource,
  archiveDirSegment: string,
  clock: ClockPort
): string {
  const fm: Record<string, unknown> = {
    schema: "knowledge.source/v1",
    id: source.slug,
    path: `${archiveDirSegment}/${source.slug}.md`,
    title: source.title,
    captured_at: clock.now().toISOString(),
    content_hash: source.contentHash,
    authority: source.authority ?? "secondary",
  }
  if (source.language) fm.language = source.language
  if (source.tags && source.tags.length > 0) fm.tags = source.tags
  if (source.originalUrl || source.corpusMetadata) {
    fm.metadata = {
      corpus: {
        ...(source.originalUrl ? { originalUrl: source.originalUrl } : {}),
        ...(source.corpusMetadata ?? {}),
      },
    }
  }
  return matter.stringify(
    source.body.startsWith("\n") ? source.body : "\n" + source.body,
    fm
  )
}

function joinPath(a: string, b: string): string {
  if (!a) return b
  return a.endsWith("/") ? a + b : a + "/" + b
}
