/**
 * `agentproto daemon <install|uninstall|start|stop|status|logs>`
 *
 * Service-management shim. On macOS we wrap `launchctl` with a
 * generated `~/Library/LaunchAgents/sh.agentproto.plist`; on Linux
 * we'll wrap `systemctl --user` once that path is finished (the
 * verb prints "not yet" until then). Windows: same, NSSM/Task
 * Scheduler is on the followup list.
 *
 * The plist's `ProgramArguments` is built from `~/.agentproto/config.json`'s
 * `daemon.*` keys (workspace, port, bind, allowedOrigins). The user
 * configures once via `agentproto config set …`, then `daemon install`
 * captures that snapshot. Re-run `install` after any config change
 * to refresh the plist.
 *
 * The plist's `EnvironmentVariables.PATH` is different: `install` captures a
 * one-time snapshot too, but `start`/`restart` self-heal it on every
 * kickstart by probing a login shell for the current PATH and rewriting the
 * plist if it changed — see the "PATH self-heal" section below
 * (`computeFreshDaemonPath`, `refreshPlistPathIfNeeded`). No manual
 * `uninstall`/`install` cycle needed after installing a new CLI tool.
 *
 * Logs go to `~/.agentproto/daemon.log` (stdout + stderr merged).
 *
 * Sub-verbs:
 *   install     write the plist + launchctl bootstrap
 *   uninstall   launchctl bootout + delete plist
 *   start       launchctl kickstart WITHOUT -k — idempotent: launches the
 *               daemon if it's down, leaves a healthy one running. Never kills.
 *   restart     launchctl kickstart -k — kill the running daemon and relaunch.
 *               The clean replacement for `pnpm killport 18790`.
 *   stop        launchctl kill SIGTERM
 *   status      plist installed? launchctl loaded? /health probe?
 *               last 10 lines of daemon.log
 *   logs        tail daemon.log (10 lines by default, --lines <N>)
 */

import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { homedir, platform as osPlatform } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import {
  loadConfig,
  CONFIG_FILE_PATH,
  type AgentprotoConfig,
} from "@agentproto/runtime/config"

import { discoverDaemon, httpGetJson } from "./_daemon-helpers.js"

const LABEL = "sh.agentproto"
const USAGE = `agentproto daemon — run agentproto serve as a background service

Usage:
  agentproto daemon install [--dry-run]   register service + start it (macOS launchd today)
  agentproto daemon uninstall             stop + deregister service
  agentproto daemon start                 launchctl kickstart (idempotent; never kills a healthy daemon)
  agentproto daemon restart               launchctl kickstart -k (kill + relaunch; replaces \`pnpm killport 18790\`)
  agentproto daemon stop                  launchctl kill SIGTERM
  agentproto daemon status                installed? loaded? /health reachable?
  agentproto daemon logs [--lines <N>]    tail daemon.log

Configure defaults via \`agentproto config set\` before \`install\`:
  agentproto config set daemon.workspace /path/to/project
  agentproto config set daemon.port 18790
  agentproto config set daemon.allowedOrigins https://guilde.work
`

export async function runDaemon(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    process.stdout.write(USAGE)
    return args.length === 0 ? 2 : 0
  }
  if (osPlatform() !== "darwin") {
    process.stderr.write(
      `agentproto daemon: ${osPlatform()} not yet supported. macOS (launchd) ships today; ` +
        "Linux (systemd --user) and Windows are on the follow-up list. " +
        "In the meantime: `agentproto serve &; disown` will detach the daemon from your shell.\n",
    )
    return 2
  }
  const sub = args[0]
  const rest = args.slice(1)
  switch (sub) {
    case "install":
      return runInstall(rest)
    case "uninstall":
      return runUninstall()
    case "start":
      return runStart()
    case "restart":
      return runRestart()
    case "stop":
      return runStop()
    case "status":
      return runStatus()
    case "logs":
      return runLogs(rest)
    default:
      process.stderr.write(
        `agentproto daemon: unknown sub-verb "${sub}".\n\n${USAGE}`,
      )
      return 2
  }
}

