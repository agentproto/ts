/**
 * `agentproto host health` - the verdict twin of `host load`: "is this host OK
 * to spawn more agents?" as OK / WARN / CRIT (exit 0 / 1 / 2) plus the reasons
 * and a compact table of checks.
 *
 * Everything here is a pure function of its inputs (a `HostLoadReport` plus
 * the few probes the command collects around it), so the verdict boundaries
 * and the rendering are unit-testable. The I/O (daemon, sessions, disk) lives
 * in host.ts.
 */
import { DEFAULT_HOST_LOAD_THRESHOLDS } from "@agentproto/runtime"
import type { HostLoadReport } from "@agentproto/runtime"
import { formatBytes, formatElapsed } from "./sessions-stats.js"

export type HealthVerdict = "OK" | "WARN" | "CRIT"
/** SKIP = the probe was not run or has no data; it never moves the verdict. */
export type CheckStatus = HealthVerdict | "SKIP"

export const HEALTH_EXIT_CODE: Record<HealthVerdict, 0 | 1 | 2> = { OK: 0, WARN: 1, CRIT: 2 }

/**
 * Every limit in one place. An "above" limit trips when value >= limit; a
 * "below" limit trips when value < limit. Each can be overridden with the flag
 * in {@link THRESHOLD_FLAGS}.
 */
export interface HostHealthThresholds {
  /** 1-minute load / cores. */
  warnLoadPerCore: number
  critLoadPerCore: number
  /** Swap used, percent. */
  warnSwapPercent: number
  critSwapPercent: number
  /** RAM available (free + reclaimable), percent of total. */
  warnMemAvailablePercent: number
  critMemAvailablePercent: number
  /** Daemon uptime below this many seconds = it just restarted (WARN). */
  warnDaemonUptimeSec: number
  /** Live agent sessions. */
  warnSessions: number
  critSessions: number
  /** Live sessions with a turn in flight. */
  warnBusySessions: number
  critBusySessions: number
  /** Reparented (ppid 1) leftover processes. */
  warnOrphans: number
  critOrphans: number
  /** Orphans that are old and busy (the host_load `orphan` warnings). */
  warnBusyOrphans: number
  critBusyOrphans: number
  /** Free space on the sessions dir's filesystem, GB. */
  warnDiskFreeGb: number
  critDiskFreeGb: number
}

export const DEFAULT_HEALTH_THRESHOLDS: HostHealthThresholds = {
  warnLoadPerCore: 2,
  // Same limit the daemon's own host_load `load` warning uses.
  critLoadPerCore: DEFAULT_HOST_LOAD_THRESHOLDS.loadPerCoreLimit,
  // Same limits as the host_load `swap` warning (warn / critical).
  warnSwapPercent: DEFAULT_HOST_LOAD_THRESHOLDS.swapWarnPercent,
  critSwapPercent: DEFAULT_HOST_LOAD_THRESHOLDS.swapCriticalPercent,
  warnMemAvailablePercent: 15,
  critMemAvailablePercent: 5,
  warnDaemonUptimeSec: 60,
  warnSessions: 30,
  critSessions: 60,
  warnBusySessions: 8,
  critBusySessions: 16,
  warnOrphans: 10,
  critOrphans: 30,
  warnBusyOrphans: 1,
  critBusyOrphans: 5,
  warnDiskFreeGb: 10,
  critDiskFreeGb: 2,
}

/** CLI flag -> threshold key. Drives both parsing and the usage docs. */
export const THRESHOLD_FLAGS: ReadonlyArray<{ flag: string; key: keyof HostHealthThresholds }> = [
  { flag: "warn-load", key: "warnLoadPerCore" },
  { flag: "crit-load", key: "critLoadPerCore" },
  { flag: "warn-swap", key: "warnSwapPercent" },
  { flag: "crit-swap", key: "critSwapPercent" },
  { flag: "warn-mem", key: "warnMemAvailablePercent" },
  { flag: "crit-mem", key: "critMemAvailablePercent" },
  { flag: "warn-uptime", key: "warnDaemonUptimeSec" },
  { flag: "warn-sessions", key: "warnSessions" },
  { flag: "crit-sessions", key: "critSessions" },
  { flag: "warn-busy", key: "warnBusySessions" },
  { flag: "crit-busy", key: "critBusySessions" },
  { flag: "warn-orphans", key: "warnOrphans" },
  { flag: "crit-orphans", key: "critOrphans" },
  { flag: "warn-busy-orphans", key: "warnBusyOrphans" },
  { flag: "crit-busy-orphans", key: "critBusyOrphans" },
  { flag: "warn-disk", key: "warnDiskFreeGb" },
  { flag: "crit-disk", key: "critDiskFreeGb" },
]

