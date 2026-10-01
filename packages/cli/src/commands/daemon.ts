/**
 * `agentproto daemon <install|uninstall|start|stop|status|logs>`
 *
 * Service-management shim. On macOS we wrap `launchctl` with a
 * generated `~/Library/LaunchAgents/sh.agentproto.plist`; on Windows
 * we wrap the Task Scheduler — a per-user `schtasks /SC ONLOGON`
 * task (no admin needed) whose payload is a generated
 * `~/.agentproto/agentproto-daemon.cmd` launcher. On Linux we'll
 * wrap `systemctl --user` once that path is finished (the verb
 * prints "not yet" until then).
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
import { dirname, join, posix as pathPosix, win32 as pathWin32 } from "node:path"
import { parseArgs } from "node:util"
import {
  compareVersions,
  runReleaseCheck,
  type ReleaseBuildSource,
  type ReleaseCheckView,
} from "@agentproto/runtime/release-check"
import {
  loadConfig,
  CONFIG_FILE_PATH,
  type AgentprotoConfig,
} from "@agentproto/runtime/config"

import { discoverDaemon, httpGetJson } from "./_daemon-helpers.js"
import { renderServiceTarget } from "../registry/install-source.js"

const LABEL = "sh.agentproto"
/** launchd job label — exported for read-only probes (`agentproto doctor`). */
export const LAUNCHD_LABEL = LABEL
const USAGE = `agentproto daemon — run agentproto serve as a background service

Usage:
  agentproto daemon install [--dry-run]   register service + start it (macOS launchd, Windows Task Scheduler)
  agentproto daemon uninstall             stop + deregister service
  agentproto daemon start                 start the service (idempotent; never kills a healthy daemon)
  agentproto daemon restart               kill + relaunch (replaces \`pnpm killport 18790\`)
  agentproto daemon stop                  stop the service
  agentproto daemon status                installed? running? /health reachable?
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
  if (osPlatform() === "win32") {
    const sub = args[0]
    switch (sub) {
      case "install":
        return runWinInstall(args.slice(1))
      case "uninstall":
        return runWinUninstall()
      case "start":
        return runWinStart()
      case "restart":
        return runWinRestart()
      case "stop":
        return runWinStop()
      case "status":
        return runWinStatus()
      case "logs":
        return runLogs(args.slice(1))
      default:
        process.stderr.write(
          `agentproto daemon: unknown sub-verb "${sub}".\n\n${USAGE}`,
        )
        return 2
    }
  }
  if (osPlatform() !== "darwin") {
    process.stderr.write(
      `agentproto daemon: ${osPlatform()} not yet supported. macOS (launchd) and Windows (Task Scheduler) ship today; ` +
        "Linux (systemd --user) is on the follow-up list. " +
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

/** Where `daemon install` writes the launchd plist. */
export function launchdPlistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
}

/**
 * The global `node_modules` directory of the Node install a binary belongs to:
 * `<prefix>/lib/node_modules` on POSIX, `<prefix>/node_modules` on Windows.
 *
 * The doctor's node/adapter-mismatch check (F4) uses this to ask whether the
 * Node the daemon runs under can see the globally-installed `@agentproto/
 * adapter-*` packages. Global installs land under whichever Node ran
 * `npm i -g`, so after an nvm/fnm switch the daemon's Node and this CLI's Node
 * can differ — and the daemon's Node then resolves no adapters.
 */
export function globalNodeModulesDir(nodeExecPath: string, platform: NodeJS.Platform): string {
  // Select the path dialect from the ARGUMENT, not the host: doctor may be
  // asked about a Windows daemon from a POSIX machine (and the test suite
  // runs the win32 case on macOS).
  const path = platform === "win32" ? pathWin32 : pathPosix
  const binDir = path.dirname(nodeExecPath)
  return platform === "win32" ? path.join(binDir, "node_modules") : path.join(path.dirname(binDir), "lib", "node_modules")
}

function paths(home: string = homedir()): Paths {
  return {
    plist: launchdPlistPath(home),
    log: join(home, ".agentproto", "daemon.log"),
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
      `# Would install a service running:\n${renderServiceTarget(p.argv[0], process.argv[1] ?? null)}\n` +
        `# Would write ${p.plist}:\n\n${plist}\n# launchctl bootstrap gui/$(id -u) ${p.plist}\n`,
    )
    return 0
  }

  await fs.mkdir(dirname(p.plist), { recursive: true })
  await fs.mkdir(dirname(p.log), { recursive: true })
  await fs.writeFile(p.plist, plist, "utf8")
  process.stdout.write(`agentproto daemon: wrote ${p.plist}\n`)
  process.stdout.write(
    `agentproto daemon: service will run:\n${renderServiceTarget(p.argv[0], process.argv[1] ?? null)}`,
  )

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
  /** The PATH the daemon captured at start (recap B4) — `null` when the
   *  daemon predates the field or runs with no PATH at all. */
  path?: string | null
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

