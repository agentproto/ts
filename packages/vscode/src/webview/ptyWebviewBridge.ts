/**
 * Host-side bridge between the daemon's PTY WebSocket and the transcript
 * webview. The bearer token stays host-side: the extension host opens the WS
 * and relays only base64 PTY bytes and status events to the webview over the
 * existing typed postMessage protocol.
 */

import type { DaemonClient } from "../client/daemonClient.js"
import type { SessionDescriptor } from "../client/types.js"
import { connectPtySocket, type PtySocketHandle } from "../terminal/ptySocket.js"
import type { PanelMessenger } from "./transcriptPanelController.js"
import type { ExtMessage } from "./protocol.js"

export function bridgePtyToWebview(
  client: DaemonClient,
  session: SessionDescriptor,
  messenger: PanelMessenger,
  initialDims: { cols: number; rows: number },
): PtySocketHandle {
  function post(msg: ExtMessage): void {
    messenger.postMessage(msg)
  }

  return connectPtySocket(client, session, initialDims, {
    onOpen: reconnected => {
      post({
        type: "ptyStatus",
        status: reconnected ? "reconnected" : "open",
      })
    },
    onData: b64 => {
      post({ type: "ptyData", b64 })
    },
    onExit: (exitCode, signal) => {
      post({ type: "ptyExit", exitCode, signal })
    },
    onRejected: status => {
      post({
        type: "ptyStatus",
        status: "rejected",
        detail: String(status),
      })
    },
    onReconnecting: (attempt, max, delayMs) => {
      post({
        type: "ptyStatus",
        status: "reconnecting",
        attempt,
        max,
        delayMs,
      })
    },
    onGaveUp: () => {
      post({ type: "ptyStatus", status: "gave-up" })
    },
  })
}
