/**
 * @agentproto/acp/tunnel — frame protocol + client/server for relaying
 * subprocess I/O across a duplex transport (typically WebSocket).
 *
 * Wire spec: agentproto/tunnel/v1, defined in ./frames.ts.
 */

export {
  TUNNEL_VERSION,
  encodeFrame,
  parseFrame,
  encodeData,
  decodeData,
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
  wrapE2E,
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