interface Paths {
  plist: string
  log: string
  /** `node /path/to/cli.mjs` — what launchd should exec. The CLI
   *  ships as an ESM `.mjs` file with no shebang; the pnpm/npm bin
   *  shim execs `node cli.mjs $@`. launchd doesn't run shell shims,
   *  so we reconstruct the `node + script` pair here. */
  argv: [string, string]
}

function paths(): Paths {
  return {
    plist: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    log: join(homedir(), ".agentproto", "daemon.log"),
    // process.execPath is the Node binary running THIS process (the
    // one running `agentproto daemon install`). Captures fnm / nvm /
    // homebrew / system Node correctly. argv[1] is the cli.mjs entry
    // resolved by the shim.
    argv: [
      process.execPath,
      process.argv[1] ?? "/dev/null",
    ],
  }
}

/** Builds the `serve` argv from `daemon.*` config keys — shared between the
 *  one-time `install` snapshot and the PATH self-heal on `start`/`restart`,
 *  which re-derives the same argv rather than parsing it back out of the
 *  existing plist's XML. */
function buildServeArgv(cfg: AgentprotoConfig): string[] {
  const daemon = cfg.daemon ?? {}
  const argv = ["serve"]
  if (daemon.workspace) argv.push("--workspace", daemon.workspace)
  if (typeof daemon.port === "number") argv.push("--port", String(daemon.port))
  if (daemon.bind) argv.push("--bind", daemon.bind)
  for (const origin of daemon.allowedOrigins ?? []) {
    argv.push("--allow-origin", origin)
  }
  if (daemon.label) argv.push("--label", daemon.label)
  const tunnelHost = cfg.tunnel?.host
  const autoconnect = cfg.tunnel?.autoconnect === true
  if (tunnelHost && autoconnect) argv.push("--connect", tunnelHost)
  return argv
}

async function runInstall(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { "dry-run": { type: "boolean" } },
  })
  const cfg = await loadConfig()
  const p = paths()
  const argv = buildServeArgv(cfg)

  const plist = renderPlist({
    label: LABEL,
    // `node /path/to/cli.mjs` first, then the serve verb + flags.
    fullArgv: [...p.argv, ...argv],
    logPath: p.log,
    // One-time capture of the installing invocation's PATH — this is the
    // documented "re-run install after any config change" behavior.
    // `start`/`restart` self-heal a fresher PATH on every kickstart instead
    // of relying on this ever being re-run; see `refreshPlistPathIfNeeded`.
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  })

  if (values["dry-run"]) {
    process.stdout.write(
      `# Would write ${p.plist}:\n\n${plist}\n# launchctl bootstrap gui/$(id -u) ${p.plist}\n`,
    )
    return 0
  }

  await fs.mkdir(dirname(p.plist), { recursive: true })
  await fs.mkdir(dirname(p.log), { recursive: true })
  await fs.writeFile(p.plist, plist, "utf8")
  process.stdout.write(`agentproto daemon: wrote ${p.plist}\n`)

  // If a previous version is loaded, bootout first so bootstrap
  // doesn't fail with "service already bootstrapped".
  await launchctl(["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`]).catch(
    () => undefined,
  )

  const boot = await launchctl([
    "bootstrap",
    `gui/${process.getuid?.() ?? 0}`,
    p.plist,
  ])
  if (boot.code !== 0) {
    process.stderr.write(
      `agentproto daemon install: launchctl bootstrap failed (exit ${boot.code})\n${boot.stderr}\n`,
    )
    return 1
  }
  process.stdout.write(
    `agentproto daemon: loaded via launchd. Tail logs: agentproto daemon logs\n`,
  )
  return 0
}

