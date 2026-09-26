/**
 * @agentproto/acp/tunnel/browser — the browser-safe tunnel core.
 *
 * The `agentproto/tunnel/v1` frame codec, the `FrameSink` contract, the
 * WebSocket adapter, `wrapE2E` and the handshake-over-sink / tunnel-e2e
 * negotiation helpers — the same source files as the Node entry
 * (`@agentproto/acp/tunnel`), with AES-GCM defaulting to WebCrypto. The Node
 * process client/server (`createTunnelClient` / `createTunnelServer`, built on
 * `node:events`/`node:stream`/`node:child_process`) are NOT part of it.
 *
 * Contract: nothing reachable from this module imports a `node:` builtin or
 * touches `Buffer`/`process`. `src/__tests__/browser-entry.test.ts` enforces it
 * by bundling this file for `platform: "browser"` and running the bundle in a
 * bare VM context that has only web globals.
 */

export {
  TUNNEL_VERSION,
  MAX_FRAME_PAYLOAD_BYTES,
  splitPayload,
  encodeFrame,
  parseFrame,
  encodeData,
  decodeData,
  type SpawnFrame,
  type StdinFrame,
  type KillFrame,
  type ResizeFrame,
  type HttpRequestFrame,
  type HttpCancelFrame,
  type HttpRequestChunkFrame,
  type HttpResponseFrame,
  type HttpResponseHeadFrame,
  type HttpResponseChunkFrame,
  type HelloFrame,
  type SpawnedFrame,
  type StdoutFrame,
  type StderrFrame,
  type ExitFrame,
  type ErrorFrame,
  type PingFrame,
  type PongFrame,
  type WsOpenFrame,
  type WsOpenAckFrame,
  type WsMessageFrame,
  type WsCloseFrame,
  type ReconnectSoonFrame,
  type E2eFrame,
  type E2eHandshakeFrame,
  type TunnelFrame,
  type HostToDaemonFrame,
  type DaemonToHostFrame,
} from "./frames.js"

export type { FrameSink } from "./transport.js"

export {
  wrapE2E,
  holdFrames,
  E2eError,
  DEFAULT_E2E_MAX_FRAMES,
  clientHandshakeOverSink,
  daemonHandshakeOverSink,
  type E2eKeys,
  type E2eErrorCode,
  type E2eFrameSink,
  type WrapE2EOptions,
  type HandshakeOverSinkOptions,
} from "./e2e.js"

export {
  connectSinkE2E,
  acceptSinkE2E,
  DEFAULT_TUNNEL_E2E_TIMEOUT_MS,
  type TunnelE2EOptions,
  type AcceptSinkE2EResult,
} from "./tunnel-e2e.js"

export { webCryptoAead, createWebCryptoAead, type E2eAead } from "./aead.js"

export { wrapWebSocket, type WebSocketLike } from "./ws-adapter.js"
