/**
 * `selector:` frontmatter → Selector.
 *
 * Authoring shape (AIP-12 §selector):
 *
 *   selector:
 *     role: sales-rep              # one ref
 *     capability: [demo, forecast] # OR within the list
 *
 * Keys are axis ids; multiple keys AND together. The advanced
 * `allOf:`/`anyOf:` long form is accepted verbatim for selectors that
 * need OR across axes.
 *
 * Parsing never throws — malformed input returns null and the caller
 * falls back to the legacy `targets` compile. A selector that silently
 * dropped a malformed term could attach an overlay to the wrong
 * operators; null keeps the file on its legacy binding instead.
 */

import type { Selector, SelectorTerm } from "./selector.js"

export function parseSelectorFrontmatter(raw: unknown): Selector | null {
  if (!isPlainObject(raw)) return null

  // Long form: explicit allOf / anyOf term lists.
  if ("allOf" in raw || "anyOf" in raw) {
    const allOf = readTermList(raw.allOf)
    const anyOf = readTermList(raw.anyOf)
    if (allOf === null || anyOf === null) return null
    if (!allOf.length && !anyOf.length) return null
    return Object.freeze({
      ...(allOf.length ? { allOf } : {}),
      ...(anyOf.length ? { anyOf } : {}),
    })
  }

  // Short form: axis → ref | ref[].
  const allOf: SelectorTerm[] = []
  for (const [axis, value] of Object.entries(raw)) {
    const refs = readRefs(value)
    if (refs === null) return null
    allOf.push(Object.freeze({ axis, anyOf: refs }))
  }
  if (!allOf.length) return null
  return Object.freeze({ allOf: Object.freeze(allOf) })
}

function readTermList(raw: unknown): readonly SelectorTerm[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const out: SelectorTerm[] = []
  for (const entry of raw as readonly unknown[]) {
    if (!isPlainObject(entry)) return null
    const axis = entry.axis
    if (typeof axis !== "string" || !axis.length) return null
    const refs = readRefs(entry.anyOf)
    if (refs === null || !refs.length) return null
    out.push(Object.freeze({ axis, anyOf: refs }))
  }
  return Object.freeze(out)
}

function readRefs(value: unknown): readonly string[] | null {
  if (typeof value === "string") {
    return value.length ? Object.freeze([value]) : null
  }
  if (Array.isArray(value)) {
    const refs = value as readonly unknown[]
    if (!refs.length) return null
    if (!refs.every((r): r is string => typeof r === "string" && r.length > 0))
      return null
    return Object.freeze([...refs])
  }
  return null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
