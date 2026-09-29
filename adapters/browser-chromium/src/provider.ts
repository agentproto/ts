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
  type BrowserDriver,
  type BrowserHealth,
  type BrowserHostContext,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserProvider,
} from "@agentproto/driver-browser"
import type { BrowserContext } from "playwright-core"
import { attachChromiumDriver, CHROMIUM_PROVIDER_ID, type ChromiumBrowserDriver } from "./driver.js"
import {
  defaultDataDir,
  INSTALL_HINT,
  loadPlaywright,
  readDevToolsEndpoint,
  type PlaywrightLoader,
} from "./launch.js"

/** What `launch` accepts beyond the kit's options. */
export interface ChromiumLaunchOptions extends BrowserLaunchOptions {
  /** A dedicated dir to use instead of `<dataDir>/profiles/<profile|label|main>`. A default Chrome dir is refused. */
  userDataDir?: string
  /** Always refused with `browser:profile-refused`; full-profile access arrives with the grant model. */
  fullProfile?: boolean
  /** Extra Chromium switches. `--user-data-dir`, `--remote-debugging-*` and `--full-profile` are refused. */
  args?: readonly string[]
  /** Chromium/Chrome binary; beats the provider config and `CHROMIUM_EXECUTABLE_PATH`. Playwright's Chromium by default. */
  executablePath?: string
}

export interface ChromiumProviderConfig {
  /** Root of the dedicated profile dirs. Default `~/.agentproto/browser/chromium`. */
  dataDir?: string
  executablePath?: string
  /** Test seam: how `playwright-core` is loaded. */
  loadPlaywright?: PlaywrightLoader
  sleep?: (ms: number) => Promise<void>
  /** Home for default-dir detection; tests only. */
  env?: { home?: string; platform?: string; localAppData?: string }
}