async function runUninstall(): Promise<number> {
  const p = paths()
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const out = await launchctl(["bootout", target])
  if (out.code !== 0 && !/No such process/i.test(out.stderr)) {
    process.stderr.write(
      `agentproto daemon uninstall: launchctl bootout failed (exit ${out.code})\n${out.stderr}\n`,
    )
  }
  try {
    await fs.unlink(p.plist)
    process.stdout.write(`agentproto daemon: removed ${p.plist}\n`)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      process.stdout.write(`agentproto daemon: ${p.plist} already absent\n`)
    } else {
      process.stderr.write(
        `agentproto daemon uninstall: failed to remove plist: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
      return 1
    }
  }
  return 0
}

/** What `/health` reports about the RUNNING daemon (plus the url we probed). */
export interface DaemonHealthInfo {
  url: string
  version?: string | null
  /** Build identity of the running binary — see the runtime's meta.build. */
  build?: { sha?: string; builtAt?: string; source?: string } | null
  pid?: number
  node?: string
  entry?: string | null
  workspace?: string
  uptimeMs?: number
}

/** " (workspace abc1234, built …)" — or "" when the daemon predates the
 *  `build` field. Shared by `start` and `status` so both render the same. */
export function renderBuild(build: DaemonHealthInfo["build"]): string {
  if (!build) return ""
  const parts = [
    build.source,
    build.sha || undefined,
    build.builtAt ? `built ${build.builtAt}` : undefined,
  ].filter((p): p is string => typeof p === "string" && p.length > 0)
  return parts.length > 0 ? ` (${parts.join(", ")})` : ""
}

/** Single `/health` attempt against the configured bind/port — null when
 *  unreachable. Injectable so the lifecycle tests never hit the network. */
export type HealthFetchFn = () => Promise<DaemonHealthInfo | null>

async function fetchHealth(): Promise<DaemonHealthInfo | null> {
  const cfg = await loadConfig()
  const port = cfg.daemon?.port ?? 18790
  const bind = cfg.daemon?.bind ?? "127.0.0.1"
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind
  const url = `http://${host}:${port}`
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) })
    if (!res.ok) return null
    const body = (await res.json()) as Omit<DaemonHealthInfo, "url">
    return { ...body, url }
  } catch {
    return null
  }
}

async function waitForHealth(
  health: HealthFetchFn,
  attempts: number,
  delayMs: number,
): Promise<DaemonHealthInfo | null> {
  for (let i = 0; i < attempts; i++) {
    const info = await health()
    if (info) return info
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
  }
  return null
}

function tilde(p: string | null | undefined): string {
  if (!p) return "?"
  const home = homedir()
  return p.startsWith(home) ? "~" + p.slice(home.length) : p
}

/** The post-start/restart info block: what booted, where its bin lives,
 *  where it serves, where it logs. */
function printLifecycleInfo(verb: string, info: DaemonHealthInfo | null): void {
  const p = paths()
  if (!info) {
    process.stdout.write(
      `agentproto daemon: ${verb} (not answering /health yet — check \`agentproto daemon logs\`)\n`,
    )
    return
  }
  process.stdout.write(
    `agentproto daemon: ${verb}\n` +
      `  version:   ${info.version ?? "?"}${renderBuild(info.build)} · pid ${info.pid ?? "?"} · up ${humaniseUptime(info.uptimeMs ?? 0)}\n` +
      `  bin:       ${tilde(info.node)} ${tilde(info.entry)}\n` +
      `  url:       ${info.url}\n` +
      `  workspace: ${tilde(info.workspace)}\n` +
      `  logs:      ${tilde(p.log)}\n`,
  )
}

// ---------------------------------------------------------------------------
// PATH self-heal
//
// `install` bakes the plist's EnvironmentVariables.PATH from whatever PATH
// the `agentproto daemon install` invocation happened to have — captured
// ONCE. A CLI installed afterwards (e.g. `uv tool install mistral-vibe`,
// landing in ~/.local/bin via a line sourced only for interactive shells)
// is invisible to the daemon forever, even across `daemon restart`, because
// `kickstart` alone never re-renders the plist. The fix: recompute PATH and
// rewrite the plist BEFORE every `start`/`restart` kickstart, so the daemon
// self-heals without requiring a manual `uninstall` + `install`.
// ---------------------------------------------------------------------------

/** Extra bin dirs that commonly aren't picked up even by a login-shell probe
 *  (e.g. a shell profile that only conditionally sources them). Appended
 *  after the probed PATH, deduped, existing entries win. */
