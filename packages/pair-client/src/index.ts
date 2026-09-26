/**
 * @agentproto/pair-client — the browser side of agentproto E2E daemon pairing.
 *
 *   inspectOffer(url)            parse/validate an offer, no network
 *   pairFromOffer(url, opts)     handshake → { daemon, confirm(), cancel() }
 *   connect(credential, opts)    → TunnelClient { fetch, state, onStateChange… }
 *   createIndexedDbCredentialStore() / createMemoryCredentialStore()
 *
 * Browser-safe: built only on `@agentproto/secrets/pairing/browser` and
 * `@agentproto/acp/tunnel/browser` (WebCrypto, the WHATWG WebSocket, fetch
 * types, IndexedDB). Nothing reachable imports a `node:` builtin or touches
 * `Buffer`/`process` — `src/__tests__/browser-entry.test.ts` bundles this entry
 * for the browser and runs it in a VM with only web globals. It runs in a
 * window, a worker, or a service worker.
 */

export { connect, type ConnectOptions, type ConnectionState, type StateChange, type TunnelClient } from "./client.js"
export {
  inspectOffer,
  pairFromOffer,
  type OfferInfo,
  type PairFromOfferOptions,
  type PairedDaemon,
  type PendingPairing,
} from "./pair.js"
export {
  createIndexedDbCredentialStore,
  createMemoryCredentialStore,
  type CredentialStore,
  type IndexedDbCredentialStoreOptions,
  type PairCredential,
} from "./credential.js"
export { TunnelClientError, type TunnelClientErrorCode } from "./errors.js"
export { PAIRING_REVOKED_CODE, type ChannelTimeouts, type WebSocketConstructor } from "./channel.js"
export { encodeOfferWebUrl, PAIR_WEB_URL } from "@agentproto/secrets/pairing/browser"
