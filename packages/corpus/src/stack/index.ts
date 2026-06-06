/**
 * Knowledge-stack resolution — the composable layer model on top of
 * `OverlayFs`. Register one `LayerProvider` per dimension; the resolver
 * emits a band-ordered stack; `buildOverlayFromStack` mounts it.
 */

export type {
  LayerMode,
  LayerRef,
  LayerProvider,
  LayerShadow,
  ResolutionContext,
  StackEntry,
  StackResolution,
  StackSkip,
} from "./types.js"

export { KnowledgeStackResolver } from "./resolver.js"
export {
  buildOverlayFromStack,
  flattenPackRefs,
  partitionStackRefs,
  type BuildOverlayOptions,
  type StackRefPartition,
} from "./mount.js"
