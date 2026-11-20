/**
 * Transport seams: a WebSocket factory and a `fetch`, both injectable so the
 * provider runs against recorded exchanges in tests. The defaults wrap the
 * `ws` package and the global `fetch`.
 */
import WebSocket from "ws"
import type { VoiceSocket, VoiceSocketFactory } from "@agentproto/voice"

export const nodeSocketFactory: VoiceSocketFactory = (url, init) => {
  const ws = new WebSocket(url, init?.headers ? { headers: init.headers } : undefined)
  const sock: VoiceSocket = {
    send: data => ws.send(data),
    close: code => ws.close(code),
    on(event: string, cb: never) {
      if (event === "message") ws.on("message", (d: WebSocket.RawData) => (cb as (s: string) => void)(d.toString()))
      else if (event === "close") ws.on("close", (code: number) => (cb as (c?: number) => void)(code))
      else ws.on(event, cb)
    },
  }
  return sock
}

export interface ElevenLabsTransport {
  /** Default: the `ws` package. */
  socket?: VoiceSocketFactory
  /** Default: global `fetch`. */
  fetch?: typeof fetch
  /** Default: `https://api.elevenlabs.io`. */
  baseUrl?: string
  /** Default: `wss://api.elevenlabs.io`. */
  wsBaseUrl?: string
}

export const DEFAULT_BASE_URL = "https://api.elevenlabs.io"
export const DEFAULT_WS_BASE_URL = "wss://api.elevenlabs.io"
