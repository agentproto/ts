/**
 * Pseudoterminal for a `pty:true` session — real node-pty bytes over
 * `WS /sessions/:id/pty` (runtime/src/http-server.ts handlePtyWebSocket).
 * Bytes are forwarded to the Pseudoterminal verbatim; VS Code's built-in
 * terminal renderer does the ANSI/scrollback/find work, which is the whole
 * reason this goes through `Pseudoterminal` instead of xterm.js.
 *
 * Uses the `ws` package, not the global WebSocket: build.mjs targets node20
 * (no global WebSocket without --experimental-websocket), and the native
 * WebSocket API can't set the Authorization header the PTY upgrade requires.
 * `DaemonClient.resolveToken()` is reused so token discovery stays in one
 * place.
 */

import WebSocket from "ws"
import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import {
  PTY_RECONNECT_DELAYS_MS,
  decodePtyData,
  encodeInputFrame,
  encodeResizeFrame,
  parsePtyServerFrame,
  reconnectDelayMs,
  shouldReconnect,
} from "./ptyMirror.logic.js"
import {
  ptyExitBanner,
  ptyUpgradeRejectionBanner,
  reconnectGaveUpBanner,
  reconnectedBanner,
  reconnectingBanner,
} from "./terminalSwitch.logic.js"

export function createPtyMirrorPty(
  client: DaemonClient,
  session: SessionDescriptor,
): vscode.Pseudoterminal {
  const writeEmitter = new vscode.EventEmitter<string>()

  let socket: WebSocket | undefined
  let cols = 80
  let rows = 24
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
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      socket = ws

      ws.on("open", () => {
        if (attempt > 0) writeEmitter.fire(`${reconnectedBanner()}\r\n`)
        attempt = 0
      })

      ws.on("message", raw => {
        const frame = parsePtyServerFrame(raw.toString("utf8"))
        if (frame.kind === "data") {
          writeEmitter.fire(decodePtyData(frame.b64))
        } else if (frame.kind === "exit") {
          settled = true
          writeEmitter.fire(`\r\n${ptyExitBanner(frame.exitCode, frame.signal)}\r\n`)
        }
      })

      // Pre-upgrade rejection (501/404/400/410 — see the WP5 brief's
      // transport facts). The daemon never completes the WS handshake for
      // these, so `ws` surfaces them here rather than as a normal message.
      ws.on("unexpected-response", (_req, res) => {
        settled = true
        writeEmitter.fire(`${ptyUpgradeRejectionBanner(res.statusCode ?? 0, session)}\r\n`)
        ws.terminate()
      })

      ws.on("close", code => {
        if (disposed || settled) return
        if (shouldReconnect(code, attempt)) {
          const delay = reconnectDelayMs(attempt) ?? 4_000
          attempt++
          writeEmitter.fire(`${reconnectingBanner(attempt, PTY_RECONNECT_DELAYS_MS.length, delay)}\r\n`)
          reconnectTimer = setTimeout(connect, delay)
          return
        }
        settled = true
        writeEmitter.fire(`${reconnectGaveUpBanner()}\r\n`)
      })

      // 'close' always follows 'error' for `ws` — reconnect/banner logic
      // lives in the close handler so it isn't duplicated here.
      ws.on("error", () => {})
    })
  }

  return {
    onDidWrite: writeEmitter.event,
    open(initialDimensions): void {
      if (initialDimensions) {
        cols = initialDimensions.columns
        rows = initialDimensions.rows
      }
      connect()
    },
    close(): void {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (socket) closeSocket(socket)
    },
    handleInput(data): void {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encodeInputFrame(data))
    },
    setDimensions(dims): void {
      cols = dims.columns
      rows = dims.rows
      if (socket?.readyState === WebSocket.OPEN) socket.send(encodeResizeFrame(dims.columns, dims.rows))
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
