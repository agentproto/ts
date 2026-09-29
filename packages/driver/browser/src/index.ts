/**
 * @agentproto/driver-browser: browser provider kit.
 *
 * `defineBrowser` (manifest + idempotent launch), the `BrowserInstance` and
 * `BrowserDriver` ports, a provider registry, a provider-kit lister, the
 * typed capability gate (`browser:unsupported`), the supervisor (health loop,
 * crash-loop detector, orphan sweep, keepAlive policy) and the conformance kit.
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

export {
  createBrowserSupervisor,
  systemClock,
  DEFAULT_LAUNCH_BUDGET_MS,
  BROWSER_CRASH_LOOPING_CODE,
  BROWSER_LAUNCH_TIMEOUT_CODE,
  BrowserCrashLoopError,
  BrowserLaunchTimeoutError,
} from "./supervisor/supervisor.js"
export type {
  SupervisorClock,
  SupervisorState,
  SupervisorStatus,
  BackendRestartEvent,
  BrowserSupervisor,
  BrowserSupervisorOptions,
} from "./supervisor/supervisor.js"
export {
  sweepOrphans,
  browserInstanceMarker,
  commandHasMarker,
  psListProcesses,
} from "./supervisor/orphan-sweep.js"
export type {
  ProcessEntry,
  ProcessLister,
  ProcessKiller,
  OrphanSweepOptions,
} from "./supervisor/orphan-sweep.js"
export { KeepAlivePolicy } from "./supervisor/keep-alive.js"
export type { KeepAlivePolicyOptions, IdleShutdownVerdict } from "./supervisor/keep-alive.js"

export { runConformance } from "./conformance/run.js"
export { CONFORMANCE_LEVELS, ConformanceSkip } from "./conformance/types.js"
export type {
  ConformanceLevel,
  ConformanceFixture,
  ConformanceOptions,
  ConformanceContext,
  ConformanceCheck,
  ConformanceCheckResult,
  ConformanceLevelReport,
  ConformanceReport,
} from "./conformance/types.js"
export { createFakeBrowserProvider } from "./conformance/fake-provider.js"
export type {
  FakeBrowserFault,
  FakeBrowserOptions,
  FakeBrowserState,
} from "./conformance/fake-provider.js"
export {
  startFakeRemoteBrowserServer,
  createFakeRemoteBrowserProvider,
} from "./conformance/fake-remote.js"
export type { FakeRemoteBrowserServer } from "./conformance/fake-remote.js"

export {
  BROWSER_PROFILE_REFUSED_CODE,
  BrowserProfileRefusedError,
  isBrowserProfileRefusedError,
  defaultChromeUserDataDirs,
  isDefaultChromeUserDataDir,
  resolveDedicatedProfileDir,
  assertNoOwnedArgs,
  assertSpawnArgsSafe,
  liveProfileLockPid,
} from "./profile.js"
export type {
  BrowserProfileRefusedCause,
  BrowserProfileRefusedReason,
  DefaultDirEnv,
  ResolveDedicatedProfileInput,
} from "./profile.js"

export { browserCookieSchema, cookiesFromSessionPayload } from "./cookies.js"
export type { BrowserCookie, BrowserCookieSource } from "./cookies.js"
