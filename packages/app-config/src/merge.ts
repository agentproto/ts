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

/**
 * Deep merge two parsed YAML values. Objects merge recursively; every other
 * shape (arrays included) is replaced by the overlay when the overlay is
 * defined. `undefined` overlays leave the base untouched.
 */
export function mergeValues(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(overlay)) {
      out[k] = k in base ? mergeValues(base[k], v) : v
    }
    return out
  }
  return overlay
}

/** Fold mergeValues over layers in precedence order, starting from an empty object. */
export function mergeLayers(layers: readonly unknown[]): unknown {
  let acc: unknown = {}
  for (const layer of layers) acc = mergeValues(acc, layer)
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
