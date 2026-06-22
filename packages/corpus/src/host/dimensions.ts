/**
 * Dimension assembly — portable port of guilde's dimension-sources.ts.
 *
 * An ordered list of `DimensionProvider`s is consulted left-to-right;
 * the first provider to supply a non-empty value for a key wins (same
 * semantics as guilde's first-match-per-key merge). The resulting
 * `Dimensions` bag feeds both the StackResolver (pick which layers apply)
 * and the PlaybookRegistry/OperatorOverlayResolver (which playbooks bind).
 *
 * No guilde-specific imports — only `slugify` from this package.
 */

import { slugify } from "../util/slug.js"
import type { Dimensions } from "../binding/selector.js"

/** A single dimension value: a scalar or a multi-valued axis. */
export type DimensionValue = string | readonly string[]

/**
 * A pluggable source of dimension values for a subject.
 * First-match-per-key wins; register higher-priority sources earlier.
 */
export interface DimensionProvider<TSubject = unknown> {
  readonly id: string
  resolve(subject: TSubject): Readonly<Record<string, DimensionValue | undefined>>
}

/**
 * Merge providers left-to-right, first-match-per-key. Returns only
 * the keys that have a non-empty resolved value.
 */
export function assembleDimensions<TSubject = unknown>(
  providers: readonly DimensionProvider<TSubject>[],
  subject: TSubject
): Dimensions {
  const out: Record<string, string | readonly string[]> = {}
  for (const provider of providers) {
    const partial = provider.resolve(subject)
    for (const [key, value] of Object.entries(partial)) {
      if (key in out) continue
      if (value == null || value === "") continue
      if (Array.isArray(value) && (value as readonly string[]).length === 0) continue
      out[key] = value as string | readonly string[]
    }
  }
  return out as Dimensions
}

/**
 * Minimal subject shape for the four well-known AIP-12 axes:
 * identity, role, position, capability.
 */
export interface StandardSubject {
  readonly slug?: string
  readonly role?: string
  readonly title?: string
  readonly capabilities?: readonly string[]
}

/**
 * Base dimension provider — maps the four well-known AIP-12 axes from
 * a `StandardSubject`. Host apps can prepend higher-priority providers
 * for app-specific axes (org / region / compliance / tier).
 *
 * Mirrors `operatorDimensionSource` from guilde's dimension-sources.ts
 * without importing anything guilde-specific.
 */
export const standardDimensionProvider: DimensionProvider<StandardSubject> = {
  id: "standard",
  resolve: (subject) => {
    if (!subject) return {}
    const identity = subject.slug ?? subject.role ?? undefined
    const role = subject.role ?? undefined
    const position = subject.title ? slugify(subject.title) : undefined
    const capability =
      subject.capabilities && subject.capabilities.length > 0
        ? subject.capabilities
        : undefined
    return { identity, role, position, capability }
  },
}
