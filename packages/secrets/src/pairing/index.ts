/**
 * @agentproto/secrets/pairing — the `pair/v1` E2E session handshake.
 *
 * See ./handshake.ts for the protocol. This barrel re-exports the public
 * surface: the two entry points (`startClientHandshake`, `respondToHandshake`),
 * their message (de)serializers, and the typed error.
 */

export {
  PAIR_VERSION,
  PairingError,
  startClientHandshake,
  respondToHandshake,
  encodePairingMessage,
  decodePairingHello,
  decodePairingReply,
  type PairingErrorCode,
  type PairingHello,
  type PairingReply,
  type PairingSession,
  type ClientHandshakeParams,
  type StartedClientHandshake,
  type DaemonHandshakeParams,
  type DaemonHandshakeResult,
} from "./handshake.js"

// P2 — offer-URL codec (shared by daemon `pair offer` + client `pair accept`).
export {
  OFFER_URL_SCHEME,
  OFFER_URL_HOST,
  OFFER_VERSION,
  encodeOfferUrl,
  parseOfferUrl,
  type PairingOffer,
  type ParseOfferOptions,
} from "./offer-url.js"

// P2 — pairing-derived key material (pair root + epoch routing tokens).
export {
  derivePairRoot,
  currentEpoch,
  deriveEpochRoutingToken,
  epochRoutingTokens,
} from "./derive.js"

// tunnel-e2e — token-authenticated handshake for `serve --connect` (no PKI;
// both ends share the pre-provisioned tunnel token).
export {
  TUNNEL_E2E_VERSION,
  TunnelHandshakeError,
  startTunnelHandshake,
  respondToTunnelHandshake,
  encodeTunnelMessage,
  decodeTunnelOffer,
  decodeTunnelAccept,
  type TunnelHandshakeErrorCode,
  type TunnelOffer,
  type TunnelAccept,
  type TunnelE2ESession,
  type StartedTunnelHandshake,
  type TunnelHandshakeResult,
} from "./tunnel-handshake.js"
