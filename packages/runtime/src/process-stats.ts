/**
 * Per-session process-tree resource sampler - answers "which session is
 * eating this host" without a hand-written `ps` walk.
 *
 * One process-table read (`ps` on macOS/Linux, `/proc` as the Linux fallback
 * when `ps` is missing) is attributed to sessions by climbing DOWN the tree
 * from each live session's adapter pid, which the registry already knows -
 * no env scraping for a session whose pid is known. Whatever is left over is
 * bucketed:
 *
 *   - `daemon`        the daemon process itself + its own non-session children
 *   - `provisioning`  daemon children spawned while a worktree provision is in
 *                     flight (setup hooks: `pnpm install`, builds) - work that
 *                     is not attached to a session yet
 *   - `orphans`       processes that look agentproto-owned (a dead session's
 *                     adapter-config dir / worktree in their args, or an
 *                     `AGENTPROTO_SESSION_ID` / adapter-config env marker on a
 *                     reparented process) but belong to no live session.
 *                     Reported only - never killed.
 *
 * The expensive part (table + host reads) is cached for a short TTL and
 * de-duplicated while in flight; attribution over the cached table is pure
 * and cheap, so a burst of `session_list`/CLI/HTTP callers costs one `ps`.
 *
 * `%CPU` is whatever `ps` reports: the kernel's decayed (macOS) or
 * lifetime-average (Linux) figure, not an instantaneous delta. That is the
 * right lens for "what has this session been costing", and the same number an
 * operator reads off `ps`/`top` - but it lags a sudden spike.
 */

import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import { freemem, loadavg, totalmem, cpus } from "node:os"
import { basename } from "node:path"
import { z } from "zod"

// ── process table ───────────────────────────────────────────────────

/** One row of the host process table. */
export interface ProcRow {
  pid: number
  ppid: number
  uid: number
  /** Resident set size in KiB (`ps` reports KiB on both macOS and Linux). */
  rssKib: number
  /** `%CPU` as reported by the OS (may exceed 100 for multi-threaded work). */
  cpuPercent: number
  /** Seconds since the process started. */
  elapsedSec: number
  /** Full command line as one string. */
  args: string
}

/** Argv for the shared `ps` invocation. `command=`/`args=` is the only
 *  spelling difference between BSD (macOS) and procps (Linux). */
export function psArgs(platform: NodeJS.Platform): string[] {
  const cmdCol = platform === "linux" ? "args=" : "command="
  return ["-A", "-ww", "-o", `pid=,ppid=,uid=,rss=,pcpu=,etime=,${cmdCol}`]
}

/** `[[dd-]hh:]mm:ss` (both platforms' `etime`) → seconds. NaN-safe: an
 *  unparseable value yields 0. */
export function parseEtime(raw: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim())
  if (!m) return 0
  const [, d, h, mi, s] = m
  return (
    Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s)
  )
}

const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s*(.*)$/

/**
 * Parse `ps -A -ww -o pid=,ppid=,uid=,rss=,pcpu=,etime=,<cmd>=` output.
 * `platform` selects the quirks: macOS shows kernel-less full paths with
 * spaces (`.app` bundles); Linux lists kernel threads as `[kworker/0:1]`
 * with rss 0. Rows that don't parse are skipped - a torn line never throws.
 */
export function parsePsTable(output: string, platform: NodeJS.Platform): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of output.split("\n")) {
    const m = PS_ROW_RE.exec(line)
    if (!m) continue
    const args = (m[7] ?? "").trim()
    // Linux kernel threads (`[kworker/…]`): no userland cost worth listing,
    // and they'd otherwise hang off pid 2 forever as noise.
    if (platform === "linux" && /^\[.+\]$/.test(args)) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      rssKib: Number(m[4]),
      cpuPercent: Number(m[5]!.replace(",", ".")),
      elapsedSec: parseEtime(m[6]!),
      args,
    })
  }
  return rows
}

export interface ProcStatContext {
  /** `/proc/uptime` first field. */
  uptimeSec: number
  /** Kernel USER_HZ - 100 on every mainstream Linux. */
  clkTck: number
  /** Bytes per page - 4096 on x86, may be larger on arm64 kernels. */
  pageSize: number
}

/**
 * Build one {@link ProcRow} from a Linux `/proc/<pid>/stat` line + its
 * `cmdline` (NUL-separated) + owning uid. `comm` (field 2) may itself contain
 * spaces and parens, so fields are indexed from the LAST `)`. Returns null for
 * a torn/unparseable stat line.
 */
