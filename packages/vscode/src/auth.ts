/**
 * Auth header building helper shared by the VS Code extension's daemon client.
 *
 * Mirrors the precedence in `packages/runtime/src/sandbox-attach.ts`'s
 * `buildMcpConfigSnippet`: explicit `authHeaders` (e.g.
 * `{ Cookie: "_port_auth=<token>" }`) take precedence over a bearer token;
 * an empty object falls back to the bearer token so the default
 * `agentproto.authHeaders: {}` setting does not change existing behaviour.
 */
export function buildAuthHeaders(
  authHeaders: Record<string, string> | undefined,
  token: string | undefined,
): Record<string, string> {
  if (authHeaders && Object.keys(authHeaders).length > 0) {
    return authHeaders
  }
  if (token) {
    return { authorization: `Bearer ${token}` }
  }
  return {}
}
