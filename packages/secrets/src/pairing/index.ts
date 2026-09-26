/**
 * @agentproto/secrets/pairing — the `pair/v2` E2E session handshake (Node entry).
 *
 * See ./handshake.ts for the protocol. This barrel re-exports the public
 * surface: the two entry points (`startClientHandshake`, `respondToHandshake`),
 * their message (de)serializers, and the typed error.
 *
 * The protocol code is shared with the browser-safe entry
 * (`@agentproto/secrets/pairing/browser`, ./browser.ts); the only difference
 * here is the default `CryptoProvider`: `node:crypto`. Every crypto function is
 * async and takes an optional trailing `crypto` to override it — e.g. pass
 * `webCryptoProvider` to run the exact browser code path under Node.
 */

import { nodeCryptoProvider } from "../crypto/node.js"
import type { CryptoProvider } from "../crypto/types.js"
import * as derive from "./derive.js"
import * as handshake from "./handshake.js"
import * as offerUrl from "./offer-url.js"
import * as tunnel from "./tunnel-handshake.js"

export {
  PAIR_VERSION,
  LEGACY_PAIR_VERSION,
  PAIRING_PROTOCOL_OUTDATED_MESSAGE,
  PairingError,
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

/** Begin a client handshake (see ./handshake.ts). */
export function startClientHandshake(
  params: handshake.ClientHandshakeParams,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<handshake.StartedClientHandshake> {
  return handshake.startClientHandshake(params, crypto)
}

/** Respond to a client hello (see ./handshake.ts). */
export function respondToHandshake(
  hello: handshake.PairingHello,
  params: handshake.DaemonHandshakeParams,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<handshake.DaemonHandshakeResult> {
  return handshake.respondToHandshake(hello, params, crypto)
}

// P2 — offer-URL codec (shared by daemon `pair offer` + client `pair accept`).
export {
  OFFER_URL_SCHEME,
  OFFER_URL_HOST,
  OFFER_VERSION,
  PAIR_WEB_URL,
  encodeOfferUrl,
  encodeOfferWebUrl,
  type PairingOffer,
  type ParseOfferOptions,
} from "./offer-url.js"

/** Answer a retired pair/v1 hello with a notice-only channel (see
 *  ./handshake.ts). Never serve over the result. */
export function respondToLegacyHandshake(
  helloBytes: Uint8Array,
  identity: Parameters<typeof handshake.respondToLegacyHandshake>[1],
  crypto: CryptoProvider = nodeCryptoProvider,
): ReturnType<typeof handshake.respondToLegacyHandshake> {
  return handshake.respondToLegacyHandshake(helloBytes, identity, crypto)
}

/** Parse + strictly validate an offer URL (see ./offer-url.ts). */
export function parseOfferUrl(
  url: string,
  opts: offerUrl.ParseOfferOptions = {},
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<offerUrl.PairingOffer> {
  return offerUrl.parseOfferUrl(url, opts, crypto)
}

// The hosted rendezvous broker `pair offer` defaults to (no flag, no config).
export { HOSTED_RENDEZVOUS_URL } from "./rendezvous.js"

// P2 — pairing-derived key material (pair root + route/auth tokens).
export { currentEpoch, importPairRootKey, type RouteAuthTokens } from "./derive.js"

/** Derive the long-term pair root from a completed session (see ./derive.ts). */
export function derivePairRoot(
  session: Pick<handshake.PairingSession, "sendKey" | "recvKey" | "transcriptHash">,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<string> {
  return derive.derivePairRoot(session, crypto)
}

/** Derive the broker ROUTE token for an epoch (see ./derive.ts). */
export function deriveEpochRoutingToken(
  pairRoot: string | CryptoKey,
  epoch: number,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<string> {
  return derive.deriveEpochRoutingToken(pairRoot, epoch, crypto)
}

/** Derive the sealed-hello AUTH token for an epoch (see ./derive.ts). */
export function deriveEpochAuthToken(
  pairRoot: string | CryptoKey,
  epoch: number,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<string> {
  return derive.deriveEpochAuthToken(pairRoot, epoch, crypto)
}

/** Route + auth tokens for an epoch (see ./derive.ts). */
export function deriveEpochTokens(
  pairRoot: string | CryptoKey,
  epoch: number,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<derive.RouteAuthTokens> {
  return derive.deriveEpochTokens(pairRoot, epoch, crypto)
}

/** Route + auth tokens for an offer secret (see ./derive.ts). */
export function deriveOfferTokens(
  offerSecret: string,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<derive.RouteAuthTokens> {
  return derive.deriveOfferTokens(offerSecret, crypto)
}

/** Current + previous epoch route/auth tokens (see ./derive.ts). */
export function epochRoutingTokens(
  pairRoot: string | CryptoKey,
  now: number = Date.now(),
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<({ epoch: number } & derive.RouteAuthTokens)[]> {
  return derive.epochRoutingTokens(pairRoot, now, crypto)
}

// tunnel-e2e — token-authenticated handshake for `serve --connect` (no PKI;
// both ends share the pre-provisioned tunnel token).
export {
  TUNNEL_E2E_VERSION,
  TunnelHandshakeError,
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

/** Begin the daemon side of `tunnel-e2e/v1` (see ./tunnel-handshake.ts). */
export function startTunnelHandshake(
  token: string,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<tunnel.StartedTunnelHandshake> {
  return tunnel.startTunnelHandshake(token, crypto)
}

/** Respond to a daemon `tunnel-e2e/v1` offer (see ./tunnel-handshake.ts). */
export function respondToTunnelHandshake(
  offer: tunnel.TunnelOffer,
  token: string,
  crypto: CryptoProvider = nodeCryptoProvider,
): Promise<tunnel.TunnelHandshakeResult> {
  return tunnel.respondToTunnelHandshake(offer, token, crypto)
}

// The crypto seam — both providers, so a caller can force either one.
export { nodeCryptoProvider } from "../crypto/node.js"
export { webCryptoProvider } from "../crypto/webcrypto.js"
export type { CryptoProvider, KeyPairDer } from "../crypto/types.js"