/**
 * The `release:` line for `daemon status` — same release-check logic the VS
 * Code indicator uses (WP-A/WP-C fold). Returns one of:
 *  - `up to date`       — this install is current.
 *  - `v<latest> available` — a newer `@agentproto/cli` is out.
 *  - `unknown`          — couldn't reach npm / no cache (offline-safe).
 */
export async function renderReleaseStatus(
  localVersion: string | null,
  buildSource: ReleaseBuildSource,
  check?: (opts: { localVersion: string | null; buildSource: ReleaseBuildSource }) => Promise<ReleaseCheckView>,
): Promise<string> {
  if (!localVersion) return "unknown"
  const view = check
    ? await check({ localVersion, buildSource })
    : await runReleaseCheck({ localVersion, buildSource, ttlMs: 60 * 60 * 1000 })
  switch (view.state) {
    case "behind":
      return view.latest ? `v${view.latest} available` : "unknown"
    case "workspace":
      // A workspace install: a newer release still means "rebuild required",
      // decided by the same version comparison as the shared logic.
      return view.latest && compareVersions(view.latest, localVersion) > 0
        ? `v${view.latest} available`
        : "up to date"
    case "current":
      return "up to date"
    default:
      return "unknown"
  }
}

/** Single `/health` attempt against the configured bind/port — null when
 *  unreachable. Injectable so the lifecycle tests never hit the network. */
export type HealthFetchFn = () => Promise<DaemonHealthInfo | null>

/** Injectable config + fetch for {@link fetchHealth} — the read-only
 *  `doctor` probe passes its own; defaults are the real ones. */
export interface FetchHealthDeps {
  config?: AgentprotoConfig
  fetchImpl?: typeof fetch
}

