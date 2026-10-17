/**
 * Shared disk+registry collection for the `sessions_report` surfaces (the
 * MCP tool and `GET /sessions/report`), mirroring `usage-rollup-service.ts`'s
 * split between a pure reducer and an impure collector. Keeping this in one
 * place means the two surfaces can't drift on how they enumerate sessions.
 *
 * Merges the live registry (capped at `HISTORY_CAP` per bucket, see
 * `session-cold-list.ts`) with the cold on-disk rows it cannot hold, so a
 * `--since 24h` report on a busy host doesn't silently undercount. A live
 * row always wins over a same-id cold one.
 */
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import { coldSessionRows } from "./session-cold-list.js"
import { buildSessionReport, type SessionReport, type SessionReportInput } from "./session-report.js"

function toReportInput(d: SessionDescriptor): SessionReportInput {
  return {
    id: d.id,
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.label !== undefined ? { label: d.label } : {}),
    status: d.status,
    ...(d.alive !== undefined ? { alive: d.alive } : {}),
    ...(d.harness !== undefined ? { harness: d.harness } : d.adapterSlug !== undefined ? { harness: d.adapterSlug } : {}),
    ...(d.model !== undefined ? { model: d.model } : {}),
    startedAt: d.startedAt,
    ...(d.endedAt !== undefined ? { endedAt: d.endedAt } : {}),
    ...(d.endedReason !== undefined ? { endedReason: d.endedReason } : {}),
    ...(d.costUsd !== undefined ? { costUsd: d.costUsd } : {}),
    ...(d.tokensIn !== undefined ? { tokensIn: d.tokensIn } : {}),
    ...(d.tokensOut !== undefined ? { tokensOut: d.tokensOut } : {}),
    ...(d.auth?.mode !== undefined ? { authMode: d.auth.mode } : {}),
    ...(d.keepAlive !== undefined ? { keepAlive: d.keepAlive } : {}),
    ...(d.openedPrs !== undefined ? { openedPrs: d.openedPrs } : {}),
  }
}

/**
 * Every `agent-cli` session the daemon knows about (live + cold), deduped by
 * id with the live row winning, projected to {@link SessionReportInput}.
 * `onlyIds` is the subtree scope a scoped orchestrator caller is restricted
 * to (same convention as `collectSessionSnapshots` in usage-rollup-service).
 */
export function collectSessionReportInputs(
  registry: SessionsRegistry,
  opts?: { onlyIds?: Set<string>; now?: number },
): SessionReportInput[] {
  const byId = new Map<string, SessionDescriptor>()
  for (const d of coldSessionRows(registry.transcriptBaseDir, opts?.now)) byId.set(d.id, d)
  for (const d of registry.list({ includeArchived: true })) byId.set(d.id, d)

  let descriptors = Array.from(byId.values()).filter(d => d.kind === "agent-cli")
  if (opts?.onlyIds) {
    const ids = opts.onlyIds
    descriptors = descriptors.filter(d => ids.has(d.id))
  }
  return descriptors.map(toReportInput)
}

/** Collect + reduce in one call — the common case for both surfaces. */
export function buildSessionReportFromRegistry(
  registry: SessionsRegistry,
  opts: { since: string; nowMs?: number; topN?: number; onlyIds?: Set<string> },
): SessionReport {
  const inputs = collectSessionReportInputs(registry, {
    ...(opts.onlyIds ? { onlyIds: opts.onlyIds } : {}),
    ...(opts.nowMs !== undefined ? { now: opts.nowMs } : {}),
  })
  return buildSessionReport(inputs, opts)
}
