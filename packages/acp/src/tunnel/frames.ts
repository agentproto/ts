/**
 * Tunnel frame protocol — agentproto/tunnel/v1.
 *
 * Bidirectional, event-shaped frames over a single duplex transport
 * (typically a WebSocket). Each frame is one JSON object per message.
 * The protocol is deliberately NOT JSON-RPC: process I/O is a
 * continuous event stream, not a request/response pattern, so we drop
 * the `id` / response correlation and let the underlying child-process
 * lifecycle drive everything.
 *
 * # Roles
 *
 *   host    — the orchestrator (e.g. Guilde API). Sends `spawn`,
 *             `stdin`, `kill`, `resize`. Receives `stdout`, `stderr`,
 *             `exit`, `error`. Holds the ACP client; sees the duplex
 *             stream as a `ChildProcess`-shaped duck.
 *
 *   daemon  — the local executor (e.g. `agentproto serve` on a user's
 *             laptop). Receives spawn-side frames; spawns real
 *             subprocesses; relays I/O back. Owns the actual file
 *             system, environment, network egress.
 *
 * # Identifiers
 *
 *   execId  — host-chosen UUID per spawned process. Lets one tunnel
 *             multiplex many concurrent agent CLIs (one daemon serving
 *             several conversations).
 *
 * # Encoding
 *
 *   - Each WS message is one JSON object. Binary frames are not used;
 *     stdout/stdin payloads are base64-encoded utf-safe strings.
 *   - Why base64 and not raw text: claude-code & friends emit JSON-RPC
 *     ACP traffic over stdio. A child can also emit non-utf8 bytes
 *     (debug logs, terminal control codes when in TTY mode). Base64
 *     keeps the wire JSON-clean and bytewise-faithful.
 *   - All frames carry `t` (type) and a per-type payload. Versioning
 *     is per-tunnel via `hello.version`, not per-frame.
 *
 * # Lifecycle
 *
 *   1. Daemon connects to host's WS endpoint with bearer token.
 *   2. Daemon sends `hello { version, capabilities, label? }`.
 *   3. Host sends `spawn` for each child it wants on this daemon.
 *   4. Daemon spawns, replies with `spawned { execId, pid }` (or
 *      `error { execId, message }`).
 *   5. stdout/stderr/exit notifications flow daemon→host;
 *      stdin/resize/kill flow host→daemon.
 *   6. Either side can send `ping`; receiver MUST `pong` back. Used
 *      to detect half-open connections.
 *   7. On disconnect, daemon SHOULD kill all children associated with
 *      this tunnel (host can re-spawn after reconnect).
 */

export const TUNNEL_VERSION = "agentproto/tunnel/v1" as const

// ─── host → daemon ──────────────────────────────────────────────

export interface SpawnFrame {
  t: "spawn"
  execId: string
  command: string
  args: readonly string[]
  /**
   * Working directory on the daemon side. Daemon SHOULD reject
   * absolute paths that escape its declared `--root` (see
   * `agentproto serve --root`); host MUST pass paths that exist
   * on the daemon.
   */
  cwd?: string
  /**
   * Environment overrides. Daemon merges these atop its own
   * process.env. Daemon MAY redact values from logs but MUST forward
   * them verbatim into the child.
   */
  env?: Readonly<Record<string, string>>
  /**
   * When true, the daemon allocates a PTY instead of plain pipes.
   * Required for binaries that detect `isTTY` (REPLs, claude
   * interactive). When false (default), stdin/stdout/stderr are
   * separate pipes — the right choice for ACP wrappers that speak
   * line-delimited JSON-RPC.
   */
  pty?: boolean
  /** Initial PTY column width. Ignored when `pty` is false. Default 80. */
  cols?: number
  /** Initial PTY row height. Ignored when `pty` is false. Default 24. */
  rows?: number
}

export interface StdinFrame {
  t: "stdin"
  execId: string
  /** Base64-encoded payload bytes. Empty string is a no-op. */
  data: string
}

export interface KillFrame {
  t: "kill"
  execId: string
  /** Default "SIGTERM". POSIX names; Windows daemons translate. */
  signal?: string
}

export interface ResizeFrame {
  t: "resize"
  execId: string
  cols: number
  rows: number
}

/**
 * Generic HTTP-over-tunnel request (HOST → DAEMON). Lets the host
 * proxy arbitrary HTTP traffic (MCP JSON-RPC today, anything tomorrow)
 * through the daemon's local network stack without exposing a public
 * URL. The daemon forwards to its configured "http upstream" (default:
 * its own gateway on `127.0.0.1:<port>`) and replies with an
 * `HttpResponseFrame` carrying the same `reqId`.
 */
export interface HttpRequestFrame {
  t: "http_request"
  /** Correlates the response. Host-chosen, MUST be unique per inflight request. */
  reqId: string
  /** HTTP method (GET / POST / PUT / DELETE / PATCH / OPTIONS). */
  method: string
  /** Path + querystring, e.g. `/mcp` or `/mcp?session=abc`.
   *  Daemon prepends its upstream base. Absolute URLs are rejected. */
  path: string
  /** Forwarded request headers. Hop-by-hop headers (Connection,
   *  Keep-Alive, Transfer-Encoding, Upgrade, Proxy-*) MUST be stripped
   *  before forwarding; daemon SHOULD also drop them defensively. */
  headers?: Readonly<Record<string, string>>
  /** Base64-encoded request body. Omitted when no body. */
  body?: string
  /** Per-request timeout in ms. Daemon SHOULD enforce + reply with
   *  `error: { code: "timeout" }` when exceeded. Default 30_000. */
  timeoutMs?: number
}

