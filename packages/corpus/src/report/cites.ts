/**
 * Citation helpers shared across the report glue. A citation is `[n]` or
 * `[n, m, …]` referencing the global bibliography index.
 */

/** Blank out fenced code blocks and inline code spans so `arr[0]`-style
 * array indexing in code never reads as a citation. */
function stripCode(s: string): string {
  return s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
}

/** Every citation number referenced in a string (flattening `[a, b]`).
 * Ignores brackets inside fenced/inline code and `[n](...)` markdown links. */
export function citesOf(s: string): number[] {
  return [...stripCode(s).matchAll(/\[(\d{1,3}(?:,\s*\d{1,3})*)\](?!\()/g)].flatMap((m) =>
    m[1]!.split(",").map((n) => parseInt(n.trim(), 10))
  )
}

/** Citation numbers in `s` outside the valid `[1, bibMax]` range. */
export function outOfRangeCites(s: string, bibMax: number): number[] {
  return [...new Set(citesOf(s).filter((n) => n < 1 || n > bibMax))]
}
