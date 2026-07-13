/**
 * @agentproto/rendezvous — the untrusted ciphertext splicer for E2E pairing.
 *
 * See ./server.ts for the protocol. Public surface: the server factory, its
 * options/stats types, and the reusable rate-limiter + constant-time compare
 * (exported so tests and embedders can reuse the exact primitives).
 */

export {
  createRendezvousServer,
  RV_CLOSE,
  type RendezvousServer,
  type RendezvousServerOptions,
  type RendezvousStats,
} from "./server.js"

export { createRateLimiter, type RateLimiter, type RateLimiterOptions } from "./rate-limiter.js"
export { timingSafeEqualStrings } from "./timing-safe.js"
export { loadEnvConfig, type RendezvousEnvConfig } from "./env.js"
