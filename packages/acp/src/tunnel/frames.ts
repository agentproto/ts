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
 *
 * Two-frame protocol:
 *   - SHORT RESPONSES (most HTTP): daemon emits a single `http_response`
 *     with body inline. The buffered `forwardHttp` resolves directly
 *     from this frame.
 *   - STREAMED RESPONSES (text/event-stream, long-lived chunked
 *     transfers, large downloads): daemon emits `http_response_head`
 *     first with status+headers, then one or more `http_response_chunk`
 *     frames, the last of which has `end: true`. The streaming
 *     `forwardHttpStream` builds a `ReadableStream` from the chunks.
 *
 * Hosts that only support the legacy buffered API can detect the
 * stream protocol by looking for `http_response_head` and either
 * pull the chunks into a buffer (compat) or refuse to handle.
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

/**
 * Streaming HTTP response head (DAEMON → HOST). Sent ONCE per
 * streaming response, before any chunk frames. Carries status +
 * headers so the host can finalize the response shape (e.g. write
 * Content-Type) before any body bytes arrive.
 */
export interface HttpResponseHeadFrame {
  t: "http_response_head"
  reqId: string
  status: number
  headers?: Readonly<Record<string, string>>
}

/**
 * Streaming HTTP response body chunk (DAEMON → HOST). Each chunk
 * carries some bytes of the response body. The terminal chunk has
 * `end: true` and MAY include final bytes. An immediate `end: true`
 * with no data signals empty-body close.
 *
 * `error` set on a chunk frame indicates the daemon's upstream
 * failed mid-stream; host SHOULD propagate it as a stream error.
 */