export const EXTRA_PATH_DIRS: readonly string[] = [
  "~/.local/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.cargo/bin",
]

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p
}

/**
 * Dedup a `:`-joined PATH (order-preserving, first occurrence wins), then
 * append any of `extraDirs` not already present. Pure — no I/O — this is the
 * unit-testable core of the self-heal.
 */
export function computeDaemonPath(
  basePath: string,
  extraDirs: readonly string[] = EXTRA_PATH_DIRS,
): string {
  const seen = new Set<string>()
  const parts: string[] = []
  const push = (dir: string) => {
    if (dir && !seen.has(dir)) {
      seen.add(dir)
      parts.push(dir)
    }
  }
  for (const raw of basePath.split(":")) push(raw)
  for (const dir of extraDirs) push(expandTilde(dir))
  return parts.join(":")
}

/** Only rewrite the plist when the computed PATH actually differs from
 *  what's currently there — avoids `bootout`/`bootstrap` churn on every
 *  restart when nothing changed. `currentPath` is `null` when the plist
 *  doesn't exist yet or has no PATH entry (never mid-way "needs a refresh"
 *  in that case — there's nothing installed to refresh). */
export function pathNeedsRefresh(currentPath: string | null, freshPath: string): boolean {
  return currentPath !== null && currentPath !== freshPath
}

/** Injectable probe for the login-shell PATH — mirrors {@link LaunchctlFn}
 *  so tests can stub it without spawning a real shell. `null` means the
 *  probe failed/timed out/returned nothing usable. */
export type ShellProbeFn = () => Promise<string | null>

/**
 * Spawn a login shell (`$SHELL`, falling back to `/bin/zsh`) and capture
 * `$PATH` the way an interactive terminal would see it — profile-sourced
 * dirs like `~/.local/bin` from `uv tool install` included. `process.env.PATH`
 * of the CLI invocation itself is deliberately NOT used here: a script or
 * non-interactive caller (cron, another tool, launchd itself) can have a
 * minimal PATH, which is exactly today's staleness bug in miniature.
 * Returns `null` on spawn error, non-zero exit, empty output, or timeout so
 * the caller can fall back to `process.env.PATH` instead of crashing.
 */
