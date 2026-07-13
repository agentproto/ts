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