export interface HttpResponseChunkFrame {
  t: "http_response_chunk"
  reqId: string
  /** Base64-encoded chunk bytes. Omitted on pure end-of-stream
   *  markers (those carry `end: true` only). */
  data?: string
  /** Set on the last chunk. After this frame the host SHOULD ignore
   *  any further frames for this reqId. */
  end?: boolean
  /** Set when the upstream failed mid-stream. Host surfaces this as
   *  a stream error and closes the readable. */
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
    /** Daemon can bridge browser-WS upgrades to its local upstream via
     *  `ws_open` / `ws_message` / `ws_close`. Hosts MUST gate
     *  `forwardWebSocket()` on this — older daemons ignore the frames. */
    wsForward?: boolean
    /**
     * Identifiers of the capabilities the daemon serves — its registered
     * agent adapters / tool surfaces. Lets a host that fronts several
     * daemons enumerate and route by what each one can do, without a
     * round-trip. Omitted by older daemons (host treats as "unknown",
     * not "none"). Advisory: the authoritative surface is still the
     * daemon's live `tools/list` over the HTTP relay.
     */
    tools?: ReadonlyArray<string>
    /**
     * Set when this daemon's tunnel channel is E2E-encrypted (design:
     * tunnel-e2e/v1). Informational confirmation only — this `hello` is
     * itself carried INSIDE the already-established encrypted channel (the
     * `wrapE2E` box), so a host that decrypts it has, by definition, already
     * completed the token-authenticated handshake. The negotiation that turns
     * a channel encrypted happens BEFORE this frame, over `e2e_handshake`
     * frames on the raw sink — not by advertising a capability here. A host
     * may surface this flag in its UI ("this daemon is end-to-end encrypted").
     * Absent ⇒ plaintext tunnel (today's behaviour). See ./tunnel-e2e.ts.
     */
    e2e?: boolean
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

// ─── WebSocket forwarding ───────────────────────────────────────
//
// Mirrors the HTTP-forwarding shape but for full-duplex upgrades.
// The daemon opens a WS connection to its local upstream (typically
// `ws://127.0.0.1:<port>${path}`), then proxies frames in both
// directions. Each open is correlated by `reqId`.
//
// Capabilities: daemons MUST set `hello.capabilities.wsForward = true`
// to opt in. Hosts that don't see it MUST NOT send `ws_open`. Older
// daemons silently ignore unknown frames, so misrouted `ws_open` on a
// non-capable daemon is benign (the host's open will time out).

/**
 * HOST → DAEMON. Open a WS connection to the daemon's upstream.
 * Path semantics match `HttpRequestFrame` — absolute URLs rejected,
 * daemon prepends its `ws://<upstream>` base. Headers forwarded as-is
 * (cookies are typically NOT forwarded since the daemon's upstream is
 * loopback; cookie passthrough is opt-in via daemon config).
 */
export interface WsOpenFrame {
  t: "ws_open"
  /** Correlates every WS frame in both directions for this connection. */
  reqId: string
  /** Path + querystring on the daemon-local upstream, e.g.
   *  `/sessions/abc/pty?cols=80&rows=24`. */
  path: string
  /** Optional registered upstream to dial instead of the daemon's
   *  default gateway — a NAME the daemon resolves to a base URL (never
   *  a URL itself, so the host can't point the daemon at an arbitrary
   *  origin). Used to reach an imported local service (e.g. a browser
   *  capability server) by alias. Absent ⇒ the daemon's own gateway. */
  upstream?: string
  /** Headers to set on the upstream WS request. Hop-by-hop headers
   *  (Connection, Upgrade, Sec-WebSocket-*) MUST be stripped — the
   *  daemon's `ws` client manages those. */
  headers?: Readonly<Record<string, string>>
  /** Subprotocols requested by the browser; forwarded to upstream. */
  protocols?: readonly string[]
}

/**
 * DAEMON → HOST. Result of a `ws_open`. On success the upstream WS is
 * connected and frames can flow. On failure `error` is set; no further
 * frames for this `reqId` will arrive.
 */
export interface WsOpenAckFrame {
  t: "ws_open_ack"
  reqId: string
  /** HTTP status from the upstream upgrade. 101 on success; 4xx/5xx
   *  when the upstream refused the upgrade. */
  status: number
  /** Selected subprotocol, if any. */
  protocol?: string
  /** Set when the daemon couldn't open the upstream (DNS failure,
   *  refused, timeout). Distinct from a clean upstream-side close,
   *  which arrives as `ws_close`. */
  error?: Readonly<{
    code: string
    message: string
  }>
}

/**
 * Either direction. One application-level WS frame's payload. Text
 * frames carry UTF-8 bytes (`binary: false`); binary frames carry
 * arbitrary bytes (`binary: true`). The `data` field is base64-encoded
 * either way so the transport stays JSON.
 */
export interface WsMessageFrame {
  t: "ws_message"
  reqId: string
  /** Base64-encoded WS frame payload. */
  data: string
  /** True for binary frames; false (or omitted) for text. */
  binary?: boolean
}

/**
 * Either direction. Close the bridged WS connection. Includes the
 * close code (1000 normal, 1006 abnormal, etc.) and optional reason.
 * After sending or receiving this frame, neither side will send
 * further frames for `reqId`.
 */
export interface WsCloseFrame {
  t: "ws_close"
  reqId: string
  /** WebSocket close code. */
  code: number
  reason?: string
}

// ─── E2E pairing envelopes ──────────────────────────────────────
//
// When a tunnel runs over an end-to-end pairing (design: DESIGN §5), the
// real tunnel/v1 frames above are AEAD-encrypted and carried inside these
// two envelope frames — the rendezvous relaying the bytes sees only opaque
// ciphertext. `wrapE2E` in ./e2e.ts produces and consumes them; the tunnel
// client/server never see them, they only ever see decrypted inner frames.
//
// These are added to the frame union (and KNOWN_TYPES) so the transport
// adapter — which drops any frame `parseFrame` doesn't recognise — forwards
// them intact to the E2E layer. A tunnel peer that is NOT E2E-wrapped will
// parse them (they're known types) but has no handler for them, so it ignores
// them cleanly rather than misinterpreting the bytes as a real frame. The
// wrapped side is the strict one: it rejects any inbound frame that is not an
// `e2e` envelope (see `wrapE2E`), which is what prevents a downgrade to
// plaintext.

/**
 * Either direction. One AEAD-encrypted inner tunnel frame. `n` is the
 * sender's per-direction, strictly-monotonic frame counter — it is the basis
 * of the GCM nonce and lets the receiver detect replay (a repeated/older `n`),
 * reorder, or drops (a gap in `n`). `d` is base64(ciphertext ‖ 16-byte GCM
 * tag). The plaintext, once decrypted, is itself an `encodeFrame`'d
 * `TunnelFrame`.
 */
export interface E2eFrame {
  t: "e2e"
  n: number
  d: string
}

/**
 * Either direction. An opaque handshake message exchanged BEFORE the channel
 * is wrapped. `d` is base64 of a transport-agnostic handshake message (the
 * `pair/v1` hello or reply, produced by `@agentproto/secrets/pairing`). The
 * E2E layer here treats it as opaque bytes handed to an injected driver, so
 * this package never depends on the crypto package.
 */
export interface E2eHandshakeFrame {
  t: "e2e_handshake"
  d: string
}

// ─── union + guards ─────────────────────────────────────────────

export type HostToDaemonFrame =
  | SpawnFrame
  | StdinFrame
  | KillFrame
  | ResizeFrame
  | HttpRequestFrame
  | WsOpenFrame
  | WsMessageFrame
  | WsCloseFrame
  | PingFrame
  | PongFrame
  | ErrorFrame
  | ReconnectSoonFrame
  | E2eFrame
  | E2eHandshakeFrame

export type DaemonToHostFrame =
  | HelloFrame
  | SpawnedFrame
  | StdoutFrame
  | StderrFrame
  | ExitFrame
  | HttpResponseFrame
  | HttpResponseHeadFrame
  | HttpResponseChunkFrame
  | WsOpenAckFrame
  | WsMessageFrame
  | WsCloseFrame
  | PingFrame
  | PongFrame
  | ErrorFrame
  | E2eFrame
  | E2eHandshakeFrame

export type TunnelFrame = HostToDaemonFrame | DaemonToHostFrame

const KNOWN_TYPES = new Set<TunnelFrame["t"]>([
  "spawn",
  "stdin",
  "kill",
  "resize",
  "http_request",
  "http_response",
  "http_response_head",
  "http_response_chunk",
  "ws_open",
  "ws_open_ack",
  "ws_message",
  "ws_close",
  "ping",
  "pong",
  "error",
  "hello",
  "spawned",
  "stdout",
  "stderr",
  "exit",
  "reconnect_soon",
  "e2e",
  "e2e_handshake",
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
