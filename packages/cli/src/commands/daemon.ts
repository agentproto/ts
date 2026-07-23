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
import { loadConfig, CONFIG_FILE_PATH } from "@agentproto/runtime/config"

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

async function runInstall(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { "dry-run": { type: "boolean" } },
  })
  const cfg = await loadConfig()
  const daemon = cfg.daemon ?? {}
  const p = paths()
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

  const plist = renderPlist({
    label: LABEL,
    // `node /path/to/cli.mjs` first, then the serve verb + flags.
    fullArgv: [...p.argv, ...argv],
    logPath: p.log,
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
): Promise<number> {
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const out = await run(["kickstart", target])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon start: ${out.stderr || "launchctl exited " + out.code}\n` +
        `  Run \`agentproto daemon install\` first.\n`,
    )
    return out.code
  }
  process.stdout.write("agentproto daemon: started\n")
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
): Promise<number> {
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const out = await run(["kickstart", "-k", target])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon restart: ${out.stderr || "launchctl exited " + out.code}\n` +
        `  Run \`agentproto daemon install\` first.\n`,
    )
    return out.code
  }
  process.stdout.write("agentproto daemon: restarted\n")
  return 0
}

async function runStop(): Promise<number> {
  const target = `gui/${process.getuid?.() ?? 0}/${LABEL}`
  const out = await launchctl(["kill", "SIGTERM", target])
  if (out.code !== 0) {
    process.stderr.write(
      `agentproto daemon stop: ${out.stderr || "launchctl exited " + out.code}\n`,
    )
    return out.code
  }
  process.stdout.write("agentproto daemon: SIGTERM sent\n")
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
      }
      health = `ok · workspace=${body.workspace ?? "?"} · up ${humaniseUptime(body.uptimeMs ?? 0)}`
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
    <key>PATH</key><string>${xmlEscape(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
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
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map(l => prefix + l)
    .join("\n")
}
