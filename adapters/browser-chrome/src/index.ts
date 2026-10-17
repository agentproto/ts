/**
 * @agentproto/adapter-browser-chrome: the system Chrome provider.
 *
 * F11: never the user's default Chrome profile. Chrome 136+ refuses
 * --remote-debugging-port there, so every launch gets a fresh dedicated
 * user-data-dir and granted cookies are injected; a default-profile or
 * full-profile request is refused with `browser:profile-refused`. See the README.
 *
 * `chrome-live` is a separate provider: a dedicated headful Chrome on its own
 * persisted profile dir (never the user's default profile) by default — no
 * attach attempt, no consent wait. Attaching to the user's own running Chrome
 * through its remote debugging toggle only happens on an explicit ask (a
 * pinned endpoint, or `attachIntent`), and only ever drives tabs it opened in
 * its own window. `stop()` kills only the child this provider itself
 * launched.
 */

export { chrome, createChromeProvider } from "./provider.js"
export type { ChromeLaunchOptions, ChromeProvider, ChromeProviderConfig } from "./provider.js"

export { attachChromeDriver, chromeDriverCapabilities, ChromeCdpDriver, CHROME_PROVIDER_ID, toCdpCookieParams } from "./driver.js"

export {
  BROWSER_CONSENT_TIMEOUT_CODE,
  BROWSER_DISCONNECTED_CODE,
  BROWSER_REMOTE_DEBUGGING_OFF_CODE,
  CHROME_LIVE_DEFAULT_CONSENT_TIMEOUT_MS,
  CHROME_LIVE_DEFAULT_PORT,
  CHROME_LIVE_PORT_ENV,
  CHROME_LIVE_PROVIDER_ID,
  CHROME_LIVE_WS_URL_ENV,
  CHROME_REMOTE_DEBUGGING_PAGE,
  ChromeConsentTimeoutError,
  ChromeDisconnectedError,
  ChromeLiveDriver,
  ChromeRemoteDebuggingOffError,
  chromeLive,
  chromeLiveDriverCapabilities,
  chromeLiveEnvSchema,
  chromeLiveWsUrl,
  createChromeLiveProvider,
  isRefusedLiveCommand,
  pinnedEndpoint,
  readChromeLiveEnv,
  wantsAttachFirst,
} from "./live.js"
export type { ChromeLiveInstance, ChromeLiveLaunchOptions, ChromeLiveProvider, ChromeLiveProviderConfig } from "./live.js"

export { CdpConnection } from "./cdp.js"
export type { CdpEnvelope, CdpEnvelopeListener } from "./cdp.js"

export { CHROME_ENV_VAR, chromeCandidates, resolveChrome } from "./resolve.js"
export type { ResolveChromeInput } from "./resolve.js"

export { buildChromeArgs, defaultDataDir, parseDevToolsActivePort } from "./launch.js"
export type { ChromeProcess, SpawnChrome } from "./launch.js"

export {
  CHROME_LIVE_LAUNCH_DEFAULT_TIMEOUT_MS,
  CHROME_LIVE_LAUNCH_DIR_ENV,
  CHROME_LIVE_LAUNCH_PROFILE,
  findFreePort,
  launchDetachedChrome,
  liveLaunchDataDir,
} from "./live-launch.js"
export type { JsonVersion, LaunchedChrome, LiveLaunchDeps } from "./live-launch.js"
