/**
 * @agentproto/ref — agentref/v1 (AIP-27).
 *
 * Composable reference primitive: typed, registry-extensible discriminated
 * union with a canonical compact string form. Eleven base kinds shipped
 * (local, url, git, github, ipfs, email, operator, user, persona, eth_tx,
 * ots); extension kinds register at the implementation boundary via
 * `registerRefKind`.
 *
 * Spec: https://agentik.net/docs/aip-27
 */

export const SPEC_NAME = "agentref/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

export { defineRef, isResolvable } from "./define-ref.js"
export { parseCompact, serializeCompact, splitKind } from "./compact.js"
export {
  registerRefKind,
  getRefKind,
  listRefKinds,
  listKindsByCollection,
  listCollections,
  refMatchesCollection,
  clearRegistry,
} from "./registry.js"
export type {
  Ref,
  AnyRef,
  RefKind,
  RefIn,
  RefKindRegistry,
  RefHandle,
  ResolveContext,
  ResolveResult,
  IdentityRegistry,
  KindDefinition,
  BaseCollection,
} from "./types.js"
export {
  baseRefShape,
  BASE_COLLECTIONS,
  UnknownRefKind,
  InvalidRefBody,
  NotResolvable,
} from "./types.js"

export type {
  LocalRef,
  UrlRef,
  GitRef,
  GithubRef,
  IpfsRef,
  EmailRef,
  OperatorRef,
  UserRef,
  PersonaRef,
  EthTxRef,
  OtsRef,
} from "./kinds/index.js"

import "./kinds/index.js"
