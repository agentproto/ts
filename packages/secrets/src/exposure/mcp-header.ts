/**
 * Resolver for `McpHeaderExposure` — turns a broker path into ready-to-use
 * HTTP headers for an MCP server's transport.
 *
 * `@agentproto/secrets` stays dependency-free of `@agentproto/auth`: instead
 * of importing `CredentialBroker` directly, this module declares the
 * structural shape it needs (`McpHeaderResolver`). `CredentialBroker`
 * already satisfies it — no adapter required at call sites.
 */

import type { McpHeaderExposure } from "./types.js"
import { assertSafeSecretValue } from "./substitute.js"

/** Structural shape a credential broker must satisfy to back
 *  `resolveMcpHeaderExposure`. `CredentialBroker` from `@agentproto/auth`
 *  matches this shape without any adapter. */
export interface McpHeaderResolver {
  resolveHeaders(o: {
    path: string
    server?: string
    signal?: AbortSignal
  }): Promise<Record<string, string>>
}

/**
 * Resolve `exposure` into a header map by delegating to `resolver`, then
 * guard every resolved header VALUE with `assertSafeSecretValue` before
 * returning it. This closes off header-injection: a broker (or whatever
 * sits behind it — a flow engine, a vault) that ever returns a value
 * containing CR/LF/NUL would otherwise let that value smuggle extra
 * header lines onto the MCP transport.
 */
export async function resolveMcpHeaderExposure(
  exposure: McpHeaderExposure,
  resolver: McpHeaderResolver,
  opts?: { signal?: AbortSignal }
): Promise<Record<string, string>> {
  const headers = await resolver.resolveHeaders({
    path: exposure.credentialPath,
    server: exposure.server,
    signal: opts?.signal,
  })
  for (const [name, value] of Object.entries(headers)) {
    assertSafeSecretValue(name, value)
  }
  return headers
}
