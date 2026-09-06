/**
 * Reads the agentproto daemon connection settings from the VS Code
 * workspace configuration (`agentproto.*` namespace) and keeps them live
 * via an onDidChangeConfiguration subscription.
 *
 * Frozen source contract (WP0): `getConfig()` returns the resolved config
 * object; later WPs read connection details exclusively through it.
 */

import * as vscode from "vscode"

import { buildAuthHeaders } from "./auth.js"

export { buildAuthHeaders }

export interface DaemonConfig {
  daemonUrl: string
  tokenPath: string
  pollIntervalMs: number
  authHeaders?: Record<string, string>
}

const DEFAULT_RELEASE_CHECK_INTERVAL_MIN = 60
const MIN_RELEASE_CHECK_INTERVAL_MIN = 10

/** `agentproto.releaseCheck.intervalMin` — npm poll TTL for the release
 *  indicator, in minutes. Default ~1 h, floor 10 (never below: a sub-10 min
 *  npm poll would be aggressive noise, per the plan). */
export function getReleaseCheckIntervalMin(): number {
  const v = vscode.workspace.getConfiguration(SECTION).get<number>("releaseCheck.intervalMin")
  if (typeof v === "number" && v >= MIN_RELEASE_CHECK_INTERVAL_MIN) return v
  return DEFAULT_RELEASE_CHECK_INTERVAL_MIN
}

/** Convenience: the same interval in milliseconds. */
export function getReleaseCheckIntervalMs(): number {
  return getReleaseCheckIntervalMin() * 60_000
}

const SECTION = "agentproto"
const DEFAULT_DAEMON_URL = "http://127.0.0.1:18790"

/** Settings that actually require a window reload — every consumer of
 *  DaemonClient/SessionStore holds this config by value from activation
 *  onward (see activate()'s own comment). Deliberately NOT the whole
 *  `agentproto.*` section: holdPermissions/confirmStop/groupByWorkspace are
 *  read fresh on each use (or drive a live tree rebuild), and firing the
 *  "reload the window" banner for those would be actively wrong — most
 *  visibly for groupByWorkspace, whose own toolbar toggle is supposed to
 *  update the tree instantly, not prompt for a reload. */
const RELOAD_REQUIRED_KEYS = ["daemonUrl", "tokenPath", "pollIntervalMs", "authHeaders"] as const

export function getConfig(): DaemonConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const pollIntervalMs = cfg.get<number>("pollIntervalMs")
  return {
    daemonUrl: cfg.get<string>("daemonUrl") || DEFAULT_DAEMON_URL,
    tokenPath: cfg.get<string>("tokenPath") || "",
    pollIntervalMs:
      typeof pollIntervalMs === "number" && pollIntervalMs >= 1000
        ? pollIntervalMs
        : 5000,
    authHeaders: cfg.get<Record<string, string>>("authHeaders") ?? undefined,
  }
}

/**
 * Subscribe to configuration changes. Returns a Disposable that tears down
 * the subscription — register it on the extension context.
 */
export function onDidChangeConfig(
  handler: (config: DaemonConfig) => void,
): vscode.Disposable {
  const sub = vscode.workspace.onDidChangeConfiguration(e => {
    if (RELOAD_REQUIRED_KEYS.some(key => e.affectsConfiguration(`${SECTION}.${key}`))) {
      handler(getConfig())
    }
  })
  return sub
}
