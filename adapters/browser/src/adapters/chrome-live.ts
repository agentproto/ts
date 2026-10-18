import {
  CHROME_LIVE_DEFAULT_PORT,
  chromeLive,
  createChromeLiveProvider,
  type ChromeLiveLaunchOptions,
  type ChromeLiveProvider,
  type ChromeLiveProviderConfig,
} from "@agentproto/adapter-browser-chrome"
import { toAdapterHandle } from "../providers/to-adapter-handle.js"
import type { BrowserAdapterHandle, BrowserAdapterInstance, BrowserAdapterStartOptions } from "../types.js"

/**
 * The kit `chrome-live` provider: a dedicated headful Chrome on its own
 * persisted profile by default (no consent click); attaching to the user's
 * own running Chrome through its remote debugging toggle only happens on an
 * explicit ask (`attachIntent: true`, or a pinned endpoint). `stop` closes
 * only the tabs it opened and its own websocket, never the user's Chrome.
 *
 * This default instance has no `cookieSource` configured — ship it as-is and
 * `chromeProfile`/`domains` on `start_browser` are accepted but have nothing
 * to inject into. A host that wants cookie injection builds its own provider
 * with `createChromeLiveAdapter({ cookieSource })` below instead (this
 * package takes no position on where cookies come from or who may grant
 * them — see `ChromeLiveProviderConfig.cookieSource`'s own doc).
 */
export const chromeLiveProvider: ChromeLiveProvider = chromeLive

const CHROME_LIVE_META = {
  defaultPort: CHROME_LIVE_DEFAULT_PORT,
  // The toggle answers HTTP empty; health goes over the CDP websocket (`instance.health()`).
  healthPath: "/json/version",
  name: "Chrome (your running browser)",
  description:
    "A dedicated headful Chrome on its own persisted profile by default (no consent click). " +
    "Pass attachIntent: true (or pin an endpoint) to attach to your own running Chrome through " +
    "chrome://inspect/#remote-debugging instead. The agent works in its own window and never touches your tabs.",
} as const

/**
 * Pure mapping, exported for testing without touching a real Chrome:
 * `profile: "personal"` is the one explicit ask that maps to `attachIntent`;
 * `"dedicated"` (or unset) leaves it unset so the provider's own default
 * (dedicated-first) decides.
 */
export function chromeLiveLaunchOptionsFrom(opts: BrowserAdapterStartOptions): ChromeLiveLaunchOptions {
  return {
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.profile === "personal" ? { attachIntent: true } : {}),
    ...(opts.chromeProfile !== undefined ? { chromeProfile: opts.chromeProfile } : {}),
    ...(opts.domains !== undefined ? { domains: opts.domains } : {}),
  }
}

async function ensureChromeLive(provider: ChromeLiveProvider, opts: BrowserAdapterStartOptions): Promise<BrowserAdapterInstance> {
  if (opts.location === "cloud") {
    throw new Error("[chrome-live] chrome-live attaches to a Chrome on this machine; it has no cloud location")
  }
  const launchOpts = chromeLiveLaunchOptionsFrom(opts)
  const instance = await provider.launch(launchOpts, opts.log ? { log: opts.log } : {})
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
    navigate: (url, tabId) => instance.navigateOwnedTarget(url, tabId),
    getDom: (tabId) => instance.domOwnedTarget(tabId),
    // Control (click/fill/evaluate/scroll) — pass straight through to the
    // owned-target methods; the kit's option shapes require fields (e.g.
    // `trusted`, `clear`) this facade's own, simpler surface leaves optional.
    click: (options, tabId) =>
      instance.clickOwnedTarget(
        { selector: options.selector, button: options.button ?? "left", clickCount: options.clickCount ?? 1, trusted: true },
        tabId
      ),
    fill: (options, tabId) =>
      instance.fillOwnedTarget({ selector: options.selector, value: options.value, clear: options.clear ?? true }, tabId),
    evaluate: (options, tabId) =>
      instance.evaluateOwnedTarget(
        {
          expression: options.expression,
          awaitPromise: options.awaitPromise ?? true,
          returnByValue: options.returnByValue ?? true,
          maxResultBytes: options.maxResultBytes ?? 64_000,
        },
        tabId
      ),
    scroll: (options, tabId) => instance.scrollOwnedTarget(options, tabId),
    // Upload (CDP DOM.setFileInputFiles onto the agent-owned tab) — the runtime
    // `browser_upload_file` tool looks this name up structurally.
    uploadFileOntoFileInput: (options, tabId) => instance.uploadFileOwnedTarget({ selector: options.selector, paths: options.paths }, tabId),
    openNewTab: (url) => instance.newTabOwnedTarget(url),
    listOwnedTabs: () => instance.listOwnedTabs(),
    stop: () => instance.stop(),
  }
}

export const chromeLiveAdapter: BrowserAdapterHandle = {
  ...toAdapterHandle(chromeLiveProvider, CHROME_LIVE_META),
  ensure: opts => ensureChromeLive(chromeLiveProvider, opts),
}

/**
 * Build a `chrome-live` adapter handle over a CUSTOM provider config — the
 * injection point for a host that wants cookie injection (`cookieSource`) or
 * any other `ChromeLiveProviderConfig` knob without touching the default
 * `chromeLiveAdapter` singleton above. This package supplies no `cookieSource`
 * itself and takes no position on where one would come from (grants, consent,
 * approvals, …) — that is entirely the caller's `config`.
 */
export function createChromeLiveAdapter(config: ChromeLiveProviderConfig = {}): BrowserAdapterHandle {
  const provider = createChromeLiveProvider(config)
  return {
    ...toAdapterHandle(provider, CHROME_LIVE_META),
    ensure: opts => ensureChromeLive(provider, opts),
  }
}
