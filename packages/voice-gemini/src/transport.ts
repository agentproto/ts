/**
 * Transport seam for the Gemini Live provider. The API key travels in the
 * URL query (`?key=...`) because that is how the Live WebSocket authenticates
 * (`@google/genai` builds the same URL); the key is never sent in a frame
 * and the recorded fixtures redact the `key` parameter (`<redacted>`).
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

export const DEFAULT_WS_BASE_URL = "wss://generativelanguage.googleapis.com"

/** The Live API's bidi method path, as `@google/genai` connects to it. */
export const BIDI_PATH = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
