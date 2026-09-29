/**
 * `agentproto host load` - one-screen host load report: loadavg vs cores, CPU,
 * RAM/swap, per-disk IO, the heaviest processes with their owning session and
 * a WARNINGS section (swap pressure, old busy orphans, deleted-cwd loops,
 * filesystem-wide scans, duplicate servers, load >> cores).
 *
 * The data is the daemon's `GET /host/load` (the same JSON the `host_load` MCP
 * tool returns). When the daemon is absent or too busy to answer - the very
 * situation this verb is for - it falls back to sampling in-process, which
 * only loses session attribution. Rendering is a pure function of the report
 * so the output is snapshot-testable.
 */
import { parseArgs } from "node:util"
import type { HostLoadReport, HostProcess, HostProcessOwner } from "@agentproto/runtime"
import { discoverDaemon, httpGetJson } from "./_daemon-helpers.js"
import { formatBytes, formatCpu, formatElapsed } from "./sessions-stats.js"

export const HOST_USAGE = `Usage:
  agentproto host load [--full] [--json] [--watch <seconds>] [--budget <ms>]
                       [--fresh] [--local] [--no-color]

One-screen host load report: load average vs core count, CPU user/sys/idle,
RAM (used/wired/compressor/free) and swap, per-disk transfers/s + MB/s, the top
10 processes by CPU and by memory footprint with their owning session
("orphan" / "system" / "daemon" otherwise), and WARNINGS.

  --full            also the per-session rollup and every process
  --json            machine-readable report (same JSON as GET /host/load)
  --watch <s>       refresh every <s> seconds (with --json: one JSON per line)
  --budget <ms>     time budget for the sample (default 1900; raise it to let
                    the macOS \`top\` footprint probe finish on a busy host)
  --fresh           bypass the daemon's ~2s cache
  --local           sample in this process instead of asking the daemon
                    (no session attribution)
  --no-color        plain output

Read-only: needs no sudo and never kills anything.
`

