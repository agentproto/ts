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

import { scanDistilledSourceIds } from "./scan.js"
import { distillFromImporter, type DistillCoreReport } from "./generate.js"
import type { DistillIndex } from "./distill-index.js"
import type { DistillDescriptor, DistillScope } from "./registry.js"

export interface DistillReport extends DistillCoreReport {
  readonly descriptorId: string
  readonly scopeId: string
}

export interface RunDistillOptions {
  /** Optional ledger — records every distilled unit (what/when/engine). */
  readonly index?: DistillIndex
  /** Engine label written into the ledger. */
  readonly engine?: string
}

export async function runDistill<S extends DistillScope>(
  descriptor: DistillDescriptor<S>,
  scope: S,
  opts: RunDistillOptions = {}
): Promise<DistillReport> {
  const empty: DistillCoreReport = {
    unitsConsidered: 0,
    unitsDistilled: 0,
    entriesWritten: 0,
    skipped: 0,
    unchanged: 0,
  }

  const target = await descriptor.target(scope)
  const distilled = await scanDistilledSourceIds(target.fs)
  const binding = descriptor.bind(scope, target)
  const config = await binding.prepare(distilled)
  // null ⇒ the binding found nothing fresh to import this run.
  if (!config) {
    return { descriptorId: descriptor.id, scopeId: scope.id, ...empty }
  }

  // The descriptor owns SOURCE selection (binding.prepare) + provenance keying;
  // the shared core owns the import → distill → (ledger) loop.
  const core = await distillFromImporter({
    fs: target.fs,
    clock: target.clock,
    distiller: descriptor.distiller(scope),
    importer: binding.importer,
    importerId: descriptor.id,
    config,
    provenanceId: binding.provenanceId,
    ...(opts.index ? { index: opts.index } : {}),
    ...(opts.engine ? { engine: opts.engine } : {}),
  })
  return { descriptorId: descriptor.id, scopeId: scope.id, ...core }
}
