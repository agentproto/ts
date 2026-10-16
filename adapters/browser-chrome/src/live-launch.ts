import { mkdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { buildChromeArgs, defaultDataDir, defaultSpawn, type ChromeProcess, type SpawnChrome } from "./launch.js"
import { resolveChrome } from "./resolve.js"

/**
 * Auto-launch fallback for `chrome-live`.
 *
 * `chrome-live` normally attaches to the user's own Chrome through the remote
 * debugging toggle (port 9222). When nothing answers there — the toggle was
 * never turned on — the provider launches a DEDICATED, headful Chrome on a free
 * port with its own persisted user-data-dir (never the user's default profile),
 * then connects to it. Chrome never asks for consent on that dedicated profile,
 * so the fallback costs the user zero clicks. Only the process this module
 * spawned is ever killed; the user's own Chrome is untouched (pid scissors in
 * `live.ts`).
 */

/** Env override for the persisted profile dir. Blank counts as unset. */
export const CHROME_LIVE_LAUNCH_DIR_ENV = "CHROME_LIVE_LAUNCH_DATA_DIR"

/** Profile subdir under the provider data dir when no explicit dir is configured. */
export const CHROME_LIVE_LAUNCH_PROFILE = "live"

/** How long to wait for the freshly launched Chrome to answer `/json/version`. */
export const CHROME_LIVE_LAUNCH_DEFAULT_TIMEOUT_MS = 30_000

/**
 * Persisted dedicated user-data-dir for the auto-launched Chrome:
 * `$CHROME_LIVE_LAUNCH_DATA_DIR`, else `<AGENTPROTO_HOME>/browser/chrome/live`
 * (default `~/.agentproto/browser/chrome/live`). Kept across runs on purpose —
 * a warm profile means fewer first-run prompts and less friction.
 */
export function liveLaunchDataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env[CHROME_LIVE_LAUNCH_DIR_ENV]
  if (typeof override === "string" && override.trim() !== "") return override
  return join(defaultDataDir(env), CHROME_LIVE_LAUNCH_PROFILE)
}

/** The `/json/version` body slice the discovery step needs. */
export interface JsonVersion {
  webSocketDebuggerUrl?: unknown
}

/** Everything `launchDetachedChrome` needs; every field has a production default and a test seam. */
export interface LiveLaunchDeps {
  /** Persisted dedicated profile dir. Default `liveLaunchDataDir(env)`. */
  dataDir?: string
  /** Chrome binary; beats `findChrome`. */
  executablePath?: string
  /** Test seam: replaces system Chrome discovery. */
  findChrome?: () => string | undefined
  /** Test seam: replaces the child-process spawn. */
  spawn?: SpawnChrome
  /** Test seam: replaces the free-port probe. */
  findFreePort?: () => Promise<number>
  /** Test seam: replaces the `/json/version` fetch. */
  fetchJsonVersion?: (port: number) => Promise<JsonVersion | undefined>
  /** Test seam: replaces the poll sleep. */
  sleep?: (ms: number) => Promise<void>
  /** How long to wait for the debugging endpoint. Default 30s. */
  timeoutMs?: number
  /** Extra env for the spawned process (merged over `process.env`). */
  env?: Readonly<Record<string, string | undefined>>
  log?: (line: string) => void
}

/** A Chrome this process spawned; `hasExited` lets `stop()` avoid a dead-child hang. */
export interface LaunchedChrome {
  process: ChromeProcess
  pid?: number
  port: number
  wsUrl: string
  hasExited: () => boolean
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Bind `:0` on 127.0.0.1, read the assigned port, release it. */
export async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

async function defaultFetchJsonVersion(port: number): Promise<JsonVersion | undefined> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })
  if (!res.ok) return undefined
  const text = await res.text()
  if (!text) return undefined
  return JSON.parse(text) as JsonVersion
}

/**
 * Launch a dedicated headful Chrome on a free port and return once its
 * `/json/version` advertises the uuid websocket URL (discover mode). Throws
 * (and kills the child) if the endpoint never appears or the child exits.
 */
export async function launchDetachedChrome(deps: LiveLaunchDeps = {}): Promise<LaunchedChrome> {
  const env = deps.env ?? {}
  const binary = deps.executablePath ?? (deps.findChrome ?? resolveChrome)()
  if (!binary) {
    throw new Error("[chrome-live] no Chrome found to auto-launch: install Google Chrome or set CHROME_EXECUTABLE_PATH")
  }
  const dir = deps.dataDir ?? liveLaunchDataDir({ ...process.env, ...env })
  const port = await (deps.findFreePort ?? findFreePort)()
  const timeoutMs = deps.timeoutMs ?? CHROME_LIVE_LAUNCH_DEFAULT_TIMEOUT_MS
  const sleep = deps.sleep ?? realSleep
  const probe = deps.fetchJsonVersion ?? defaultFetchJsonVersion
  const spawn = deps.spawn ?? defaultSpawn

  await mkdir(dir, { recursive: true })
  // No live process holds the dir, so a leftover port file is stale.
  await rm(join(dir, "DevToolsActivePort"), { force: true })

  const args = buildChromeArgs({ dir, port, headless: false, extraArgs: [] })
  deps.log?.(`[chrome-live] auto-launching ${binary} headful on 127.0.0.1:${port} (profile ${dir})`)
  const child = spawn(binary, args, { env: { ...process.env, ...env } })
  let exited = false
  child.once("exit", () => {
    exited = true
  })
  const hasExited = (): boolean => exited

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const version = await probe(port).catch(() => undefined)
    const ws = version?.webSocketDebuggerUrl
    if (typeof ws === "string" && /^wss?:\/\//.test(ws)) {
      return { process: child, ...(child.pid !== undefined ? { pid: child.pid } : {}), port, wsUrl: ws, hasExited }
    }
    if (exited) {
      throw new Error(`[chrome-live] the auto-launched Chrome exited before opening its debugging endpoint (profile ${dir})`)
    }
    if (Date.now() >= deadline) {
      child.kill("SIGTERM")
      throw new Error(`[chrome-live] the auto-launched Chrome did not answer /json/version within ${Math.round(timeoutMs / 1_000)}s`)
    }
    await sleep(50)
  }
}
