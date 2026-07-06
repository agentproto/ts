/**
 * Dependency-injection surface for MCP credential resolution.
 *
 * `packages/runtime` intentionally does NOT depend on `@agentproto/auth`;
 * the daemon bootstrap (e.g. `packages/cli`) can set a broker-backed
 * resolver here, and `session-spawn.ts` will call it when an `mcpServers`
 * entry carries `credentialRef`. Errors from the hook are treated as
 * non-fatal by the caller.
 */

export interface McpCredentialDeps {
  /** Resolve brokered headers for an `mcpServers` entry that names a
   *  `credentialRef`. The returned headers are merged ON TOP of the
   *  entry's static `headers` so brokered auth wins on collision. */
  resolveMcpCredentialHeaders?: (o: {
    credentialRef: string
    signal?: AbortSignal
  }) => Promise<Record<string, string> | undefined>
}

let deps: McpCredentialDeps = {}

export function setMcpCredentialDeps(d: McpCredentialDeps): void {
  deps = d
}

export function getMcpCredentialDeps(): McpCredentialDeps {
  return deps
}
