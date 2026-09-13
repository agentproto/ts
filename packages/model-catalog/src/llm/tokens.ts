/**
 * Shared human-readable token formatting, so the `agentproto models` CLI and
 * the `catalog_models` MCP tool render the same `1M`/`200k` shapes instead of
 * raw integers. Lives next to `resolveContextWindow` (its data source) — one
 * formatter per concept, both output surfaces consume it.
 */

/** Format a token count compactly — `1M`, `500k`, `2k`, `448`. Undefined ⇒
 *  null so JSON output omits rather than fabricates a value. */
export function formatTokens(n: number | undefined): string | null {
  if (typeof n !== "number" || n <= 0) return null
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    const text = Number.isInteger(m) ? String(m) : m.toFixed(1)
    return `${text}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    const text = Number.isInteger(k) ? String(k) : k.toFixed(1)
    return `${text}k`
  }
  return String(n)
}
