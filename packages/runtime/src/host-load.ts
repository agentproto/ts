/**
 * Host-level load report - answers "why is this machine on its knees" without
 * a hand-run `top` / `vm_stat` / `iostat` / `ps` / `lsof` session.
 *
 * One collector (`createHostLoadService`) gathers, in parallel and each under
 * a hard timeout so the whole call stays inside a small budget even at load
 * 500:
 *
 *   - load average vs core count, CPU user/sys/idle
 *   - RAM used / wired / compressor / cached / free, swap used
 *   - per-disk transfers/s and MB/s
 *   - the process table, attributed to sessions with the same rules as
 *     `session_stats` (`process-stats.ts`), plus per-process memory footprint
 *     including compressed pages where the OS exposes it
 *   - listening TCP ports and (for a handful of suspects) the cwd, to spot
 *     deleted-cwd loops and duplicate dev servers
 *
 * and turns them into WARNINGS: swap pressure, reparented (ppid 1) leftovers
 * that are old and busy or serving, deleted-cwd processes, filesystem-wide
 * scans, several servers on one port, load far above the core count.
 *
 * macOS shells out to `vm_stat`, `sysctl vm.swapusage`, `iostat`, `top`, `ps`,
 * `lsof`; Linux reads `/proc` (+ `ps`, `ss`). Nothing needs sudo. A probe that
 * is missing, denied or too slow is skipped and named in `partial` - the rest
 * of the report still ships. The collector is exported (`getHostLoadService`,
 * `createHostLoadService`) so a scheduler can gate heavy jobs on it.
 */

import { execFile } from "node:child_process"
import { readFile, readlink, stat } from "node:fs/promises"
import { basename } from "node:path"
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os"
import {
  attributeProcesses,
  createProcessTableSource,
  defaultEnvHintReader,
  normalizeCommand,
  parseVmStatAvailable,
  strayEnvCandidates,
  toStatsSessionInput,
  worktreeProvisions,
  type ProcRow,
  type ProvisionInFlight,
  type ProvisionTracker,
  type StatsSessionDescriptor,
} from "./process-stats.js"

// ── report shape ────────────────────────────────────────────────────

export type HostLoadDetail = "summary" | "full"

export interface HostLoadCpu {
  userPercent: number
  sysPercent: number
  idlePercent: number
  source: "iostat" | "top" | "proc-stat"
}

export interface HostLoadMemory {
  totalBytes: number
  /** App + wired + compressed (Activity Monitor's "Memory Used"). Absent when
   *  the platform gives no such split. */
  usedBytes?: number
  wiredBytes?: number
  /** Bytes physically occupied by the compressor (macOS). */
  compressorBytes?: number
  /** File cache + purgeable pages. */
  cachedBytes?: number
  /** Never-touched pages only. */
  freeBytes: number
  /** Free + reclaimable: what a new job can actually get without swapping. */
  availableBytes: number
}

export interface HostLoadSwap {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  percent: number
}

export interface DiskLoad {
  name: string
  /** Transfers per second over the sampling interval. */
  tps: number
  mbPerSec: number
  /** Average KB per transfer, when the OS reports it. */
  kbPerTransfer?: number
}

export type HostProcessOwner =
  | { kind: "session"; sessionId: string; label?: string; detached?: boolean }
  | { kind: "daemon" }
  | { kind: "provisioning" }
  /** Reparented to init by a session that is gone (or never was one). */
  | { kind: "orphan"; sessionHint?: string }
  /** OS services and installed apps. */
  | { kind: "system" }
  /** Anything else: the operator's own shells, editors, other users. */
  | { kind: "other" }

export interface HostProcess {
  pid: number
  ppid: number
  uid: number
  /** Normalized name (`pnpm install`, `vitest`, `node`, ...). */
  command: string
  /** Raw command line, truncated. */
  args: string
  rssBytes: number
  /** Footprint including compressed pages when measured, else RSS. */
  memoryBytes: number
  memorySource: "footprint" | "rss"
  /** Bytes of this process the OS has compressed / swapped out. */
  compressedBytes?: number
  cpuPercent: number
  elapsedSec: number
  owner: HostProcessOwner
  /** TCP ports it listens on. */
  listening?: number[]
  /** Its cwd was deleted out from under it. */
  cwdDeleted?: boolean
}

export type HostWarningKind = "swap" | "load" | "orphan" | "deleted-cwd" | "fs-scan" | "duplicate-port"

export interface HostWarning {
  kind: HostWarningKind
  severity: "warn" | "critical"
  message: string
  pids?: number[]
}

export interface HostSessionRollup {
  sessionId: string
  label?: string
  rssBytes: number
  memoryBytes: number
  cpuPercent: number
  procCount: number
}

export interface HostLoadReport {
  sampledAt: string
  detail: HostLoadDetail
  /** Wall time the collection took. */
  elapsedMs: number
  /** Probes that failed, timed out or were skipped; the rest is still valid. */
  partial: string[]
  platform: NodeJS.Platform
  loadAvg: [number, number, number]
  cpuCount: number
  /** 1-minute load divided by core count. */
  loadPerCore: number
  cpu?: HostLoadCpu
  memory: HostLoadMemory
  swap?: HostLoadSwap
  disks: DiskLoad[]
  topByCpu: HostProcess[]
  topByMemory: HostProcess[]
  warnings: HostWarning[]
  /** `detail: "full"` only. */
  sessions?: HostSessionRollup[]
  /** `detail: "full"` only: every process, largest memory first. */
  processes?: HostProcess[]
  /** Subtree-scoped caller: only its own sessions' processes are listed. */
  scoped?: true
}