/** Pairs whose ordering must hold: [warn key, crit key, direction]. */
const ORDERED_PAIRS: ReadonlyArray<[keyof HostHealthThresholds, keyof HostHealthThresholds, "above" | "below"]> = [
  ["warnLoadPerCore", "critLoadPerCore", "above"],
  ["warnSwapPercent", "critSwapPercent", "above"],
  ["warnMemAvailablePercent", "critMemAvailablePercent", "below"],
  ["warnSessions", "critSessions", "above"],
  ["warnBusySessions", "critBusySessions", "above"],
  ["warnOrphans", "critOrphans", "above"],
  ["warnBusyOrphans", "critBusyOrphans", "above"],
  ["warnDiskFreeGb", "critDiskFreeGb", "below"],
]

/** Merge `--warn-*`/`--crit-*` flag values over the defaults. Returns an error
 *  string for a non-numeric / negative value or a warn limit that is on the
 *  wrong side of its crit limit. */
export function resolveThresholds(
  raw: Readonly<Record<string, string | undefined>>,
): { thresholds: HostHealthThresholds } | { error: string } {
  const thresholds: HostHealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS }
  for (const { flag, key } of THRESHOLD_FLAGS) {
    const v = raw[flag]
    if (v === undefined) continue
    const n = Number(v)
    if (v.trim() === "" || !Number.isFinite(n) || n < 0) return { error: `--${flag} expects a number >= 0, got "${v}"` }
    thresholds[key] = n
  }
  for (const [warn, crit, dir] of ORDERED_PAIRS) {
    const ok = dir === "above" ? thresholds[warn] <= thresholds[crit] : thresholds[warn] >= thresholds[crit]
    if (!ok) {
      const flagOf = (k: keyof HostHealthThresholds): string => `--${THRESHOLD_FLAGS.find(f => f.key === k)!.flag}`
      return { error: `${flagOf(warn)} (${thresholds[warn]}) must be ${dir === "above" ? "<=" : ">="} ${flagOf(crit)} (${thresholds[crit]})` }
    }
  }
  return { thresholds }
}

// ── model ───────────────────────────────────────────────────────────

export interface HealthCheck {
  id: "load" | "memory" | "swap" | "daemon" | "sessions" | "busy" | "orphans" | "busy-orphans" | "disk"
  label: string
  status: CheckStatus
  /** Numeric value in {@link HealthCheck.unit}; null when unavailable. */
  value: number | null
  unit: string
  /** The value as shown in the table. */
  display: string
  /** Limits; `direction: "above"` trips at >= limit, `"below"` at < limit.
   *  Null when the check has no numeric limit. */
  threshold: { warn: number | null; crit: number | null; direction: "above" | "below" } | null
  /** Short phrase naming what is wrong (or, when OK, the context). */
  detail: string
}

export interface DaemonProbe {
  reachable: boolean
  uptimeMs?: number
  error?: string
}

export interface SessionCounts {
  /** Live (running/starting) agent sessions. */
  alive: number
  /** Of those, how many have a turn in flight. */
  busy: number
}

export type DiskProbe = { path: string; freeBytes: number; totalBytes: number } | { path: string; error: string }

export interface HostHealthInput {
  report: HostLoadReport
  /** Absent = daemon not asked (`--local`). */
  daemon?: DaemonProbe
  /** Absent = daemon unreachable or the list was unavailable. */
  sessions?: SessionCounts
  disk?: DiskProbe
  /** Where the report came from (e.g. "sampled locally"); shown under the verdict. */
  note?: string
}

export interface HostHealth {
  verdict: HealthVerdict
  exitCode: 0 | 1 | 2
  sampledAt: string
  /** One entry per non-OK check, worst first. */
  reasons: string[]
  checks: HealthCheck[]
  thresholds: HostHealthThresholds
  note?: string
}

const GB = 1024 ** 3

type Dir = "above" | "below"

function grade(value: number, warn: number, crit: number, dir: Dir): HealthVerdict {
  if (dir === "above") return value >= crit ? "CRIT" : value >= warn ? "WARN" : "OK"
  return value < crit ? "CRIT" : value < warn ? "WARN" : "OK"
}

const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d
const num = (n: number): string => String(round(n, 2))

function skipped(id: HealthCheck["id"], label: string, unit: string, detail: string): HealthCheck {
  return { id, label, status: "SKIP", value: null, unit, display: "n/a", threshold: null, detail }
}

