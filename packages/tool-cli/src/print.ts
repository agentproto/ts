/** Deterministic default formatter for a projected tool command. */
export function printToolOutput(value: unknown, opts?: { pretty?: boolean; raw?: boolean }): string {
  if (opts?.raw) return typeof value === "string" ? value : JSON.stringify(value)
  return JSON.stringify(value, null, opts?.pretty ? 2 : undefined)
}
