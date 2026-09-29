/**
 * `agentproto sessions --stats[=full]` - per-session RAM / CPU / process
 * counts, sorted by RAM, with a totals row and a host header.
 *
 * The data comes from the daemon (`GET /sessions/stats`, the same report the
 * `session_stats` MCP tool returns); this module only parses the flag and
 * renders. Rendering is a pure function of (rows, report) so the output is
 * snapshot-testable without a daemon or a terminal.
 */
import type { LabeledProcessStatsReport, LabeledSessionStats, ProcessDetail } from "@agentproto/runtime"

export type StatsMode = "summary" | "full"

export class StatsFlagError extends Error {}

/**
 * Pull `--stats`, `--stats=full|summary|true` and `--verbose`/`-v` out of the
 * raw args (parseArgs can't express an optional-value flag). `--stats
 * --verbose` is the spelling of `--stats=full`; `--verbose` alone is ignored
 * so it stays free for other uses. Returns the remaining args untouched.
 */
export function extractStatsFlag(args: readonly string[]): {
  rest: string[]
  stats: StatsMode | undefined
} {
  const rest: string[] = []
  let stats: StatsMode | undefined
  let verbose = false
  for (const a of args) {
    if (a === "--stats") {
      stats ??= "summary"
    } else if (a.startsWith("--stats=")) {
      const v = a.slice("--stats=".length)
      if (v === "full") stats = "full"
      else if (v === "summary" || v === "true" || v === "") stats ??= "summary"
      else throw new StatsFlagError(`--stats expects "full" (or no value), got "${v}"`)
    } else if (a === "--verbose" || a === "-v") {
      verbose = true
    } else {
      rest.push(a)
    }
  }
  if (!stats) return { rest: [...args], stats: undefined }
  return { rest, stats: verbose ? "full" : stats }
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/** 1 KB = 1024 B (RSS and `free` memory are binary quantities). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  let v = n
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${Math.round(v)} B` : `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`
}

export function formatCpu(pct: number): string {
  return `${pct.toFixed(1)}%`
}

export function formatElapsed(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

/** One listed session, pre-rendered by the caller (status text depends on the
 *  presence classifier, which stays in sessions.ts). */
export interface StatsListRow {
  id: string
  label: string
  kind: string
  status: string
  pinned?: boolean
}

export interface RenderStatsOptions {
  colour: boolean
  mode: StatsMode
  /** Max child-process lines shown per session in `full` mode. */
  maxProcs?: number
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s)
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

function topSummary(stats: { topCommands: Array<{ name: string; count: number; rssBytes: number }> }, n = 3): string {
  return stats.topCommands
    .slice(0, n)
    .map(c => `${c.name}${c.count > 1 ? ` x${c.count}` : ""} ${formatBytes(c.rssBytes)}`)
    .join(", ")
}

function procLines(procs: readonly ProcessDetail[], indent: string, max: number): string[] {
  const shown = procs.slice(0, max)
  const w = Math.max(...shown.map(p => String(p.pid).length), 3)
  const cw = Math.min(Math.max(...shown.map(p => p.command.length), 7), 28)
  const lines = shown.map(
    p =>
      `${indent}${padL(String(p.pid), w)}  ${pad(clip(p.command, cw), cw)}  ${padL(formatBytes(p.rssBytes), 8)}  ${padL(formatCpu(p.cpuPercent), 7)}  ${padL(formatElapsed(p.elapsedSec), 4)}${p.detached ? "  (detached)" : ""}`,
  )
  if (procs.length > shown.length) lines.push(`${indent}... ${procs.length - shown.length} more`)
  return lines
}

/**
 * Render the `--stats` view: host header, one row per session sorted by RAM
 * (unmeasured rows last, original order), the daemon and provisioning buckets,
 * a totals row, then the orphans section. Pure - no I/O, no clock.
 */
export function renderStatsTable(
  rows: readonly StatsListRow[],
  report: LabeledProcessStatsReport,
  opts: RenderStatsOptions,
): string {
  const dim = (s: string): string => (opts.colour ? `\x1b[2m${s}\x1b[0m` : s)
  const warn = (s: string): string => (opts.colour ? `\x1b[33m${s}\x1b[0m` : s)
  const maxProcs = opts.maxProcs ?? 12
  const out: string[] = []

  const h = report.host
  out.push(
    `host: load ${h.loadAvg.map(n => n.toFixed(2)).join(" ")} (${h.cpuCount} cpus) | ` +
      `memory free ${formatBytes(h.freeMemBytes)} of ${formatBytes(h.totalMemBytes)}`,
  )
  out.push("")

  const measured = new Map<string, LabeledSessionStats>(report.sessions.map(s => [s.sessionId, s]))
  const ordered = rows
    .map((r, i) => ({ r, i, s: measured.get(r.id) }))
    .sort((a, b) => (b.s?.rssBytes ?? -1) - (a.s?.rssBytes ?? -1) || a.i - b.i)

  interface Line {
    id: string
    label: string
    kind: string
    status: string
    ram: string
    cpu: string
    procs: string
    top: string
    detail?: string[]
    muted?: boolean
  }
  const lines: Line[] = ordered.map(({ r, s }) => ({
    id: r.id,
    label: r.label || "-",
    kind: r.kind,
    status: r.status,
    ram: s ? formatBytes(s.rssBytes) : "-",
    cpu: s ? formatCpu(s.cpuPercent) : "-",
    procs: s ? String(s.procCount) : "-",
    top: s ? topSummary(s) : "",
    muted: !s,
    ...(opts.mode === "full" && s?.processes ? { detail: procLines(s.processes, "      ", maxProcs) } : {}),
  }))

  const d = report.daemon
  const p = report.provisioning
  const buckets: Line[] = []
  if (!report.scoped) {
    buckets.push({
      id: "-",
      label: `(daemon pid ${d.pid})`,
      kind: "daemon",
      status: "",
      ram: formatBytes(d.rssBytes),
      cpu: formatCpu(d.cpuPercent),
      procs: String(d.procCount),
      top: topSummary(d),
      ...(opts.mode === "full" && d.processes ? { detail: procLines(d.processes, "      ", maxProcs) } : {}),
    })
    const pending = p.inFlight.length
    buckets.push({
      id: "-",
      label: pending > 0 ? `(worktree provisioning, ${pending} in flight)` : "(worktree provisioning)",
      kind: "provision",
      status: "",
      ram: formatBytes(p.rssBytes),
      cpu: formatCpu(p.cpuPercent),
      procs: String(p.procCount),
      top: topSummary(p),
      detail: [
        ...p.inFlight.map(f => `      in flight: ${f.label ?? f.sessionId ?? "?"} (${f.cwd})`),
        ...(opts.mode === "full" && p.processes ? procLines(p.processes, "      ", maxProcs) : []),
      ],
    })
  }

  const all = [...lines, ...buckets]
  const totalLabel = report.scoped ? "(your sessions)" : "(sessions + daemon + provisioning)"
  const w = {
    id: Math.max(...all.map(l => l.id.length), 2),
    label: Math.min(Math.max(...all.map(l => l.label.length), totalLabel.length, 5), 34),
    kind: Math.max(...all.map(l => l.kind.length), 4),
    status: Math.max(...all.map(l => l.status.length), 6),
    ram: Math.max(...all.map(l => l.ram.length), 3, formatBytes(report.totals.rssBytes).length),
    cpu: Math.max(...all.map(l => l.cpu.length), 3, formatCpu(report.totals.cpuPercent).length),
    procs: Math.max(...all.map(l => l.procs.length), 5),
  }
  const fmt = (l: Line): string =>
    `${pad(l.id, w.id)}  ${pad(clip(l.label, w.label), w.label)}  ${pad(l.kind, w.kind)}  ${pad(l.status, w.status)}  ` +
    `${padL(l.ram, w.ram)}  ${padL(l.cpu, w.cpu)}  ${padL(l.procs, w.procs)}  ${l.top}`.trimEnd()

  out.push(
    dim(
      `${pad("ID", w.id)}  ${pad("LABEL", w.label)}  ${pad("KIND", w.kind)}  ${pad("STATUS", w.status)}  ` +
        `${padL("RAM", w.ram)}  ${padL("CPU", w.cpu)}  ${padL("PROCS", w.procs)}  TOP`,
    ),
  )
  for (const l of lines) {
    out.push(l.muted ? dim(fmt(l)) : fmt(l))
    if (l.detail?.length) out.push(...l.detail)
  }
  if (buckets.length > 0) out.push(dim("-".repeat(Math.min(100, fmt(buckets[0]!).length))))
  for (const l of buckets) {
    out.push(fmt(l))
    if (l.detail?.length) out.push(...l.detail)
  }
  const t = report.totals
  out.push(
    fmt({
      id: "TOTAL",
      label: totalLabel,
      kind: "",
      status: "",
      ram: formatBytes(t.rssBytes),
      cpu: formatCpu(t.cpuPercent),
      procs: String(t.procCount),
      top: "",
    }),
  )

  if (!report.scoped) {
    out.push("")
    if (report.orphans.length === 0) {
      out.push(dim("orphans: none (no agentproto-looking processes outside a live session)"))
    } else {
      out.push(
        warn(
          `orphans: ${report.orphans.length} agentproto-looking process group(s) with no live session (reported only, never killed)`,
        ),
      )
      const ow = {
        pid: Math.max(...report.orphans.map(o => String(o.pid).length), 3),
        cmd: Math.min(Math.max(...report.orphans.map(o => o.command.length), 7), 24),
        ram: Math.max(...report.orphans.map(o => formatBytes(o.rssBytes).length), 3),
        cpu: Math.max(...report.orphans.map(o => formatCpu(o.cpuPercent).length), 3),
        age: Math.max(...report.orphans.map(o => formatElapsed(o.elapsedSec).length), 3),
        session: Math.max(...report.orphans.map(o => (o.sessionHint ?? "-").length), 7),
      }
      out.push(
        dim(
          `${padL("PID", ow.pid)}  ${pad("COMMAND", ow.cmd)}  ${padL("RAM", ow.ram)}  ${padL("CPU", ow.cpu)}  ${padL("PROCS", 5)}  ${padL("AGE", ow.age)}  ${pad("SESSION", ow.session)}  WHY`,
        ),
      )
      for (const o of report.orphans) {
        out.push(
          `${padL(String(o.pid), ow.pid)}  ${pad(clip(o.command, ow.cmd), ow.cmd)}  ${padL(formatBytes(o.rssBytes), ow.ram)}  ${padL(formatCpu(o.cpuPercent), ow.cpu)}  ${padL(String(o.procCount), 5)}  ${padL(formatElapsed(o.elapsedSec), ow.age)}  ${pad(o.sessionHint ?? "-", ow.session)}  ${o.reason}`,
        )
        if (opts.mode === "full" && o.processes) out.push(...procLines(o.processes, "      ", maxProcs))
      }
    }
  }
  out.push("")
  out.push(
    dim(`sampled ${report.sampledAt}; CPU is ps's %CPU (kernel-averaged, lags spikes); cached ~3s`),
  )
  return out.join("\n") + "\n"
}
