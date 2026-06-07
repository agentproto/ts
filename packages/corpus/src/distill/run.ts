/**
 * runDistill — the generic distill pass for one (descriptor × scope).
 *
 * The kind-agnostic generalization of the conversation pipeline: resolve the
 * scope's TARGET, scan which provenance ids are already distilled, ask the
 * binding (SOURCE + IMPORTER) for the fresh refs, import each, and run the
 * DISTILLER over it — writing refined AIP-10 entries via `DistillRunner`.
 * No per-kind branches: every variation rides on the descriptor's slots.
 *
 * Idempotent: a unit whose provenance id already backs an entry is skipped by
 * the binding's `prepare`, and `DistillRunner` additionally skips any entry
 * slug that already exists — so a daily re-run only adds fresh material.
 */

import { DistillRunner, type DistillSource } from "./runner.js"
import { scanDistilledSourceIds } from "./scan.js"
import type { DistillDescriptor, DistillScope } from "./registry.js"

export interface DistillReport {
  readonly descriptorId: string
  readonly scopeId: string
  /** Sources the importer yielded this run. */
  unitsConsidered: number
  /** Units that produced ≥1 new entry. */
  unitsDistilled: number
  entriesWritten: number
  /** Entry slugs skipped because an identical title already existed. */
  skipped: number
}

export async function runDistill<S extends DistillScope>(
  descriptor: DistillDescriptor<S>,
  scope: S
): Promise<DistillReport> {
  const report: DistillReport = {
    descriptorId: descriptor.id,
    scopeId: scope.id,
    unitsConsidered: 0,
    unitsDistilled: 0,
    entriesWritten: 0,
    skipped: 0,
  }

  const target = await descriptor.target(scope)
  const distilled = await scanDistilledSourceIds(target.fs)
  const binding = descriptor.bind(scope, target)
  const config = await binding.prepare(distilled)
  // null ⇒ the binding found nothing fresh to import this run.
  if (!config) return report

  const runner = new DistillRunner({
    fs: target.fs,
    clock: target.clock,
    distiller: descriptor.distiller(scope),
  })

  for await (const imported of binding.importer.enumerate({
    importerId: descriptor.id,
    config,
  })) {
    report.unitsConsidered++
    // Provenance id is binding-defined (window slug, URL, …) so the skip-scan
    // matches it on the next run — not the slugified entry slug.
    const source: DistillSource = {
      id: binding.provenanceId(imported),
      title: imported.title,
      body: imported.body,
      ...(imported.tags ? { tags: imported.tags } : {}),
    }
    try {
      const r = await runner.run(source)
      if (r.entryPaths.length > 0) report.unitsDistilled++
      report.entriesWritten += r.entryPaths.length
      report.skipped += r.skipped.length
    } catch {
      // One unit failing (rate cap, transient) must not abort the rest — it
      // stays undistilled and is retried next run.
    }
  }
  return report
}