export async function fetchHealth(deps: FetchHealthDeps = {}): Promise<DaemonHealthInfo | null> {
  const cfg = deps.config ?? (await loadConfig())
  const doFetch = deps.fetchImpl ?? fetch
  const port = cfg.daemon?.port ?? 18790
  const bind = cfg.daemon?.bind ?? "127.0.0.1"
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind
  const url = `http://${host}:${port}`
  try {
    const res = await doFetch(`${url}/health`, { signal: AbortSignal.timeout(800) })
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
export function extractPlistPathValue(xml: string): string | null {
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
  let release: string | null = null
  let buildSource: ReleaseBuildSource = null
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
      // Fold the release check (same logic the VS Code indicator uses): state
      // the install channel + whether a newer release exists.
      buildSource = body.build?.source === "workspace" ? "workspace" : "tarball"
      release = await renderReleaseStatus(body.version ?? null, buildSource)
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
      `  release:   ${release ?? "unknown"}\n` +
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

// ---------------------------------------------------------------------------
// Windows (schtasks)
//
// No plist on Windows — the equivalent generated file is
// `~/.agentproto/agentproto-daemon.cmd`, a one-line cmd launcher whose args
// come out of the same `buildServeArgv(cfg)` snapshot launchd's
// `ProgramArguments` uses. `schtasks /TR` is a single stored command string
// whose quoting rules (re-parsed by Task Scheduler AND by cmd routinely) are
// hostile to multi-argv payloads and to output redirection, so the task's
// /TR is just the quoted launcher path; the .cmd file is where redirection
// (`>> daemon.log 2>&1`) and argv quoting live. Per-user task (HKCU) — no
// admin required. Same three-part `status` shape as the launchd branch.
// ---------------------------------------------------------------------------

/** The Task Scheduler task name. Exported for read-only probes (doctor,
 *  the onboarding daemon step's `schtasks /Query`). */
export const SCHTASKS_TASK_NAME = "agentproto-daemon"

/** Where `daemon install` writes the Windows launcher. */
export function schtasksTaskScriptPath(home: string = homedir()): string {
  return join(home, ".agentproto", `${SCHTASKS_TASK_NAME}.cmd`)
}

/** Injectable sync step ahead of `kickstart` — see the PATH self-heal
 *  section above. */
export type SchtasksFn = (args: string[]) => Promise<LaunchctlResult>

/** The /TR payload for a task whose payload is a single launcher path —
 *  double-quoted (Task Scheduler stores it verbatim; the outer quoting is
 *  what keeps paths with spaces intact). Pure — unit-tested without real
 *  schtasks. */
export function renderSchtasksTr(commandPath: string): string {
  return `"${commandPath.replace(/"/g, '\\"')}"`
}

/** The launcher .cmd's body: quoted argv + merged stdout/stderr redirection
 *  into `~/.agentproto/daemon.log` (the plist equivalents are
 *  StandardOutPath/StandardErrorPath). Pure — unit-tested without real cmd.
 *
 *  Win field test (BOOTSTRAP P3, 2026-09-30): Task Scheduler ran the task
 *  from `C:\Windows\System32` (no working directory in `schtasks /TR`), so
 *  the daemon tried to create `.agentproto/runtime.json` under System32 and
 *  died EPERM. The first line therefore `cd /d`s to a writable home before
 *  anything execs: the configured `daemon.workspace` when one is set,
 *  `%USERPROFILE%` (expanded by cmd at run time — never a hardcoded path)
 *  otherwise. */
export function renderWinDaemonScript(
  argv: readonly string[],
  logPath: string,
  cwd?: string,
): string {
  const q = (a: string): string =>
    a.includes(" ") || a.includes('"') ? `"${a.replace(/"/g, '""')}"` : a
  const cdLine = cwd
    ? `cd /d "${cwd.replace(/"/g, '""')}"`
    : `cd /d "%USERPROFILE%"`
  return `@echo off\n${cdLine}\n${argv.map(q).join(" ")} >> "${logPath}" 2>&1\n`
}

function schtasks(args: string[]): Promise<LaunchctlResult> {
  return new Promise(resolve => {
    const child = spawn("schtasks", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8").on("data", c => (stdout += c))
    child.stderr?.setEncoding("utf8").on("data", c => (stderr += c))
    child.on("error", err => resolve({ code: 127, stdout, stderr: err.message }))
    child.on("exit", code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

export async function runWinInstall(
  args: readonly string[] = [],
  schtasksFn: SchtasksFn = schtasks,
  /** Home override — tests point this at a temp dir so no real launcher is
   *  ever written. */
  home: string = homedir(),
): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { "dry-run": { type: "boolean" } },
  })
  const cfg = await loadConfig()
  const p = paths(home)
  const scriptPath = schtasksTaskScriptPath(home)
  const script = renderWinDaemonScript(
    [...p.argv, ...buildServeArgv(cfg)],
    p.log,
    // Working directory for the launcher (see renderWinDaemonScript's doc —
    // System32 default breaks runtime.json). Explicit workspace wins;
    // otherwise %USERPROFILE% expanded at run time by cmd.
    cfg.daemon?.workspace,
  )
  const create = [
    "/Create", "/TN", SCHTASKS_TASK_NAME,
    // Per-user task under HKCU, runs at logon, overwrite any previous one.
    // No elevation required.
    "/SC", "ONLOGON", "/F",
    "/TR", renderSchtasksTr(scriptPath),
  ]

  if (values["dry-run"]) {
    process.stdout.write(
      `# Would install a service running:\n${renderServiceTarget(p.argv[0], process.argv[1] ?? null, "win32")}\n` +
        `# Would write ${scriptPath}:\n\n${script}\n# schtasks ${create.join(" ")}\n# schtasks /Run /TN ${SCHTASKS_TASK_NAME}\n`,
    )
    return 0
  }

  await fs.mkdir(dirname(p.log), { recursive: true })
  try {
    await fs.writeFile(scriptPath, script, "utf8")
  } catch (err) {
    process.stderr.write(
      `agentproto daemon install: failed to write launcher: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }
  process.stdout.write(`agentproto daemon: wrote ${scriptPath}\n`)
  process.stdout.write(
    `agentproto daemon: service will run:\n${renderServiceTarget(p.argv[0], process.argv[1] ?? null, "win32")}`,
  )

  const created = await schtasksFn(create)
  if (created.code !== 0) {
    process.stderr.write(
      `agentproto daemon install: schtasks create failed (exit ${created.code})\n${created.stderr}\n`,
    )
    return 1
  }
  const started = await schtasksFn(["/Run", "/TN", SCHTASKS_TASK_NAME])
  if (started.code !== 0) {
    process.stderr.write(
      `agentproto daemon install: task registered but schtasks start failed (exit ${started.code})\n${started.stderr}\n`,
    )
    return 1
  }
  process.stdout.write(
    `agentproto daemon: registered as a scheduled task at logon and started. Tail logs: agentproto daemon logs\n`,
  )
  return 0
}

export async function runWinUninstall(
  schtasksFn: SchtasksFn = schtasks,
): Promise<number> {
  // Best-effort stop first — a task mid-run can't be deleted cleanly.
  await schtasksFn(["/End", "/TN", SCHTASKS_TASK_NAME])
  const out = await schtasksFn(["/Delete", "/TN", SCHTASKS_TASK_NAME, "/F"])
  if (out.code !== 0) {
    if (/\b(ERROR:)?\s*the system cannot find|does not exist|no such task/i.test(out.stderr + out.stdout)) {
      process.stdout.write(
        `agentproto daemon: scheduled task ${SCHTASKS_TASK_NAME} already absent\n`,
      )
      return 0
    }
    process.stderr.write(
      `agentproto daemon uninstall: schtasks delete failed (exit ${out.code})\n${out.stderr}\n`,
    )
    return 1
  }
  process.stdout.write(`agentproto daemon: removed scheduled task ${SCHTASKS_TASK_NAME}\n`)
  return 0
}

export async function runWinStart(
  schtasksFn: SchtasksFn = schtasks,
  health: HealthFetchFn = fetchHealth,
  probeAttempts = 20,
): Promise<number> {
  const out = await schtasksFn(["/Run", "/TN", SCHTASKS_TASK_NAME])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon start: ${out.stderr || "schtasks exited " + out.code}\n` +
        `  Run \`agentproto daemon install\` first.\n`,
    )
    return out.code
  }
  printLifecycleInfo("started", await waitForHealth(health, probeAttempts, 300))
  return 0
}

export async function runWinRestart(
  schtasksFn: SchtasksFn = schtasks,
  health: HealthFetchFn = fetchHealth,
  probeAttempts = 20,
): Promise<number> {
  // /End fails harmlessly when the task isn't mid-run; /Run always relaunches.
  await schtasksFn(["/End", "/TN", SCHTASKS_TASK_NAME])
  const out = await schtasksFn(["/Run", "/TN", SCHTASKS_TASK_NAME])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon restart: ${out.stderr || "schtasks exited " + out.code}\n` +
        `  Run \`agentproto daemon install\` first.\n`,
    )
    return out.code
  }
  printLifecycleInfo("restarted", await waitForHealth(health, probeAttempts, 300))
  return 0
}

/** Synchronous app-stop surgery: `schtasks /End` reports the task ended,
 *  but (WIN11 field test 2026-09-30, BOOTSTRAP P3 item 3) the node child it
 *  spawned keeps LISTENING on the daemon port — a later `start` reuses the
 *  task and the new code never loads. After `/End`, therefore: probe
 *  `/health`, and if the port still answers, kill the recorded PID tree
 *  (`taskkill /PID <pid> /T /F` — win32 only) and re-probe. Everything is
 *  injectable so the tests never touch schtasks, taskkill, or the network. */
export interface WinStopDeps {
  health?: HealthFetchFn
  /** Kill a process tree by pid. Default: win32 `taskkill /T /F`. */
  killTree?: (pid: number) => Promise<number>
  /** The daemon PID recorded at start — `~/.agentproto/runtime.json`'s
   *  `pid` field by default. Fallback when `/health` doesn't expose one. */
  readDaemonPid?: () => Promise<number | null>
  /** Delay before post-kill re-probes (tests set 0 to stay hermetic). */
  releaseDelayMs?: number
}

/** One `taskkill /PID <pid> /T /F` — kills the node daemon AND its whole
 *  child tree. No port killer, SO_REUSEADDR, or task-snapshot parsing: the
 *  recorded pid is the authority, matching how `start`/`/health` report it. */
async function taskkillTree(pid: number): Promise<number> {
  return new Promise(resolve => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    })
    child.on("error", () => resolve(127))
    child.on("exit", code => resolve(code ?? 1))
  })
}