/**
 * Generic HTTP-over-tunnel response (DAEMON → HOST). Mirrors
 * `HttpRequestFrame` — see its docs.
 */
export interface HttpResponseFrame {
  t: "http_response"
  reqId: string
  /** HTTP status code (e.g. 200, 404, 500). Set even on transport
   *  failure (then `error` is also set and status SHOULD be 502/504). */
  status: number
  headers?: Readonly<Record<string, string>>
  /** Base64-encoded response body. */
  body?: string
  /** Set when the daemon failed to complete the upstream call. */
  error?: Readonly<{
    code: string
    message: string
  }>
}

// ─── daemon → host ──────────────────────────────────────────────

export interface HelloFrame {
  t: "hello"
  version: typeof TUNNEL_VERSION
  /**
   * Daemon-declared capabilities. Hosts MAY refuse to dispatch
   * features the daemon hasn't claimed.
   */
  capabilities: Readonly<{
    pty: boolean
    /** Future: file-transfer, port-forward, etc. */
  }>
  /** User-friendly daemon label, surfaced in host UIs. */
  label?: string
  /** Daemon process info — diagnostics only, not authoritative. */
  daemon?: Readonly<{
    name: string
    version: string
    platform: string
    nodeVersion?: string
  }>
}

export interface SpawnedFrame {
  t: "spawned"
  execId: string
  pid: number
}

export interface StdoutFrame {
  t: "stdout"
  execId: string
  /** Base64-encoded payload bytes. */
  data: string
}

export interface StderrFrame {
  t: "stderr"
  execId: string
  /** Base64-encoded payload bytes. */
  data: string
}

export interface ExitFrame {
  t: "exit"
  execId: string
  /** Null when killed by signal. */
  code: number | null
  /** POSIX signal name when killed by signal; null otherwise. */
  signal: string | null
}

// ─── either direction ───────────────────────────────────────────

export interface ErrorFrame {
  t: "error"
  /** Omitted for tunnel-level errors not tied to a specific exec. */
  execId?: string
  /** Stable machine-readable code, e.g. "spawn_failed", "unknown_exec". */
  code: string
  /** Human-readable diagnostic. */
  message: string
}

export interface PingFrame {
  t: "ping"
  /** Echoed verbatim in the matching pong. */
  nonce: string
}

export interface PongFrame {
  t: "pong"
  nonce: string
}

/**
 * HOST → DAEMON. Graceful drain signal sent during host rollover (e.g.
 * Kubernetes preStop). On receipt the daemon SHOULD:
 *   1. Stop accepting new in-flight work where it can.
 *   2. Close the WS cleanly (does not need to wait — host will follow
 *      up with a `close(1012, "service_restart")` ~2 s later as a
 *      hard backstop).
 *   3. Reconnect IMMEDIATELY without the usual exponential backoff —
 *      the host is mid-deploy, the new replica is already listening.
 *
 * Backward-compatible: daemons that don't know the frame just ignore
 * it (parseFrame returns null for unknown types). The host's close
 * then triggers the daemon's normal backoff loop — worst case ~30 s
 * reconnect gap instead of ~2 s with the handler.
 */
export interface ReconnectSoonFrame {
  t: "reconnect_soon"
  /** Hint of how long the host plans to wait before forcing close.
   *  Optional — daemons MAY use it to decide whether to finish
   *  in-flight work or close immediately. */
  reasonMs?: number
}

// ─── union + guards ─────────────────────────────────────────────

export type HostToDaemonFrame =
  | SpawnFrame
  | StdinFrame
  | KillFrame
  | ResizeFrame
  | HttpRequestFrame
  | PingFrame
  | PongFrame
  | ErrorFrame
  | ReconnectSoonFrame

export type DaemonToHostFrame =
  | HelloFrame
  | SpawnedFrame
  | StdoutFrame
  | StderrFrame
  | ExitFrame
  | HttpResponseFrame
  | PingFrame
  | PongFrame
  | ErrorFrame

export type TunnelFrame = HostToDaemonFrame | DaemonToHostFrame

const KNOWN_TYPES = new Set<TunnelFrame["t"]>([
  "spawn",
  "stdin",
  "kill",
  "resize",
  "http_request",
  "http_response",
  "ping",
  "pong",
  "error",
  "hello",
  "spawned",
  "stdout",
  "stderr",
  "exit",
  "reconnect_soon",
])

/**
 * Parse a raw WS message into a `TunnelFrame`. Returns null when the
 * payload isn't a valid frame — callers MUST handle null defensively
 * (typically: send an `error` frame and ignore). We don't throw so
 * one bad frame can't tear down the tunnel.
 */
export function parseFrame(raw: string): TunnelFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("t" in parsed) ||
    typeof (parsed as { t: unknown }).t !== "string"
  ) {
    return null
  }
  const t = (parsed as { t: string }).t
  if (!KNOWN_TYPES.has(t as TunnelFrame["t"])) return null
  return parsed as TunnelFrame
}

export function encodeFrame(frame: TunnelFrame): string {
  return JSON.stringify(frame)
}

/**
 * Encode raw bytes for an `stdin` / `stdout` / `stderr` frame's `data`
 * field. Centralised so both sides agree on the encoding.
 */
export function encodeData(bytes: Uint8Array | string): string {
  const buf =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes)
  return buf.toString("base64")
}

export function decodeData(data: string): Buffer {
  return Buffer.from(data, "base64")
}
