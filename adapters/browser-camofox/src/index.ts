/**
 * @agentproto/adapter-browser-camofox: the camofox browser provider.
 *
 * Server: bureau-sh/camofox-browser (a fork of jo-inc/camofox-browser, MIT,
 * Jo, Inc). See the README.
 */

export { camofox, createCamofoxProvider } from "./provider.js"
export type { CamofoxLaunchOptions, CamofoxProvider, CamofoxProviderConfig } from "./provider.js"

export {
  createCamofoxRestClient,
  CamofoxHttpError,
  camofoxCookieSchema,
  normalizeBaseUrl,
  DEFAULT_CAMOFOX_URL,
} from "./client.js"
export type {
  CamofoxClient,
  CamofoxRestClient,
  CamofoxRestClientConfig,
  CamofoxCookie,
  CamofoxHealthResponse,
  CamofoxNavigateOptions,
  CamofoxScreenshotOptions,
  CamofoxScriptResult,
  CamofoxTab,
  CamofoxTypeOptions,
} from "./client.js"

export {
  attachCamofoxDriver,
  camofoxDriverCapabilities,
  CamofoxBrowserDriver,
  CAMOFOX_PROVIDER_ID,
} from "./driver.js"
export type { AttachCamofoxDriverOptions } from "./driver.js"

export { mapCamofoxHealth, isCamofoxAnswer } from "./health.js"

export {
  resolveCamofoxLaunchCommand,
  DEFAULT_CAMOFOX_PORT,
  DEFAULT_LAUNCHD_LABEL,
} from "./launch.js"
export type { LaunchCommand, SpawnFn, SpawnedProcess, SpawnOptions } from "./launch.js"

export {
  BLOCKED_PAGE_EXPRESSION,
  actionSettleMs,
  navDwellMs,
  typingOptions,
} from "./behavior.js"
