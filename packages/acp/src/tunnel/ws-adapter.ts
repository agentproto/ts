/**
 * Adapter from a WebSocket-shaped object to a `FrameSink`. Works with
 * both the browser-native WebSocket API and the `ws` library's server
 * sockets — anything with `send`, `close`, and `addEventListener`-style
 * `message`/`close` events.
 *
 * Why a duck-typed shape and not `import("ws")`: the cli, the host,
 * and (eventually) browser hosts all need to wrap WS instances they
 * obtained themselves. Importing `ws` in this package would force
 * every consumer to install it even when running in environments
 * (Bun, Deno, browser) that ship native WebSocket.
 */

import { encodeFrame, parseFrame, type TunnelFrame } from "./frames.js"
import type { FrameSink } from "./transport.js"

export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  readyState: number
  addEventListener(
    event: "message",
    handler: (ev: { data: string | ArrayBuffer | Buffer }) => void
  ): void
  addEventListener(event: "close", handler: () => void): void
  addEventListener(event: "error", handler: (ev: { message?: string }) => void): void
  removeEventListener(event: string, handler: (...args: never[]) => void): void
}

const READY_OPEN = 1

export function wrapWebSocket(ws: WebSocketLike): FrameSink {
  const frameHandlers = new Set<(frame: TunnelFrame) => void>()
  const closeHandlers = new Set<(reason?: string) => void>()
  let isOpen = ws.readyState === READY_OPEN

  // The `ws` library delivers Buffer; the browser delivers string or
  // ArrayBuffer. We coerce to string and parse — everything we send is
  // JSON text, so non-text payloads are protocol violations and get
  // dropped.
  const onMessage = (ev: { data: string | ArrayBuffer | Buffer }): void => {
    let text: string
    if (typeof ev.data === "string") text = ev.data
    else if (ev.data instanceof ArrayBuffer) text = Buffer.from(ev.data).toString("utf8")
    else text = (ev.data as Buffer).toString("utf8")
    const frame = parseFrame(text)
    if (!frame) return
    for (const h of frameHandlers) h(frame)
  }

  const onClose = (): void => {
    if (!isOpen) return
    isOpen = false
    for (const h of closeHandlers) h("transport.closed")
    frameHandlers.clear()
    closeHandlers.clear()
  }

  const onError = (ev: { message?: string }): void => {
    if (!isOpen) return
    isOpen = false
    for (const h of closeHandlers) h(ev.message ?? "transport.error")
    frameHandlers.clear()
    closeHandlers.clear()
  }

  ws.addEventListener("message", onMessage)
  ws.addEventListener("close", onClose)
  ws.addEventListener("error", onError)

  return {
    get isOpen() {
      return isOpen
    },
    send(frame) {
      if (!isOpen) return
      try {
        ws.send(encodeFrame(frame))
      } catch {
        // Send-on-closed-socket is a benign race; rely on the close
        // handler to flip isOpen and let listeners drain naturally.
      }
    },
    close(reason) {
      if (!isOpen) return
      try {
        ws.close(1000, reason)
      } catch {
        // ignore
      }
    },
    onFrame(handler) {
      frameHandlers.add(handler)
      return () => frameHandlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
  }
}
