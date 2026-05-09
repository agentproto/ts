/**
 * AIP-43 REGISTRY — `createRegistry<H>()` reference implementation.
 *
 * In-memory, insertion-ordered, duplicate-refusing catalog of doctype
 * handles. Type-parametric so the same impl works for STORAGE
 * handles, SANDBOX handles, OPERATOR handles, EXTENSION handles —
 * whatever the host registers.
 *
 * Storage: a `Map<string, H>`. Insertion order is the iteration
 * order JS guarantees on Maps; `list()` and `entries()` rely on it.
 */

import {
  RegistryDuplicateError,
  RegistryKeyError,
  RegistryNotFoundError,
  type Registry,
  type RegistryOptions,
} from "./types.js"

/**
 * Default key resolution per AIP-43 § Identity:
 *   1. `handle.id` (standalone doctype manifests)
 *   2. `handle.provider` (STORAGE / SANDBOX handles)
 *   3. `handle.slug` (EXTENSION handles)
 *
 * Returns null when none of the above are non-empty strings — the
 * caller raises `RegistryKeyError` in that case.
 */
function defaultKeyBy<H>(handle: H): string | null {
  if (!handle || typeof handle !== "object") return null
  const h = handle as { id?: unknown; provider?: unknown; slug?: unknown }
  if (typeof h.id === "string" && h.id.length > 0) return h.id
  if (typeof h.provider === "string" && h.provider.length > 0) return h.provider
  if (typeof h.slug === "string" && h.slug.length > 0) return h.slug
  return null
}

export function createRegistry<H>(options: RegistryOptions<H>): Registry<H> {
  const { family } = options
  const keyBy = options.keyBy ?? ((handle: H) => defaultKeyBy(handle) ?? "")
  const entries = new Map<string, H>()

  function resolveKey(handle: H): string {
    let key: string
    try {
      key = keyBy(handle)
    } catch (err) {
      throw new RegistryKeyError(
        family,
        `keyBy threw while computing the key for a handle: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new RegistryKeyError(
        family,
        `keyBy returned ${
          key === ""
            ? "an empty string"
            : key === undefined
              ? "undefined"
              : key === null
                ? "null"
                : `a non-string (${typeof key})`
        } for a handle. Provide an explicit \`keyBy\` in the registry options or set \`id\`/\`provider\`/\`slug\` on the handle.`,
      )
    }
    return key
  }

  return {
    register(handle) {
      const key = resolveKey(handle)
      if (entries.has(key)) {
        throw new RegistryDuplicateError(family, key)
      }
      entries.set(key, handle)
    },

    has(id) {
      return entries.has(id)
    },

    count() {
      return entries.size
    },

    get(id) {
      return entries.get(id)
    },

    list() {
      return Array.from(entries.values())
    },

    entries() {
      return Array.from(entries.entries())
    },

    lookup(predicate) {
      const out: H[] = []
      for (const handle of entries.values()) {
        if (predicate(handle)) out.push(handle)
      }
      return out
    },

    unregister(id) {
      return entries.delete(id)
    },

    replace(handle) {
      const key = resolveKey(handle)
      if (!entries.has(key)) {
        throw new RegistryNotFoundError(family, key)
      }
      entries.set(key, handle)
    },
  }
}
