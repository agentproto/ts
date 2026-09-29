import type { BrowserLaunchOptions } from "@agentproto/driver-browser"

/**
 * The kit's launch options plus the knobs the legacy `BrowserAdapterStartOptions`
 * carried. Every built-in provider behind the facade accepts these.
 */
export interface FacadeLaunchOptions extends BrowserLaunchOptions {
  /** Shell command that starts the service; beats the `*_SERVE_CMD` env vars. */
  launchCmd?: string
  /** Override the executable of the resolved launch command. */
  binPath?: string
  /** Wait only this long for a fresh spawn, then return unhealthy while it keeps booting. */
  initialWaitMs?: number
  /** `cloud`: never spawn; `baseUrl` must already answer. */
  location?: "local" | "cloud"
  /** Bureau only: the camofox port it depends on. */
  camofoxPort?: number
}
