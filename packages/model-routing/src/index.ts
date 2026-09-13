/**
 * @agentproto/model-routing — AIP-57 MODEL-ROUTING reference implementation.
 *
 * A pure primitive answering one question: given an AIP-42 `ModelRef` that
 * is not a literal provider/model pair, which model actually serves this
 * request? No I/O, no clock, no randomness (§7) — a host composes
 * credential resolution, health checking and dispatch around this, never
 * inside it.
 *
 * @see https://agentproto.sh/docs/aip-57
 */

export const SPEC_NAME = "modelrouting/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export type {
  Chain,
  ChainResolution,
  Keyspace,
  Layer,
  Pack,
  ReservedSource,
  ResolvedRoute,
  RoutableMessage,
  RoutableRequest,
  Route,
  RouteOrGate,
  Source,
} from "./types.js"

export { definePack, overlay } from "./pack.js"
export { resolve } from "./resolve.js"
export { envKeySuffix, envLayer, parseRouteRef, type EnvLayerOptions } from "./env.js"
export {
  defineChain,
  fnv1a32,
  resolveChain,
  resolveThroughChain,
  stablePrefix,
  stablePrefixHash,
} from "./sticky.js"
