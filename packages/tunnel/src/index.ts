/**
 * @agentproto/tunnel - public surface.
 *
 * The Tunnel Provider primitive: contract types, the shared HTTP client,
 * and the on-disk credential store. Providers implement `TunnelProvider`
 * (usually on top of `TunnelClient`).
 */

export {
  DEFAULT_TUNNEL_TIMEOUT_MS,
  TunnelProviderError,
  tunnelServiceUrl,
} from "./types.js"
export type {
  CreateTunnelInput,
  FetchLike,
  TunnelApiKeyAuth,
  TunnelAuth,
  TunnelAuthMode,
  TunnelCapabilities,
  TunnelConfig,
  TunnelHealth,
  TunnelHealthHost,
  TunnelHealthState,
  TunnelInfo,
  TunnelOidcAuth,
  TunnelProvider,
  TunnelStatus,
  TunnelTarget,
  TunnelTokenAuth,
} from "./types.js"

export { TunnelClient, normalizeTunnelBaseUrl } from "./client.js"
export type { TunnelRequestOptions } from "./client.js"

export {
  TUNNEL_SLUG_PATTERN,
  deleteTunnelCredentials,
  readTunnelCredentials,
  tunnelCredsDir,
  tunnelCredsPath,
  writeTunnelCredentials,
} from "./credentials.js"
export type { TunnelCredsStoreOptions } from "./credentials.js"
