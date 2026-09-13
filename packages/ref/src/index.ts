/**
 * @agentproto/ref — AIP-54 REF (absorbing AIP-27's `agentref/v1`).
 *
 * One package, two schemes:
 *
 *  - **`aip://` (AIP-54)** — the canonical typed cross-AIP reference:
 *    `ArtifactRef` ({aip, id, version?}) + `aip://<aip>/<id>[@version]`
 *    URI serialization, resolved through per-family AIP-43 registries
 *    joined by `RefCatalog`. One reference mechanism for every AIP,
 *    replacing per-primitive xRef fields.
 *  - **`ws://` (AIP-27, superseded)** — the world-scheme: a typed,
 *    registry-extensible discriminated union with a canonical compact
 *    string form. Eleven base kinds shipped (local, url, git, github,
 *    ipfs, email, operator, user, persona, eth_tx, ots); extension
 *    kinds register at the implementation boundary via
 *    `registerRefKind`. It points at a resource in the world — a job
 *    `aip://` does not do — and remains the scheme of the governance
 *    engine's audit/signature surface.
 *
 * AIP-27 (`agentref/v1`) is superseded by AIP-54 (`ref/v1`) as the
 * cross-AIP artifact reference; its kinds live on as the `ws://`
 * scheme of this package.
 *
 * @see https://agentproto.sh/docs/aip-54
 * @see https://agentproto.sh/docs/aip-27
 */

export const SPEC_NAME = "ref/v1" as const
export const SPEC_VERSION = "1.0.0-alpha" as const

// — AIP-54: the canonical artifact reference (`aip://`) —
export {
  RefCatalog,
  refFor,
  refToUri,
  refFromUri,
  type RefCatalogOptions,
} from "./ref-catalog.js"
export {
  RefFamilyError,
  RefUnresolvableError,
  type ArtifactRef,
  type FamilySpec,
  type RefKeyableHandle,
  type RefRegistryLike,
  type ResolvedArtifact,
} from "./artifact-ref.js"

// — AIP-27 (superseded): the world scheme (`ws://`) —
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
