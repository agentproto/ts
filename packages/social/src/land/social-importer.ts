/**
 * SocialImporter — adapts a captured footprint onto the corpus
 * CorpusImporter contract, so the existing ImporterRunner lands sources
 * + candidate rows (dedup, archival, events) with zero new I/O code.
 *
 * The capture is buffered once by the orchestrator (both sinks consume
 * it), so this importer takes the records directly rather than the port.
 */

import type {
  CorpusImporter,
  ImportedSource,
  ImporterTarget,
  CandidateRow,
} from "@agentproto/corpus"
import type { FootprintRecord } from "../model/footprint.js"
import {
  footprintToSources,
  type FootprintToCorpusOptions,
} from "./footprint-to-corpus.js"

export class SocialImporter implements CorpusImporter {
  readonly id = "social"
  readonly label = "Social footprint"

  constructor(
    private readonly records: readonly FootprintRecord[],
    private readonly options: FootprintToCorpusOptions
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async *enumerate(_target: ImporterTarget): AsyncIterable<ImportedSource> {
    for (const source of footprintToSources(this.records, this.options)) {
      yield source
    }
  }
}

/**
 * Candidate mapper for social sources — sets `corpusKind: "social-post"`
 * so the character distiller can select them. `now` is injected to keep
 * the kit clock-pure (pass `clock.now().toISOString()`).
 */
export function makeSocialCandidateMapper(opts: {
  readonly now: string
  readonly discoveredBy?: string
}): (s: ImportedSource, sourceId: string) => CandidateRow {
  return (s, sourceId) => ({
    id: sourceId,
    status: "discovered",
    corpusKind: "social-post",
    sourceUrl: s.originalUrl,
    contentHash: s.contentHash,
    title: s.title,
    discoveredAt: opts.now,
    discoveredBy: opts.discoveredBy ?? "ws://operators/social-importer",
    provenanceKind: "imported-from-social",
  })
}
