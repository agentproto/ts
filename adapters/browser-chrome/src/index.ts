/**
 * @agentproto/adapter-browser-chrome: the system Chrome provider.
 *
 * F11: never the user's default Chrome profile. Chrome 136+ refuses
 * --remote-debugging-port there, so every launch gets a fresh dedicated
 * user-data-dir and granted cookies are injected; a default-profile or
 * full-profile request is refused with `browser:profile-refused`. See the README.
 */

export { chrome, createChromeProvider } from "./provider.js"
export type { ChromeLaunchOptions, ChromeProvider, ChromeProviderConfig } from "./provider.js"

export { attachChromeDriver, chromeDriverCapabilities, ChromeCdpDriver, CHROME_PROVIDER_ID, toCdpCookieParams } from "./driver.js"

export { CdpConnection } from "./cdp.js"
export type { CdpEnvelope, CdpEnvelopeListener } from "./cdp.js"

export { CHROME_ENV_VAR, chromeCandidates, resolveChrome } from "./resolve.js"
export type { ResolveChromeInput } from "./resolve.js"

export { buildChromeArgs, defaultDataDir, parseDevToolsActivePort } from "./launch.js"
export type { ChromeProcess, SpawnChrome } from "./launch.js"
