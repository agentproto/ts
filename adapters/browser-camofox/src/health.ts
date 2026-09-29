import { browserLifecycleHealthSchema, type BrowserHealth } from "@agentproto/driver-browser"
import type { CamofoxHealthResponse } from "./client.js"

/** True when the answer looks like a camofox server (any lifecycle state), so a launch must not spawn a second one. */
export function isCamofoxAnswer(res: CamofoxHealthResponse | null): res is CamofoxHealthResponse {
  if (!res) return false
  if (res.status === 200) return true
  return res.status === 503 && (res.body["engine"] === "camoufox" || typeof res.body["browserState"] === "string")
}

/**
 * Map `GET /health` (see the camofox server's BUREAU-API.md) onto the kit's
 * `BrowserHealth`. A 503 is a state, not an error: `crash-looping` and
 * `launching` come back as `ok: false` with `lifecycle.browserState` set, so
 * a supervisor can tell them from an unreachable server.
 */
export function mapCamofoxHealth(res: CamofoxHealthResponse | null, error?: unknown): BrowserHealth {
  if (!res) {
    const why = error instanceof Error ? error.message : "no answer"
    return { ok: false, reason: `unreachable: ${why}` }
  }
  const parsed = browserLifecycleHealthSchema.safeParse(res.body)
  const lifecycle = parsed.success ? parsed.data : undefined
  const withLifecycle = lifecycle ? { lifecycle } : {}
  const state = lifecycle?.browserState

  if (state === "crash-looping") {
    const failures = res.body["consecutiveLaunchFailures"]
    const count = typeof failures === "number" ? ` after ${failures} failed launches` : ""
    return { ok: false, reason: `browser is crash-looping${count}; launches are paused until POST /start`, ...withLifecycle }
  }
  if (res.status === 200 && res.body["ok"] !== false) return { ok: true, ...withLifecycle }
  if (state === "launching") return { ok: false, reason: "browser is launching", ...withLifecycle }
  return { ok: false, reason: `HTTP ${res.status}`, ...withLifecycle }
}
