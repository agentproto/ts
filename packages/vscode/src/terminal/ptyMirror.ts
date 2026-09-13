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

import * as vscode from "vscode"

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import { decodePtyData } from "./ptyMirror.logic.js"
import {
  ptyExitBanner,
  ptyUpgradeRejectionBanner,
  reconnectGaveUpBanner,
  reconnectedBanner,
  reconnectingBanner,
} from "./terminalSwitch.logic.js"
import { connectPtySocket } from "./ptySocket.js"

export function createPtyMirrorPty(
  client: DaemonClient,
  session: SessionDescriptor,
): vscode.Pseudoterminal {
  const writeEmitter = new vscode.EventEmitter<string>()

  let handle: ReturnType<typeof connectPtySocket> | undefined

  return {
    onDidWrite: writeEmitter.event,
    open(initialDimensions): void {
      const cols = initialDimensions?.columns ?? 80
      const rows = initialDimensions?.rows ?? 24
      handle = connectPtySocket(
        client,
        session,
        { cols, rows },
        {
          onOpen: reconnected => {
            if (reconnected) writeEmitter.fire(`${reconnectedBanner()}\r\n`)
          },
          onData: b64 => {
            writeEmitter.fire(decodePtyData(b64))
          },
          onExit: (exitCode, signal) => {
            writeEmitter.fire(`\r\n${ptyExitBanner(exitCode, signal)}\r\n`)
          },
          onRejected: status => {
            writeEmitter.fire(`${ptyUpgradeRejectionBanner(status, session)}\r\n`)
          },
          onReconnecting: (attempt, max, delayMs) => {
            writeEmitter.fire(`${reconnectingBanner(attempt, max, delayMs)}\r\n`)
          },
          onGaveUp: () => {
            writeEmitter.fire(`${reconnectGaveUpBanner()}\r\n`)
          },
        },
      )
    },
    close(): void {
      handle?.dispose()
      handle = undefined
    },
    handleInput(data): void {
      handle?.sendInput(data)
    },
    setDimensions(dims): void {
      handle?.resize(dims.columns, dims.rows)
    },
  }
}
