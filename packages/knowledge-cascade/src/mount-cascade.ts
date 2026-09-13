/**
 * mountCascade — compose a stack of {ref, fs} layers, ordered by
 * precedence, into one mounted `OverlayFs`.
 *
 * This is the same mount order `buildOverlayFromStack` derives from a
 * resolved `StackResolution` (`@agentproto/corpus`'s `stack/mount.ts`), and
 * the shape Guilde's `overlayOperatorPacks` hand-assembles for its
 * persona→pack binding — generalized here so any host (standalone app
 * included) can reach it without going through the `LayerProvider`/
 * `StackResolver` machinery:
 *
 *   [ ...constraints (read-only floor, precedence order) ]   ← top
 *   [ base (the single writable layer) ]                     ← writes here
 *   [ ...lens (precedence order) ]                            ← floor packs
 *
 * `constraints` are hoisted ABOVE `base` so neither an override nor a
 * `.whiteout` marker in `base` can shadow or remove them — they sit
 * higher, and top-down resolution + whiteout-only-suppresses-lower make
 * them a true floor. Writes still target `base` (`writableLayer` is set to
 * its index), so the read floor and the write target stay independent.
 *
 * `lens` layers are the shadowable defaults: `base` overrides same-path
 * entries, adds new ones (extend), and can `.whiteout` them (remove).
 *
 * Returns `base` unchanged when no other layer is given, mirroring
 * `buildOverlayFromStack`'s single-layer fast path.
 */

import { OverlayFs, ReadOnlyFs, type FsPort } from "@agentproto/corpus"

export interface MountCascadeOptions {
  /** The single writable layer — local overrides/extensions/whiteouts. */
  readonly base: FsPort
  /** Shadowable floor packs, highest precedence first. `base` wins over these. */
  readonly lens?: readonly FsPort[]
  /** Non-shadowable floor packs, highest precedence first. Wins over `base`. */
  readonly constraints?: readonly FsPort[]
}

export function mountCascade(opts: MountCascadeOptions): FsPort {
  const lens = opts.lens ?? []
  const constraints = (opts.constraints ?? []).map(fs => new ReadOnlyFs(fs))

  if (constraints.length === 0 && lens.length === 0) return opts.base

  const layers = [...constraints, opts.base, ...lens]
  return new OverlayFs(layers, {
    whiteout: true,
    writableLayer: constraints.length, // index of `base`
  })
}