export function parseProcStat(
  statLine: string,
  cmdline: string,
  uid: number,
  ctx: ProcStatContext,
): ProcRow | null {
  const open = statLine.indexOf("(")
  const close = statLine.lastIndexOf(")")
  if (open < 0 || close < open) return null
  const pid = Number(statLine.slice(0, open).trim())
  const comm = statLine.slice(open + 1, close)
  // After `)`: state(3) ppid(4) … utime(14) stime(15) … starttime(22) … rss(24)
  const rest = statLine.slice(close + 1).trim().split(/\s+/)
  const at = (field: number): number => Number(rest[field - 3])
  const ppid = at(4)
  const utime = at(14)
  const stime = at(15)
  const startTicks = at(22)
  const rssPages = at(24)
  if (![pid, ppid, utime, stime, startTicks, rssPages].every(Number.isFinite)) return null
  const elapsedSec = Math.max(0, ctx.uptimeSec - startTicks / ctx.clkTck)
  const cpuSec = (utime + stime) / ctx.clkTck
  const args = cmdline.replace(/\0+$/, "").replace(/\0/g, " ").trim()
  return {
    pid,
    ppid,
    uid,
    rssKib: Math.round((rssPages * ctx.pageSize) / 1024),
    cpuPercent: elapsedSec > 0 ? Math.round((cpuSec / elapsedSec) * 1000) / 10 : 0,
    elapsedSec: Math.floor(elapsedSec),
    args: args || `[${comm}]`,
  }
}

/** Where the process table comes from. Injectable for tests. */
export type ProcessTableSource = () => Promise<ProcRow[]>

function execPs(platform: NodeJS.Platform): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      psArgs(platform),
      // LC_ALL=C pins the decimal separator of `pcpu` to `.` regardless of the
      // operator's locale.
      { maxBuffer: 32 * 1024 * 1024, timeout: 20_000, env: { ...process.env, LC_ALL: "C" } },
      (err, stdout) =>
        err
          ? reject(new Error(`ps failed${(err as { killed?: boolean }).killed ? " (timed out, host overloaded?)" : ""}: ${err.message.trim()}`))
          : resolve(stdout),
    )
  })
}

async function readProcfsTable(): Promise<ProcRow[]> {
  const uptimeSec = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/)[0])
  const ctx: ProcStatContext = { uptimeSec, clkTck: 100, pageSize: 4096 }
  const entries = (await readdir("/proc")).filter(e => /^\d+$/.test(e))
  const rows = await Promise.all(
    entries.map(async e => {
      try {
        const [statLine, cmdline, st] = await Promise.all([
          readFile(`/proc/${e}/stat`, "utf8"),
          readFile(`/proc/${e}/cmdline`, "utf8").catch(() => ""),
          stat(`/proc/${e}`),
        ])
        return parseProcStat(statLine, cmdline, st.uid, ctx)
      } catch {
        return null // exited between readdir and read
      }
    }),
  )
  return rows.filter((r): r is ProcRow => r !== null)
}

/** Default table source: `ps` on macOS/Linux, `/proc` when Linux has no `ps`
 *  (slim containers). Windows resolves to an empty table - no data, no throw. */
export const defaultProcessTableSource: ProcessTableSource = async () => {
  const platform = process.platform
  if (platform === "win32") return []
  try {
    return parsePsTable(await execPs(platform), platform)
  } catch (err) {
    if (platform === "linux") return readProcfsTable()
    throw err
  }
}

// ── command normalization ───────────────────────────────────────────

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "npx", "bunx", "pnpx", "corepack"])
const RUNNERS = new Set(["node", "nodejs", "bun", "deno", "tsx", "ts-node"])
/** Package-manager flags whose next token is a value, not the subcommand. */
const PM_VALUE_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--prefix", "--cwd", "--workspace"])
const SCRIPT_RUNNER_SUBS = new Set(["run", "exec", "dlx", "x"])

/** Tool names worth naming in a breakdown, keyed by lowercase script/package. */
const KNOWN_TOOLS: Record<string, string> = {
  pnpm: "pnpm",
  npm: "npm",
  yarn: "yarn",
  npx: "npx",
  vitest: "vitest",
  jest: "jest",
  tsc: "tsc",
  tsserver: "tsserver",
  tsup: "tsup",
  esbuild: "esbuild",
  vite: "vite",
  turbo: "turbo",
  eslint: "eslint",
  prettier: "prettier",
  biome: "biome",
  rollup: "rollup",
  webpack: "webpack",
  next: "next",
  playwright: "playwright",
  "claude-code": "claude",
  claude: "claude",
}

function stripExt(name: string): string {
  return name.replace(/\.(?:c|m)?[jt]s$/, "").replace(/\.exe$/, "")
}

/** The package directory after the LAST `node_modules/` in a script path,
 *  scope-aware (`@anthropic-ai/claude-code` → `claude-code`). */
function packageOfScript(script: string): string | undefined {
  const idx = script.lastIndexOf("node_modules/")
  if (idx < 0) return undefined
  const parts = script.slice(idx + "node_modules/".length).split("/")
  if (parts[0]?.startsWith("@")) return parts[1]
  return parts[0]
}

