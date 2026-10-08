/**
 * `agentproto host health` - a verdict (OK / WARN / CRIT, exit 0 / 1 / 2) on
 * "is this host OK to spawn more agents?"; the checks and rendering are pure
 * functions in host-health.ts, the probes around the shared host_load report
 * live here.
 *
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
import { statfs } from "node:fs/promises"
import { dirname } from "node:path"
import { parseArgs } from "node:util"
import type { HostLoadReport, HostProcess, HostProcessOwner } from "@agentproto/runtime"
import { discoverDaemon, httpGetJson } from "./_daemon-helpers.js"
import {
  DEFAULT_HEALTH_THRESHOLDS as D,
  THRESHOLD_FLAGS,
  computeHostHealth,
  renderHostHealth,
  resolveThresholds,
  type DaemonProbe,
  type DiskProbe,
  type HostHealthInput,
  type HostHealthThresholds,
  type SessionCounts,
} from "./host-health.js"
import { formatBytes, formatCpu, formatElapsed } from "./sessions-stats.js"

export const HOST_USAGE = `Usage:
  agentproto host load   [--full] [--json] [--watch <seconds>] [--budget <ms>]
                         [--fresh] [--local] [--no-color]
  agentproto host health [--json] [--watch <seconds>] [--budget <ms>] [--local]
                         [--no-color] [--warn-load <x>] [--crit-load <x>] [...]

host load: one-screen host load report: load average vs core count, CPU
user/sys/idle, RAM (used/wired/compressor/free) and swap, per-disk transfers/s +
MB/s, the top 10 processes by CPU and by memory footprint with their owning
session ("orphan" / "system" / "daemon" otherwise), and WARNINGS.

  --full            also the per-session rollup and every process
  --json            machine-readable report (same JSON as GET /host/load)
  --watch <s>       refresh every <s> seconds (with --json: one JSON per line)
  --budget <ms>     time budget for the sample (default 1900; raise it to let
                    the macOS \`top\` footprint probe finish on a busy host)
  --fresh           bypass the daemon's ~2s cache
  --local           sample in this process instead of asking the daemon
                    (no session attribution)
  --no-color        plain output

host health: "is this host OK to spawn more agents?" as one verdict line
(OK / WARN / CRIT) with the reasons, then a table of the checks. Exit code
0 = OK, 1 = WARN, 2 = CRIT (also when the host cannot be sampled at all); a
usage error exits 64. Safe for cron and scripts.

  --json            {verdict, exitCode, reasons[], checks[], thresholds}
  --watch <s>       re-check every <s> seconds (exit code = the last verdict)
  --budget <ms>     time budget for the sample (default 1900)
  --local           skip the daemon (no daemon check, no session counts)
  --no-color        plain output

A limit trips WARN/CRIT when the value is at or above it ("above" rows) or
below it ("below" rows). Defaults, each overridable by the flag shown:

  check         WARN        CRIT        flags
  load          >=${D.warnLoadPerCore}x/core    >=${D.critLoadPerCore}x/core    --warn-load <x>  --crit-load <x>      (1m load / cores)
  ram           <${D.warnMemAvailablePercent}% avail   <${D.critMemAvailablePercent}% avail    --warn-mem <%>  --crit-mem <%>       (available / total)
  swap          >=${D.warnSwapPercent}% used   >=${D.critSwapPercent}% used   --warn-swap <%>  --crit-swap <%>
  daemon        up <${D.warnDaemonUptimeSec}s      unreachable --warn-uptime <s>     (unreachable = CRIT)
  sessions      >=${D.warnSessions} live     >=${D.critSessions} live     --warn-sessions <n>  --crit-sessions <n>
  busy          >=${D.warnBusySessions} mid-turn >=${D.critBusySessions} mid-turn --warn-busy <n>  --crit-busy <n>
  orphans       >=${D.warnOrphans}          >=${D.critOrphans}          --warn-orphans <n>  --crit-orphans <n>
  busy orphans  >=${D.warnBusyOrphans}           >=${D.critBusyOrphans}           --warn-busy-orphans <n>  --crit-busy-orphans <n>
  disk          <${D.warnDiskFreeGb} GB free   <${D.critDiskFreeGb} GB free    --warn-disk <GB>  --crit-disk <GB>  (sessions dir)

Checks with no data (e.g. no swap probe, --local) show SKIP and never move the
verdict. If the daemon is unreachable the verdict is CRIT, but the rest is still
reported from an in-process sample.

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

interface FetchOpts {
  mode: "summary" | "full"
  budgetMs?: number
  fresh: boolean
  local: boolean
}

async function fetchDaemonReport(url: string, o: Omit<FetchOpts, "local">): Promise<HostLoadReport> {
  const qs = new URLSearchParams({ detail: o.mode })
  if (o.fresh) qs.set("fresh", "true")
  if (o.budgetMs) qs.set("budgetMs", String(o.budgetMs))
  return withTimeout(httpGetJson<HostLoadReport>(`${url}/host/load?${qs}`), (o.budgetMs ?? 1900) + 5000, "the daemon")
}

async function sampleLocal(o: Omit<FetchOpts, "local">, note?: string): Promise<Fetched> {
  const { getHostLoadService } = await import("@agentproto/runtime")
  const report = await getHostLoadService().report([], {
    detail: o.mode,
    fresh: true,
    ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}),
  })
  return { report, ...(note ? { note } : {}) }
}

const daemonFallbackNote = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return `daemon unavailable (${/404/.test(msg) ? "it predates GET /host/load; restart it to pick the route up" : msg}); sampled locally, no session attribution`
}

async function fetchReport(o: FetchOpts): Promise<Fetched> {
  let note: string | undefined
  if (!o.local) {
    const found = (await discoverDaemon()).found
    if (found) {
      try {
        return { report: await fetchDaemonReport(found.url, o) }
      } catch (err) {
        note = daemonFallbackNote(err)
      }
    } else {
      note = "no daemon found; sampled locally, no session attribution"
    }
  }
  return sampleLocal(o, note)
}

// ── host health: the probes around the shared report ────────────────

/** How long /health and /sessions may take before the daemon counts as down. */
const HEALTH_PROBE_TIMEOUT_MS = 3000
const EXIT_USAGE = 64

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

