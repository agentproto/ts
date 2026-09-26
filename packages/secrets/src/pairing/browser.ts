/**
 * @agentproto/secrets/pairing/browser — the browser-safe pairing entry.
 *
 * The same `pair/v2` handshake, `tunnel-e2e/v1` handshake, offer-URL codec,
 * pair-root / epoch-token derivation, seal box and transcript signatures as
 * the Node entries (`@agentproto/secrets/pairing`, `/seal`, `/identity`) — the
 * same source files, not a port — with WebCrypto (`globalThis.crypto.subtle`)
 * as the default `CryptoProvider`.
 *
 * Contract: nothing reachable from this module imports a `node:` builtin or
 * touches `Buffer`/`process`. `src/__tests__/browser-entry.test.ts` enforces it
 * by bundling this file for `platform: "browser"` and running the bundle in a
 * bare VM context that has only web globals.
 */

export {
  PAIR_VERSION,
  LEGACY_PAIR_VERSION,
  PAIRING_PROTOCOL_OUTDATED_MESSAGE,
  PairingError,
  startClientHandshake,
  respondToHandshake,
  respondToLegacyHandshake,
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

export {
  OFFER_URL_SCHEME,
  OFFER_URL_HOST,
  OFFER_VERSION,
  encodeOfferUrl,
  parseOfferUrl,
  type PairingOffer,
  type ParseOfferOptions,
} from "./offer-url.js"

export { HOSTED_RENDEZVOUS_URL } from "./rendezvous.js"

export {
  derivePairRoot,
  currentEpoch,
  deriveEpochRoutingToken,
  deriveEpochAuthToken,
  deriveEpochTokens,
  deriveOfferTokens,
  epochRoutingTokens,
  type RouteAuthTokens,
} from "./derive.js"

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

export {
  SEAL_ALG,
  SEAL_VERSION,
  SealError,
  seal,
  unseal,
  generateSealKeyPair,
  sealingPublicKey,
  sealKeyId,
  type SealKeyPair,
} from "../seal/core.js"

export {
  IDENTITY_VERSION,
  IdentityError,
  generateIdentity,
  identityFingerprint,
  signTranscript,
  verifyTranscript,
  type DaemonIdentity,
  type IdentityKeyPair,
} from "../identity/core.js"

export { webCryptoProvider } from "../crypto/webcrypto.js"
export type { CryptoProvider, KeyPairDer } from "../crypto/types.js"
export {
  base64Decode,
  base64Encode,
  base64UrlEncode,
  utf8Decode,
  utf8Encode,
  concatBytes,
} from "../crypto/bytes.js"
