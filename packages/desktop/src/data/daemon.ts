// Typed wrappers over the Rust daemon commands (src-tauri/src/lib.rs).
// The WebView never touches the network or the token file — it invokes Rust.

import { invoke } from "@tauri-apps/api/core"

import type {
  DaemonHealth,
  ExportResult,
  GitDiff,
  JsonValue,
  PendingPermission,
  RespondPermissionInput,
  SessionDescriptor,
  SessionEventsPage,
  SetModelResult,
  SpawnAgentOptions,
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

/** POST /sessions/agent — spawn a new agent session. Bearer-gated in Rust. */
export function daemonSpawn(
  opts: SpawnAgentOptions,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<SessionDescriptor> {
  return invoke<SessionDescriptor>("daemon_spawn", { daemonUrl, opts })
}

/** POST /sessions/:id/kill — end a session. Bearer-gated in Rust. */
export function daemonKill(
  sessionId: string,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<JsonValue> {
  return invoke<JsonValue>("daemon_kill", { daemonUrl, sessionId })
}

/** POST /sessions/:id/interrupt — cancel the in-flight turn, leave the session
 *  alive. Bearer-gated in Rust. */
export function daemonInterrupt(
  sessionId: string,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<JsonValue> {
  return invoke<JsonValue>("daemon_interrupt", { daemonUrl, sessionId })
}

/** POST /sessions/:id/model — switch model on a live session. Bearer-gated.
 *  Non-fatal: a rejected switch resolves `applied:false` + `reason`. */
export function daemonSetModel(
  sessionId: string,
  model: string,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<SetModelResult> {
  return invoke<SetModelResult>("daemon_set_model", { daemonUrl, sessionId, model })
}

/** GET /sessions/:id/export?format=… — export the session transcript.
 *  Bearer-gated. */
export function daemonExportSession(
  sessionId: string,
  format: "markdown" | "json" = "markdown",
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<ExportResult> {
  return invoke<ExportResult>("daemon_export_session", { daemonUrl, sessionId, format })
}

/** DELETE /sessions/:id — delete a session. Bearer-gated. */
export function daemonDeleteSession(
  sessionId: string,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<{ ok: boolean; id: string }> {
  return invoke<{ ok: boolean; id: string }>("daemon_delete_session", { daemonUrl, sessionId })
}

/** GET /permissions[?sessionId=…] — pending permission requests for the given
 *  session (or all sessions when omitted). Bearer-gated in Rust. */
export function daemonPermissions(
  sessionId?: string,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<PendingPermission[]> {
  return invoke<PendingPermission[]>("daemon_permissions", { daemonUrl, sessionId })
}

/** POST /permissions/:id — respond to a pending permission request.
 *  Bearer-gated in Rust. */
export function respondPermission(
  permissionId: string,
  input: RespondPermissionInput,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<JsonValue> {
  return invoke<JsonValue>("daemon_respond_permission", { daemonUrl, permissionId, input })
}