export interface RenderHostLoadOptions {
  colour: boolean
  mode: "summary" | "full"
  /** Extra line shown under the header (e.g. why the daemon was bypassed). */
  note?: string
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))
const padL = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s)
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 3)}...`)

export function ownerText(o: HostProcessOwner): string {
  switch (o.kind) {
    case "session":
      return o.label ? `${o.sessionId} (${o.label})` : o.sessionId
    case "orphan":
      return o.sessionHint ? `orphan (${o.sessionHint})` : "orphan"
    default:
      return o.kind
  }
}

function processTable(procs: readonly HostProcess[], indent: string): string[] {
  if (procs.length === 0) return [`${indent}(none)`]
  const w = {
    pid: Math.max(...procs.map(p => String(p.pid).length), 3),
    cmd: Math.min(Math.max(...procs.map(p => p.command.length), 7), 24),
    mem: Math.max(...procs.map(p => formatBytes(p.memoryBytes).length + (p.memorySource === "rss" ? 1 : 0)), 3),
    cmp: Math.max(...procs.map(p => (p.compressedBytes ? formatBytes(p.compressedBytes).length : 1)), 4),
    cpu: Math.max(...procs.map(p => formatCpu(p.cpuPercent).length), 3),
    age: Math.max(...procs.map(p => formatElapsed(p.elapsedSec).length), 3),
  }
  const head =
    `${indent}${padL("PID", w.pid)}  ${pad("COMMAND", w.cmd)}  ${padL("MEM", w.mem)}  ${padL("CMPR", w.cmp)}  ` +
    `${padL("CPU", w.cpu)}  ${padL("AGE", w.age)}  OWNER`
  const rows = procs.map(p => {
    const mem = formatBytes(p.memoryBytes) + (p.memorySource === "rss" ? "*" : "")
    const cmp = p.compressedBytes ? formatBytes(p.compressedBytes) : "-"
    return (
      `${indent}${padL(String(p.pid), w.pid)}  ${pad(clip(p.command, w.cmd), w.cmd)}  ${padL(mem, w.mem)}  ${padL(cmp, w.cmp)}  ` +
      `${padL(formatCpu(p.cpuPercent), w.cpu)}  ${padL(formatElapsed(p.elapsedSec), w.age)}  ${ownerText(p.owner)}`
    )
  })
  return [head, ...rows]
}

/** Render the report. Pure - no I/O, no clock. */
export function renderHostLoad(report: HostLoadReport, opts: RenderHostLoadOptions): string {
  const c = (code: string, s: string): string => (opts.colour ? `\x1b[${code}m${s}\x1b[0m` : s)
  const dim = (s: string): string => c("2", s)
  const out: string[] = []
  const lbl = (s: string): string => pad(s, 8)

  out.push(
    `host load  ${report.sampledAt}  (sampled in ${report.elapsedMs} ms, ${report.platform})` +
      (report.scoped ? "  [scoped to your sessions]" : ""),
  )
  if (opts.note) out.push(dim(opts.note))
  if (report.partial.length > 0) {
    out.push(c("33", `partial: ${report.partial.join("; ")}`))
  }
  out.push("")

  const [l1, l5, l15] = report.loadAvg
  out.push(
    `${lbl("load")}${l1.toFixed(2)} ${l5.toFixed(2)} ${l15.toFixed(2)}  (1m 5m 15m) on ${report.cpuCount} cores = ${report.loadPerCore.toFixed(1)}x per core`,
  )
  out.push(
    report.cpu
      ? `${lbl("cpu")}${report.cpu.userPercent.toFixed(1)}% user  ${report.cpu.sysPercent.toFixed(1)}% sys  ${report.cpu.idlePercent.toFixed(1)}% idle  ${dim(`(${report.cpu.source})`)}`
      : `${lbl("cpu")}${dim("unavailable")}`,
  )
  const m = report.memory
  const memParts = [
    m.usedBytes !== undefined ? `${formatBytes(m.usedBytes)} used of ${formatBytes(m.totalBytes)}` : `${formatBytes(m.totalBytes)} total`,
    ...(m.wiredBytes !== undefined ? [`wired ${formatBytes(m.wiredBytes)}`] : []),
    ...(m.compressorBytes !== undefined ? [`compressor ${formatBytes(m.compressorBytes)}`] : []),
    ...(m.cachedBytes !== undefined ? [`cached ${formatBytes(m.cachedBytes)}`] : []),
    `free ${formatBytes(m.freeBytes)}`,
    `available ${formatBytes(m.availableBytes)}`,
  ]
  out.push(`${lbl("memory")}${memParts.join("   ")}`)
  out.push(
    report.swap
      ? `${lbl("swap")}${formatBytes(report.swap.usedBytes)} of ${formatBytes(report.swap.totalBytes)} used (${Math.round(report.swap.percent)}%)`
      : `${lbl("swap")}${dim("unavailable")}`,
  )
  if (report.disks.length === 0) {
    out.push(`${lbl("disks")}${dim("unavailable")}`)
  } else {
    const nw = Math.max(...report.disks.map(d => d.name.length), 4)
    report.disks.forEach((d, i) => {
      out.push(
        `${i === 0 ? lbl("disks") : lbl("")}${pad(d.name, nw)}  ${padL(String(Math.round(d.tps)), 6)} tps  ${padL(d.mbPerSec.toFixed(1), 7)} MB/s` +
          (d.kbPerTransfer !== undefined ? `  ${padL(d.kbPerTransfer.toFixed(1), 6)} KB/op` : ""),
      )
    })
  }
  out.push("")

  if (report.warnings.length === 0) {
    out.push(dim("warnings: none"))
  } else {
    out.push(c("1", `WARNINGS (${report.warnings.length})`))
    for (const w of report.warnings) {
      const tag = w.severity === "critical" ? c("31", "[critical]") : c("33", "[warn]    ")
      out.push(`  ${tag} ${w.message}`)
    }
  }
  out.push("")

  out.push(c("1", "TOP BY CPU"))
  out.push(...processTable(report.topByCpu, "  "))
  out.push("")
  out.push(c("1", "TOP BY MEMORY") + dim("  (footprint incl. compressed; * = RSS only)"))
  out.push(...processTable(report.topByMemory, "  "))

  if (opts.mode === "full") {
    out.push("")
    out.push(c("1", "SESSIONS"))
    const rows = report.sessions ?? []
    if (rows.length === 0) out.push("  (no live session processes)")
    else {
      const idw = Math.max(...rows.map(r => r.sessionId.length), 2)
      const lw = Math.min(Math.max(...rows.map(r => (r.label ?? "-").length), 5), 30)
      out.push(dim(`  ${pad("ID", idw)}  ${pad("LABEL", lw)}  ${padL("MEM", 8)}  ${padL("RSS", 8)}  ${padL("CPU", 7)}  PROCS`))
      for (const r of rows) {
        out.push(
          `  ${pad(r.sessionId, idw)}  ${pad(clip(r.label ?? "-", lw), lw)}  ${padL(formatBytes(r.memoryBytes), 8)}  ${padL(formatBytes(r.rssBytes), 8)}  ${padL(formatCpu(r.cpuPercent), 7)}  ${r.procCount}`,
        )
      }
    }
    out.push("")
    out.push(c("1", `ALL PROCESSES (${report.processes?.length ?? 0})`))
    out.push(...processTable(report.processes ?? [], "  "))
  }
  out.push("")
  return out.join("\n")
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)
    p.then(
      v => {
        clearTimeout(t)
        resolve(v)
      },
      e => {
        clearTimeout(t)
        reject(e)
      },
    )
  })

interface Fetched {
  report: HostLoadReport
  note?: string
}

async function fetchReport(o: { mode: "summary" | "full"; budgetMs?: number; fresh: boolean; local: boolean }): Promise<Fetched> {
  let note: string | undefined
  if (!o.local) {
    const found = (await discoverDaemon()).found
    if (found) {
      const qs = new URLSearchParams({ detail: o.mode })
      if (o.fresh) qs.set("fresh", "true")
      if (o.budgetMs) qs.set("budgetMs", String(o.budgetMs))
      try {
        const report = await withTimeout(
          httpGetJson<HostLoadReport>(`${found.url}/host/load?${qs}`),
          (o.budgetMs ?? 1900) + 5000,
          "the daemon",
        )
        return { report }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        note = `daemon unavailable (${/404/.test(msg) ? "it predates GET /host/load; restart it to pick the route up" : msg}); sampled locally, no session attribution`
      }
    } else {
      note = "no daemon found; sampled locally, no session attribution"
    }
  }
  const { getHostLoadService } = await import("@agentproto/runtime")
  const report = await getHostLoadService().report([], {
    detail: o.mode,
    fresh: true,
    ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}),
  })
  return { report, ...(note ? { note } : {}) }
}

export async function runHost(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HOST_USAGE)
    return args.length === 0 ? 2 : 0
  }
  const sub = args[0]
  if (sub !== "load") {
    process.stderr.write(`agentproto host: unknown subcommand "${sub}"\n\n${HOST_USAGE}`)
    return 2
  }

  let values: {
    full?: boolean
    json?: boolean
    watch?: string
    budget?: string
    fresh?: boolean
    local?: boolean
    "no-color"?: boolean
  }
  try {
    values = parseArgs({
      args: [...args.slice(1)],
      allowPositionals: false,
      strict: true,
      options: {
        full: { type: "boolean" },
        json: { type: "boolean" },
        watch: { type: "string" },
        budget: { type: "string" },
        fresh: { type: "boolean" },
        local: { type: "boolean" },
        "no-color": { type: "boolean" },
      },
    }).values
  } catch (err) {
    process.stderr.write(`agentproto host load: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  const num = (raw: string | undefined, flag: string, min: number): number | undefined | "bad" => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min) {
      process.stderr.write(`agentproto host load: ${flag} expects a number >= ${min}, got "${raw}"\n`)
      return "bad"
    }
    return n
  }
  const watchSec = num(values.watch, "--watch", 1)
  const budgetMs = num(values.budget, "--budget", 300)
  if (watchSec === "bad" || budgetMs === "bad") return 2

  const mode = values.full ? "full" : "summary"
  const colour = !values["no-color"] && process.stdout.isTTY === true
  const once = async (): Promise<void> => {
    const { report, note } = await fetchReport({
      mode,
      fresh: values.fresh === true || watchSec !== undefined,
      local: values.local === true,
      ...(budgetMs !== undefined ? { budgetMs } : {}),
    })
    if (values.json) {
      process.stdout.write((watchSec !== undefined ? JSON.stringify(report) : JSON.stringify(report, null, 2)) + "\n")
      if (note) process.stderr.write(`${note}\n`)
      return
    }
    if (watchSec !== undefined && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H")
    process.stdout.write(renderHostLoad(report, { colour, mode, ...(note ? { note } : {}) }))
  }

  try {
    await once()
    if (watchSec === undefined) return 0
    let stop = false
    process.once("SIGINT", () => {
      stop = true
    })
    while (!stop) {
      await new Promise(r => setTimeout(r, watchSec * 1000))
      if (!stop) await once()
    }
    return 0
  } catch (err) {
    process.stderr.write(`agentproto host load: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
