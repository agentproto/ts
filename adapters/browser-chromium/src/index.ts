/**
 * @agentproto/adapter-browser-chromium: the chromium browser provider.
 *
 * F11: never the user's default Chrome profile. Every launch gets a fresh
 * dedicated user-data-dir; a default-profile or full-profile request is refused
 * with `browser:profile-refused`. See the README.
 */

export { chromium, createChromiumProvider } from "./provider.js"
export type { ChromiumLaunchOptions, ChromiumProvider, ChromiumProviderConfig } from "./provider.js"

export {
  attachChromiumDriver,
  chromiumDriverCapabilities,
  ChromiumBrowserDriver,
  CHROMIUM_PROVIDER_ID,
  toPlaywrightCookies,
} from "./driver.js"
export type { ScreencastFrame } from "./driver.js"

export { defaultDataDir, INSTALL_HINT, parseDevToolsActivePort } from "./launch.js"
export type { PlaywrightChromium, PlaywrightLoader } from "./launch.js"