export function probeLoginShellPath(timeoutMs = 3000): Promise<string | null> {
  const shell = process.env.SHELL && process.env.SHELL.trim() !== "" ? process.env.SHELL : "/bin/zsh"
  return new Promise(resolve => {
    let settled = false
    const finish = (result: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ["-lc", 'echo -n "$PATH"'], { stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    let stdout = ""
    child.stdout?.setEncoding("utf8").on("data", c => (stdout += c))
    child.on("error", () => finish(null))
    child.on("exit", code => {
      const trimmed = stdout.trim()
      finish(code === 0 && trimmed ? trimmed : null)
    })
  })
}

/** Probe the login shell for PATH (falling back to `process.env.PATH` on
 *  failure) and run it through {@link computeDaemonPath}. */
export async function computeFreshDaemonPath(
  probe: ShellProbeFn = probeLoginShellPath,
): Promise<string> {
  const base = (await probe()) ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"
  return computeDaemonPath(base)
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
}

/** Pull the current `EnvironmentVariables.PATH` value back out of a
 *  previously-rendered plist's XML — `null` when the plist has no such key
 *  (shouldn't happen for a plist we wrote, but be defensive). */
function extractPlistPathValue(xml: string): string | null {
  const m = xml.match(/<key>PATH<\/key><string>([^<]*)<\/string>/)
  return m && m[1] !== undefined ? xmlUnescape(m[1]) : null
}

interface RefreshPlistPathOpts {
  plistPath: string
  /** Raw XML of the currently-installed plist, or `null` if there isn't
   *  one (nothing to refresh — `kickstart` will fail with its own
   *  "run install first" hint). */
  currentXml: string | null
  fullArgv: string[]
  logPath: string
  freshPath: string
  run: LaunchctlFn
  writeFile?: (path: string, data: string) => Promise<void>
}

/**
 * Core gating + action for the PATH self-heal, factored out so it's
 * testable without touching real files or spawning real `launchctl`/shells:
 * given the plist's current XML and a freshly-computed PATH, rewrite (via
 * {@link renderPlist}) and re-bootstrap ONLY if the PATH actually changed.
 * Returns whether it rewrote.
 */
export async function refreshPlistPathIfNeeded(opts: RefreshPlistPathOpts): Promise<boolean> {
  if (opts.currentXml === null) return false
  const currentPath = extractPlistPathValue(opts.currentXml)
  if (!pathNeedsRefresh(currentPath, opts.freshPath)) return false

  const plist = renderPlist({
    label: LABEL,
    fullArgv: opts.fullArgv,
    logPath: opts.logPath,
    path: opts.freshPath,
  })
  const writeFile = opts.writeFile ?? (async (path, data) => fs.writeFile(path, data, "utf8"))
  await writeFile(opts.plistPath, plist)

  // Re-bootstrap so the running launchd job picks up the rewritten plist —
  // `kickstart` alone reloads the PROGRAM, not the job DEFINITION. Mirrors
  // `runInstall`'s bootout-then-bootstrap sequence.
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  await opts.run(["bootout", target])
  await opts.run(["bootstrap", `gui/${process.getuid?.() ?? 0}`, opts.plistPath])
  return true
}

/** Real wiring for {@link refreshPlistPathIfNeeded}: reads the actual plist
 *  off disk, probes a real login shell, reloads config for the argv. Never
 *  throws — this is best-effort and must never block a `start`/`restart`. */
async function selfHealDaemonPath(run: LaunchctlFn): Promise<boolean> {
  try {
    const p = paths()
    let currentXml: string | null
    try {
      currentXml = await fs.readFile(p.plist, "utf8")
    } catch {
      currentXml = null
    }
    if (currentXml === null) return false

    const [freshPath, cfg] = await Promise.all([computeFreshDaemonPath(), loadConfig()])
    return await refreshPlistPathIfNeeded({
      plistPath: p.plist,
      currentXml,
      fullArgv: [...p.argv, ...buildServeArgv(cfg)],
      logPath: p.log,
      freshPath,
      run,
    })
  } catch {
    return false
  }
}

/** Injectable sync step ahead of `kickstart` — see the PATH self-heal
 *  section above. */
export type PathSyncFn = (run: LaunchctlFn) => Promise<boolean>

/**
 * `start` — idempotent launch. `kickstart` WITHOUT `-k` asks launchd to start
 * the service if it isn't running and is a no-op if it already is; it never
 * kills a healthy daemon. Pairs with the crash-only `KeepAlive` in
 * {@link renderPlist} and the idempotent `serve` preflight: a re-`start` won't
 * fight an incumbent, so a hand-relaunch or a `RunAtLoad` respawn settles
 * cleanly instead of crash-looping on the port. Use `restart` to force-cycle.
 */
export async function runStart(
  run: LaunchctlFn = launchctl,
  health: HealthFetchFn = fetchHealth,
  probeAttempts = 20,
  syncPath: PathSyncFn = selfHealDaemonPath,
): Promise<number> {
  await syncPath(run).catch(() => false)
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const out = await run(["kickstart", target])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon start: ${out.stderr || "launchctl exited " + out.code}\n` +
        `  Run \`agentproto daemon install\` first.\n`,
    )
    return out.code
  }
  printLifecycleInfo("started", await waitForHealth(health, probeAttempts, 300))
  return 0
}

/**
 * `restart` — force-cycle. `kickstart -k` kills the running daemon (if any)
 * and relaunches it. This is the clean replacement for `pnpm killport 18790`:
 * a supervised restart that goes through launchd rather than SIGKILLing the
 * port out from under it.
 */
export async function runRestart(
  run: LaunchctlFn = launchctl,
  health: HealthFetchFn = fetchHealth,
  probeAttempts = 20,
  syncPath: PathSyncFn = selfHealDaemonPath,
): Promise<number> {
  await syncPath(run).catch(() => false)
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const out = await run(["kickstart", "-k", target])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon restart: ${out.stderr || "launchctl exited " + out.code}\n` +
        `  Run \`agentproto daemon install\` first.\n`,
    )
    return out.code
  }
  printLifecycleInfo("restarted", await waitForHealth(health, probeAttempts, 300))
  return 0
}

