/**
 * The `/mcp/orchestrator?scope=<token>` ref shape, kept apart from
 * `orchestrator-gateway.ts` so modules that gateway already imports (the
 * restart core) can read and redact these refs without an import cycle.
 */

/** Pull the `scope` query param out of an `/mcp/orchestrator` ref URL.
 *  Returns null for any other URL shape. Never logs the token. */
export function extractOrchestratorScopeToken(ref: string): string | null {
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    return null
  }
  if (!url.pathname.endsWith("/mcp/orchestrator")) return null
  const token = url.searchParams.get("scope")
  return token && token.length > 0 ? token : null
}

/** `ref` with the `/mcp/orchestrator` scope-token blanked, for anything
 *  that announces a mount (events, logs). Any other ref is returned as is. */
export function redactOrchestratorScopeRef(ref: string): string {
  if (extractOrchestratorScopeToken(ref) === null) return ref
  const url = new URL(ref)
  url.searchParams.set("scope", "redacted")
  return url.toString()
}