function counted(
  id: HealthCheck["id"],
  label: string,
  value: number,
  display: string,
  warn: number,
  crit: number,
  detail: (status: HealthVerdict) => string,
): HealthCheck {
  const status = grade(value, warn, crit, "above")
  return { id, label, status, value, unit: "", display, threshold: { warn, crit, direction: "above" }, detail: detail(status) }
}

/** Verdict + per-check results. Pure. */
export function computeHostHealth(input: HostHealthInput, th: HostHealthThresholds = DEFAULT_HEALTH_THRESHOLDS): HostHealth {
  const { report } = input
  const checks: HealthCheck[] = []

  const loadPerCore = report.cpuCount > 0 ? report.loadAvg[0] / report.cpuCount : report.loadPerCore
  const loadStatus = grade(loadPerCore, th.warnLoadPerCore, th.critLoadPerCore, "above")
  checks.push({
    id: "load",
    label: "load",
    status: loadStatus,
    value: round(loadPerCore, 2),
    unit: "x",
    display: `${loadPerCore.toFixed(2)}x per core`,
    threshold: { warn: th.warnLoadPerCore, crit: th.critLoadPerCore, direction: "above" },
    detail: `load ${report.loadAvg[0].toFixed(1)} on ${report.cpuCount} cores = ${loadPerCore.toFixed(1)}x per core`,
  })

  const total = report.memory.totalBytes
  if (total > 0) {
    const availPct = (report.memory.availableBytes / total) * 100
    checks.push({
      id: "memory",
      label: "ram",
      status: grade(availPct, th.warnMemAvailablePercent, th.critMemAvailablePercent, "below"),
      value: round(availPct, 1),
      unit: "%",
      display: `${availPct.toFixed(1)}% avail`,
      threshold: { warn: th.warnMemAvailablePercent, crit: th.critMemAvailablePercent, direction: "below" },
      detail: `only ${formatBytes(report.memory.availableBytes)} of ${formatBytes(total)} RAM available (${availPct.toFixed(1)}%)`,
    })
  } else {
    checks.push(skipped("memory", "ram", "%", "RAM size unknown"))
  }

  if (report.swap) {
    const pct = report.swap.percent
    checks.push({
      id: "swap",
      label: "swap",
      status: grade(pct, th.warnSwapPercent, th.critSwapPercent, "above"),
      value: round(pct, 1),
      unit: "%",
      display: `${pct.toFixed(1)}% used`,
      threshold: { warn: th.warnSwapPercent, crit: th.critSwapPercent, direction: "above" },
      detail: `swap ${formatBytes(report.swap.usedBytes)} of ${formatBytes(report.swap.totalBytes)} used (${Math.round(pct)}%)`,
    })
  } else {
    checks.push(skipped("swap", "swap", "%", "swap usage unavailable"))
  }

  if (!input.daemon) {
    checks.push(skipped("daemon", "daemon", "s", "not checked (--local)"))
  } else if (!input.daemon.reachable) {
    checks.push({
      id: "daemon",
      label: "daemon",
      status: "CRIT",
      value: null,
      unit: "s",
      display: "unreachable",
      threshold: { warn: th.warnDaemonUptimeSec, crit: null, direction: "below" },
      detail: `daemon unreachable${input.daemon.error ? ` (${input.daemon.error})` : ""}`,
    })
  } else {
    const upSec = input.daemon.uptimeMs !== undefined ? input.daemon.uptimeMs / 1000 : undefined
    const young = upSec !== undefined && upSec < th.warnDaemonUptimeSec
    checks.push({
      id: "daemon",
      label: "daemon",
      status: young ? "WARN" : "OK",
      value: upSec !== undefined ? Math.floor(upSec) : null,
      unit: "s",
      display: upSec !== undefined ? `up ${formatElapsed(upSec)}` : "up",
      threshold: { warn: th.warnDaemonUptimeSec, crit: null, direction: "below" },
      detail: young ? `daemon restarted ${Math.floor(upSec)}s ago` : "daemon reachable",
    })
  }

  if (!input.sessions) {
    checks.push(skipped("sessions", "sessions", "", "session list unavailable"))
    checks.push(skipped("busy", "busy", "", "session list unavailable"))
  } else {
    const { alive, busy } = input.sessions
    checks.push(
      counted("sessions", "sessions", alive, `${alive} live`, th.warnSessions, th.critSessions, () => `${alive} live sessions`),
      counted("busy", "busy", busy, `${busy} busy`, th.warnBusySessions, th.critBusySessions, () => `${busy} sessions mid-turn`),
    )
  }

  const procs =
    report.processes ??
    [...new Map([...report.topByCpu, ...report.topByMemory].map(p => [p.pid, p] as const)).values()]
  const orphans = procs.filter(p => p.owner.kind === "orphan").length
  const exact = report.processes !== undefined
  checks.push(
    counted("orphans", "orphans", orphans, `${exact ? "" : ">="}${orphans}`, th.warnOrphans, th.critOrphans, () =>
      `${exact ? "" : "at least "}${orphans} orphan processes (ppid 1)`,
    ),
  )
  const oldBusy = report.warnings.filter(w => w.kind === "orphan").length
  checks.push(
    counted("busy-orphans", "busy orphans", oldBusy, String(oldBusy), th.warnBusyOrphans, th.critBusyOrphans, () =>
      `${oldBusy} old busy orphan${oldBusy === 1 ? "" : "s"}`,
    ),
  )

  if (!input.disk) {
    checks.push(skipped("disk", "disk", " GB", "sessions dir not checked"))
  } else if ("error" in input.disk) {
    checks.push(skipped("disk", "disk", " GB", `cannot stat ${input.disk.path}: ${input.disk.error}`))
  } else {
    const freeGb = input.disk.freeBytes / GB
    checks.push({
      id: "disk",
      label: "disk",
      status: grade(freeGb, th.warnDiskFreeGb, th.critDiskFreeGb, "below"),
      value: round(freeGb, 1),
      unit: " GB",
      display: `${formatBytes(input.disk.freeBytes)} free`,
      threshold: { warn: th.warnDiskFreeGb, crit: th.critDiskFreeGb, direction: "below" },
      detail: `only ${formatBytes(input.disk.freeBytes)} free of ${formatBytes(input.disk.totalBytes)} on ${input.disk.path}`,
    })
  }

  const rank: Record<CheckStatus, number> = { SKIP: -1, OK: 0, WARN: 1, CRIT: 2 }
  const worst = checks.reduce<HealthVerdict>((acc, c) => (c.status !== "SKIP" && rank[c.status] > rank[acc] ? c.status : acc), "OK")
  const reasons = checks
    .filter(c => c.status === "WARN" || c.status === "CRIT")
    .sort((a, b) => rank[b.status] - rank[a.status])
    .map(c => c.detail)

  return {
    verdict: worst,
    exitCode: HEALTH_EXIT_CODE[worst],
    sampledAt: report.sampledAt,
    reasons,
    checks,
    thresholds: th,
    ...(input.note ? { note: input.note } : {}),
  }
}

