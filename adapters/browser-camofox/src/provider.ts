import {
  defineBrowser,
  type BehaviorProfile,
  type BrowserAttachOptions,
  type BrowserDriver,
  type BrowserHealth,
  type BrowserHostContext,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserProvider,
} from "@agentproto/driver-browser"
import { attachCamofoxDriver, CAMOFOX_PROVIDER_ID, type CamofoxBrowserDriver } from "./driver.js"
import { createCamofoxRestClient, DEFAULT_CAMOFOX_URL, normalizeBaseUrl, type CamofoxRestClient } from "./client.js"
import { isCamofoxAnswer, mapCamofoxHealth } from "./health.js"
import {
  currentPlatform,
  DEFAULT_CAMOFOX_PORT,
  DEFAULT_LAUNCHD_LABEL,
  defaultSpawn,
  isLoopbackHost,
  readPersistedEnv,
  resolveCamofoxLaunchCommand,
  terminate,
  type SpawnFn,
} from "./launch.js"

/** What `launch` accepts beyond the kit's options (the adapter-browser facade passes these through). */
export interface CamofoxLaunchOptions extends BrowserLaunchOptions {
  /** Shell command to start the server; beats `CAMOFOX_SERVE_CMD` and launchd. */
  launchCmd?: string
  /** Override the executable of the resolved launch command. */
  binPath?: string
  /** Wait only this long for a fresh spawn to answer, then return unhealthy while it keeps booting. */
  initialWaitMs?: number
  /** `cloud`: never spawn; `baseUrl` must already answer. */
  location?: "local" | "cloud"
  /** Bearer key for this launch; beats the provider config and `CAMOFOX_API_KEY`. */
  apiKey?: string
}

