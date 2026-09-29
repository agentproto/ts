import { z } from "zod"

/**
 * Capability flags a browser provider declares in its manifest. Two groups:
 *
 *  - page-level flags (`can*`, `isUserVisible`), carried over unchanged from
 *    the studio's `BrowserDriverCapabilities`. Tools branch on these, never
 *    on the provider id.
 *  - process-level flags (`stealth`, `headless`, `cdp`, ...) describing what
 *    the browser process and its endpoints can do.
 *
 * Every flag is optional on input and defaults to "off" (`false`, or
 * `"none"` for `recording`). Unknown keys are rejected so a typo cannot
 * silently declare nothing.
 */
export const browserCapabilitiesSchema = z
  .object({
    // page-level
    canCaptureResponseBodies: z.boolean().default(false),
    canDispatchTrustedInput: z.boolean().default(false),
    canMultiTarget: z.boolean().default(false),
    canThrottleNetwork: z.boolean().default(false),
    isUserVisible: z.boolean().default(false),
    canScreencast: z.boolean().default(false),
    canRecordVideo: z.boolean().default(false),
    canStealth: z.boolean().default(false),
    canFullPageScreenshot: z.boolean().default(false),
    canAiActions: z.boolean().default(false),
    canCookies: z.boolean().default(false),
    // process-level
    stealth: z.boolean().default(false),
    headless: z.boolean().default(false),
    headed: z.boolean().default(false),
    persistentProfile: z.boolean().default(false),
    multiInstance: z.boolean().default(false),
    recording: z.enum(["none", "screencast", "video"]).default("none"),
    cdp: z.boolean().default(false),
    downloads: z.boolean().default(false),
  })
  .strict()

export type BrowserCapabilities = z.infer<typeof browserCapabilitiesSchema>
export type BrowserCapabilitiesInput = z.input<typeof browserCapabilitiesSchema>
export type BrowserCapabilityName = keyof BrowserCapabilities

export const BROWSER_CAPABILITY_NAMES = Object.freeze(
  Object.keys(browserCapabilitiesSchema.shape) as BrowserCapabilityName[],
)

/** The page-level subset a live `BrowserDriver` reports about itself. */
export type BrowserDriverCapabilities = Pick<
  BrowserCapabilities,
  | "canCaptureResponseBodies"
  | "canDispatchTrustedInput"
  | "canMultiTarget"
  | "canThrottleNetwork"
  | "isUserVisible"
  | "canScreencast"
  | "canRecordVideo"
  | "canStealth"
  | "canFullPageScreenshot"
  | "canAiActions"
> &
  Partial<Pick<BrowserCapabilities, "canCookies">>

/** True when the flag is on (`recording` counts as on unless `"none"`). */
export function hasCapability(
  capabilities: Partial<BrowserCapabilities>,
  name: BrowserCapabilityName,
): boolean {
  const value = capabilities[name]
  return name === "recording" ? value !== undefined && value !== "none" : value === true
}
