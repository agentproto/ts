/**
 * A value a read might not be able to produce: either a `known` result or an
 * `unknown` with a human reason. A cookie read that threw (sqlite3 missing, the
 * DB copy failed, Chrome holding the Cookies lock) is `{ unknown }`, so a caller
 * can never mistake a failed read for a confident empty or zero result.
 */
export type Known<T> = { known: T } | { unknown: string }

export function isKnown<T>(k: Known<T>): k is { known: T } {
  return "known" in k
}

/** Collapse a {@link Known} to a plain value with an explicit fallback (a deliberate, greppable decision). */
export function knownOr<T>(k: Known<T>, fallback: T): T {
  return isKnown(k) ? k.known : fallback
}
