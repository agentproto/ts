/**
 * distillFromImporter — the importer → distill core, shared by every entrypoint.
 *
 * This is the kind-agnostic engine the conversation/web/source pipelines all
 * ride on: take a configured IMPORTER, stream its sources, and run the DISTILLER
 * over each — writing refined AIP-10 entries via {@link DistillRunner} and
 * (optionally) recording each unit in the {@link DistillIndex} ledger.
 *
 * It owns NO source selection: the caller hands it an already-prepared importer
 * `config` (which refs/urls/paths to pull). That keeps two very different
 * entrypoints on ONE core:
 *   - cron `runDistill(descriptor, scope)` — resolves the guild target + the
 *     binding's fresh-ref `prepare`, then calls this.
 *   - standalone CLI / runtime tool — points an FsPort at any corpus folder and
 *     a transcript/local-files importer at any input, then calls this.
 *
 * Idempotent: {@link DistillRunner} skips an entry slug that already exists, and
 * when a `index` ledger is supplied the caller can pre-skip sources by content
 * hash (re-distill only on change). Pure — consumes FsPort + ClockPort + an
 * injected DistillPort, no HTTP / no child process.
 */

import { DistillRunner, type DistillSource, type EntryLayout } from "./runner.js"
import type { DistillPort } from "./types.js"
import type { DistillIndex } from "./distill-index.js"
import type { ClockPort } from "../ports/clock.port.js"
import type { FsPort } from "../ports/fs.port.js"
import type {
  CorpusImporter,
  ImportedSource,
} from "../importers/types.js"

/** Aggregate of one importer → distill pass (no descriptor/scope coupling). */
export interface DistillCoreReport {
  /** Sources the importer yielded this run. */
  unitsConsidered: number
  /** Units that produced ≥1 new entry. */
  unitsDistilled: number
  entriesWritten: number
  /** Entry slugs skipped because an identical title already existed. */
  skipped: number
  /** Sources skipped because the ledger shows an unchanged prior distillation. */
  unchanged: number
}

export interface DistillFromImporterOptions {
  readonly fs: FsPort
  readonly clock: ClockPort
  readonly distiller: DistillPort
  /** The configured importer (ConversationImporter, LocalFilesImporter, …). */
  readonly importer: CorpusImporter
  /** Stable importer id — passed through as the enumerate target's importerId. */
  readonly importerId: string
  /** Importer-native, already-prepared config (`{refs}`, `{urls}`, `{rootPath}`…). */
  readonly config: Readonly<Record<string, unknown>>
  /** Entry path layout; defaults to the runner's "dated". */
  readonly layout?: EntryLayout
  /**
   * Provenance id from an imported source — the value written into each entry's
   * `sources:` backlink AND the ledger key. Defaults to the importer's slug.
   */
  readonly provenanceId?: (imported: ImportedSource) => string
  /**
   * Optional ledger. When set, each distilled unit is recorded (sourceId,
   * timestamp, engine, content hash, entry count) AND a source whose ledger row
   * already matches its content hash is skipped before the LLM is called.
   */
  readonly index?: DistillIndex
  /** Engine label written into the ledger (e.g. "claude-code"). */
  readonly engine?: string
}

export async function distillFromImporter(
  opts: DistillFromImporterOptions
): Promise<DistillCoreReport> {
  const report: DistillCoreReport = {
    unitsConsidered: 0,
    unitsDistilled: 0,
    entriesWritten: 0,
    skipped: 0,
    unchanged: 0,
  }

  const runner = new DistillRunner({
    fs: opts.fs,
    clock: opts.clock,
    distiller: opts.distiller,
    ...(opts.layout ? { layout: opts.layout } : {}),
  })
  const provenanceId = opts.provenanceId ?? (s => s.slug)

  for await (const imported of opts.importer.enumerate({
    importerId: opts.importerId,
    config: opts.config,
  })) {
    report.unitsConsidered++
    const sourceId = provenanceId(imported)

    // Ledger fast-path: an unchanged source (same content hash) needs no LLM.
    if (
      opts.index &&
      (await opts.index.isDistilled(sourceId, imported.contentHash))
    ) {
      report.unchanged++
      continue
    }

    const source: DistillSource = {
      id: sourceId,
      title: imported.title,
      body: imported.body,
      ...(imported.tags ? { tags: imported.tags } : {}),
    }
    try {
      const r = await runner.run(source)
      if (r.entryPaths.length > 0) report.unitsDistilled++
      report.entriesWritten += r.entryPaths.length
      report.skipped += r.skipped.length

      // Record the run regardless of new-entry count — "distilled at T, produced
      // N" is the audit fact; 0 new entries (all slugs already existed) is valid.
      if (opts.index) {
        await opts.index.record({
          sourceId,
          title: imported.title,
          distilledAt: opts.clock.now().toISOString(),
          ...(opts.engine ? { engine: opts.engine } : {}),
          ...(imported.contentHash ? { contentHash: imported.contentHash } : {}),
          entryCount: r.entryPaths.length,
          ...(r.entryPaths.length ? { entryPaths: r.entryPaths } : {}),
        })
      }
    } catch {
      // One unit failing (rate cap, transient) must not abort the rest — it
      // stays unrecorded and is retried on the next run.
    }
  }
  return report
}
