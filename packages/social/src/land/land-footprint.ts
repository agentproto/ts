/**
 * landFootprint — the single landing pipeline a footprint fans out through.
 *
 * Both surfaces that consume a capture (the CLI script and the in-product
 * `profile_social` tool) used to inline the same two-sink fan-out: corpus
 * (the subject's voice → immutable AIP-10 sources + candidates) and graph
 * (their network → idempotent merge ops). Re-deciding md-vs-graph at each
 * call-site is the duplication this kills — the decision lives here, once.
 *
 * Pure orchestration: the host injects an already-built `ImporterRunner`
 * (carrying its fs / clock / identity + the candidate mapper that stamps
 * `discoveredBy` + `now` provenance) and, opt-in, a `GraphSinkPort`. A graph
 * port that is absent ⇒ the graph sink is skipped at zero cost; a port that
 * is present ⇒ the network always lands (default-on, no silent opt-out flag).
 * The host owns the graph store lifecycle so it can read a dossier back on
 * the same connection after landing.
 */

import type { ImporterRunner } from "@agentproto/corpus"

import type { FootprintFile, FootprintSubject } from "../model/footprint.schema.js"
import { footprintSubject } from "../model/footprint.schema.js"
import type { GraphSinkPort } from "../ports/graph-sink.port.js"
import { footprintToGraphOps, runGraphSink } from "./footprint-to-graph.js"
import { SocialImporter } from "./social-importer.js"

export interface LandCorpusSink {
  /**
   * A runner the host built with its own fs / clock / identity and a
   * `makeSocialCandidateMapper` carrying provenance (`discoveredBy`, `now`).
   * landFootprint only drives it — provenance is the runner's concern.
   */
  readonly runner: ImporterRunner
  /** Extra source tags; the subject's platform is always prepended. */
  readonly tags?: readonly string[]
}

export interface LandFootprintSinks {
  readonly corpus?: LandCorpusSink
  readonly graph?: GraphSinkPort
}

export interface LandCorpusResult {
  readonly archived: number
  readonly duplicates: number
  readonly candidates: number
  readonly warnings: readonly string[]
}

export interface LandGraphResult {
  readonly applied: number
  readonly failed: number
}

export interface LandFootprintResult {
  /** Resolved subject (stamped → profile-derived), or null if undeterminable. */
  readonly subject: FootprintSubject | null
  readonly corpus?: LandCorpusResult
  readonly graph?: LandGraphResult
}

export async function landFootprint(
  file: FootprintFile,
  sinks: LandFootprintSinks
): Promise<LandFootprintResult> {
  const subject = footprintSubject(file)
  const records = file.records
  const profile = file.profile ?? null

  let corpus: LandCorpusResult | undefined
  if (sinks.corpus) {
    const platform = subject?.platform
    const handle = subject?.handle ?? profile?.handle ?? ""
    const tags = platform
      ? [platform, ...(sinks.corpus.tags ?? [])]
      : [...(sinks.corpus.tags ?? [])]
    const report = await sinks.corpus.runner.run(
      new SocialImporter(records, {
        handle,
        profileUrl: profile?.profileUrl ?? null,
        tags,
      }),
      { importerId: "social", config: {} }
    )
    corpus = {
      archived: report.archivedSlugs.length,
      duplicates: report.duplicateSlugs.length,
      candidates: report.candidateIds.length,
      warnings: report.warnings,
    }
  }

  let graph: LandGraphResult | undefined
  if (sinks.graph) {
    const ops = footprintToGraphOps(records, {
      platform: subject?.platform ?? profile?.platform ?? "",
      handle: subject?.handle ?? profile?.handle ?? "",
      name: profile?.name,
    })
    graph = await runGraphSink(ops, sinks.graph)
  }

  return { subject, corpus, graph }
}
