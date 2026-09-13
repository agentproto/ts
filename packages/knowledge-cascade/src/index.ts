/**
 * @agentproto/knowledge-cascade — a global knowledge pack shadowed by
 * per-scope override/extend/whiteout, over plain file trees.
 *
 * The cascade mechanics (`OverlayFs`, `StackResolver`,
 * `buildOverlayFromStack`, `FsPort`, `MemFs`, `ReadOnlyFs`) live in
 * `@agentproto/corpus` and are re-exported here unchanged — this package
 * adds a standalone-first surface on top: a disk-backed `FsPort`
 * (`DiskFs`), a read-only pack-directory loader (`packFs`), and a
 * convenience that composes a precedence-ordered layer stack into one
 * mounted overlay (`mountCascade`) without going through the
 * `LayerProvider`/`StackResolver` dynamic-binding machinery.
 *
 * Override/extend/remove is by PATH IDENTITY over plain file trees, not
 * typed-item merging — a higher layer re-authoring `entries/foo.md`
 * shadows the lower layer's copy (override), a new path is additive
 * (extend), and `entries/foo.md.whiteout` removes it (remove). See
 * `OverlayFs`'s doc comment for the full contract.
 */

export {
  OverlayFs,
  ReadOnlyFs,
  MemFs,
  StackResolver,
  buildOverlayFromStack,
  flattenPackRefs,
  partitionStackRefs,
  WHITEOUT_SUFFIX,
} from "@agentproto/corpus"
export type {
  FsPort,
  FsStat,
  FsLockHandle,
  OverlayFsOptions,
  BuildOverlayOptions,
  StackRefPartition,
  LayerMode,
  LayerRef,
  LayerProvider,
  LayerShadow,
  ResolutionContext,
  StackEntry,
  StackResolution,
  StackSkip,
} from "@agentproto/corpus"

export { DiskFs, type DiskFsOptions } from "./disk-fs.js"
export { packFs, type PackFsOptions } from "./pack-fs.js"
export { mountCascade, type MountCascadeOptions } from "./mount-cascade.js"
