/**
 * Citation helpers shared across the report glue. A citation is `[n]` or
 * `[n, m, …]` referencing the global bibliography index.
 */

/** Every citation number referenced in a string (flattening `[a, b]`). */
export function citesOf(s: string): number[] {
  return [...s.matchAll(/\[(\d{1,3}(?:,\s*\d{1,3})*)\]/g)].flatMap((m) =>
    m[1]!.split(",").map((n) => parseInt(n.trim(), 10))
  )
}

/** Citation numbers in `s` outside the valid `[1, bibMax]` range. */
export function outOfRangeCites(s: string, bibMax: number): number[] {
  return [...new Set(citesOf(s).filter((n) => n < 1 || n > bibMax))]
}