function toolFromScript(script: string): string | undefined {
  const base = stripExt(basename(script)).toLowerCase()
  if (KNOWN_TOOLS[base]) return KNOWN_TOOLS[base]
  const pkg = packageOfScript(script)?.toLowerCase()
  if (pkg && KNOWN_TOOLS[pkg]) return KNOWN_TOOLS[pkg]
  return undefined
}

function withSubcommand(tool: string, rest: readonly string[]): string {
  if (!PACKAGE_MANAGERS.has(tool)) return tool
  const args: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (PM_VALUE_FLAGS.has(t)) i += 1
    else if (!t.startsWith("-")) args.push(t)
  }
  const sub = args[0]
  if (!sub) return tool
  if (SCRIPT_RUNNER_SUBS.has(sub) && args[1]) return `${tool} ${sub} ${args[1]}`
  return `${tool} ${sub}`
}

/**
 * Collapse a raw command line to the short name an operator reads:
 * `node …/pnpm.cjs install` → `pnpm install`, a vitest fork worker →
 * `vitest`, `…/@esbuild/darwin-arm64/bin/esbuild --service` → `esbuild`,
 * `…/claude-code/cli.js` → `claude`. Unrecognised node scripts stay `node`;
 * anything else is its executable's basename (a macOS `.app` bundle is the
 * app's name). Pure - no filesystem access.
 */
export function normalizeCommand(args: string): string {
  const app = /\/([^/]+)\.app\/Contents\//.exec(args)
  if (app) return app[1]!
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return "?"
  const argv0 = stripExt(basename(tokens[0]!))
  const lower = argv0.toLowerCase()

  if (RUNNERS.has(lower)) {
    // First positional after the runner is the script; flags that take a
    // value (`-r x`, `--import x`) are skipped so the value isn't mistaken
    // for the script. An inline eval has no script at all.
    const valueFlags = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"])
    let i = 1
    while (i < tokens.length) {
      const t = tokens[i]!
      if (t === "-e" || t === "-p" || t === "--eval" || t === "--print") return lower
      if (valueFlags.has(t)) {
        i += 2
        continue
      }
      if (t.startsWith("-")) {
        i += 1
        continue
      }
      break
    }
    const script = tokens[i]
    if (!script) return lower
    const tool = toolFromScript(script)
    if (!tool) return lower
    return withSubcommand(tool, tokens.slice(i + 1))
  }

  if (KNOWN_TOOLS[lower]) return withSubcommand(KNOWN_TOOLS[lower]!, tokens.slice(1))
  if (PACKAGE_MANAGERS.has(lower)) return withSubcommand(lower, tokens.slice(1))
  return argv0
}

// ── stats shapes ────────────────────────────────────────────────────

export interface CommandGroupStats {
  /** Normalized command name (`pnpm install`, `vitest`, `git`, …). */
  name: string
  count: number
  rssBytes: number
  cpuPercent: number
}

export interface ProcessDetail {
  pid: number
  ppid: number
  /** Normalized name. */
  command: string
  /** Raw command line, truncated. */
  args: string
  rssBytes: number
  cpuPercent: number
  elapsedSec: number
  /** True when the process was attributed by env/args marker rather than by
   *  descent from the session's adapter pid (a reparented stray). */
  detached?: boolean
}

export interface ResourceStats {
  rssBytes: number
  cpuPercent: number
  procCount: number
  /** Top command groups by RSS. */
  topCommands: CommandGroupStats[]
  /** Every process, largest RSS first - populated by `detail: "full"` only. */
  processes?: ProcessDetail[]
}

export interface SessionResourceStats extends ResourceStats {
  sessionId: string
  /** The adapter pid the tree was climbed from. */
  pid: number
}

export interface OrphanGroup extends ResourceStats {
  /** Top of the orphaned subtree. */
  pid: number
  command: string
  elapsedSec: number
  /** Session id the markers point at, when one was recoverable. */
  sessionHint?: string
  /** Why this looks agentproto-owned. */
  reason: string
}

export interface ProvisionInFlight {
  sessionId?: string
  label?: string
  cwd: string
  startedAt: string
}

export interface ProvisioningStats extends ResourceStats {
  inFlight: ProvisionInFlight[]
}

export interface HostInfo {
  platform: NodeJS.Platform
  cpuCount: number
  /** 1/5/15-minute load averages. */
  loadAvg: [number, number, number]
  totalMemBytes: number
  /** Memory available for new work - `MemAvailable` on Linux, free +
   *  reclaimable pages on macOS, `os.freemem()` elsewhere. */
  freeMemBytes: number
}

export type StatsDetail = "summary" | "full"

