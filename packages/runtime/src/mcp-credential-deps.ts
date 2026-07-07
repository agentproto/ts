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
  /** Resolve a single named secret (an env-var-shaped slug — e.g. a sandbox
   *  spec's `env.passthrough` / `env.auth.state.env` entries) to its raw
   *  value. Distinct from `resolveMcpCredentialHeaders` above (which
   *  resolves an MCP `credentialRef` PATH into Authorization-style
   *  headers): this is the `SecretResolver` shape `agent_start`'s sandbox
   *  branch (`session-spawn.ts`) passes to `@agentproto/sandbox`'s
   *  `SandboxSecretsConfig.resolver` — so a booted sandbox's env is filled
   *  from the same host-injected broker as every other secret, never a
   *  bare `process.env` read at the call site. Returns null when the slug
   *  can't be resolved (missing/unconfigured). */
  resolveSandboxSecret?: (slug: string) => Promise<string | null>
}

let deps: McpCredentialDeps = {}

export function setMcpCredentialDeps(d: McpCredentialDeps): void {
  deps = d
}

export function getMcpCredentialDeps(): McpCredentialDeps {
  return deps
}