/** The lifetime summary printed on `stop` — gathered BEFORE the SIGTERM
 *  (the daemon can't answer afterwards). All fields best-effort. */
export interface DaemonStopStats {
  uptimeMs?: number
  version?: string | null
  sessions?: number
  tokensIn?: number
  tokensOut?: number
  unpricedTokens?: number
  spentUsd?: number
}

export type StopStatsFn = () => Promise<DaemonStopStats | null>

/** `/health` for uptime/version, then `/usage/rollup` over exactly the
 *  daemon's own uptime window — sessions with activity + token totals +
 *  the local spend estimate for THIS daemon run, not all history. */
async function gatherStopStats(): Promise<DaemonStopStats | null> {
  const health = await fetchHealth()
  if (!health) return null
  const stats: DaemonStopStats = {
    ...(health.uptimeMs !== undefined ? { uptimeMs: health.uptimeMs } : {}),
    version: health.version ?? null,
  }
  try {
    const report = await discoverDaemon()
    if (report.found) {
      const windowS = Math.max(1, Math.ceil((health.uptimeMs ?? 0) / 1000))
      const rollup = await httpGetJson<{
        total: { spentUsd: number; tokensIn: number; tokensOut: number; unpricedTokens: number }
        sessionsConsidered: number
      }>(`${report.found.url}/usage/rollup?window=${windowS}s`)
      stats.sessions = rollup.sessionsConsidered
      stats.tokensIn = rollup.total.tokensIn
      stats.tokensOut = rollup.total.tokensOut
      stats.unpricedTokens = rollup.total.unpricedTokens
      stats.spentUsd = rollup.total.spentUsd
    }
  } catch {
    // Usage rollup is decoration on the goodbye line — never block a stop.
  }
  return stats
}

/** `1.2M` / `340k` / `512` — compact token counts for the stop summary. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export async function runStop(
  run: LaunchctlFn = launchctl,
  gather: StopStatsFn = gatherStopStats,
): Promise<number> {
  // Gather BEFORE killing — a stopped daemon answers nothing.
  const stats = await gather()
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const out = await run(["kill", "SIGTERM", target])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon stop: ${out.stderr || "launchctl exited " + out.code}\n`,
    )
    return out.code
  }
  let msg = "agentproto daemon: SIGTERM sent\n"
  if (stats) {
    msg += `  ran:       ${humaniseUptime(stats.uptimeMs ?? 0)}${stats.version ? ` · v${stats.version}` : ""}\n`
    if (stats.sessions !== undefined) {
      const tokens = `${fmtTokens(stats.tokensIn ?? 0)} in / ${fmtTokens(stats.tokensOut ?? 0)} out tok`
      const unpriced = stats.unpricedTokens ? ` · ${fmtTokens(stats.unpricedTokens)} unpriced` : ""
      const spend = stats.spentUsd !== undefined ? ` · ~$${stats.spentUsd.toFixed(2)} est` : ""
      msg += `  activity:  ${stats.sessions} session${stats.sessions === 1 ? "" : "s"} · ${tokens}${spend}${unpriced}\n`
    }
  }
  process.stdout.write(msg)
  return 0
}

async function runStatus(): Promise<number> {
  const p = paths()
  const cfg = await loadConfig()
  const port = cfg.daemon?.port ?? 18790
  const bind = cfg.daemon?.bind ?? "127.0.0.1"

  // 1. plist installed?
  let plistOk = false
  try {
    await fs.access(p.plist)
    plistOk = true
  } catch {
    /* not installed */
  }

  // 2. launchctl loaded?
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const printOut = await launchctl(["print", target])
  const loaded = printOut.code === 0
  // Extract pid (or state) from the print output — best-effort regex
  // so a launchctl output format change doesn't crash us.
  const pidMatch = printOut.stdout.match(/^\s*pid\s*=\s*(\d+)/m)
  const stateMatch = printOut.stdout.match(/^\s*state\s*=\s*(\w+)/m)

  // 3. /health probe.
  let health: string | null = null
  try {
    const res = await fetch(`http://${bind}:${port}/health`, {
      signal: AbortSignal.timeout(800),
    })
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        workspace?: string
        uptimeMs?: number
        version?: string | null
        build?: DaemonHealthInfo["build"]
      }
      health =
        `ok${body.version ? ` · v${body.version}` : ""}${renderBuild(body.build)}` +
        ` · workspace=${body.workspace ?? "?"} · up ${humaniseUptime(body.uptimeMs ?? 0)}`
    } else {
      health = `HTTP ${res.status}`
    }
  } catch {
    health = "unreachable"
  }

  process.stdout.write(
    `agentproto daemon status\n` +
      `  plist:     ${plistOk ? "installed" : "not installed"} (${p.plist})\n` +
      `  launchd:   ${loaded ? "loaded" : "not loaded"}` +
      (pidMatch ? ` · pid=${pidMatch[1]}` : "") +
      (stateMatch ? ` · state=${stateMatch[1]}` : "") +
      `\n` +
      `  /health:   ${health}  (http://${bind}:${port})\n` +
      `  config:    ${CONFIG_FILE_PATH()}\n` +
      `  logs:      ${p.log}\n`,
  )

  // Tail the last 5 lines so users see what the daemon is up to.
  try {
    const buf = await fs.readFile(p.log, "utf8")
    const tail = buf.split("\n").slice(-6).join("\n").trim()
    if (tail) {
      process.stdout.write(`\n  recent logs:\n${indent(tail, "    ")}\n`)
    }
  } catch {
    /* no log yet */
  }
  return plistOk && loaded ? 0 : 1
}