export type ChromiumProvider = Omit<BrowserProvider, "launch"> & {
  launch(opts: ChromiumLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance>
}

const DEFAULT_TIMEOUT_MS = 60_000
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const DESCRIPTION =
  "Chromium driven by Playwright on its own dedicated profile dir (never the user's Chrome profile), " +
  "with CDP access, network capture and screenshots. Headless by default."

interface Entry {
  dir: string
  id: string
  context: BrowserContext
  cdp: string
  port: number
  closed: boolean
  drivers: Set<ChromiumBrowserDriver>
  /** Resolves once the context is fully closed. */
  closing?: Promise<void>
}

export function createChromiumProvider(config: ChromiumProviderConfig = {}): ChromiumProvider {
  const dataDir = config.dataDir ?? defaultDataDir()
  const load = config.loadPlaywright ?? loadPlaywright
  const sleep = config.sleep ?? realSleep
  const running = new Map<string, Entry>()
  const starting = new Map<string, Promise<Entry>>()

  async function start(dir: string, id: string, opts: ChromiumLaunchOptions, ctx: BrowserHostContext): Promise<Entry> {
    const { chromium } = await load()
    const executablePath = opts.executablePath ?? config.executablePath ?? process.env["CHROMIUM_EXECUTABLE_PATH"]
    const args = ["--remote-debugging-port=0", ...(opts.args ?? [])]
    // Playwright adds its own --user-data-dir from `dir`; check the argv it will get.
    assertSpawnArgsSafe([`--user-data-dir=${dir}`], CHROMIUM_PROVIDER_ID, config.env)

    // No live process holds the dir (checked by the caller), so a leftover port file is stale.
    await rm(join(dir, "DevToolsActivePort"), { force: true })
    ctx.log?.(`[chromium] launching on ${dir}`)
    let context: BrowserContext
    try {
      context = await chromium.launchPersistentContext(dir, {
        headless: opts.headless ?? true,
        args,
        ...(executablePath ? { executablePath } : {}),
        ...(opts.env ? { env: { ...process.env, ...opts.env } as Record<string, string> } : {}),
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (/executable doesn't exist|browserType\.launch/i.test(text)) {
        throw new Error(`[chromium] no Chromium binary found (run \`${INSTALL_HINT}\` or set CHROMIUM_EXECUTABLE_PATH): ${text.split("\n")[0]}`)
      }
      throw err
    }

    try {
      const endpoint = await readDevToolsEndpoint(dir, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, sleep)
      const entry: Entry = {
        dir,
        id,
        context,
        port: endpoint.port,
        cdp: `ws://127.0.0.1:${endpoint.port}${endpoint.browserWsPath}`,
        closed: false,
        drivers: new Set(),
      }
      context.on("close", () => {
        entry.closed = true
        if (running.get(dir) === entry) running.delete(dir)
      })
      return entry
    } catch (err) {
      await context.close().catch(() => {})
      throw err
    }
  }

  async function launch(opts: ChromiumLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance> {
    assertNoOwnedArgs(opts.args ?? [], CHROMIUM_PROVIDER_ID)
    const resolved = resolveDedicatedProfileDir({
      providerId: CHROMIUM_PROVIDER_ID,
      dataDir,
      ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.userDataDir !== undefined ? { userDataDir: opts.userDataDir } : {}),
      ...(opts.fullProfile !== undefined ? { fullProfile: opts.fullProfile } : {}),
      ...(config.env ? { env: config.env } : {}),
    })
    // Refusals are done; create the dir now so the registry key is the real path on every call (tmp dirs are symlinks on macOS).
    await mkdir(resolved, { recursive: true })
    const dir = await realpath(resolved)
    const id = `${CHROMIUM_PROVIDER_ID}:${basename(dir)}`

    const live = running.get(dir)
    if (live && !live.closed) return makeInstance(live, true)

    const pending = starting.get(dir)
    if (pending) return makeInstance(await pending, true)

    const foreign = liveProfileLockPid(dir)
    if (foreign !== undefined) {
      throw new Error(`[chromium] ${dir} is already held by pid ${foreign} outside this process; stop it or pick another profile`)
    }

    const promise = start(dir, id, opts, ctx)
    starting.set(dir, promise)
    try {
      const entry = await promise
      running.set(dir, entry)
      return makeInstance(entry, false)
    } finally {
      starting.delete(dir)
    }
  }

  function makeInstance(entry: Entry, wasAlreadyRunning: boolean): BrowserInstance {
    return {
      id: entry.id,
      endpoints: { cdp: entry.cdp },
      wasAlreadyRunning,

      async health(): Promise<BrowserHealth> {
        if (entry.closed) return { ok: false, reason: "stopped" }
        try {
          const res = await fetch(`http://127.0.0.1:${entry.port}/json/version`, { signal: AbortSignal.timeout(5_000) })
          return res.ok ? { ok: true } : { ok: false, reason: `devtools answered ${res.status}` }
        } catch (err) {
          return { ok: false, reason: `devtools unreachable: ${err instanceof Error ? err.message : String(err)}` }
        }
      },

      async attach(attachOpts?: BrowserAttachOptions): Promise<BrowserDriver> {
        if (entry.closed) throw new Error(`[chromium] instance ${entry.id} is stopped`)
        const cookies = cookiesFromSessionPayload(attachOpts?.sessionPayload)
        const driver = await attachChromiumDriver(entry.context, {
          ...(attachOpts?.initialUrl ? { initialUrl: attachOpts.initialUrl } : {}),
          cookies,
        })
        entry.drivers.add(driver)
        return driver
      },

      async stop(): Promise<void> {
        // A view that found the browser already running does not own it.
        if (wasAlreadyRunning) return
        if (!entry.closing) {
          entry.closed = true
          if (running.get(entry.dir) === entry) running.delete(entry.dir)
          entry.closing = (async () => {
            for (const driver of entry.drivers) await driver.close().catch(() => {})
            entry.drivers.clear()
            await entry.context.close().catch(() => {})
          })()
        }
        await entry.closing
      },
    }
  }

  return defineBrowser({
    id: CHROMIUM_PROVIDER_ID,
    name: "Chromium (Playwright)",
    description: DESCRIPTION,
    version: "1.0.0",
    transport: "sdk",
    location: "local",
    capabilities: {
      canCaptureResponseBodies: true,
      canDispatchTrustedInput: true,
      canMultiTarget: true,
      canFullPageScreenshot: true,
      canScreencast: true,
      canCookies: true,
      headless: true,
      headed: true,
      persistentProfile: true,
      multiInstance: true,
      cdp: true,
      stealth: false,
      recording: "screencast",
      downloads: false,
    },
    install: [{ method: "path" }],
    options: [{ id: "headless", type: "boolean", default: true, description: "Run without a window. Headed launches need a display." }],
    config: [
      {
        id: "chromium-install",
        kind: "prompt",
        prompt: `Chromium binary: run \`${INSTALL_HINT}\` (or give the path of a Chromium build)`,
        type: "text",
        persist: { env: "CHROMIUM_EXECUTABLE_PATH" },
      },
    ],
    launch,
  }) as ChromiumProvider
}

/** The default chromium provider: dedicated profile dirs under `~/.agentproto/browser/chromium`. */
export const chromium: ChromiumProvider = createChromiumProvider()
