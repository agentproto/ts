/**
 * `agentproto sessions report [--since 12h] [--topN 5] [--json]` — the text
 * renderer for the `sessions_report` MCP tool's output (same report the CLI
 * fetches from `GET /sessions/report`). Rendering is a pure function of the
 * report so it's snapshot-testable without a daemon.
 */
import type { SessionReport } from "@agentproto/runtime"

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`
}

function fmtDurationMs(ms: number): string {
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(0)}s`
  const min = sec / 60
  if (min < 60) return `${min.toFixed(1)}m`
  const hr = min / 60
  if (hr < 48) return `${hr.toFixed(1)}h`
  return `${(hr / 24).toFixed(1)}d`
}

function fmtCountRows(rows: readonly { key: string; count: number }[]): string {
  if (rows.length === 0) return "  (none)"
  return rows.map(r => `  ${r.key}: ${r.count}`).join("\n")
}

function fmtCostBucket(label: string, b: SessionReport["cost"]["total"]): string {
  const parts = [fmtUsd(b.costUsd), `${b.tokensIn} in / ${b.tokensOut} out tokens`]
  if (b.unpricedTokens > 0) parts.push(`${b.unpricedTokens} unpriced tokens`)
  return `  ${label}: ${parts.join(", ")} (${b.sessionCount} session${b.sessionCount === 1 ? "" : "s"})`
}

/** Render the full text report. Pure — no I/O, no clock. */
export function renderSessionReportText(report: SessionReport): string {
  const out: string[] = []
  out.push(`sessions report: ${report.since} (${report.windowStart} .. ${report.now})`)
  out.push(`total sessions: ${report.totalSessions}`)
  out.push("")

  out.push("by harness:")
  out.push(fmtCountRows(report.byHarness))
  out.push("")
  out.push("by model:")
  out.push(fmtCountRows(report.byModel))
  out.push("")
  out.push("by status:")
  out.push(fmtCountRows(report.byStatus))
  out.push("")
  out.push("by end reason (terminal sessions only):")
  out.push(fmtCountRows(report.byEndReason))
  out.push("")

  out.push(
    `duration: total ${fmtDurationMs(report.duration.totalMs)}, ` +
      `average ${fmtDurationMs(report.duration.averageMs)} ` +
      `(${report.duration.sessionCount} session${report.duration.sessionCount === 1 ? "" : "s"} measured)`,
  )
  out.push("")

  out.push("cost:")
  out.push(fmtCostBucket("subscription", report.cost.subscription))
  out.push(fmtCostBucket("api-key", report.cost.apiKey))
  out.push(fmtCostBucket("unknown auth", report.cost.unknown))
  out.push(fmtCostBucket("total", report.cost.total))
  out.push("")

  out.push(`PRs opened: ${report.openedPrs.length}`)
  for (const pr of report.openedPrs) {
    out.push(`  #${pr.number} ${pr.url} (${pr.sessionName ?? pr.sessionId})`)
  }
  out.push("")

  out.push(`top by cost (${report.topByCost.length}):`)
  for (const s of report.topByCost) {
    out.push(
      `  ${s.costUsd !== undefined ? fmtUsd(s.costUsd) : "-"}  ${s.id}  ${s.name ?? ""}  ` +
        `${s.harness ?? "-"}/${s.model ?? "-"}  ${s.status}`,
    )
  }
  out.push("")

  out.push(`top by duration (${report.topByDuration.length}):`)
  for (const s of report.topByDuration) {
    out.push(
      `  ${fmtDurationMs(s.durationMs ?? 0)}  ${s.id}  ${s.name ?? ""}  ` +
        `${s.harness ?? "-"}/${s.model ?? "-"}  ${s.status}`,
    )
  }
  out.push("")

  out.push(`active sessions (${report.activeSessions.length}):`)
  for (const s of report.activeSessions) {
    out.push(`  ${s.id}  ${s.name ?? ""}  ${s.harness ?? "-"}/${s.model ?? "-"}  started ${s.startedAt}`)
  }
  out.push("")

  out.push(`permanent agents (${report.permanentAgents.length}):`)
  for (const s of report.permanentAgents) {
    out.push(`  ${s.id}  ${s.name ?? ""}  ${s.harness ?? "-"}/${s.model ?? "-"}  started ${s.startedAt}`)
  }

  return out.join("\n") + "\n"
}