export interface ProcessStatsReport {
  sampledAt: string
  detail: StatsDetail
  host: HostInfo
  sessions: SessionResourceStats[]
  daemon: ResourceStats & { pid: number }
  provisioning: ProvisioningStats
  orphans: OrphanGroup[]
  /** Sessions + daemon + provisioning. Orphans are reported separately and
   *  are NOT in this sum (they belong to nobody). */
  totals: { rssBytes: number; cpuPercent: number; procCount: number }
}

// ── worktree provision tracker ──────────────────────────────────────

export interface ProvisionTracker {
  begin(info: { sessionId?: string; label?: string; cwd: string }): () => void
  list(): ProvisionInFlight[]
}

export function createProvisionTracker(now: () => number = Date.now): ProvisionTracker {
  const live = new Map<symbol, ProvisionInFlight>()
  return {
    begin(info) {
      const key = Symbol("provision")
      live.set(key, {
        ...(info.sessionId ? { sessionId: info.sessionId } : {}),
        ...(info.label ? { label: info.label } : {}),
        cwd: info.cwd,
        startedAt: new Date(now()).toISOString(),
      })
      return () => void live.delete(key)
    },
    list: () => [...live.values()],
  }
}

/** Process-wide tracker the spawn path reports into and the default sampler
 *  reads from. */
export const worktreeProvisions: ProvisionTracker = createProvisionTracker()

/** Run `fn` (a worktree provision) with the tracker marking it in flight. */
export async function trackWorktreeProvision<T>(
  info: { sessionId?: string; label?: string; cwd: string },
  fn: () => Promise<T>,
  tracker: ProvisionTracker = worktreeProvisions,
): Promise<T> {
  const end = tracker.begin(info)
  try {
    return await fn()
  } finally {
    end()
  }
}

// ── attribution (pure) ──────────────────────────────────────────────

/** The slice of a session the attribution needs. */
export interface StatsSessionInput {
  id: string
  /** Adapter/PTY pid, when the registry has one. */
  pid?: number | null
  live: boolean
  /** Paths whose presence in a process's args marks it as this session's
   *  (adapter-config dir, worktree). Used for ended sessions' orphans. */
  markerPaths?: readonly string[]
}

export interface AttributeInput {
  table: readonly ProcRow[]
  sessions: readonly StatsSessionInput[]
  daemonPid: number
  provisions: readonly ProvisionInFlight[]
  /** Env-derived `pid → session id` hints for stray roots. */
  envHints?: ReadonlyMap<number, string>
  detail: StatsDetail
  /** Uid whose stray processes are candidates for orphan detection. */
  uid?: number
  /** Wall clock, for dating a provision against `elapsedSec`. */
  nowMs: number
  topN?: number
}

export interface AttributionResult {
  sessions: SessionResourceStats[]
  daemon: ResourceStats & { pid: number }
  provisioning: ResourceStats
  orphans: OrphanGroup[]
  /** Pids under a live session or the daemon, before stray attribution -
   *  the complement is the forest whose env is worth reading. */
  claimedPids: ReadonlySet<number>
}

const SESSION_MARKER_RES = [
  /\.agentproto\/adapter-config\/([A-Za-z0-9_-]+)/,
  /AGENTPROTO_SESSION_ID=([A-Za-z0-9_-]+)/,
]
const OWN_PS_RE = /(^|\/)ps\s.*\bpid=,ppid=/
/** macOS shows an exited-but-unreaped process as `(name)`; a `vm_stat` child of
 *  the daemon is the host-memory probe itself. Neither is work worth billing. */
const ZOMBIE_RE = /^\([^)]*\)$/
const isSamplerNoise = (r: ProcRow, daemonPid: number): boolean =>
  ZOMBIE_RE.test(r.args) || (r.ppid === daemonPid && /(^|\/)vm_stat$/.test(r.args))
const ARGS_TRUNCATE = 240
const PROVISION_SLACK_MS = 2500

/** Session id an args/env string points at, if any. */
export function sessionHintFrom(text: string): string | undefined {
  for (const re of SESSION_MARKER_RES) {
    const m = re.exec(text)
    if (m) return m[1]
  }
  return undefined
}

/** Roots of the unattributed forest worth reading env for: same-uid processes
 *  reparented to init (`ppid <= 1`) - where a killed session's leftovers land.
 *  Exposed so the sampler reads env for only these, once each. */
export function strayEnvCandidates(
  table: readonly ProcRow[],
  claimed: ReadonlySet<number>,
  uid: number | undefined,
): number[] {
  return table
    .filter(r => !claimed.has(r.pid) && r.ppid <= 1 && r.pid > 1 && (uid === undefined || r.uid === uid))
    .map(r => r.pid)
}

