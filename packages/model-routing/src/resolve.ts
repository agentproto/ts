/**
 * AIP-57 §3, §4 — layered resolution.
 *
 * Pure per §7: `resolve` touches nothing but its arguments. Building an
 * `env`-sourced {@link Layer} means reading `process.env` — that I/O
 * belongs at the CALL SITE (see `env.ts`'s `envLayer`, which takes an env
 * record as a plain argument), never inside `resolve` itself.
 */

import type { Layer, Pack, ResolvedRoute, Route, Source } from "./types.js"

/**
 * Resolve `key` against `pack`, walking `layers` in the given order —
 * highest precedence first, e.g. `[overrideLayer, envLayer]` — with
 * `pack.routes` as the implicit, always-present lowest layer (§3).
 *
 * `null` is a capability gate, not a missing value (§4): once a layer sets
 * `key` to `null`, no *catch-all* at an equal-or-higher layer may switch it
 * back on. Only a layer naming `key` EXPLICITLY may. Implemented by folding
 * layers from lowest to highest precedence, tracking whether the current
 * decision is gated; a catch-all is skipped entirely while gated, an
 * explicit entry always wins and resets the gate.
 */
export function resolve<Key extends string, R extends Route = Route>(
  pack: Pack<Key, R>,
  key: Key,
  layers: readonly Layer<Key, R>[] = []
): ResolvedRoute<R> | null {
  let current: R | null = pack.routes[key]
  let source: Source = "pack"
  let gated = current === null

  // Highest precedence must win, so apply layers in reverse: the
  // lowest-precedence given layer first, the highest-precedence one last.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!
    if (layer.entries && Object.prototype.hasOwnProperty.call(layer.entries, key)) {
      current = layer.entries[key] ?? null
      source = layer.source
      gated = current === null
    } else if (layer.catchAll !== undefined && !gated) {
      current = layer.catchAll
      source = layer.source
    }
  }

  if (current === null) return null
  return { ...current, key, source } as ResolvedRoute<R>
}
