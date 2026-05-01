import { getRefKind } from "./registry.js"
import type { AnyRef } from "./types.js"
import { UnknownRefKind } from "./types.js"

/**
 * Split a compact form string into kind + body on the first `:`.
 * Returns null when no colon is present.
 */
export function splitKind(compact: string): [string, string] | null {
  const idx = compact.indexOf(":")
  if (idx < 0) return null
  return [compact.slice(0, idx), compact.slice(idx + 1)]
}

export function parseCompact(compact: string): AnyRef {
  const split = splitKind(compact)
  if (!split) {
    throw new Error(
      `Compact form must contain a kind separator ':' — got '${compact}'`
    )
  }
  const [kind, body] = split
  const def = getRefKind(kind)
  if (!def) throw new UnknownRefKind(kind)
  return def.parse(body)
}

export function serializeCompact(value: AnyRef): string {
  const def = getRefKind(value.kind)
  if (!def) throw new UnknownRefKind(value.kind)
  return `${value.kind}:${def.serialize(value)}`
}