// ── parsers (pure, fixture-tested) ──────────────────────────────────

const UNIT: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
const round1 = (n: number): number => Math.round(n * 10) / 10

/** `5674M`, `12G`, `160K`, `1.5G+` (top appends +/- for movement) to bytes. */
export function sizeToBytes(raw: string): number | undefined {
  const m = /^([\d.]+)\s*([BKMGT])?/i.exec(raw.trim())
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n * UNIT[(m[2] ?? "B").toUpperCase()]!) : undefined
}

function mkSwap(totalBytes: number, usedBytes: number): HostLoadSwap {
  return {
    totalBytes,
    usedBytes,
    freeBytes: Math.max(0, totalBytes - usedBytes),
    percent: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0,
  }
}

/** `sysctl vm.swapusage`: `total = 16384.00M  used = 15035.38M  free = ...`. */
export function parseSwapUsage(text: string): HostLoadSwap | undefined {
  const field = (k: string): number | undefined => {
    const m = new RegExp(`${k}\\s*=\\s*([\\d.]+\\s*[BKMGT]?)`, "i").exec(text)
    return m ? sizeToBytes(m[1]!) : undefined
  }
  const total = field("total")
  const used = field("used")
  return total === undefined || used === undefined ? undefined : mkSwap(total, used)
}

/** macOS `vm_stat` to the RAM split. `used` follows Activity Monitor:
 *  (anonymous - purgeable) + wired + compressor. */
export function parseVmStatMemory(text: string, totalBytes: number): HostLoadMemory | undefined {
  const size = /page size of (\d+) bytes/.exec(text)
  if (!size) return undefined
  const page = Number(size[1])
  const pages = (label: string): number | undefined => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)
    return m ? Number(m[1]) : undefined
  }
  const wired = pages("Pages wired down") ?? 0
  const compressor = pages("Pages occupied by compressor") ?? 0
  const purgeable = pages("Pages purgeable") ?? 0
  const anon = pages("Anonymous pages")
  const app = anon !== undefined ? Math.max(0, anon - purgeable) : (pages("Pages active") ?? 0)
  const available = parseVmStatAvailable(text) ?? 0
  return {
    totalBytes,
    usedBytes: Math.min(totalBytes, (app + wired + compressor) * page),
    wiredBytes: wired * page,
    compressorBytes: compressor * page,
    cachedBytes: ((pages("File-backed pages") ?? 0) + purgeable) * page,
    freeBytes: ((pages("Pages free") ?? 0) + (pages("Pages speculative") ?? 0)) * page,
    availableBytes: available,
  }
}

/** The two header lines of `top -l 1` that carry CPU and RAM totals. Used as
 *  the fallback when `iostat` / `vm_stat` are unavailable. */
export function parseTopHeader(text: string): {
  cpu?: HostLoadCpu
  mem?: { usedBytes: number; wiredBytes: number; compressorBytes: number; unusedBytes: number }
} {
  const out: ReturnType<typeof parseTopHeader> = {}
  const c = /CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/.exec(text)
  if (c) out.cpu = { userPercent: Number(c[1]), sysPercent: Number(c[2]), idlePercent: Number(c[3]), source: "top" }
  const m = /PhysMem:\s*(\S+) used \((\S+) wired,\s*(\S+) compressor\),\s*(\S+) unused/.exec(text)
  if (m) {
    const [used, wired, comp, unused] = [m[1], m[2], m[3], m[4]].map(v => sizeToBytes(v!))
    if (used !== undefined && wired !== undefined && comp !== undefined && unused !== undefined) {
      out.mem = { usedBytes: used, wiredBytes: wired, compressorBytes: comp, unusedBytes: unused }
    }
  }
  return out
}

/** Per-process memory from `top -l 1 -stats pid,mem,cmprs`: `mem` is the
 *  resident part, `cmprs` the compressed part; footprint is their sum. */
export interface Footprint {
  memoryBytes: number
  compressedBytes: number
}

export function parseTopProcesses(text: string): Map<number, Footprint> {
  const out = new Map<number, Footprint>()
  const lines = text.split("\n")
  const start = lines.findIndex(l => /^\s*PID\s+MEM\s+CMPRS/.test(l))
  if (start < 0) return out
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line)
    if (!m) continue
    const mem = sizeToBytes(m[2]!)
    const cmp = sizeToBytes(m[3]!)
    if (mem === undefined || cmp === undefined) continue
    out.set(Number(m[1]), { memoryBytes: mem + cmp, compressedBytes: cmp })
  }
  return out
}

/** `iostat -c 2 -w 1` (macOS): the LAST data row is the 1s interval. Disk
 *  columns come in `KB/t tps MB/s` triples, then `us sy id`, then load. */
export function parseIostat(text: string): { disks: DiskLoad[]; cpu?: HostLoadCpu; intervals: number } {
  const lines = text.split("\n").filter(l => l.trim().length > 0)
  const names = (lines[0] ?? "")
    .trim()
    .split(/\s+/)
    .filter(t => t && t !== "cpu" && t !== "load" && t !== "average")
  const data = lines.filter(l => /^\s*[\d.]+(\s+[\d.]+)+\s*$/.test(l))
  const last = data.at(-1)
  if (!last) return { disks: [], intervals: 0 }
  const n = last.trim().split(/\s+/).map(Number)
  const disks: DiskLoad[] = names.map((name, i) => ({
    name,
    kbPerTransfer: n[i * 3] ?? 0,
    tps: n[i * 3 + 1] ?? 0,
    mbPerSec: n[i * 3 + 2] ?? 0,
  }))
  const at = names.length * 3
  const cpu: HostLoadCpu | undefined =
    n.length >= at + 3
      ? { userPercent: n[at]!, sysPercent: n[at + 1]!, idlePercent: n[at + 2]!, source: "iostat" }
      : undefined
  return { disks, ...(cpu ? { cpu } : {}), intervals: data.length }
}

