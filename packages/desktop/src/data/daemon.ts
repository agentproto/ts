// Typed wrappers over the Rust daemon commands (src-tauri/src/lib.rs).
// The WebView never touches the network or the token file — it invokes Rust.

import { invoke } from "@tauri-apps/api/core"

import type {
  DaemonHealth,
  GitDiff,
  JsonValue,
  SessionDescriptor,
  SessionEventsPage,
} from "./types"

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:18790"

/** GET /health — public liveness probe. */
export function daemonHealth(daemonUrl = DEFAULT_DAEMON_URL): Promise<DaemonHealth> {
  return invoke<DaemonHealth>("daemon_health", { daemonUrl })
}

/** GET /sessions — the daemon's session rows (Bearer-gated in Rust). */
export function daemonSessions(daemonUrl = DEFAULT_DAEMON_URL): Promise<SessionDescriptor[]> {
  return invoke<SessionDescriptor[]>("daemon_sessions", { daemonUrl })
}

/** GET /sessions/:id/events — a page of the session's durable semantic events.
 *  Returns an empty page for terminal-only sessions (daemon 404 no_transcript). */
export function daemonSessionEvents(
  id: string,
  since = 0,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<SessionEventsPage> {
  return invoke<SessionEventsPage>("daemon_session_events", { daemonUrl, id, since })
}

/** POST /sessions/:id/prompt?wait=false — drive the session with a new message.
 *  Fire-and-forget (wait=false); the transcript poll surfaces the reply. */
export function daemonPrompt(
  sessionId: string,
  text: string,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<JsonValue> {
  return invoke<JsonValue>("daemon_prompt", { daemonUrl, sessionId, text })
}

/** git diff of a session's working tree, parsed into changed files + hunks.
 *  `cwd` is the session's working directory (SessionDescriptor.cwd). */
export function gitDiff(cwd: string): Promise<GitDiff> {
  return invoke<GitDiff>("git_diff", { cwd })
}
