import {
  CHROME_LIVE_DEFAULT_PORT,
  chromeLive,
  type ChromeLiveLaunchOptions,
  type ChromeLiveProvider,
} from "@agentproto/adapter-browser-chrome"
import { toAdapterHandle } from "../providers/to-adapter-handle.js"
import type { BrowserAdapterHandle, BrowserAdapterInstance, BrowserAdapterStartOptions } from "../types.js"

/**
 * The kit `chrome-live` provider: the user's own running Chrome, attached
 * through its remote debugging toggle. Launches nothing; `stop` closes only the
 * tabs it opened and its own websocket, never the user's Chrome.
 */
export const chromeLiveProvider: ChromeLiveProvider = chromeLive

const CHROME_LIVE_META = {
  defaultPort: CHROME_LIVE_DEFAULT_PORT,
  // The toggle answers HTTP empty; health goes over the CDP websocket (`instance.health()`).
  healthPath: "/json/version",
  name: "Chrome (your running browser)",
  description:
    "Your own running Chrome (logged-in profile), attached through chrome://inspect/#remote-debugging. " +
    "If the toggle is off it auto-launches a dedicated headful Chrome on its own persisted profile (no consent click). " +
    "The agent works in its own window and never touches your tabs.",
} as const

async function ensureChromeLive(opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {
  if (opts.location === "cloud") {
    throw new Error("[chrome-live] chrome-live attaches to a Chrome on this machine; it has no cloud location")
  }
  const launchOpts: ChromeLiveLaunchOptions = {
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }
  const instance = await chromeLiveProvider.launch(launchOpts, opts.log ? { log: opts.log } : {})
  const cdp = instance.endpoints.cdp
  if (!cdp) throw new Error("[chrome-live] the provider returned no CDP endpoint")
  const url = new URL(cdp)
  return {
    id: chromeLiveProvider.id,
    port: Number(url.port) || CHROME_LIVE_DEFAULT_PORT,
    baseUrl: `http://${url.host}`,
    // Set only when the provider auto-launched a dedicated Chrome; an
    // attach-only session leaves it undefined and is never signalled by stop().
    ...(instance.pid !== undefined ? { pid: instance.pid } : {}),
    wasAlreadyRunning: instance.wasAlreadyRunning,
    healthy: (await instance.health()).ok,
    health: async () => instance.health(),
    // Screencast (chrome-live's own Page.startScreencast, live view + frames
    // for the runtime's mp4 recording) — pass the provider methods straight
    // through; the runtime browser tools call them structurally.
    screencastStart: (opts) => instance.screencastStart(opts),
    screencastFrame: () => instance.screencastFrame(),
    screencastStop: () => instance.screencastStop(),
    screenshot: async (tabId) => {
      const shot = await instance.screenshotOwnedTarget(tabId)
      return {
        data: shot.base64,
        format: "png",
        ...(shot.width !== undefined ? { width: shot.width } : {}),
        ...(shot.height !== undefined ? { height: shot.height } : {}),
      }
    },
    stop: () => instance.stop(),
  }
}

export const chromeLiveAdapter: BrowserAdapterHandle = {
  ...toAdapterHandle(chromeLiveProvider, CHROME_LIVE_META),
  ensure: ensureChromeLive,
}