/** Linux `/proc/meminfo`. */
export function parseMeminfo(text: string): { memory: HostLoadMemory; swap?: HostLoadSwap } | undefined {
  const kb = (k: string): number | undefined => {
    const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, "m").exec(text)
    return m ? Number(m[1]) * 1024 : undefined
  }
  const total = kb("MemTotal")
  if (total === undefined) return undefined
  const free = kb("MemFree") ?? 0
  const cached = (kb("Cached") ?? 0) + (kb("Buffers") ?? 0)
  const available = kb("MemAvailable") ?? free + cached
  const swapTotal = kb("SwapTotal")
  const swapFree = kb("SwapFree")
  return {
    memory: {
      totalBytes: total,
      usedBytes: Math.max(0, total - available),
      cachedBytes: cached,
      freeBytes: free,
      availableBytes: available,
    },
    ...(swapTotal !== undefined && swapFree !== undefined ? { swap: mkSwap(swapTotal, swapTotal - swapFree) } : {}),
  }
}

/** Linux CPU split from two `/proc/stat` reads. */
export function parseProcStatCpu(before: string, after: string): HostLoadCpu | undefined {
  const read = (t: string): number[] | undefined => {
    const m = /^cpu\s+(.*)$/m.exec(t)
    return m ? m[1]!.trim().split(/\s+/).map(Number) : undefined
  }
  const a = read(before)
  const b = read(after)
  if (!a || !b) return undefined
  const d = b.map((v, i) => v - (a[i] ?? 0))
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = d
  const total = user + nice + system + idle + iowait + irq + softirq + steal
  if (total <= 0) return undefined
  const pct = (n: number): number => round1((n / total) * 100)
  return {
    userPercent: pct(user + nice),
    sysPercent: pct(system + irq + softirq),
    idlePercent: pct(idle + iowait),
    source: "proc-stat",
  }
}

const WHOLE_DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/

/** Linux per-disk rates from two `/proc/diskstats` reads `intervalSec` apart. */
export function parseDiskstats(before: string, after: string, intervalSec: number): DiskLoad[] {
  const read = (t: string): Map<string, { ops: number; sectors: number }> => {
    const out = new Map<string, { ops: number; sectors: number }>()
    for (const line of t.split("\n")) {
      const f = line.trim().split(/\s+/)
      const name = f[2]
      if (!name || !WHOLE_DISK_RE.test(name)) continue
      out.set(name, {
        ops: Number(f[3]) + Number(f[7]),
        sectors: Number(f[5]) + Number(f[9]),
      })
    }
    return out
  }
  const a = read(before)
  const disks: DiskLoad[] = []
  for (const [name, now] of read(after)) {
    const prev = a.get(name)
    if (!prev || intervalSec <= 0) continue
    const ops = now.ops - prev.ops
    const bytes = (now.sectors - prev.sectors) * 512
    disks.push({
      name,
      tps: round1(ops / intervalSec),
      mbPerSec: round1(bytes / 1024 ** 2 / intervalSec),
      ...(ops > 0 ? { kbPerTransfer: round1(bytes / 1024 / ops) } : {}),
    })
  }
  return disks
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` to `pid → listening ports`. */
export function parseLsofListeners(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>()
  let pid: number | undefined
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) {
      const m = /:(\d+)(?:\s|$)/.exec(line)
      if (!m) continue
      const port = Number(m[1])
      const ports = out.get(pid) ?? []
      if (!ports.includes(port)) ports.push(port)
      out.set(pid, ports)
    }
  }
  return out
}

/** Linux `ss -H -ltnp` to `pid → listening ports`. */
export function parseSsListeners(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/)
    const port = /:(\d+)$/.exec(cols[3] ?? "")
    if (!port) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1])
      const ports = out.get(pid) ?? []
      if (!ports.includes(Number(port[1]))) ports.push(Number(port[1]))
      out.set(pid, ports)
    }
  }
  return out
}

/** `lsof -a -d cwd -p … -Fpn` to `pid → cwd path`. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid: number | undefined
  let isCwd = false
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("f")) isCwd = line.slice(1) === "cwd"
    else if (line.startsWith("n") && isCwd && pid !== undefined) out.set(pid, line.slice(1))
  }
  return out
}

// ── analysis helpers (pure) ─────────────────────────────────────────

const SCAN_TOOLS = new Set(["find", "gfind", "bfs", "fd", "fdfind", "du", "gdu", "ncdu", "tree"])
const FIND_LIKE = new Set(["find", "gfind", "bfs"])
const BROAD_ROOTS = new Set(["/", "~", "/Users", "/home", "/Volumes"])

/** The whole-filesystem root a `find`/`bfs`/`du`/... command line scans, or
 *  undefined when it is scoped to something narrower. "Broad" = `/`, `~`, the
 *  home directory, `/Users`, `/home`, `/Volumes`. */
export function scanRootOf(args: string, home: string): string | undefined {
  const toks = args.trim().split(/\s+/)
  const exe = basename(toks[0] ?? "")
  if (!SCAN_TOOLS.has(exe)) return undefined
  const findLike = FIND_LIKE.has(exe)
  const homeNorm = home.replace(/\/+$/, "")
  for (const t of toks.slice(1)) {
    if (findLike) {
      if (/^-[HLPEXsxd]$/.test(t)) continue
      if (t.startsWith("-") || t === "(" || t === "!") break
    } else if (t.startsWith("-")) continue
    const norm = t.length > 1 ? t.replace(/\/+$/, "") : t
    if (BROAD_ROOTS.has(norm) || norm === "~/" || (homeNorm.length > 1 && norm === homeNorm)) return t
  }
  return undefined
}

const SYSTEM_PATH_RE =
  /^(\/System\/|\/usr\/libexec\/|\/usr\/sbin\/|\/sbin\/|\/Library\/|\/Applications\/|\/usr\/lib\/systemd\/|\/lib\/systemd\/)|\.app\/Contents\//
const DEV_SERVER_RE =
  /\b(vite|next|webpack|nodemon|tsx|ts-node|http-server|storybook|astro|nuxt|remix|parcel|serve|live-server|wrangler|expo)\b|http\.server/

/** OS service or installed app: an OS/app path, or another (low-numbered)
 *  system uid. Owned by the running user + not under those paths = not system. */
export function isSystemLike(r: Pick<ProcRow, "uid" | "args">, myUid: number | undefined, platform: NodeJS.Platform): boolean {
  if (SYSTEM_PATH_RE.test(r.args)) return true
  return myUid !== undefined && r.uid !== myUid && r.uid < (platform === "darwin" ? 500 : 1000)
}

export interface HostLoadThresholds {
  swapWarnPercent: number
  swapCriticalPercent: number
  /** Reparented processes younger than this are not flagged. */
  orphanMinAgeSec: number
  orphanCpuPercent: number
  /** 1-minute load / cores above which the host is flagged. */
  loadPerCoreLimit: number
}

export const DEFAULT_HOST_LOAD_THRESHOLDS: HostLoadThresholds = {
  swapWarnPercent: 50,
  swapCriticalPercent: 85,
  orphanMinAgeSec: 30 * 60,
  orphanCpuPercent: 5,
  loadPerCoreLimit: 4,
}

function fmtBytes(n: number): string {
  let v = n
  let i = 0
  const u = ["B", "KB", "MB", "GB", "TB"]
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${Math.round(v)} B` : `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

function fmtAge(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 3)}...`)

