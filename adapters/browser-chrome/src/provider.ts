import { mkdir, realpath, rm } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  assertNoOwnedArgs,
  assertSpawnArgsSafe,
  cookiesFromSessionPayload,
  defineBrowser,
  liveProfileLockPid,
  resolveDedicatedProfileDir,
  type BrowserAttachOptions,
  type BrowserCookie,
  type BrowserCookieSource,
  type BrowserDriver,
  type BrowserHealth,
  type BrowserHostContext,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserProvider,
} from "@agentproto/driver-browser"
import { CdpConnection } from "./cdp.js"
import { attachChromeDriver, CHROME_PROVIDER_ID, type ChromeCdpDriver } from "./driver.js"
import {
  buildChromeArgs,
  defaultDataDir,
  defaultSpawn,
  readDevToolsEndpoint,
  type ChromeProcess,
  type SpawnChrome,
} from "./launch.js"
import { CHROME_ENV_VAR, resolveChrome } from "./resolve.js"

/** What `launch` accepts beyond the kit's options. */
export interface ChromeLaunchOptions extends BrowserLaunchOptions {
  /** A dedicated dir to use instead of `<dataDir>/profiles/<profile|label|main>`. A default Chrome dir is refused. */
  userDataDir?: string
  /** Always refused with `browser:profile-refused`; full-profile access arrives with the grant model. */
  fullProfile?: boolean
  /** Extra Chrome switches. `--user-data-dir`, `--remote-debugging-*` and `--full-profile` are refused. */
  args?: readonly string[]
  /** Chrome binary; beats the provider config, `CHROME_EXECUTABLE_PATH` and discovery. */
  executablePath?: string
}

export interface ChromeProviderConfig {
  /** Root of the dedicated profile dirs. Default `~/.agentproto/browser/chrome`. */
  dataDir?: string
  executablePath?: string
  /** Supplies the granted cookies injected through `Network.setCookies` on every attach. The interface only: grants come later. */
  cookieSource?: BrowserCookieSource
  /** Test seam: replaces system Chrome discovery. */
  findChrome?: () => string | undefined
  spawn?: SpawnChrome
  sleep?: (ms: number) => Promise<void>
  /** Home for default-dir detection; tests only. */
  env?: { home?: string; platform?: string; localAppData?: string }
}