/** The `pid` field of the serve daemon's home runtime.json — `null` when
 *  missing/malformed/absent-pid. Keep the read bounded: one JSON parse,
 *  never a config load (this must work even when the daemon is wedged). */
async function readHomeRuntimePid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(
      join(homedir(), ".agentproto", "runtime.json"),
      "utf8",
    )
    const parsed = JSON.parse(raw) as { pid?: unknown }
    return typeof parsed.pid === "number" ? parsed.pid : null
  } catch {
    return null
  }
}

export async function runWinStop(
  schtasksFn: SchtasksFn = schtasks,
  deps: WinStopDeps = {},
): Promise<number> {
  const out = await schtasksFn(["/End", "/TN", SCHTASKS_TASK_NAME])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon stop: ${out.stderr || "schtasks exited " + out.code}\n`,
    )
    return out.code
  }
  process.stdout.write("agentproto daemon: task ended\n")

  const health = deps.health ?? fetchHealth
  const killTree = deps.killTree ?? taskkillTree
  const readPid = deps.readDaemonPid ?? readHomeRuntimePid
  const delay = deps.releaseDelayMs ?? 500
  const wait = (): Promise<void> =>
    delay > 0 ? new Promise(r => setTimeout(r, delay)) : Promise.resolve()

  // Verify the port is actually released — /End doesn't kill children.
  const leftover = await health()
  if (leftover) {
    const pid = leftover.pid ?? (await readPid())
    if (pid === null || pid === undefined) {
      process.stderr.write(
        `agentproto daemon stop: task ended but port still answering and no pid found\n` +
          `  (already-listening daemon on the port? — kill it manually)\n`,
      )
      return 0
    }
    const killCode = await killTree(pid)
    if (killCode !== 0) {
      process.stderr.write(
        `agentproto daemon stop: taskkill /PID ${pid} exited ${killCode}\n`,
      )
    }
    // Give the socket a beat to release, then check — up to 3 attempts.
    for (let attempt = 0; attempt < 3; attempt++) {
      await wait()
      if (!(await health())) {
        process.stdout.write(
          `agentproto daemon stop: killed pid ${pid} tree (port released)\n`,
        )
        return 0
      }
    }
    process.stderr.write(
      `agentproto daemon stop: killed pid ${pid} but port still answering\n` +
        `  check what owns the port and kill it manually\n`,
    )
  }
  return 0
}

export async function runWinStatus(schtasksFn: SchtasksFn = schtasks): Promise<number> {
  const p = paths()
  const cfg = await loadConfig()
  const port = cfg.daemon?.port ?? 18790
  const bind = cfg.daemon?.bind ?? "127.0.0.1"

  // 1. task registered? (`schtasks /Query /TN <name>` exits 0 iff found.)
  const query = await schtasksFn(["/Query", "/TN", SCHTASKS_TASK_NAME])
  const installed = query.code === 0
  // Task Scheduler prints a `Status:` line ("Ready", "Running", …); grab it
  // best-effort so an output-format change degrades to just the state word.
  const status = query.stdout.match(/^\s*Status:\s*(\S.*)$/m)?.[1]?.trim() ?? null

  // 2. /health probe — same shape as the launchd branch.
  let health: string | null = null
  let release: string | null = null
  let buildSource: ReleaseBuildSource = null
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
      buildSource = body.build?.source === "workspace" ? "workspace" : "tarball"
      release = await renderReleaseStatus(body.version ?? null, buildSource)
    } else {
      health = `HTTP ${res.status}`
    }
  } catch {
    health = "unreachable"
  }

  process.stdout.write(
    `agentproto daemon status\n` +
      `  task:      ${installed ? "registered" : "not registered"} (${SCHTASKS_TASK_NAME})\n` +
      `  schtasks:  ${installed ? (status ?? "registered") : "not registered"}` +
      `\n` +
      `  /health:   ${health}  (http://${bind}:${port})\n` +
      `  release:   ${release ?? "unknown"}\n` +
      `  config:    ${CONFIG_FILE_PATH()}\n` +
      `  logs:      ${p.log}\n`,
  )
  try {
    const buf = await fs.readFile(p.log, "utf8")
    const tail = buf.split("\n").slice(-6).join("\n").trim()
    if (tail) {
      process.stdout.write(`\n  recent logs:\n${indent(tail, "    ")}\n`)
    }
  } catch {
    /* no log yet */
  }
  return installed ? 0 : 1
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

export function humaniseUptime(ms: number): string {
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
