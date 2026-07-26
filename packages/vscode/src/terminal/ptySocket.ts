/**
 * Transport-agnostic PTY WebSocket client for `WS /sessions/:id/pty`.
 *
 * Extracted from ptyMirror.ts so the same reconnect/backoff state machine can
 * drive both the real VS Code Terminal path (ptyMirror.ts) and the transcript
 * panel's embedded xterm.js view (ptyWebviewBridge.ts). The host keeps the
 * daemon bearer token; callers receive base64 data frames and status events.
 */

import WebSocket from "ws"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import { buildAuthHeaders } from "../auth.js"
import {
  PTY_RECONNECT_DELAYS_MS,
  encodeInputFrame,
  encodeResizeFrame,
  parsePtyServerFrame,
  reconnectDelayMs,
  shouldReconnect,
} from "./ptyMirror.logic.js"

export interface PtySocketCallbacks {
  /** WS opened. `reconnected` is true when this followed a reconnect banner. */
  onOpen(reconnected: boolean): void
  /** One raw base64 data frame from the daemon. The caller decides whether to
   *  decode (real Terminal) or relay as-is (webview xterm). */
  onData(b64: string): void
  /** Process exited; no further reconnect attempts after this. */
  onExit(exitCode: number, signal?: number): void
  /** The daemon rejected the WS upgrade (400/404/410/501 or unknown). */
  onRejected(status: number): void
  /** A transient disconnect is being retried. */
  onReconnecting(attempt: number, max: number, delayMs: number): void
  /** Reconnect attempts exhausted. */
  onGaveUp(): void
}

export interface PtySocketDimensions {
  cols: number
  rows: number
}

export interface PtySocketHandle {
  sendInput(text: string): void
  resize(cols: number, rows: number): void
  dispose(): void
}

export function connectPtySocket(
  client: DaemonClient,
  session: SessionDescriptor,
  initialDims: PtySocketDimensions,
  callbacks: PtySocketCallbacks,
): PtySocketHandle {
  let socket: WebSocket | undefined
  let cols = initialDims.cols
  let rows = initialDims.rows
  let attempt = 0
  // Set once we've seen an {kind:"exit"} frame or a non-reconnectable
  // upgrade rejection — the WS "close" that follows shortly after must NOT
  // trigger a reconnect in either case.
  let settled = false
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function connect(): void {
    if (disposed) return
    void client.resolveToken().then(token => {
      if (disposed) return
      const wsUrl =
        `${client.url.replace(/^http/, "ws")}/sessions/${encodeURIComponent(session.id)}/pty` +
        `?cols=${cols}&rows=${rows}`
      const ws = new WebSocket(wsUrl, {
        headers: buildAuthHeaders(client.authHeaders, token),
      })
      socket = ws

      ws.on("open", () => {
        const wasReconnect = attempt > 0
        attempt = 0
        callbacks.onOpen(wasReconnect)
      })

      ws.on("message", raw => {
        const frame = parsePtyServerFrame(raw.toString("utf8"))
        if (frame.kind === "data") {
          callbacks.onData(frame.b64)
        } else if (frame.kind === "exit") {
          settled = true
          callbacks.onExit(frame.exitCode, frame.signal)
        }
      })

      // Pre-upgrade rejection (501/404/400/410 — see the WP5 brief's
      // transport facts). The daemon never completes the WS handshake for
      // these, so `ws` surfaces them here rather than as a normal message.
      ws.on("unexpected-response", (_req, res) => {
        settled = true
        callbacks.onRejected(res.statusCode ?? 0)
        ws.terminate()
      })

      ws.on("close", code => {
        if (disposed || settled) return
        if (shouldReconnect(code, attempt)) {
          const delay = reconnectDelayMs(attempt) ?? 4_000
          attempt++
          callbacks.onReconnecting(attempt, PTY_RECONNECT_DELAYS_MS.length, delay)
          reconnectTimer = setTimeout(connect, delay)
          return
        }
        settled = true
        callbacks.onGaveUp()
      })

      // 'close' always follows 'error' for `ws` — reconnect/banner logic
      // lives in the close handler so it isn't duplicated here.
      ws.on("error", () => {})
    })
  }

  connect()

  return {
    sendInput(text): void {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encodeInputFrame(text))
    },
    resize(nextCols, nextRows): void {
      cols = nextCols
      rows = nextRows
      if (socket?.readyState === WebSocket.OPEN) socket.send(encodeResizeFrame(nextCols, nextRows))
    },
    dispose(): void {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (socket) closeSocket(socket)
      socket = undefined
    },
  }
}

/** `.close()` on a still-CONNECTING `ws` socket logs a benign-but-noisy warning; terminate() is the clean way to abandon it. */
function closeSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate()
  } else {
    ws.close(1000, "terminal closed")
  }
}