export type ChromeProvider = Omit<BrowserProvider, "launch"> & {
  launch(opts: ChromeLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance>
}

const DEFAULT_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 5_000
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const DESCRIPTION =
  "The system Chrome, launched on its own fresh dedicated profile dir (never the user's Chrome profile) and driven over CDP. " +
  "Granted cookies are injected with Network.setCookies. Headless by default."

interface Entry {
  dir: string
  id: string
  profile: string
  port: number
  cdp: string
  child: ChromeProcess
  exited: boolean
  closing?: Promise<void>
  conn?: Promise<CdpConnection>
  drivers: Set<ChromeCdpDriver>
}

export function createChromeProvider(config: ChromeProviderConfig = {}): ChromeProvider {
  const dataDir = config.dataDir ?? defaultDataDir()
  const spawn = config.spawn ?? defaultSpawn
  const sleep = config.sleep ?? realSleep
  const running = new Map<string, Entry>()
  const starting = new Map<string, Promise<Entry>>()

  async function start(dir: string, id: string, profile: string, opts: ChromeLaunchOptions, ctx: BrowserHostContext): Promise<Entry> {
    const binary = opts.executablePath ?? config.executablePath ?? (config.findChrome ?? resolveChrome)()
    if (!binary) {
      throw new Error(`[chrome] no Chrome found: install Google Chrome or set ${CHROME_ENV_VAR} to the binary`)
    }
    const args = buildChromeArgs({
      dir,
      port: opts.port ?? 0,
      headless: opts.headless ?? true,
      extraArgs: opts.args ?? [],
    })
    assertSpawnArgsSafe(args, CHROME_PROVIDER_ID, config.env)

    // No live process holds the dir (checked by the caller), so a leftover port file is stale.
    await rm(join(dir, "DevToolsActivePort"), { force: true })
    ctx.log?.(`[chrome] launching ${binary} on ${dir}`)
    const child = spawn(binary, args, { env: { ...process.env, ...opts.env } })
    let exited = false
    child.once("exit", () => {
      exited = true
    })
    let endpoint
    try {
      endpoint = await readDevToolsEndpoint(dir, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, sleep, () => exited)
    } catch (err) {
      child.kill("SIGTERM")
      throw err
    }
    const entry: Entry = {
      dir,
      id,
      profile,
      port: endpoint.port,
      cdp: `ws://127.0.0.1:${endpoint.port}${endpoint.browserWsPath}`,
      child,
      exited,
      drivers: new Set(),
    }
    child.once("exit", () => {
      entry.exited = true
      entry.conn?.then((c) => c.close()).catch(() => {})
      if (running.get(dir) === entry) running.delete(dir)
    })
    return entry
  }

  async function launch(opts: ChromeLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance> {
    assertNoOwnedArgs(opts.args ?? [], CHROME_PROVIDER_ID)
    const resolved = resolveDedicatedProfileDir({
      providerId: CHROME_PROVIDER_ID,
      dataDir,
      ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.userDataDir !== undefined ? { userDataDir: opts.userDataDir } : {}),
      ...(opts.fullProfile !== undefined ? { fullProfile: opts.fullProfile } : {}),
      ...(config.env ? { env: config.env } : {}),
    })
    // Refusals are done; create the dir now so the registry key is the real path on every call.
    await mkdir(resolved, { recursive: true })
    const dir = await realpath(resolved)
    const id = `${CHROME_PROVIDER_ID}:${basename(dir)}`

    const live = running.get(dir)
    if (live && !live.exited) return makeInstance(live, true)
    const pending = starting.get(dir)
    if (pending) return makeInstance(await pending, true)

    const foreign = liveProfileLockPid(dir)
    if (foreign !== undefined) {
      throw new Error(`[chrome] ${dir} is already held by pid ${foreign} outside this process; stop it or pick another profile`)
    }

    const promise = start(dir, id, opts.profile ?? opts.label ?? "main", opts, ctx)
    starting.set(dir, promise)
    try {
      const entry = await promise
      running.set(dir, entry)
      return makeInstance(entry, false, ctx)
    } finally {
      starting.delete(dir)
    }
  }

  function connection(entry: Entry): Promise<CdpConnection> {
    if (!entry.conn) {
      const attempt: Promise<CdpConnection> = CdpConnection.connect(entry.cdp).catch((err: unknown) => {
        // Do not cache a rejected connect forever: the next attach should retry.
        if (entry.conn === attempt) entry.conn = undefined
        throw err
      })
      entry.conn = attempt
    }
    return entry.conn
  }

  function makeInstance(entry: Entry, wasAlreadyRunning: boolean, launchCtx?: BrowserHostContext): BrowserInstance {
    return {
      id: entry.id,
      endpoints: { cdp: entry.cdp },
      ...(entry.child.pid !== undefined ? { pid: entry.child.pid } : {}),
      wasAlreadyRunning,

      async health(): Promise<BrowserHealth> {
        if (entry.exited) return { ok: false, reason: "stopped" }
        try {
          const res = await fetch(`http://127.0.0.1:${entry.port}/json/version`, { signal: AbortSignal.timeout(5_000) })
          return res.ok ? { ok: true } : { ok: false, reason: `devtools answered ${res.status}` }
        } catch (err) {
          return { ok: false, reason: `devtools unreachable: ${err instanceof Error ? err.message : String(err)}` }
        }
      },

      async attach(attachOpts?: BrowserAttachOptions): Promise<BrowserDriver> {
        if (entry.exited) throw new Error(`[chrome] instance ${entry.id} is stopped`)
        const granted: BrowserCookie[] = [
          ...(config.cookieSource ? await config.cookieSource({ providerId: CHROME_PROVIDER_ID, profile: entry.profile }) : []),
          ...cookiesFromSessionPayload(attachOpts?.sessionPayload),
        ]
        if (granted.length > 0) launchCtx?.log?.(`[chrome] injecting ${granted.length} granted cookie(s) via Network.setCookies`)
        const driver = await attachChromeDriver(await connection(entry), {
          ...(attachOpts?.initialUrl ? { initialUrl: attachOpts.initialUrl } : {}),
          cookies: granted,
        })
        entry.drivers.add(driver)
        return driver
      },

      async stop(): Promise<void> {
        // Only a Chrome this provider spawned is ours to stop; the user's own Chrome is never touched.
        if (wasAlreadyRunning) return
        if (!entry.closing) {
          if (running.get(entry.dir) === entry) running.delete(entry.dir)
          entry.closing = (async () => {
            for (const driver of entry.drivers) await driver.close().catch(() => {})
            entry.drivers.clear()
            const conn = await entry.conn?.catch(() => undefined)
            conn?.close()
            if (entry.exited) return
            const gone = new Promise<void>((resolve) => entry.child.once("exit", resolve))
            entry.child.kill("SIGTERM")
            const killer = setTimeout(() => entry.child.kill("SIGKILL"), STOP_GRACE_MS)
            await gone
            clearTimeout(killer)
            entry.exited = true
          })()
        }
        await entry.closing
      },
    }
  }

  return defineBrowser({
    id: CHROME_PROVIDER_ID,
    name: "Chrome (system)",
    description: DESCRIPTION,
    version: "1.0.0",
    transport: "sdk",
    location: "local",
    capabilities: {
      canCaptureResponseBodies: true,
      canDispatchTrustedInput: true,
      canFullPageScreenshot: true,
      canCookies: true,
      headless: true,
      headed: true,
      persistentProfile: true,
      multiInstance: true,
      cdp: true,
      stealth: false,
      downloads: false,
    },
    install: [{ method: "path" }],
    options: [{ id: "headless", type: "boolean", default: true, description: "Run without a window. Headed launches need a display." }],
    config: [
      {
        id: "chrome-executable",
        kind: "prompt",
        prompt: "Path of the Chrome binary (leave blank to use the standard install location)",
        type: "text",
        persist: { env: CHROME_ENV_VAR },
      },
    ],
    launch,
    async check(): Promise<boolean> {
      try {
        return (config.executablePath ?? (config.findChrome ?? resolveChrome)()) !== undefined
      } catch {
        return false
      }
    },
  }) as ChromeProvider
}

/** The default chrome provider: dedicated profile dirs under `~/.agentproto/browser/chrome`. */
export const chrome: ChromeProvider = createChromeProvider()
