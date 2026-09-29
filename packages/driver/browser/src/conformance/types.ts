import type { BrowserCapabilityName } from "../capabilities.js"
import type { BrowserDriver } from "../driver.js"
import type {
  BrowserHostContext,
  BrowserInstance,
  BrowserLaunchOptions,
  BrowserProvider,
} from "../provider.js"

export const CONFORMANCE_LEVELS = [
  "core",
  "interaction",
  "network",
  "download",
  "profile",
] as const
export type ConformanceLevel = (typeof CONFORMANCE_LEVELS)[number]

/** A page the provider can load, so DOM-touching checks have something real to drive. */
export interface ConformanceFixture {
  /** Navigation target for `navigate`, and the `initialUrl` of the driver each level attaches. Default `about:blank`. */
  url?: string
  /** With `buttonSelector`, enables the click/fill check. */
  inputSelector?: string
  buttonSelector?: string
}

export interface ConformanceOptions {
  /** Default: every level. */
  levels?: readonly ConformanceLevel[]
  /** Passed to every launch (`baseUrl` for a remote provider). `label` and `profile` are set by the runner. */
  launch?: BrowserLaunchOptions
  hostContext?: BrowserHostContext
  fixture?: ConformanceFixture
  /** Per-check timeout. Default 15 000 ms. */
  checkTimeoutMs?: number
  /** Provider-specific checks appended to a level. */
  extraChecks?: readonly ConformanceCheck[]
}

export interface ConformanceContext {
  provider: BrowserProvider
  instance: BrowserInstance
  driver: BrowserDriver
  fixture: ConformanceFixture
  /** Launch another instance under `label`; it is stopped when the level ends. */
  launch(label: string, extra?: BrowserLaunchOptions): Promise<BrowserInstance>
}

export interface ConformanceCheck {
  level: ConformanceLevel
  name: string
  run(ctx: ConformanceContext): Promise<void>
}

/** Thrown by a check that cannot apply here; recorded as a skip, not a failure. */
export class ConformanceSkip extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "ConformanceSkip"
  }
}

export interface ConformanceCheckResult {
  level: ConformanceLevel
  name: string
  status: "pass" | "fail" | "skip"
  durationMs: number
  /** Failure message or skip reason. */
  message?: string
  /** Set when a skip came from the typed `browser:unsupported`. */
  unsupportedCapability?: BrowserCapabilityName
}

export interface ConformanceLevelReport {
  level: ConformanceLevel
  status: "pass" | "fail" | "skipped"
  checks: ConformanceCheckResult[]
  /** Why the whole level was skipped. */
  skipReason?: string
  unsupportedCapability?: BrowserCapabilityName
}

export interface ConformanceReport {
  providerId: string
  location: "local" | "remote"
  ok: boolean
  levels: ConformanceLevelReport[]
  /** `level/check` names of every failed check. */
  failed: string[]
}