export function describeOwner(o: HostProcessOwner): string {
  switch (o.kind) {
    case "session":
      return o.label ? `${o.sessionId} (${o.label})` : o.sessionId
    case "orphan":
      return o.sessionHint ? `orphan (${o.sessionHint})` : "orphan"
    default:
      return o.kind
  }
}

export interface HostWarningInput {
  loadAvg: readonly [number, number, number]
  cpuCount: number
  swap?: HostLoadSwap
  processes: readonly HostProcess[]
  homeDir: string
  thresholds?: Partial<HostLoadThresholds>
}

export function computeHostWarnings(input: HostWarningInput): HostWarning[] {
  const th = { ...DEFAULT_HOST_LOAD_THRESHOLDS, ...input.thresholds }
  const out: HostWarning[] = []
  const who = (p: HostProcess): string => `pid ${p.pid} ${clip(p.args || p.command, 70)} [${describeOwner(p.owner)}]`

  const ratio = input.cpuCount > 0 ? input.loadAvg[0] / input.cpuCount : 0
  if (ratio > th.loadPerCoreLimit) {
    out.push({
      kind: "load",
      severity: "critical",
      message: `load ${input.loadAvg[0].toFixed(1)} is ${Math.round(ratio)}x the ${input.cpuCount} cores (limit ${th.loadPerCoreLimit}x)`,
    })
  }
  if (input.swap && input.swap.percent > th.swapWarnPercent) {
    out.push({
      kind: "swap",
      severity: input.swap.percent >= th.swapCriticalPercent ? "critical" : "warn",
      message: `swap ${fmtBytes(input.swap.usedBytes)} of ${fmtBytes(input.swap.totalBytes)} used (${Math.round(input.swap.percent)}%)`,
    })
  }
  for (const p of input.processes) {
    if (p.owner.kind !== "orphan" || p.elapsedSec < th.orphanMinAgeSec) continue
    const serving = (p.listening?.length ?? 0) > 0 && DEV_SERVER_RE.test(p.args)
    if (!serving && p.cpuPercent <= th.orphanCpuPercent) continue
    out.push({
      kind: "orphan",
      severity: "warn",
      message:
        `orphan (ppid 1) ${who(p)} running ${fmtAge(p.elapsedSec)}, ${Math.round(p.cpuPercent)}% CPU` +
        (serving ? `, listening on ${p.listening!.join(",")}` : ""),
      pids: [p.pid],
    })
  }
  for (const p of input.processes) {
    if (!p.cwdDeleted) continue
    out.push({
      kind: "deleted-cwd",
      severity: "warn",
      message: `${who(p)} is running in a deleted cwd (${fmtAge(p.elapsedSec)}, ${Math.round(p.cpuPercent)}% CPU)`,
      pids: [p.pid],
    })
  }
  for (const p of input.processes) {
    const root = scanRootOf(p.args, input.homeDir)
    if (!root) continue
    out.push({
      kind: "fs-scan",
      severity: "warn",
      message: `filesystem-wide scan ${who(p)} rooted at ${root}, running ${fmtAge(p.elapsedSec)}`,
      pids: [p.pid],
    })
  }
  const byPort = new Map<number, HostProcess[]>()
  for (const p of input.processes) for (const port of p.listening ?? []) byPort.set(port, [...(byPort.get(port) ?? []), p])
  for (const [port, ps] of [...byPort].sort((a, b) => a[0] - b[0])) {
    // One process forking workers onto a shared port is normal; distinct
    // parents on one port are leftover servers. Reparented processes all show
    // ppid 1 but are unrelated, so each counts as its own parent.
    if (ps.length < 2 || new Set(ps.map(p => (p.ppid <= 1 ? -p.pid : p.ppid))).size < 2) continue
    out.push({
      kind: "duplicate-port",
      severity: "warn",
      message: `${ps.length} servers listening on port ${port}: ${ps.map(p => `pid ${p.pid} (${p.command}, ${fmtAge(p.elapsedSec)})`).join(", ")}`,
      pids: ps.map(p => p.pid),
    })
  }
  return out
}