function summarize(
  pids: readonly number[],
  byPid: ReadonlyMap<number, ProcRow>,
  detail: StatsDetail,
  topN: number,
  detached?: ReadonlySet<number>,
): ResourceStats {
  let rssKib = 0
  let cpu = 0
  const groups = new Map<string, CommandGroupStats>()
  const procs: ProcessDetail[] = []
  for (const pid of pids) {
    const r = byPid.get(pid)
    if (!r) continue
    rssKib += r.rssKib
    cpu += r.cpuPercent
    const name = normalizeCommand(r.args)
    const g = groups.get(name) ?? { name, count: 0, rssBytes: 0, cpuPercent: 0 }
    g.count += 1
    g.rssBytes += r.rssKib * 1024
    g.cpuPercent = round1(g.cpuPercent + r.cpuPercent)
    groups.set(name, g)
    if (detail === "full") {
      procs.push({
        pid: r.pid,
        ppid: r.ppid,
        command: name,
        args: r.args.length > ARGS_TRUNCATE ? `${r.args.slice(0, ARGS_TRUNCATE)}...` : r.args,
        rssBytes: r.rssKib * 1024,
        cpuPercent: r.cpuPercent,
        elapsedSec: r.elapsedSec,
        ...(detached?.has(pid) ? { detached: true } : {}),
      })
    }
  }
  const topCommands = [...groups.values()].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, topN)
  return {
    rssBytes: rssKib * 1024,
    cpuPercent: round1(cpu),
    procCount: pids.filter(p => byPid.has(p)).length,
    topCommands,
    ...(detail === "full" ? { processes: procs.sort((a, b) => b.rssBytes - a.rssBytes) } : {}),
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * Attribute a process table to sessions / daemon / provisioning / orphans.
 * Pure over its input, so every rule is unit-testable with a fake table.
 */
export function attributeProcesses(input: AttributeInput): AttributionResult {
  const topN = input.topN ?? 5
  const rows = input.table.filter(r => !OWN_PS_RE.test(r.args) && !isSamplerNoise(r, input.daemonPid))
  const byPid = new Map(rows.map(r => [r.pid, r]))
  const children = new Map<number, number[]>()
  for (const r of rows) {
    const list = children.get(r.ppid)
    if (list) list.push(r.pid)
    else children.set(r.ppid, [r.pid])
  }
  const claimed = new Set<number>()

  const descend = (root: number, stopAt: ReadonlySet<number> = new Set()): number[] => {
    const out: number[] = []
    const stack = [root]
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (claimed.has(pid) || !byPid.has(pid)) continue
      if (pid !== root && stopAt.has(pid)) continue
      claimed.add(pid)
      out.push(pid)
      for (const c of children.get(pid) ?? []) stack.push(c)
    }
    return out
  }

  // 1. Live sessions, climbed from their known adapter pid. Other sessions'
  //    roots are boundaries so nested adapters keep their own subtree.
  const liveWithPid = input.sessions.filter(
    (s): s is StatsSessionInput & { pid: number } =>
      s.live && typeof s.pid === "number" && s.pid > 0 && byPid.has(s.pid),
  )
  const rootPids = new Set(liveWithPid.map(s => s.pid))
  const sessionPids = new Map<string, number[]>()
  for (const s of liveWithPid) sessionPids.set(s.id, descend(s.pid, rootPids))
  const liveIds = new Set(input.sessions.filter(s => s.live).map(s => s.id))

  // 2. Provisioning: unclaimed direct children of the daemon that started
  //    after the earliest in-flight provision began. Whole subtrees.
  const provisioningPids: number[] = []
  if (input.provisions.length > 0) {
    const earliest = Math.min(...input.provisions.map(p => Date.parse(p.startedAt)))
    for (const c of children.get(input.daemonPid) ?? []) {
      const r = byPid.get(c)
      if (!r || claimed.has(c)) continue
      if (input.nowMs - r.elapsedSec * 1000 >= earliest - PROVISION_SLACK_MS) {
        provisioningPids.push(...descend(c, rootPids))
      }
    }
  }

  // 3. Daemon itself + whatever else hangs off it.
  const daemonPids = byPid.has(input.daemonPid) ? descend(input.daemonPid, rootPids) : []

  // 4. Strays: env/args markers over the unclaimed remainder.
  const claimedPids = new Set(claimed)
  const markerFor = new Map<string, string>()
  for (const s of input.sessions) for (const p of s.markerPaths ?? []) if (p) markerFor.set(p, s.id)
  const stray = rows.filter(r => !claimed.has(r.pid) && (input.uid === undefined || r.uid === input.uid))
  const hintByPid = new Map<number, { session: string; reason: string }>()
  for (const r of stray) {
    const fromArgs = sessionHintFrom(r.args)
    if (fromArgs) {
      hintByPid.set(r.pid, { session: fromArgs, reason: "adapter-config marker in command line" })
      continue
    }
    const fromEnv = input.envHints?.get(r.pid)
    if (fromEnv) {
      hintByPid.set(r.pid, { session: fromEnv, reason: "session env marker" })
      continue
    }
    for (const [path, id] of markerFor) {
      if (r.args.includes(path)) {
        hintByPid.set(r.pid, { session: id, reason: "references an ended session's directory" })
        break
      }
    }
  }
  // A marked process's whole subtree shares its attribution.
  const strayRoots: Array<{ pid: number; session: string; reason: string }> = []
  for (const [pid, hint] of hintByPid) {
    let top = pid
    // Climb only through ancestors that are themselves marked, so an unmarked
    // parent (a shell, another daemon) is never swallowed into the group.
    for (;;) {
      const parent = byPid.get(top)?.ppid
      if (parent === undefined || !hintByPid.has(parent)) break
      top = parent
    }
    if (!strayRoots.some(r => r.pid === top)) {
      strayRoots.push({ pid: top, session: hintByPid.get(top)?.session ?? hint.session, reason: hintByPid.get(top)?.reason ?? hint.reason })
    }
  }
  const detached = new Set<number>()
  const orphans: OrphanGroup[] = []
  for (const root of strayRoots) {
    const pids = descend(root.pid)
    if (pids.length === 0) continue
    if (liveIds.has(root.session)) {
      const owned = sessionPids.get(root.session) ?? []
      for (const p of pids) detached.add(p)
      sessionPids.set(root.session, [...owned, ...pids])
      continue
    }
    const r = byPid.get(root.pid)!
    orphans.push({
      pid: root.pid,
      command: normalizeCommand(r.args),
      elapsedSec: r.elapsedSec,
      sessionHint: root.session,
      reason: root.reason,
      ...summarize(pids, byPid, input.detail, topN),
    })
  }
  orphans.sort((a, b) => b.rssBytes - a.rssBytes)

  const sessions: SessionResourceStats[] = []
  for (const s of liveWithPid) {
    const pids = sessionPids.get(s.id) ?? []
    sessions.push({
      sessionId: s.id,
      pid: s.pid,
      ...summarize(pids, byPid, input.detail, topN, detached),
    })
  }
  sessions.sort((a, b) => b.rssBytes - a.rssBytes)

  return {
    sessions,
    daemon: { pid: input.daemonPid, ...summarize(daemonPids, byPid, input.detail, topN) },
    provisioning: summarize(provisioningPids, byPid, input.detail, topN),
    orphans,
    claimedPids,
  }
}

