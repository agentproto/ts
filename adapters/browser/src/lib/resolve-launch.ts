import { spawn } from "node:child_process"
import { platform, homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { ensureBrowserProcess } from "@agentproto/browser-process"
import type { BrowserAdapterHandle, BrowserAdapterStartOptions, BrowserAdapterInstance } from "../types.js"

// ── Persisted config ledger ───────────────────────────────────────────────────

/**
 * Best-effort read of the persisted env values written by
 * `agentproto browser install`.  Returns `{}` on any read/parse failure.
 *
 * Path: `$AGENTPROTO_HOME/browser-adapters/<adapterId>.json`
 * (same convention as the CLI's `browserAdapterLedgerPath()`).
 */
async function loadPersistedEnv(adapterId: string): Promise<Record<string, string>> {
  const base = process.env["AGENTPROTO_HOME"] ?? join(homedir(), ".agentproto")
  const ledgerPath = join(base, "browser-adapters", `${adapterId}.json`)
  try {
    const raw = await readFile(ledgerPath, "utf8")
    const parsed = JSON.parse(raw) as { envValues?: Record<string, string> }
    return parsed.envValues ?? {}
  } catch {
    return {}
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ResolveLaunchConfig {
  handle: Pick<BrowserAdapterHandle, "id" | "defaultPort" | "healthPath" | "location" | "requires">
  opts: BrowserAdapterStartOptions
  /**
   * Short label used in log and error messages (e.g. "camofox", "bureau").
   * Typically matches `handle.id`.
   */
  label: string
  /**
   * Returns the local launch command, or `null` when no command is resolvable.
   * The returned object may carry `isLaunchctl: true` for launchers (like
   * launchctl) that exit immediately and are not the real managed process — in
   * that case the child is spawned for its side-effect only and `pid` stays
   * undefined in the resulting instance.
   * `cwd` is forwarded to the spawned child when present.
   */
  resolveLocalCmd(): {
    file: string
    args: string[]
    isLaunchctl?: boolean
    cwd?: string
  } | null
  /**
   * Extra env vars merged into the spawned process env (after `opts.env`).
   * Accepts either a plain record or a factory that receives the resolved port
   * (useful when the port must be baked into an env var like `PORT`).
   */
  extraEnv?: Record<string, string> | ((port: number) => Record<string, string>)
  /**
   * When `true`, stop() sends SIGTERM to the whole process group (`-pid`),
   * falling back to the direct pid on failure.  Use for adapters that spawn
   * through `sh -c` and need to terminate pnpm-forked child processes.
   * Default: false (direct-pid SIGTERM only).
   */
  killProcessGroup?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStop(pid: number | undefined, processGroup: boolean): () => Promise<void> {
  return async () => {
    if (!pid) return
    if (processGroup) {
      try {
        process.kill(-pid, "SIGTERM")
        return
      } catch {
        // group already gone — fall through to direct pid
      }
    }
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // process may have already exited — ignore
    }
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Shared launch/health-check logic for all three browser adapters.
 *
 * Two execution paths:
 * - **local**  — resolves a launch command and spawns a detached child process,
 *   then polls health (existing behaviour, unchanged).
 * - **cloud**  — health-checks `opts.baseUrl` directly; no process is spawned.
 */
export async function resolveLaunch(cfg: ResolveLaunchConfig): Promise<BrowserAdapterInstance> {
  const { handle, opts, label } = cfg
  const port = opts.port ?? handle.defaultPort
  const timeoutMs = opts.timeoutMs ?? 60_000
  const log = opts.log
  const location = opts.location ?? handle.location ?? "local"

  // Persisted config from `agentproto browser install` — merged as lowest-priority
  // env so that opts.env (explicit caller overrides) always wins.
  const persistedEnv = await loadPersistedEnv(handle.id)

  const resolvedExtraEnv =
    typeof cfg.extraEnv === "function" ? cfg.extraEnv(port) : cfg.extraEnv

  // ── Cloud path ──────────────────────────────────────────────────────────────
  if (location === "cloud") {
    const cloudBase = opts.baseUrl
    if (!cloudBase) {
      throw new Error(
        `[${label}] location="cloud" requires opts.baseUrl (the remote service base URL).`
      )
    }
    const healthUrl = cloudBase.replace(/\/$/, "") + handle.healthPath
    log?.(`[${label}] cloud mode — health-checking ${healthUrl}`)
    const result = await ensureBrowserProcess({
      kind: handle.id,
      healthUrl,
      launch: () => null,
      timeoutMs,
      intervalMs: 1000,
      log,
      ...(opts.initialWaitMs !== undefined ? { initialWaitMs: opts.initialWaitMs } : {}),
    })
    return {
      id: handle.id,
      port,
      baseUrl: result.baseUrl,
      pid: undefined,
      wasAlreadyRunning: result.wasAlreadyRunning,
      healthy: result.healthy,
      stop: async () => {},
    }
  }

  // ── Local path ──────────────────────────────────────────────────────────────
  const result = await ensureBrowserProcess({
    kind: handle.id,
    healthUrl: `http://127.0.0.1:${port}${handle.healthPath}`,
    launch() {
      const cmd = cfg.resolveLocalCmd()
      if (!cmd) {
        const nativePlatforms = handle.requires?.nativeLaunchOs
        const platformHint =
          nativePlatforms && !nativePlatforms.includes(platform())
            ? ` (native launcher only available on ${nativePlatforms.join(", ")}; ` +
              `set the relevant SERVE_CMD env var on ${platform()} or pass opts.launchCmd)`
            : ""
        throw new Error(
          `[${label}] service is not running on :${port} and no launch command is available.${platformHint}`
        )
      }
      const cmdFile = opts.binPath ?? cmd.file
      log?.(`[${label}] starting: ${[cmdFile, ...cmd.args].join(" ")}`)
      if (cmd.isLaunchctl) {
        // Launcher exits immediately — spawn for side-effect only; pid stays undefined.
        spawn(cmdFile, cmd.args, {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, ...persistedEnv, ...opts.env, ...resolvedExtraEnv },
        }).unref()
        return null
      }
      const child = spawn(cmdFile, cmd.args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...persistedEnv, ...opts.env, ...resolvedExtraEnv },
        ...(cmd.cwd ? { cwd: cmd.cwd } : {}),
      })
      child.unref()
      return child
    },
    timeoutMs,
    intervalMs: 1000,
    log,
    ...(opts.initialWaitMs !== undefined ? { initialWaitMs: opts.initialWaitMs } : {}),
  })

  return {
    id: handle.id,
    port,
    baseUrl: result.baseUrl,
    pid: result.pid,
    wasAlreadyRunning: result.wasAlreadyRunning,
    healthy: result.healthy,
    stop: makeStop(result.pid, cfg.killProcessGroup ?? false),
  }
}