// ── probes ──────────────────────────────────────────────────────────

/** Raw inputs of a Linux CPU/disk sample: two reads of `/proc/stat` and
 *  `/proc/diskstats`. */
export interface LinuxCpuDiskSample {
  statBefore: string
  statAfter: string
  diskBefore: string
  diskAfter: string
  intervalSec: number
}

export interface CwdInfo {
  path: string
  deleted: boolean
}

/** Every external read the collector performs. Each takes the time (ms) it may
 *  spend; a probe that is not applicable on the platform is left undefined. */
export interface HostProbes {
  platform: NodeJS.Platform
  table: (timeoutMs: number) => Promise<ProcRow[]>
  vmStat?: (timeoutMs: number) => Promise<string>
  swapUsage?: (timeoutMs: number) => Promise<string>
  iostat?: (timeoutMs: number) => Promise<string>
  top?: (timeoutMs: number) => Promise<string>
  meminfo?: (timeoutMs: number) => Promise<string>
  cpuDisk?: (timeoutMs: number) => Promise<LinuxCpuDiskSample>
  listeners?: (timeoutMs: number) => Promise<string>
  cwds?: (pids: readonly number[], timeoutMs: number) => Promise<Map<number, CwdInfo>>
  smaps?: (pids: readonly number[], timeoutMs: number) => Promise<Map<number, Footprint>>
  envHints?: (pids: readonly number[], timeoutMs: number) => Promise<Map<number, string>>
  /** Pids of the child processes the probes themselves spawned, so they are
   *  not billed as host load. */
  ownPids?: () => ReadonlySet<number>
  loadAvg?: () => [number, number, number]
  cpuCount?: () => number
  totalMem?: () => number
}

export function createDefaultHostProbes(): HostProbes {
  const platform = process.platform
  const own = new Set<number>()
  const run = (cmd: string, args: string[], timeoutMs: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        cmd,
        args,
        { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, LC_ALL: "C" } },
        (err, stdout) => {
          if (!err) return resolve(stdout)
          // Non-zero exit with output (`lsof` exits 1 when a pid vanished) is
          // still an answer; a kill (timeout) never is.
          if ((err as { killed?: boolean }).killed) return reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
          return stdout ? resolve(stdout) : reject(err)
        },
      )
      if (child.pid !== undefined) own.add(child.pid)
    })
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

  const probes: HostProbes = {
    platform,
    table: t => createProcessTableSource(t)(),
    ownPids: () => own,
  }

  if (platform === "darwin") {
    probes.vmStat = t => run("vm_stat", [], t)
    probes.swapUsage = t => run("sysctl", ["vm.swapusage"], t)
    probes.iostat = t => run("iostat", ["-c", "2", "-w", "1"], t)
    probes.top = t => run("top", ["-l", "1", "-n", "40", "-o", "mem", "-stats", "pid,mem,cmprs"], t)
    probes.listeners = t => run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], t)
    probes.cwds = async (pids, t) => {
      const paths = parseLsofCwd(await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], t))
      // lsof keeps printing the old name of a removed directory, so existence
      // of that path is the test.
      const gone = new Map<string, boolean>()
      await Promise.all(
        [...new Set(paths.values())].map(async p => {
          gone.set(p, await stat(p).then(() => false, (e: NodeJS.ErrnoException) => e.code === "ENOENT"))
        }),
      )
      return new Map([...paths].map(([pid, path]) => [pid, { path, deleted: gone.get(path) === true }]))
    }
  } else if (platform === "linux") {
    probes.meminfo = () => readFile("/proc/meminfo", "utf8")
    probes.cpuDisk = async () => {
      const read = (): Promise<[string, string]> =>
        Promise.all([readFile("/proc/stat", "utf8"), readFile("/proc/diskstats", "utf8").catch(() => "")])
      const t0 = Date.now()
      const [statBefore, diskBefore] = await read()
      await sleep(400)
      const [statAfter, diskAfter] = await read()
      return { statBefore, statAfter, diskBefore, diskAfter, intervalSec: (Date.now() - t0) / 1000 }
    }
    probes.listeners = t => run("ss", ["-H", "-ltnp"], t)
    probes.cwds = async pids => {
      const out = new Map<number, CwdInfo>()
      await Promise.all(
        pids.map(async pid => {
          try {
            const link = await readlink(`/proc/${pid}/cwd`)
            const deleted = / \(deleted\)$/.test(link)
            out.set(pid, { path: deleted ? link.replace(/ \(deleted\)$/, "") : link, deleted })
          } catch {
            // exited, or not ours
          }
        }),
      )
      return out
    }
    probes.smaps = async pids => {
      const out = new Map<number, Footprint>()
      await Promise.all(
        pids.map(async pid => {
          try {
            const text = await readFile(`/proc/${pid}/smaps_rollup`, "utf8")
            const kb = (k: string): number => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0) * 1024
            out.set(pid, { memoryBytes: kb("Pss") + kb("SwapPss"), compressedBytes: kb("SwapPss") })
          } catch {
            // exited, or not ours
          }
        }),
      )
      return out
    }
  }
  if (platform !== "win32") probes.envHints = pids => defaultEnvHintReader(pids)
  return probes
}

