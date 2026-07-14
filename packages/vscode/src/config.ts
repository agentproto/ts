/**
 * Reads the agentproto daemon connection settings from the VS Code
 * workspace configuration (`agentproto.*` namespace) and keeps them live
 * via an onDidChangeConfiguration subscription.
 *
 * Frozen source contract (WP0): `getConfig()` returns the resolved config
 * object; later WPs read connection details exclusively through it.
 */

import * as vscode from "vscode"

export interface DaemonConfig {
  daemonUrl: string
  tokenPath: string
  pollIntervalMs: number
}

const SECTION = "agentproto"
const DEFAULT_DAEMON_URL = "http://127.0.0.1:18790"

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
    if (e.affectsConfiguration(SECTION)) {
      handler(getConfig())
    }
  })
  return sub
}
