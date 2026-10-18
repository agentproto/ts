/**
 * Dependency-injection surface for MCP credential resolution.
 *
 * `packages/runtime` does depend on `@agentproto/auth` (e.g. `KeychainStore`
 * in `session-spawn.ts`), but credential resolution is still injected here
 * so non-darwin / test stores stay pluggable. The daemon bootstrap (e.g.
 * `packages/cli`) can set a broker-backed resolver here, and `session-spawn.ts` will call it when an `mcpServers`
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
  /** Read an imported-MCP secret by opaque ref
   *  (`agentproto/mcp-import/<importId>#<header|env>:<KEY>`, split on the last
   *  `#` into keychain path + account). Undefined when the ref is missing. */
  resolveMcpSecret?: (ref: string) => Promise<string | undefined>
  /** Persist an imported-MCP secret under `ref`. */
  storeMcpSecret?: (ref: string, value: string) => Promise<void>
}

/**
 * `setMcpCredentialDeps`/`getMcpCredentialDeps` are a plain module-scope
 * singleton, and this package ships with `splitting: false` across many
 * tsup entries: `./mcp-credential-deps` here, `./mcp-oauth` and
 * `./mcp-client-pool` each bundle their OWN copy of this file, with their
 * OWN independent `deps` variable. A `setMcpCredentialDeps` call reached
 * through one subpath import is invisible to a `getMcpCredentialDeps` call
 * reached through another — only consumers that both go through the SAME
 * subpath (or both through `./index`, which inlines everything into one
 * chunk) actually share state. Treat any cross-subpath read of this
 * singleton as unreliable; pass the resolved deps explicitly instead (see
 * `createDaemonOAuthProvider`'s `io` parameter and `mcp-proxy.ts`'s
 * `openClient` for the pattern).
 */
let deps: McpCredentialDeps = {}

export function setMcpCredentialDeps(d: McpCredentialDeps): void {
  deps = d
}

export function getMcpCredentialDeps(): McpCredentialDeps {
  return deps
}
