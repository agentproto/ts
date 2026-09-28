/**
 * Canonical JSON: the deterministic byte form of a value that signing and
 * verification both hash — recursively sorted object keys, no whitespace,
 * arrays kept in order. Two structurally-equal values (regardless of the key
 * order either side happened to build them in) always canonicalize to the
 * same string, so a signature over the canonical form survives a JSON
 * round-trip through any conformant parser/serializer.
 *
 * `undefined` (a bare value, an object property, or an array element) drops
 * out exactly like `JSON.stringify` already treats it — omitted from an
 * object, `null` inside an array — so canonicalizing is safe to call on the
 * same value a plain `JSON.stringify` would already accept.
 */

export function canonicalJson(value: unknown): string {
  return stringify(value)
}

function stringify(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stringify(v)).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`).join(",")}}`
}