// ── rendering ───────────────────────────────────────────────────────

export interface RenderHostHealthOptions {
  colour: boolean
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))

function limitText(c: HealthCheck, which: "warn" | "crit"): string {
  const t = c.threshold
  const v = t?.[which]
  if (!t || v === null || v === undefined) return "-"
  return `${t.direction === "above" ? ">=" : "<"}${num(v)}${c.unit}`
}

/** Render the verdict line, reasons and the check table. Pure. */
export function renderHostHealth(health: HostHealth, opts: RenderHostHealthOptions): string {
  const c = (code: string, s: string): string => (opts.colour ? `\x1b[${code}m${s}\x1b[0m` : s)
  const colourOf: Record<CheckStatus, string> = { OK: "32", WARN: "33", CRIT: "31", SKIP: "2" }
  const out: string[] = []

  const summary = health.reasons.length > 0 ? health.reasons.join("; ") : "host has headroom for more agents"
  out.push(`${c(`1;${colourOf[health.verdict]}`, health.verdict)}  ${summary}`)
  if (health.note) out.push(c("2", health.note))
  out.push("")

  const w = {
    name: Math.max(...health.checks.map(k => k.label.length), 5),
    value: Math.max(...health.checks.map(k => k.display.length), 5),
    warn: Math.max(...health.checks.map(k => limitText(k, "warn").length), 4),
  }
  out.push(c("2", `${pad("CHECK", w.name)}  ${pad("STATUS", 6)}  ${pad("VALUE", w.value)}  ${pad("WARN", w.warn)}  CRIT`))
  for (const k of health.checks) {
    out.push(
      `${pad(k.label, w.name)}  ${c(colourOf[k.status], pad(k.status, 6))}  ${pad(k.display, w.value)}  ${pad(limitText(k, "warn"), w.warn)}  ${limitText(k, "crit")}`,
    )
  }
  out.push("")
  return out.join("\n")
}