export interface CamofoxProviderConfig {
  /** Default server origin when a launch gives no `baseUrl` or `port`. */
  baseUrl?: string
  apiKey?: string
  /** launchd label used on macOS when no serve command is set. Default `com.agentik.camofox`. */
  launchdLabel?: string
  /** Pacing for every attached driver. Default: `$BUREAU_BEHAVIOR`, else `human`. */
  behavior?: BehaviorProfile
  /** Camofox context id (logins live here) when a launch names no `profile`. Default `main`. */
  userId?: string
  sessionKey?: string
  /** Ask the server to keep the attached tabs out of its idle reaper. */
  keepAlive?: boolean
  /** Server records video natively. Default: `$CAMOFOX_NATIVE_VIDEO === "true"`. */
  nativeVideo?: boolean
  spawn?: SpawnFn
  sleep?: (ms: number) => Promise<void>
  platform?: string
  readPersistedEnv?: (adapterId: string) => Promise<Record<string, string>>
  /** Poll interval while waiting for a fresh spawn. Default 500 ms. */
  pollIntervalMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const DESCRIPTION =
  "Camofox: a stealth Firefox (Camoufox) behind a local REST service on :9377 with /health, /tabs and /sessions. " +
  "No CDP and no network capture (Gecko); deterministic click and fill, evaluate, screenshots, cookies, downloads."

/** A `BrowserProvider` whose `launch` also takes the camofox-only options; still assignable to `BrowserProvider`. */
export type CamofoxProvider = Omit<BrowserProvider, "launch"> & {
  launch(opts: CamofoxLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance>
}

export function createCamofoxProvider(config: CamofoxProviderConfig = {}): CamofoxProvider {
  const nativeVideo = config.nativeVideo ?? process.env["CAMOFOX_NATIVE_VIDEO"] === "true"
  const spawn = config.spawn ?? defaultSpawn
  const sleep = config.sleep ?? realSleep
  const platform = config.platform ?? currentPlatform()
  const loadPersisted = config.readPersistedEnv ?? readPersistedEnv
  const pollMs = config.pollIntervalMs ?? 500

  async function launch(opts: CamofoxLaunchOptions, ctx: BrowserHostContext): Promise<BrowserInstance> {
    const log = ctx.log
    const persisted = await loadPersisted(CAMOFOX_PROVIDER_ID)
    const env: Record<string, string | undefined> = { ...process.env, ...persisted, ...opts.env }

    const origin = normalizeBaseUrl(
      opts.baseUrl ??
        (opts.port !== undefined ? `http://127.0.0.1:${opts.port}` : undefined) ??
        config.baseUrl ??
        env["CAMOFOX_URL"] ??
        DEFAULT_CAMOFOX_URL,
    )
    const url = new URL(origin)
    const port = url.port ? Number(url.port) : DEFAULT_CAMOFOX_PORT
    const apiKey = opts.apiKey ?? config.apiKey ?? env["CAMOFOX_API_KEY"]
    const scrub = (text: string): string => (apiKey ? text.split(apiKey).join("[redacted]") : text)
    const client = createCamofoxRestClient({
      baseUrl: origin,
      ...(apiKey ? { apiKey } : {}),
      userId: opts.profile ?? config.userId ?? "main",
      ...(config.sessionKey ? { sessionKey: config.sessionKey } : {}),
    })

    const probe = async () => {
      try {
        const res = await client.health()
        return isCamofoxAnswer(res) ? res : null
      } catch {
        return null
      }
    }

    let pid: number | undefined
    let wasAlreadyRunning = true
    if ((await probe()) === null) {
      wasAlreadyRunning = false
      if (opts.location === "cloud" || !isLoopbackHost(url.hostname)) {
        throw new Error(`[camofox] ${origin} does not answer and is not a local address, so nothing was started`)
      }
      const cmd = resolveCamofoxLaunchCommand({
        ...(opts.launchCmd ? { launchCmd: opts.launchCmd } : {}),
        env,
        launchdLabel: config.launchdLabel ?? env["CAMOFOX_LAUNCHD_LABEL"] ?? DEFAULT_LAUNCHD_LABEL,
        platform,
      })
      if (!cmd) {
        throw new Error(
          `[camofox] nothing answers on :${port} and no launch command is available ` +
            `(set CAMOFOX_SERVE_CMD or pass launchCmd; the launchd default is macOS only, this is ${platform})`,
        )
      }
      const file = opts.binPath ?? cmd.file
      log?.(scrub(`[camofox] starting: ${[file, ...cmd.args].join(" ")}`))
      const child = spawn(file, cmd.args, {
        env: cmd.isLaunchctl ? env : { CAMOFOX_PORT: String(port), ...env },
      })
      pid = cmd.isLaunchctl ? undefined : child.pid

      const waitMs = opts.initialWaitMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const deadline = Date.now() + waitMs
      let up = false
      while (Date.now() < deadline) {
        await sleep(pollMs)
        if ((await probe()) !== null) {
          up = true
          break
        }
        log?.(`[camofox] waiting for ${origin}/health`)
      }
      if (!up) {
        if (opts.initialWaitMs === undefined) {
          if (pid !== undefined) terminate(pid)
          throw new Error(`[camofox] ${origin} did not answer within ${Math.round(waitMs / 1000)}s`)
        }
        log?.(`[camofox] not up within ${opts.initialWaitMs}ms, still starting in the background`)
      }
    }

    return makeInstance({
      client,
      id: `camofox:${opts.label ?? "default"}@${url.host}`,
      origin,
      wasAlreadyRunning,
      pid,
      owned: !wasAlreadyRunning && pid !== undefined,
    })
  }

  function makeInstance(input: {
    client: CamofoxRestClient
    id: string
    origin: string
    wasAlreadyRunning: boolean
    pid: number | undefined
    owned: boolean
  }): BrowserInstance {
    const { client } = input
    let stopped = false
    const drivers = new Set<CamofoxBrowserDriver>()

    return {
      id: input.id,
      endpoints: { rest: input.origin },
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      wasAlreadyRunning: input.wasAlreadyRunning,

      async health(): Promise<BrowserHealth> {
        if (stopped) return { ok: false, reason: "stopped" }
        try {
          return mapCamofoxHealth(await client.health())
        } catch (err) {
          return mapCamofoxHealth(null, err)
        }
      },

      async attach(attachOpts?: BrowserAttachOptions): Promise<BrowserDriver> {
        if (stopped) throw new Error(`[camofox] instance ${input.id} is stopped`)
        const driver = await attachCamofoxDriver({
          client,
          nativeVideo,
          behavior: attachOpts?.behavior ?? config.behavior,
          ...(attachOpts?.targetId ? { targetId: attachOpts.targetId } : {}),
          ...(attachOpts?.initialUrl ? { initialUrl: attachOpts.initialUrl } : {}),
          ...(attachOpts?.sessionPayload !== undefined ? { sessionPayload: attachOpts.sessionPayload } : {}),
          ...(config.keepAlive !== undefined ? { keepAlive: config.keepAlive } : {}),
        })
        drivers.add(driver)
        return driver
      },

      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        for (const driver of drivers) await driver.close().catch(() => {})
        drivers.clear()
        // Only a server this call started is ours to kill; a healthy one that was already up is left alone.
        if (input.owned && input.pid !== undefined) terminate(input.pid)
      },
    }
  }

  const provider = defineBrowser({
    id: CAMOFOX_PROVIDER_ID,
    name: "Camofox (stealth Firefox)",
    description: DESCRIPTION,
    version: "1.0.0",
    transport: "http",
    location: "local",
    capabilities: {
      canDispatchTrustedInput: true,
      canMultiTarget: true,
      canStealth: true,
      canCookies: true,
      canRecordVideo: nativeVideo,
      stealth: true,
      headless: true,
      headed: true,
      persistentProfile: true,
      recording: nativeVideo ? "video" : "none",
      cdp: false,
      downloads: true,
    },
    install: [{ method: "vendored" }],
    requires: { nativeLaunchOs: ["darwin"] },
    config: [
      {
        id: "camofox-serve-cmd",
        kind: "prompt",
        prompt: "Shell command to start camofox (leave blank on macOS when using a launchd job)",
        description: "Required on non-macOS hosts. On macOS it overrides the default `launchctl start <label>` path.",
        type: "text",
        persist: { env: "CAMOFOX_SERVE_CMD" },
      },
    ],
    launch,
  })
  return provider
}

/** The default camofox provider: reads `CAMOFOX_URL`, `CAMOFOX_API_KEY`, `CAMOFOX_SERVE_CMD` from the environment. */
export const camofox: CamofoxProvider = createCamofoxProvider()
