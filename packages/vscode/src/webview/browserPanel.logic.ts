/**
 * Pure message-shaping for the browser live-view panel (browserPanel.ts) —
 * kept out of the panel so it's unit-testable without a real webview host.
 */

export interface BrowserScreenshotResult {
  data: string
  format: string
  width?: number
  height?: number
}

export interface BrowserFrameMessage {
  type: "frame"
  dataUrl: string
  width?: number
  height?: number
  at: number
}

/** Build the host→webview frame message from a raw `browser_screenshot` result. */
export function frameMessage(result: BrowserScreenshotResult, at: number): BrowserFrameMessage {
  return {
    type: "frame",
    dataUrl: `data:image/${result.format};base64,${result.data}`,
    ...(result.width !== undefined ? { width: result.width } : {}),
    ...(result.height !== undefined ? { height: result.height } : {}),
    at,
  }
}

/**
 * Poll cadence: 2s steady-state, backing off to 5s after 3 consecutive
 * failures (a struggling backend shouldn't be hammered every 2s) — reset to
 * 2s the moment a frame succeeds.
 */
export function nextPollDelayMs(consecutiveFailures: number): number {
  return consecutiveFailures >= 3 ? 5000 : 2000
}
