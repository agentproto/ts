/**
 * @agentproto/acp/tunnel — frame protocol + client/server for relaying
 * subprocess I/O across a duplex transport (typically WebSocket). Node entry.
 *
 * Wire spec: agentproto/tunnel/v1, defined in ./frames.ts.
 *
 * The frame codec, `wrapE2E` and the handshake-over-sink helpers are shared
 * with the browser-safe entry (`@agentproto/acp/tunnel/browser`, ./browser.ts).
 * The only difference here: the E2E helpers default their AES-GCM to
 * `node:crypto` (`nodeAead`) instead of WebCrypto — same bytes either way —
 * and `decodeData` keeps its `Buffer` return type.
 */

import { nodeAead } from "./aead-node.js"
import * as e2e from "./e2e.js"
import type { FrameSink } from "./transport.js"
import * as tunnelE2e from "./tunnel-e2e.js"

export { decodeData } from "./node-data.js"

export {
  TUNNEL_VERSION,
  encodeFrame,
  parseFrame,
  encodeData,
  type SpawnFrame,
  type StdinFrame,
  type KillFrame,
  type ResizeFrame,
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
  E2eError,
  DEFAULT_E2E_MAX_FRAMES,
  holdFrames,
  type E2eKeys,
  type E2eErrorCode,
  type E2eFrameSink,
  type WrapE2EOptions,
  type HandshakeOverSinkOptions,
} from "./e2e.js"

export {
  DEFAULT_TUNNEL_E2E_TIMEOUT_MS,
  type TunnelE2EOptions,
  type AcceptSinkE2EResult,
} from "./tunnel-e2e.js"

export { nodeAead } from "./aead-node.js"
export { webCryptoAead, createWebCryptoAead, type E2eAead } from "./aead.js"

const withNodeAead = (wrap: e2e.WrapE2EOptions = {}): e2e.WrapE2EOptions => ({ aead: nodeAead, ...wrap })

/** `wrapE2E` (see ./e2e.ts), AES-GCM defaulting to `node:crypto`. */
export function wrapE2E(
  inner: FrameSink,
  keys: e2e.E2eKeys,
  opts: e2e.WrapE2EOptions = {},
): e2e.E2eFrameSink {
  return e2e.wrapE2E(inner, keys, withNodeAead(opts))
}

/** `clientHandshakeOverSink` (see ./e2e.ts), AES-GCM defaulting to `node:crypto`. */
export function clientHandshakeOverSink(
  sink: FrameSink,
  hello: Uint8Array,
  deriveKeys: (reply: Uint8Array) => e2e.E2eKeys | Promise<e2e.E2eKeys>,
  opts: e2e.HandshakeOverSinkOptions = {},
): Promise<e2e.E2eFrameSink> {
  return e2e.clientHandshakeOverSink(sink, hello, deriveKeys, { ...opts, wrap: withNodeAead(opts.wrap) })
}

/** `daemonHandshakeOverSink` (see ./e2e.ts), AES-GCM defaulting to `node:crypto`. */
export function daemonHandshakeOverSink(
  sink: FrameSink,
  respond: Parameters<typeof e2e.daemonHandshakeOverSink>[1],
  opts: e2e.HandshakeOverSinkOptions = {},
): Promise<e2e.E2eFrameSink> {
  return e2e.daemonHandshakeOverSink(sink, respond, { ...opts, wrap: withNodeAead(opts.wrap) })
}

/** `connectSinkE2E` (see ./tunnel-e2e.ts), AES-GCM defaulting to `node:crypto`. */
export function connectSinkE2E(
  sink: FrameSink,
  offer: Uint8Array,
  deriveKeys: (reply: Uint8Array) => e2e.E2eKeys | Promise<e2e.E2eKeys>,
  opts: tunnelE2e.TunnelE2EOptions = {},
): Promise<e2e.E2eFrameSink | null> {
  return tunnelE2e.connectSinkE2E(sink, offer, deriveKeys, { ...opts, wrap: withNodeAead(opts.wrap) })
}

/** `acceptSinkE2E` (see ./tunnel-e2e.ts), AES-GCM defaulting to `node:crypto`. */
export function acceptSinkE2E(
  sink: FrameSink,
  respond: Parameters<typeof tunnelE2e.acceptSinkE2E>[1],
  opts: tunnelE2e.TunnelE2EOptions = {},
): Promise<tunnelE2e.AcceptSinkE2EResult> {
  return tunnelE2e.acceptSinkE2E(sink, respond, { ...opts, wrap: withNodeAead(opts.wrap) })
}

export {
  createTunnelServer,
  DEFAULT_WS_DIAL_TIMEOUT_MS,
  DEFAULT_HTTP_FORWARD_TIMEOUT_MS,
  type TunnelServer,
  type TunnelServerOptions,
  type PtyProcess,
  type UpstreamWebSocket,
} from "./server.js"

export {
  createTunnelClient,
  type TunnelClient,
  type TunnelClientOptions,
  type TunnelChildProcess,
  type TunnelSpawnOptions,
  type TunnelHttpRequest,
  type TunnelHttpResponse,
  type TunnelHttpStreamResponse,
  type TunnelWebSocket,
  type TunnelWebSocketOpenRequest,
} from "./client.js"

export { wrapWebSocket, type WebSocketLike } from "./ws-adapter.js"