// ── host info ───────────────────────────────────────────────────────

/** `MemAvailable` (kB → bytes) from `/proc/meminfo`, or undefined. */
export function parseMeminfoAvailable(text: string): number | undefined {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)
  return m ? Number(m[1]) * 1024 : undefined
}

/** Free + reclaimable bytes from macOS `vm_stat` (free, inactive, speculative,
 *  purgeable pages) - `os.freemem()` there counts only never-touched pages and
 *  reads misleadingly small. */
export function parseVmStatAvailable(text: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(text)
  if (!size) return undefined
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(text)
    return m ? Number(m[1]) : 0
  }
  const total = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")
  return total * Number(size[1])
}

function execText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

export type HostInfoSource = () => Promise<HostInfo>

export const defaultHostInfoSource: HostInfoSource = async () => {
  let freeMemBytes = freemem()
  try {
    if (process.platform === "linux") {
      freeMemBytes = parseMeminfoAvailable(await readFile("/proc/meminfo", "utf8")) ?? freeMemBytes
    } else if (process.platform === "darwin") {
      freeMemBytes = parseVmStatAvailable(await execText("vm_stat", [])) ?? freeMemBytes
    }
  } catch {
    // fall back to os.freemem()
  }
  const [a, b, c] = loadavg()
  return {
    platform: process.platform,
    cpuCount: cpus().length,
    loadAvg: [a ?? 0, b ?? 0, c ?? 0],
    totalMemBytes: totalmem(),
    freeMemBytes,
  }
}

// ── env hints ───────────────────────────────────────────────────────

/** Read `pid → session id` markers from the environment of `pids`. Best
 *  effort: Linux reads `/proc/<pid>/environ` (own uid only); macOS asks
 *  `ps -E`, which some hardened setups blank out - a miss just means a stray
 *  is judged by its command line alone. Never throws. */
export type EnvHintReader = (pids: readonly number[]) => Promise<Map<number, string>>

export const defaultEnvHintReader: EnvHintReader = async pids => {
  const hints = new Map<number, string>()
  if (pids.length === 0 || process.platform === "win32") return hints
  if (process.platform === "linux") {
    await Promise.all(
      pids.map(async pid => {
        try {
          const env = await readFile(`/proc/${pid}/environ`, "utf8")
          const hint = sessionHintFrom(env.replace(/\0/g, "\n"))
          if (hint) hints.set(pid, hint)
        } catch {
          // exited or not ours
        }
      }),
    )
    return hints
  }
  try {
    const out = await execText("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")])
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line)
      const hint = m ? sessionHintFrom(m[2]!) : undefined
      if (m && hint) hints.set(Number(m[1]), hint)
    }
  } catch {
    // ps -E unsupported or blocked
  }
  return hints
}

