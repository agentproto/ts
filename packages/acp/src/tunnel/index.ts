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
  type TunnelFrame,
  type HostToDaemonFrame,
  type DaemonToHostFrame,
} from "./frames.js"

export type { FrameSink } from "./transport.js"

export {
  createTunnelServer,
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
