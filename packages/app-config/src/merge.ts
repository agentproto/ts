import { createHash } from "node:crypto"

/**
 * Deterministic value helpers shared by load / contracts / verify:
 * a deep merge (objects merge recursively, arrays REPLACE), canonical JSON
 * (sorted keys, recursive), and a sha256 over that canonical form. The merge
 * semantics mirror book-config's precedence chain: later layers win on
 * conflicts, an object overlay merges into an object base key-by-key, and an
 * array overlay replaces the base array wholesale (order is meaningful
 * configuration, not something to interleave).
 */

export type Layer = "defaults" | "entry" | "item"

export const DEFAULT_PRECEDENCE: readonly Layer[] = ["defaults", "entry", "item"]

export function isLayer(v: unknown): v is Layer {
  return v === "defaults" || v === "entry" || v === "item"
}

/** Validate a caller-supplied precedence permutation. */
export function normalizePrecedence(precedence: readonly string[] | undefined): readonly Layer[] {
  if (precedence === undefined) return DEFAULT_PRECEDENCE
  if (precedence.length !== 3 || !precedence.every(isLayer)) {
    throw new AppConfigError(
      `precedence must be a permutation of ["defaults", "entry", "item"], got ${JSON.stringify(precedence)}`,
    )
  }
  const unique = new Set(precedence)
  if (unique.size !== 3) {
    throw new AppConfigError(`precedence must not repeat a layer: ${JSON.stringify(precedence)}`)
  }
  return precedence
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Merge options: `arraysBy[field] = keyField` turns the array at that field
 * into a keyed merge (overlay entries with the same key REPLACE the base
 * entry, others append) instead of the replace-by-default. */
export interface MergeOptions {
  arraysBy?: Record<string, string>
}

/**
 * Deep merge two parsed YAML values. Objects merge recursively; every other
 * shape (arrays included) is replaced by the overlay when the overlay is
 * defined — except arrays listed in `opts.arraysBy`, which merge keyed by
 * their entry key field. `undefined` overlays leave the base untouched.
 */
export function mergeValues(base: unknown, overlay: unknown, opts?: MergeOptions): unknown {
  return mergeInto(base, overlay, opts ?? {}, "")
}

function mergeInto(base: unknown, overlay: unknown, opts: MergeOptions, field: string): unknown {
  if (overlay === undefined) return base
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(overlay)) {
      out[k] = k in base ? mergeInto(base[k], v, opts, k) : v
    }
    return out
  }
  if (Array.isArray(base) && Array.isArray(overlay)) {
    const keyField = opts.arraysBy?.[field]
    if (keyField !== undefined) return mergeArraysByKey(base, overlay, keyField)
  }
  return overlay
}

/**
 * Keyed array merge: an overlay entry whose `keyField` matches a base entry
 * REPLACES it in place (a book that narrows its knowledge slice must not
 * inherit the series-wide selector for the same workspace); overlay entries
 * with new keys append, in overlay order.
 */
export function mergeArraysByKey(base: readonly unknown[], overlay: readonly unknown[], keyField: string): unknown[] {
  function keyOf(entry: unknown): string {
    if (!isPlainObject(entry)) return canonicalJson(entry)
    const p = pick(entry, keyField)
    return p.found ? canonicalJson(p.value) : ""
  }
  const overlayByKey = new Map<string, unknown>()
  for (const o of overlay) overlayByKey.set(keyOf(o), o)
  const out: unknown[] = []
  const consumed = new Set<string>()
  for (const b of base) {
    const k = keyOf(b)
    if (overlayByKey.has(k)) {
      out.push(overlayByKey.get(k))
      consumed.add(k)
    } else {
      out.push(b)
    }
  }
  for (const o of overlay) {
    const k = keyOf(o)
    if (!consumed.has(k)) {
      out.push(o)
      consumed.add(k)
    }
  }
  return out
}

/** Fold mergeValues over layers in precedence order, starting from an empty object. */
export function mergeLayers(layers: readonly unknown[], opts?: MergeOptions): unknown {
  let acc: unknown = {}
  for (const layer of layers) acc = mergeValues(acc, layer, opts)
  return acc
}

/** Read one key off a parsed value without casting: returns whether it was present. */
export function pick(value: object, key: string): { found: boolean; value: unknown } {
  for (const [k, v] of Object.entries(value)) {
    if (k === key) return { found: true, value: v }
  }
  return { found: false, value: undefined }
}

/** Canonical JSON text: keys sorted recursively, the sha256 input for contracts. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** Copy with keys sorted recursively — the stable on-disk key order for contract files. */
export function sortedCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedCopy)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) out[k] = sortedCopy(value[k])
    return out
  }
  return value
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export class AppConfigError extends Error {
  constructor(message: string) {
    super(`app-config: ${message}`)
    this.name = "AppConfigError"
  }
}