// ── collection ──────────────────────────────────────────────────────

export interface HostSample {
  at: number
  budgetMs: number
  elapsedMs: number
  partial: string[]
  platform: NodeJS.Platform
  loadAvg: [number, number, number]
  cpuCount: number
  cpu?: HostLoadCpu
  memory: HostLoadMemory
  swap?: HostLoadSwap
  disks: DiskLoad[]
  table: ProcRow[]
  footprints: Map<number, Footprint>
  listeners: Map<number, number[]>
  cwds: Map<number, CwdInfo>
  envHints: Map<number, string>
}

export const DEFAULT_HOST_LOAD_BUDGET_MS = 1900

const OWN_PS_RE = /(^|\/)ps\s.*\bpid=,ppid=/

/** Processes worth a cwd/footprint look: the CPU and memory leaders plus
 *  reparented leftovers of the running user. */
function heavyCandidates(rows: readonly ProcRow[], uid: number | undefined, platform: NodeJS.Platform): number[] {
  const pick = new Set<number>()
  for (const r of [...rows].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 12)) pick.add(r.pid)
  for (const r of [...rows].sort((a, b) => b.rssKib - a.rssKib).slice(0, 12)) pick.add(r.pid)
  for (const r of rows) {
    if (pick.size >= 60) break
    if (r.ppid <= 1 && r.pid > 1 && (uid === undefined || r.uid === uid) && !isSystemLike(r, uid, platform)) pick.add(r.pid)
  }
  return [...pick].filter(p => p > 1)
}

/**
 * Run every probe under the budget and fold the results into one sample. A
 * failed probe is recorded in `partial` and its section left empty.
 */