// ── service ─────────────────────────────────────────────────────────

/** The slice of a registry descriptor the service reads. */
export interface StatsSessionDescriptor {
  id: string
  pid?: number | null
  status: string
  adapterConfigDir?: string
  worktreePath?: string
  label?: string
  name?: string
  kind?: string
  adapterSlug?: string
}

export interface ProcessStatsServiceOptions {
  table?: ProcessTableSource
  host?: HostInfoSource
  envHints?: EnvHintReader
  tracker?: ProvisionTracker
  daemonPid?: number
  uid?: number
  /** How long a sampled table is reused. Default 3000 ms. */
  ttlMs?: number
  now?: () => number
}

export interface ProcessStatsService {
  report(
    sessions: readonly StatsSessionDescriptor[],
    opts?: { detail?: StatsDetail; fresh?: boolean },
  ): Promise<ProcessStatsReport>
}

interface Snapshot {
  at: number
  table: ProcRow[]
  host: HostInfo
  envHints: Map<number, string>
}

export function createProcessStatsService(opts: ProcessStatsServiceOptions = {}): ProcessStatsService {
  const table = opts.table ?? defaultProcessTableSource
  const host = opts.host ?? defaultHostInfoSource
  const readEnv = opts.envHints ?? defaultEnvHintReader
  const tracker = opts.tracker ?? worktreeProvisions
  const ttlMs = opts.ttlMs ?? 3000
  const now = opts.now ?? Date.now
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined)
  // A process's environment never changes after exec, so a stray's marker is
  // read once per (pid, start time) and remembered. `null` = looked, none.
  const envMemo = new Map<string, string | null>()

  let cached: Snapshot | undefined
  let inFlight: Promise<Snapshot> | undefined

  const take = async (sessions: readonly StatsSessionDescriptor[]): Promise<Snapshot> => {
    const [rows, hostInfo] = await Promise.all([table(), host()])
    const daemonPid = opts.daemonPid ?? process.pid
    const claimed = attributeProcesses({
      table: rows,
      sessions: sessions.map(toInput),
      daemonPid,
      provisions: [],
      detail: "summary",
      nowMs: now(),
    }).claimedPids
    const byPid = new Map(rows.map(r => [r.pid, r]))
    const keyOf = (pid: number): string =>
      `${pid}:${Math.floor((now() - (byPid.get(pid)?.elapsedSec ?? 0) * 1000) / 2000)}`
    const candidates = strayEnvCandidates(rows, claimed, uid)
    const unread = candidates.filter(p => !envMemo.has(keyOf(p)))
    const read = await readEnv(unread)
    for (const p of unread) envMemo.set(keyOf(p), read.get(p) ?? null)
    const envHints = new Map<number, string>()
    for (const p of candidates) {
      const h = envMemo.get(keyOf(p))
      if (h) envHints.set(p, h)
    }
    if (envMemo.size > 4096) envMemo.clear()
    return { at: now(), table: rows, host: hostInfo, envHints }
  }

  return {
    async report(sessions, o = {}) {
      const detail = o.detail ?? "summary"
      const stale = !cached || o.fresh === true || now() - cached.at > ttlMs
      if (stale) {
        if (!inFlight || o.fresh === true) {
          inFlight = take(sessions).then(
            snap => {
              cached = snap
              inFlight = undefined
              return snap
            },
            err => {
              inFlight = undefined
              throw err
            },
          )
        }
        await inFlight
      }
      const snap = cached!
      const daemonPid = opts.daemonPid ?? process.pid
      const provisions = tracker.list()
      const a = attributeProcesses({
        table: snap.table,
        sessions: sessions.map(toInput),
        daemonPid,
        provisions,
        envHints: snap.envHints,
        detail,
        nowMs: snap.at,
        ...(uid !== undefined ? { uid } : {}),
      })
      const sum = (parts: ResourceStats[]) => ({
        rssBytes: parts.reduce((n, p) => n + p.rssBytes, 0),
        cpuPercent: round1(parts.reduce((n, p) => n + p.cpuPercent, 0)),
        procCount: parts.reduce((n, p) => n + p.procCount, 0),
      })
      return {
        sampledAt: new Date(snap.at).toISOString(),
        detail,
        host: snap.host,
        sessions: a.sessions,
        daemon: a.daemon,
        provisioning: { ...a.provisioning, inFlight: provisions },
        orphans: a.orphans,
        totals: sum([...a.sessions, a.daemon, a.provisioning]),
      }
    },
  }
}

