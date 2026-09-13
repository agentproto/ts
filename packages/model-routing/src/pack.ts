/**
 * AIP-57 §2 — Pack construction and overlay.
 */

import type { Pack, Route } from "./types.js"

/**
 * Declare a Pack. The `const Key` type parameter captures the literal keys,
 * so the pack's keyspace becomes its type: an unknown key at a call site is
 * a compile-time error rather than a runtime lookup miss (§2).
 */
export function definePack<const Key extends string, R extends Route = Route>(pack: {
  id: string
  label: string
  description?: string
  keyspace: Pack<Key, R>["keyspace"]
  routes: Record<Key, R | null>
}): Pack<Key, R> {
  return pack
}

/**
 * Layer `patch` on top of `base`, key by key. Only keys `base` already
 * declares may be overridden — an unknown key in `patch` is a compile
 * error, which is the point: an overlay re-routes known keys, it does not
 * grow the keyspace. The result keeps `base`'s keyspace and id/label unless
 * `patch` names its own (§2: "the provider-outage lever — one declaration
 * re-routes a set of keys without touching the base").
 */
export function overlay<Key extends string, R extends Route = Route>(
  base: Pack<Key, R>,
  patch: {
    id?: string
    label?: string
    description?: string
    routes: Partial<Record<Key, R | null>>
  }
): Pack<Key, R> {
  const routes = { ...base.routes } as Record<Key, R | null>
  for (const [key, route] of Object.entries(patch.routes) as [Key, (R | null) | undefined][]) {
    if (route !== undefined) routes[key] = route
  }
  return {
    id: patch.id ?? base.id,
    label: patch.label ?? base.label,
    ...((patch.description ?? base.description) !== undefined
      ? { description: patch.description ?? base.description }
      : {}),
    keyspace: base.keyspace,
    routes,
  }
}