async function runLogs(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { lines: { type: "string", short: "n" } },
  })
  const n = values.lines ? Number.parseInt(values.lines, 10) : 10
  const p = paths()
  try {
    const buf = await fs.readFile(p.log, "utf8")
    const lines = buf.split("\n")
    process.stdout.write(lines.slice(-n - 1).join("\n"))
    if (!buf.endsWith("\n")) process.stdout.write("\n")
    return 0
  } catch (err) {
    process.stderr.write(
      `agentproto daemon logs: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
}

interface PlistOpts {
  label: string
  /** Full argv launchd execs — `[node, cli.mjs, serve, …]`. */
  fullArgv: string[]
  logPath: string
  /** `EnvironmentVariables.PATH` to bake into the plist. Callers decide how
   *  to compute this — `runInstall` captures `process.env.PATH` once, the
   *  `start`/`restart` self-heal recomputes it fresh each time (see
   *  `computeFreshDaemonPath`). */
  path: string
}

export function renderPlist(opts: PlistOpts): string {
  const argEls = opts.fullArgv
    .map(a => `    <string>${xmlEscape(a)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argEls}
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Crash-only restart: relaunch when the daemon exits NON-zero (a crash),
       but leave a clean exit-0 alone. The idempotent \`serve\` exits 0 when a
       healthy daemon already owns the port; a bare \`KeepAlive: true\` would
       fight that by respawning the redundant launcher into an EADDRINUSE
       crash-loop. SuccessfulExit:false restarts on failure only. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(opts.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(opts.path)}</string>
    <key>HOME</key><string>${xmlEscape(process.env.HOME ?? homedir())}</string>
  </dict>
</dict>
</plist>
`
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

interface LaunchctlResult {
  code: number
  stdout: string
  stderr: string
}

/** Runner shape shared by `launchctl` and its test doubles. */
type LaunchctlFn = (args: string[]) => Promise<LaunchctlResult>

function launchctl(args: string[]): Promise<LaunchctlResult> {
  return new Promise(resolve => {
    const child = spawn("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8").on("data", c => (stdout += c))
    child.stderr?.setEncoding("utf8").on("data", c => (stderr += c))
    child.on("error", err =>
      resolve({ code: 127, stdout, stderr: err.message }),
    )
    child.on("exit", code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function humaniseUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ""}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? `${h % 24}h` : ""}`
}

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map(l => prefix + l)
    .join("\n")
}
