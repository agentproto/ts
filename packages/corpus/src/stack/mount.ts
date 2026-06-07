/**
 * Turn a resolved knowledge stack into a mounted `OverlayFs`, and the
 * helpers that flatten it.
 *
 * Mount order encodes the AIP-10 plane-precedence invariant:
 *
 *   [ ...constraint layers (read-only floor, band-ordered) ]   ← top
 *   [ guild writable layer ]                                   ← writes here
 *   [ ...lens layers (band-ordered) ]                          ← floor packs
 *
 * Constraints are hoisted ABOVE the guild layer so neither a guild edit
 * nor a `.whiteout` can shadow or remove them (they sit higher, and
 * top-down resolution + whiteout-only-suppresses-lower make them a true
 * floor). Writes still target the guild layer via `writableLayer`, so the
 * read floor and the write target stay independent.
 */

import { OverlayFs, ReadOnlyFs } from "../knowledge/overlay-fs.js"
import type { FsPort } from "../ports/fs.port.js"
import type { LayerRef, StackResolution } from "./types.js"

export interface BuildOverlayOptions {
  /** The guild's own editable corpus — the single writable layer. */
  readonly guildFs: FsPort
  /** The resolved stack (band-ordered entries). */
  readonly stack: StackResolution
  /** Resolve a layer ref to an FsPort, or null if it has no mountable source. */
  readonly loadFs: (ref: LayerRef) => FsPort | null
}

/**
 * Build the mounted overlay for a resolved stack. Returns `guildFs`
 * unchanged when no layer resolves to a mountable source (so the
 * single-layer fast path is preserved).
 */
export function buildOverlayFromStack(opts: BuildOverlayOptions): FsPort {
  const { guildFs, stack, loadFs } = opts

  const constraintFs: FsPort[] = []
  const lensFs: FsPort[] = []
  for (const entry of stack.entries) {
    const target = entry.mode === "constraint" ? constraintFs : lensFs
    for (const ref of entry.refs) {
      const fs = loadFs(ref)
      if (fs) target.push(entry.mode === "constraint" ? new ReadOnlyFs(fs) : fs)
    }
  }

  if (constraintFs.length === 0 && lensFs.length === 0) return guildFs

  const layers = [...constraintFs, guildFs, ...lensFs]
  return new OverlayFs(layers, {
    whiteout: true,
    writableLayer: constraintFs.length, // index of guildFs
  })
}

/**
 * Flatten a resolved stack to a de-duplicated, band-ordered list of pack
 * refs (kind `pack` or unspecified). This reproduces the legacy
 * `resolveOperatorPacks` output shape (operator packs before role packs,
 * each id once) so the pack-id contract stays stable.
 */
export function flattenPackRefs(stack: StackResolution): string[] {
  const out: string[] = []
  for (const entry of stack.entries) {
    for (const ref of entry.refs) {
      if (ref.kind && ref.kind !== "pack") continue
      if (!out.includes(ref.ref)) out.push(ref.ref)
    }
  }
  return out
}

/** Pack refs split by composition mode, each list deduped + band-ordered. */
export interface StackRefPartition {
  /** Lens packs — mount UNDER the writable layer (the guild shadows them). */
  readonly lens: readonly string[]
  /** Constraint packs — mount ABOVE the writable layer (a non-shadowable floor). */
  readonly constraint: readonly string[]
}

/**
 * Partition a resolved stack's pack refs by mode. The host mounts `lens`
 * below the guild layer and `constraint` above it (read-only), so a
 * compliance/legal floor cannot be shadowed or tombstoned. With no
 * constraint layers resolved, `lens` equals `flattenPackRefs` — the legacy
 * pack-id contract.
 */
export function partitionStackRefs(stack: StackResolution): StackRefPartition {
  const lens: string[] = []
  const constraint: string[] = []
  for (const entry of stack.entries) {
    const target = entry.mode === "constraint" ? constraint : lens
    for (const ref of entry.refs) {
      if (ref.kind && ref.kind !== "pack") continue
      if (!target.includes(ref.ref)) target.push(ref.ref)
    }
  }
  return { lens, constraint }
}
