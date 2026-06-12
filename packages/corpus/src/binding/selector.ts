/**
 * Selector ⊨ Dimensions — the one matcher every attachment kind uses.
 *
 * A `Selector` is a small boolean expression over axis terms; the host
 * supplies the subject's `Dimensions` (axis → value(s)) and the matcher
 * decides whether the asset attaches. Scope (org / guild / workspace
 * reach) is NOT expressed here — reach is decided by which corpus
 * workspaces the host aggregates before matching ever runs.
 */

import { ANY_REF, type AxisDefinition, type AxisRegistry } from "./axes.js"

export interface SelectorTerm {
  readonly axis: string
  /** Refs the term accepts — OR within the list. `"*"` = any present value. */
  readonly anyOf: readonly string[]
}

export interface Selector {
  /** Every term must match (AND). */
  readonly allOf?: readonly SelectorTerm[]
  /** At least one term must match (OR). */
  readonly anyOf?: readonly SelectorTerm[]
}

/**
 * The subject's axis values. A missing key means the subject has no
 * value on that axis — terms against it fail (never match-all).
 */
export type Dimensions = Readonly<
  Record<string, string | readonly string[] | undefined>
>

export interface MatchOptions {
  /** Axis registry supplying per-axis `normalizeRef`. Optional — without it refs match verbatim. */
  readonly axes?: AxisRegistry
}

export const EMPTY_SELECTOR: Selector = Object.freeze({})

/** True when the selector has no terms at all. */
export function isEmptySelector(selector: Selector): boolean {
  return !selector.allOf?.length && !selector.anyOf?.length
}

/**
 * Evaluate `selector ⊨ dimensions`.
 *
 * - An EMPTY selector matches NOTHING — an asset that wants everyone
 *   in scope says so with an explicit `{ axis, anyOf: ["*"] }` term.
 *   (Parity with the legacy empty-`targets` behavior.)
 * - A term fails when the dimension is absent.
 * - A term matches when its normalized refs intersect the dimension's
 *   values, or when it carries `"*"` and the dimension is present.
 */
export function matchesSelector(
  selector: Selector,
  dimensions: Dimensions,
  options: MatchOptions = {}
): boolean {
  if (isEmptySelector(selector)) return false
  const { allOf, anyOf } = selector
  if (allOf?.length) {
    for (const term of allOf) {
      if (!termMatches(term, dimensions, options)) return false
    }
  }
  if (anyOf?.length) {
    return anyOf.some((term) => termMatches(term, dimensions, options))
  }
  return true
}

function termMatches(
  term: SelectorTerm,
  dimensions: Dimensions,
  options: MatchOptions
): boolean {
  const raw = dimensions[term.axis]
  if (raw === undefined) return false
  const values = typeof raw === "string" ? [raw] : raw
  if (values.length === 0) return false
  const axis = options.axes?.get(term.axis)
  for (const ref of term.anyOf) {
    const normalized = normalizeRef(ref, axis)
    if (normalized === ANY_REF) return true
    if (values.includes(normalized)) return true
  }
  return false
}

function normalizeRef(ref: string, axis: AxisDefinition | undefined): string {
  return axis?.normalizeRef ? axis.normalizeRef(ref) : ref
}