export async function collectHostSample(
  probes: HostProbes,
  sessions: readonly StatsSessionDescriptor[],
  opts: { budgetMs?: number; now?: () => number; uid?: number; daemonPid?: number } = {},
): Promise<HostSample> {
  const now = opts.now ?? Date.now
  const budgetMs = opts.budgetMs ?? DEFAULT_HOST_LOAD_BUDGET_MS
  const t0 = now()
  const left = (): number => Math.max(0, budgetMs - (now() - t0))
  const partial: string[] = []
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined)

  const guarded = async <T>(name: string, fn: ((t: number) => Promise<T>) | undefined): Promise<T | undefined> => {
    if (!fn) return undefined
    const t = left()
    if (t < 100) {
      partial.push(`${name}: skipped (budget exhausted)`)
      return undefined
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        fn(t),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${t}ms`)), t + 50)
        }),
      ])
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0]!
      partial.push(`${name}: ${clip(msg, 120)}`)
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const tableP = guarded("ps", probes.table)
  // Follow-ups that need the table run as a chain so they overlap the
  // independent probes instead of waiting behind them.
  const followP = tableP.then(async rows => {
    if (!rows) return { cwds: undefined, smaps: undefined, env: undefined }
    const heavy = heavyCandidates(rows, uid, probes.platform)
    const claimed = attributeProcesses({
      table: rows,
      sessions: sessions.map(toStatsSessionInput),
      daemonPid: opts.daemonPid ?? process.pid,
      provisions: [],
      detail: "summary",
      nowMs: now(),
    }).claimedPids
    const strays = strayEnvCandidates(rows, claimed, uid)
    const rss = new Map(rows.map(r => [r.pid, r.rssKib]))
    const envPids = strays.sort((a, b) => (rss.get(b) ?? 0) - (rss.get(a) ?? 0)).slice(0, 30)
    const [cwds, smaps, env] = await Promise.all([
      guarded("cwd", probes.cwds && (t => probes.cwds!(heavy, t))),
      guarded("smaps", probes.smaps && (t => probes.smaps!(heavy, t))),
      envPids.length > 0 ? guarded("env", probes.envHints && (t => probes.envHints!(envPids, t))) : undefined,
    ])
    return { cwds, smaps, env }
  })

  const [vmStat, swapText, iostatText, topText, meminfoText, cpuDisk, listenText, follow, rows] = await Promise.all([
    guarded("vm_stat", probes.vmStat),
    guarded("swap", probes.swapUsage),
    guarded("iostat", probes.iostat),
    guarded("top", probes.top),
    guarded("meminfo", probes.meminfo),
    guarded("cpu/disk", probes.cpuDisk),
    guarded("listeners", probes.listeners),
    followP,
    tableP,
  ])

  const totalMem = probes.totalMem?.() ?? totalmem()
  const [l1, l5, l15] = probes.loadAvg?.() ?? loadavg()
  const io = iostatText ? parseIostat(iostatText) : undefined
  if (io && io.intervals < 2) partial.push("iostat: only the since-boot sample was readable (rates unavailable)")
  const top = topText ? parseTopHeader(topText) : {}
  const mem = meminfoText ? parseMeminfo(meminfoText) : undefined

  let memory: HostLoadMemory | undefined = mem?.memory
  if (!memory && vmStat) memory = parseVmStatMemory(vmStat, totalMem)
  if (!memory && top.mem) {
    memory = {
      totalBytes: totalMem,
      usedBytes: top.mem.usedBytes,
      wiredBytes: top.mem.wiredBytes,
      compressorBytes: top.mem.compressorBytes,
      freeBytes: top.mem.unusedBytes,
      availableBytes: top.mem.unusedBytes,
    }
  }
  memory ??= { totalBytes: totalMem, freeBytes: freemem(), availableBytes: freemem() }

  const linuxCpu = cpuDisk ? parseProcStatCpu(cpuDisk.statBefore, cpuDisk.statAfter) : undefined
  const cpu = (io && io.intervals >= 2 ? io.cpu : undefined) ?? linuxCpu ?? top.cpu
  const swap = (swapText ? parseSwapUsage(swapText) : undefined) ?? mem?.swap

  const disks = cpuDisk
    ? parseDiskstats(cpuDisk.diskBefore, cpuDisk.diskAfter, cpuDisk.intervalSec)
    : io && io.intervals >= 2
      ? io.disks
      : []

  const ownPids = probes.ownPids?.() ?? new Set<number>()
  const footprints = new Map<number, Footprint>()
  for (const [pid, fp] of topText ? parseTopProcesses(topText) : []) footprints.set(pid, fp)
  for (const [pid, fp] of follow.smaps ?? []) footprints.set(pid, fp)
  let listeners = new Map<number, number[]>()
  if (listenText) listeners = probes.platform === "linux" ? parseSsListeners(listenText) : parseLsofListeners(listenText)

  return {
    at: t0,
    budgetMs,
    elapsedMs: now() - t0,
    partial,
    platform: probes.platform,
    loadAvg: [l1 ?? 0, l5 ?? 0, l15 ?? 0],
    cpuCount: probes.cpuCount?.() ?? cpus().length,
    ...(cpu ? { cpu } : {}),
    memory,
    ...(swap ? { swap } : {}),
    disks,
    table: (rows ?? []).filter(r => !ownPids.has(r.pid) && !OWN_PS_RE.test(r.args)),
    footprints,
    listeners,
    cwds: follow.cwds ?? new Map(),
    envHints: follow.env ?? new Map(),
  }
}

// ── report ──────────────────────────────────────────────────────────

export interface BuildHostLoadOptions {
  sessions: readonly StatsSessionDescriptor[]
  detail?: HostLoadDetail
  daemonPid?: number
  uid?: number
  homeDir?: string
  provisions?: readonly ProvisionInFlight[]
  /** Restrict to these sessions' processes (subtree-scoped MCP caller). */
  visible?: ReadonlySet<string>
  thresholds?: Partial<HostLoadThresholds>
  topN?: number
}

const ARGS_TRUNCATE = 240

/** Fold a sample plus the session registry into the report. Pure. */
export function buildHostLoadReport(sample: HostSample, opts: BuildHostLoadOptions): HostLoadReport {
  const detail = opts.detail ?? "summary"
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined)
  const topN = opts.topN ?? 10
  const byId = new Map(opts.sessions.map(s => [s.id, s]))

  const a = attributeProcesses({
    table: sample.table,
    sessions: opts.sessions.map(toStatsSessionInput),
    daemonPid: opts.daemonPid ?? process.pid,
    provisions: opts.provisions ?? [],
    envHints: sample.envHints,
    detail: "full",
    nowMs: sample.at,
    ...(uid !== undefined ? { uid } : {}),
  })
  const owners = new Map<number, HostProcessOwner>()
  for (const s of a.sessions) {
    const d = byId.get(s.sessionId)
    const label = d?.label ?? d?.name
    for (const p of s.processes ?? []) {
      owners.set(p.pid, {
        kind: "session",
        sessionId: s.sessionId,
        ...(label ? { label } : {}),
        ...(p.detached ? { detached: true } : {}),
      })
    }
  }
  for (const p of a.daemon.processes ?? []) owners.set(p.pid, { kind: "daemon" })
  for (const p of a.provisioning.processes ?? []) owners.set(p.pid, { kind: "provisioning" })
  for (const o of a.orphans) {
    for (const p of o.processes ?? []) {
      owners.set(p.pid, { kind: "orphan", ...(o.sessionHint ? { sessionHint: o.sessionHint } : {}) })
    }
  }

  const processes: HostProcess[] = sample.table.map(r => {
    const fp = sample.footprints.get(r.pid)
    const ports = sample.listeners.get(r.pid)
    const cwd = sample.cwds.get(r.pid)
    const owner: HostProcessOwner =
      owners.get(r.pid) ??
      (isSystemLike(r, uid, sample.platform)
        ? { kind: "system" }
        : r.ppid <= 1 && r.pid > 1 && (uid === undefined || r.uid === uid)
          ? { kind: "orphan" }
          : { kind: "other" })
    const rssBytes = r.rssKib * 1024
    return {
      pid: r.pid,
      ppid: r.ppid,
      uid: r.uid,
      command: normalizeCommand(r.args),
      args: r.args.length > ARGS_TRUNCATE ? `${r.args.slice(0, ARGS_TRUNCATE)}...` : r.args,
      rssBytes,
      memoryBytes: fp ? Math.max(fp.memoryBytes, rssBytes) : rssBytes,
      memorySource: fp ? "footprint" : "rss",
      ...(fp && fp.compressedBytes > 0 ? { compressedBytes: fp.compressedBytes } : {}),
      cpuPercent: r.cpuPercent,
      elapsedSec: r.elapsedSec,
      owner,
      ...(ports?.length ? { listening: ports } : {}),
      ...(cwd?.deleted ? { cwdDeleted: true } : {}),
    }
  })

  const cores = sample.cpuCount
  let warnings = computeHostWarnings({
    loadAvg: sample.loadAvg,
    cpuCount: cores,
    ...(sample.swap ? { swap: sample.swap } : {}),
    processes,
    homeDir: opts.homeDir ?? homedir(),
    ...(opts.thresholds ? { thresholds: opts.thresholds } : {}),
  })

  let visibleProcs = processes
  if (opts.visible) {
    const vis = opts.visible
    visibleProcs = processes.filter(p => p.owner.kind === "session" && vis.has(p.owner.sessionId))
    const pids = new Set(visibleProcs.map(p => p.pid))
    warnings = warnings.filter(w => !w.pids || w.pids.every(pid => pids.has(pid)))
  }

  const byMemory = [...visibleProcs].sort((x, y) => y.memoryBytes - x.memoryBytes || x.pid - y.pid)
  const byCpu = [...visibleProcs].sort((x, y) => y.cpuPercent - x.cpuPercent || x.pid - y.pid)

  const report: HostLoadReport = {
    sampledAt: new Date(sample.at).toISOString(),
    detail,
    elapsedMs: sample.elapsedMs,
    partial: sample.partial,
    platform: sample.platform,
    loadAvg: sample.loadAvg,
    cpuCount: cores,
    loadPerCore: cores > 0 ? round1(sample.loadAvg[0] / cores) : 0,
    ...(sample.cpu ? { cpu: sample.cpu } : {}),
    memory: sample.memory,
    ...(sample.swap ? { swap: sample.swap } : {}),
    disks: sample.disks,
    topByCpu: byCpu.slice(0, topN),
    topByMemory: byMemory.slice(0, topN),
    warnings,
  }
  if (detail === "full") {
    const roll = new Map<string, HostSessionRollup>()
    for (const p of visibleProcs) {
      if (p.owner.kind !== "session") continue
      const cur = roll.get(p.owner.sessionId) ?? {
        sessionId: p.owner.sessionId,
        ...(p.owner.label ? { label: p.owner.label } : {}),
        rssBytes: 0,
        memoryBytes: 0,
        cpuPercent: 0,
        procCount: 0,
      }
      cur.rssBytes += p.rssBytes
      cur.memoryBytes += p.memoryBytes
      cur.cpuPercent = round1(cur.cpuPercent + p.cpuPercent)
      cur.procCount += 1
      roll.set(cur.sessionId, cur)
    }
    report.sessions = [...roll.values()].sort((x, y) => y.memoryBytes - x.memoryBytes)
    report.processes = byMemory
  }
  if (opts.visible) report.scoped = true
  return report
}

// ── service ─────────────────────────────────────────────────────────

export interface HostLoadServiceOptions {
  probes?: HostProbes
  tracker?: ProvisionTracker
  daemonPid?: number
  uid?: number
  homeDir?: string
  /** How long a sample is reused. Default 2000 ms. */
  ttlMs?: number
  /** Default per-call budget. */
  budgetMs?: number
  now?: () => number
}

export interface HostLoadService {
  report(
    sessions: readonly StatsSessionDescriptor[],
    opts?: {
      detail?: HostLoadDetail
      fresh?: boolean
      budgetMs?: number
      visible?: ReadonlySet<string>
      thresholds?: Partial<HostLoadThresholds>
    },
  ): Promise<HostLoadReport>
}

export function createHostLoadService(opts: HostLoadServiceOptions = {}): HostLoadService {
  const probes = opts.probes ?? createDefaultHostProbes()
  const tracker = opts.tracker ?? worktreeProvisions
  const ttlMs = opts.ttlMs ?? 2000
  const now = opts.now ?? Date.now
  let cached: HostSample | undefined
  let inFlight: Promise<HostSample> | undefined

  return {
    async report(sessions, o = {}) {
      const budgetMs = o.budgetMs ?? opts.budgetMs ?? DEFAULT_HOST_LOAD_BUDGET_MS
      // A partial sample taken under a smaller budget is not good enough for
      // a caller willing to wait longer (e.g. `--budget 15000` for `top`).
      const stale =
        !cached ||
        o.fresh === true ||
        now() - cached.at > ttlMs ||
        (cached.partial.length > 0 && budgetMs > cached.budgetMs)
      if (stale) {
        if (!inFlight || o.fresh === true) {
          inFlight = collectHostSample(probes, sessions, {
            budgetMs,
            now,
            ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
            ...(opts.daemonPid !== undefined ? { daemonPid: opts.daemonPid } : {}),
          }).then(
            s => {
              cached = s
              inFlight = undefined
              return s
            },
            err => {
              inFlight = undefined
              throw err
            },
          )
        }
        await inFlight
      }
      return buildHostLoadReport(cached!, {
        sessions,
        ...(o.detail ? { detail: o.detail } : {}),
        ...(opts.daemonPid !== undefined ? { daemonPid: opts.daemonPid } : {}),
        ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
        provisions: tracker.list(),
        ...(o.visible ? { visible: o.visible } : {}),
        ...(o.thresholds ? { thresholds: o.thresholds } : {}),
      })
    },
  }
}

let defaultService: HostLoadService | undefined

/** Process-wide collector shared by MCP, HTTP and in-process callers (a job
 *  scheduler gating on `report.loadPerCore` / `report.warnings`), so one probe
 *  round serves them all within the TTL. */
export function getHostLoadService(): HostLoadService {
  defaultService ??= createHostLoadService()
  return defaultService
}
