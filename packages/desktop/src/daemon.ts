// Thin typed wrapper over the Rust daemon commands (src-tauri/src/lib.rs).
// The WebView never touches the network or the token file — it invokes Rust.

import { invoke } from "@tauri-apps/api/core"

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:18790"

/** A trimmed view of the daemon's SessionDescriptor — only the fields this
 *  first screen renders. Mirrors packages/vscode/src/client/types.ts. */
export interface SessionDescriptor {
  id: string
  kind: string
  status: string
  command: string
  workspaceSlug?: string
  title?: string
  label?: string
  adapterSlug?: string
  model?: string
  startedAt?: string
  busy?: boolean
  awaitingInput?: boolean
  awaitingPermission?: boolean
  costUsd?: number
}

export interface DaemonHealth {
  ok?: boolean
  version?: string
  workspace?: string
  [k: string]: unknown
}

export function daemonHealth(daemonUrl = DEFAULT_DAEMON_URL): Promise<DaemonHealth> {
  return invoke<DaemonHealth>("daemon_health", { daemonUrl })
}

export function daemonSessions(daemonUrl = DEFAULT_DAEMON_URL): Promise<SessionDescriptor[]> {
  return invoke<SessionDescriptor[]>("daemon_sessions", { daemonUrl })
}
