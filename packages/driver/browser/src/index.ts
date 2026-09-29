/**
 * @agentproto/driver-browser: browser provider kit.
 *
 * `defineBrowser` (manifest + idempotent launch), the `BrowserInstance` and
 * `BrowserDriver` ports, a provider registry, a provider-kit lister and the
 * typed capability gate (`browser:unsupported`).
 */

export { defineBrowser } from "./define-browser.js"
export { createBrowserRegistry } from "./registry.js"
export type { BrowserRegistry } from "./registry.js"
export { makeBrowserProviderLister } from "./lister.js"
export type { BrowserProviderInfo } from "./lister.js"

export {
  browserCapabilitiesSchema,
  BROWSER_CAPABILITY_NAMES,
  hasCapability,
} from "./capabilities.js"
export type {
  BrowserCapabilities,
  BrowserCapabilitiesInput,
  BrowserCapabilityName,
  BrowserDriverCapabilities,
} from "./capabilities.js"

export {
  BROWSER_UNSUPPORTED_CODE,
  BROWSER_TOOL_GATES,
  BrowserUnsupportedError,
  isBrowserUnsupportedError,
  assertCapability,
  assertToolSupported,
} from "./errors.js"
export type { BrowserUnsupportedCause } from "./errors.js"

export {
  browserTransportSchema,
  browserLocationSchema,
  browserInstallSchema,
  browserRequiresSchema,
  browserOptionSchema,
  browserConfigStepSchema,
  browserManifestSchema,
  browserLaunchOptionsSchema,
  browserStateSchema,
  browserLifecycleHealthSchema,
  browserHealthSchema,
  browserEndpointsSchema,
  browserInstanceInfoSchema,
} from "./provider.js"
export type {
  BrowserTransport,
  BrowserLocation,
  BrowserInstall,
  BrowserRequires,
  BrowserOption,
  BrowserConfigStep,
  BrowserManifest,
  BrowserManifestInput,
  BrowserLaunchOptions,
  BrowserHostContext,
  BrowserState,
  BrowserLifecycleHealth,
  BrowserHealth,
  BrowserEndpoints,
  BrowserInstanceInfo,
  BrowserInstance,
  BrowserProvider,
  BrowserDefinition,
} from "./provider.js"

export {
  browserTargetSchema,
  networkRequestSummarySchema,
  navigateOptionsSchema,
  evaluateOptionsSchema,
  evaluateResultSchema,
  clickOptionsSchema,
  fillOptionsSchema,
  screenshotOptionsSchema,
  screenshotResultSchema,
  screenshotFileResultSchema,
  screenshotSegmentsResultSchema,
  behaviorProfileSchema,
  browserAttachOptionsSchema,
  BROWSER_DRIVER_SCOPES,
} from "./driver.js"
export type {
  BrowserDriver,
  BrowserTarget,
  BrowserAttachOptions,
  BehaviorProfile,
  CDPCommand,
  CDPEvent,
  CDPEventListener,
  CDPTargetInfo,
  CDPGetTargetsResult,
  Unsubscribe,
  NetworkRequestSummary,
  NavigateOptions,
  EvaluateOptions,
  EvaluateResult,
  ClickOptions,
  FillOptions,
  ScreenshotOptions,
  ScreenshotResult,
  ScreenshotFileResult,
  ScreenshotSegmentsResult,
} from "./driver.js"