function toInput(s: StatsSessionDescriptor): StatsSessionInput {
  return {
    id: s.id,
    pid: s.pid ?? null,
    live: s.status === "running" || s.status === "starting",
    markerPaths: [s.adapterConfigDir, s.worktreePath].filter((p): p is string => typeof p === "string" && p.length > 1),
  }
}

let defaultService: ProcessStatsService | undefined

/** Process-wide sampler shared by every surface (MCP, HTTP, CLI-over-HTTP),
 *  so one `ps` per TTL serves them all. */
export function getProcessStatsService(): ProcessStatsService {
  defaultService ??= createProcessStatsService()
  return defaultService
}

// ── surface helpers (shared by MCP + HTTP) ──────────────────────────

/** `stats` request param: `true` (summary) or `"full"` (per-process). MCP
 *  clients that stringify booleans still work. */
export const statsParamSchema = z
  .preprocess(v => (v === "true" ? true : v === "false" ? false : v), z.union([z.boolean(), z.literal("full")]))
  .optional()

/** `true | "full" | false | undefined` → the detail level, or undefined for
 *  "don't sample". */
export function statsDetailOf(param: boolean | "full" | undefined): StatsDetail | undefined {
  if (param === "full") return "full"
  return param === true ? "summary" : undefined
}

/** What a session row carries under `stats`. */
export type SessionRowStats = Omit<SessionResourceStats, "sessionId">

/**
 * Stamp `stats` onto the live rows that have a measured process tree. One
 * shared sample serves every row; rows with no pid / no live process keep no
 * `stats` at all ("no data" is not "measured zero"). Never throws - a failed
 * sample returns the rows untouched.
 */
export async function withSessionStats<T extends StatsSessionDescriptor>(
  rows: readonly T[],
  allSessions: readonly StatsSessionDescriptor[],
  detail: StatsDetail,
  service: ProcessStatsService = getProcessStatsService(),
): Promise<Array<T & { stats?: SessionRowStats }>> {
  let report: ProcessStatsReport
  try {
    report = await service.report(allSessions, { detail })
  } catch {
    return [...rows]
  }
  const byId = new Map(report.sessions.map(s => [s.sessionId, s]))
  return rows.map(r => {
    const hit = byId.get(r.id)
    if (!hit) return r
    const { sessionId: _id, ...stats } = hit
    return { ...r, stats }
  })
}

export interface LabeledSessionStats extends SessionResourceStats {
  label?: string
  name?: string
  kind?: string
  status: string
  adapterSlug?: string
}

export interface LabeledProcessStatsReport extends Omit<ProcessStatsReport, "sessions"> {
  sessions: LabeledSessionStats[]
  /** Set for a subtree-scoped caller: host-wide buckets are withheld. */
  scoped?: true
}

/**
 * The full report every surface returns (`GET /sessions/stats`, the
 * `session_stats` MCP tool, the CLI's `--stats`): per-session rows labelled
 * from the registry. `visible` scopes a subtree-restricted caller to its own
 * sessions and withholds the host-wide buckets (daemon, provisioning,
 * orphans) - those describe the whole machine, not the caller's subtree.
 */
export async function buildLabeledStatsReport(input: {
  sessions: readonly StatsSessionDescriptor[]
  detail?: StatsDetail
  fresh?: boolean
  visible?: ReadonlySet<string>
  service?: ProcessStatsService
}): Promise<LabeledProcessStatsReport> {
  const service = input.service ?? getProcessStatsService()
  const report = await service.report(input.sessions, {
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.fresh ? { fresh: true } : {}),
  })
  const byId = new Map(input.sessions.map(d => [d.id, d]))
  const rows: LabeledSessionStats[] = report.sessions
    .filter(r => !input.visible || input.visible.has(r.sessionId))
    .map(r => {
      const d = byId.get(r.sessionId)
      return {
        ...r,
        ...(d?.label ? { label: d.label } : {}),
        ...(d?.name ? { name: d.name } : {}),
        ...(d?.kind ? { kind: d.kind } : {}),
        status: d?.status ?? "running",
        ...(d?.adapterSlug ? { adapterSlug: d.adapterSlug } : {}),
      }
    })
  if (!input.visible) return { ...report, sessions: rows }
  const empty: ResourceStats = { rssBytes: 0, cpuPercent: 0, procCount: 0, topCommands: [] }
  return {
    ...report,
    sessions: rows,
    daemon: { ...empty, pid: report.daemon.pid },
    provisioning: { ...empty, inFlight: [] },
    orphans: [],
    totals: {
      rssBytes: rows.reduce((n, r) => n + r.rssBytes, 0),
      cpuPercent: round1(rows.reduce((n, r) => n + r.cpuPercent, 0)),
      procCount: rows.reduce((n, r) => n + r.procCount, 0),
    },
    scoped: true,
  }
}