interface SessionRow {
  kind?: string
  status?: string
  alive?: boolean
  busy?: boolean
}

export function countSessions(rows: readonly SessionRow[]): SessionCounts {
  let alive = 0
  let busy = 0
  for (const r of rows) {
    if (r.kind !== undefined && r.kind !== "agent-cli") continue
    if (!(r.alive ?? (r.status === "running" || r.status === "starting"))) continue
    alive++
    if (r.busy === true) busy++
  }
  return { alive, busy }
}

/** Free space on the filesystem holding the sessions dir (or its nearest existing parent). */
async function probeSessionsDisk(): Promise<DiskProbe> {
  const { loadConfig } = await import("@agentproto/runtime/config")
  const { defaultTranscriptBaseDir, setDefaultSessionsBaseDir } = await import("@agentproto/runtime")
  const cfg = await loadConfig().catch(() => undefined)
  setDefaultSessionsBaseDir(cfg?.sessions?.eventsDir)
  const path = defaultTranscriptBaseDir()
  let probe = path
  for (;;) {
    try {
      const s = await statfs(probe)
      return { path, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
    } catch (err) {
      const parent = dirname(probe)
      if (parent === probe) return { path, error: errText(err) }
      probe = parent
    }
  }
}

async function gatherHealthInput(o: { local: boolean; budgetMs?: number }): Promise<HostHealthInput> {
  const opts = { mode: "full" as const, fresh: true, ...(o.budgetMs !== undefined ? { budgetMs: o.budgetMs } : {}) }
  const disk = probeSessionsDisk().catch((err): DiskProbe => ({ path: "sessions dir", error: errText(err) }))

  if (o.local) {
    const { report } = await sampleLocal(opts)
    return { report, disk: await disk }
  }

  const found = (await discoverDaemon()).found
  if (!found) {
    const { report } = await sampleLocal(opts)
    return {
      report,
      daemon: { reachable: false, error: "no daemon found" },
      disk: await disk,
      note: "no daemon found; sampled locally, no session attribution",
    }
  }

  let daemon: DaemonProbe
  try {
    const h = await withTimeout(httpGetJson<{ uptimeMs?: unknown }>(`${found.url}/health`), HEALTH_PROBE_TIMEOUT_MS, "the daemon")
    daemon = { reachable: true, ...(typeof h.uptimeMs === "number" ? { uptimeMs: h.uptimeMs } : {}) }
  } catch (err) {
    daemon = { reachable: false, error: errText(err) }
  }
  if (!daemon.reachable) {
    const { report } = await sampleLocal(opts)
    return { report, daemon, disk: await disk, note: "daemon unreachable; sampled locally, no session attribution" }
  }

  const [rep, list] = await Promise.allSettled([
    fetchDaemonReport(found.url, opts),
    withTimeout(httpGetJson<{ sessions?: SessionRow[] }>(`${found.url}/sessions?fields=kind,status,alive,busy`), HEALTH_PROBE_TIMEOUT_MS + 2000, "the daemon"),
  ])
  const sessions = list.status === "fulfilled" && Array.isArray(list.value?.sessions) ? countSessions(list.value.sessions) : undefined
  if (rep.status === "fulfilled") {
    return { report: rep.value, daemon, ...(sessions ? { sessions } : {}), disk: await disk }
  }
  const { report } = await sampleLocal(opts)
  return { report, daemon, ...(sessions ? { sessions } : {}), disk: await disk, note: daemonFallbackNote(rep.reason) }
}

async function runHealth(args: readonly string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        json: { type: "boolean" },
        watch: { type: "string" },
        budget: { type: "string" },
        local: { type: "boolean" },
        "no-color": { type: "boolean" },
        ...Object.fromEntries(THRESHOLD_FLAGS.map(({ flag }) => [flag, { type: "string" as const }])),
      },
    }).values
  } catch (err) {
    process.stderr.write(`agentproto host health: ${errText(err)}\n`)
    return EXIT_USAGE
  }

  const flagNum = (raw: unknown, flag: string, min: number): number | undefined | "bad" => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min) {
      process.stderr.write(`agentproto host health: ${flag} expects a number >= ${min}, got "${String(raw)}"\n`)
      return "bad"
    }
    return n
  }
  const watchSec = flagNum(values.watch, "--watch", 1)
  const budgetMs = flagNum(values.budget, "--budget", 300)
  if (watchSec === "bad" || budgetMs === "bad") return EXIT_USAGE
  const resolved = resolveThresholds(
    Object.fromEntries(THRESHOLD_FLAGS.map(({ flag }) => [flag, typeof values[flag] === "string" ? (values[flag] as string) : undefined])),
  )
  if ("error" in resolved) {
    process.stderr.write(`agentproto host health: ${resolved.error}\n`)
    return EXIT_USAGE
  }
  const thresholds: HostHealthThresholds = resolved.thresholds

  const colour = values["no-color"] !== true && process.stdout.isTTY === true
  let exitCode = 2
  const once = async (): Promise<void> => {
    const health = computeHostHealth(
      await gatherHealthInput({ local: values.local === true, ...(budgetMs !== undefined ? { budgetMs } : {}) }),
      thresholds,
    )
    exitCode = health.exitCode
    if (values.json) {
      process.stdout.write((watchSec !== undefined ? JSON.stringify(health) : JSON.stringify(health, null, 2)) + "\n")
      return
    }
    if (watchSec !== undefined && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H")
    process.stdout.write(renderHostHealth(health, { colour }))
  }

  try {
    await once()
    if (watchSec === undefined) return exitCode
    let stop = false
    process.once("SIGINT", () => {
      stop = true
    })
    while (!stop) {
      await new Promise(r => setTimeout(r, watchSec * 1000))
      if (!stop) await once()
    }
    return exitCode
  } catch (err) {
    process.stderr.write(`agentproto host health: ${errText(err)}\n`)
    return 2
  }
}

export async function runHost(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HOST_USAGE)
    return args.length === 0 ? 2 : 0
  }
  const sub = args[0]
  if (sub === "health") return runHealth(args.slice(1))
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
