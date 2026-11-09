/**
 * Outward projection of a `SessionDescriptor` — the one shape every MCP tool
 * result and HTTP JSON body serves. Lives in its own module so both
 * `session-tools.ts` and `http-server.ts` (which session-tools imports) can
 * share it without an import cycle.
 *
 * The registry keeps the real descriptor (persisted as is, and re-read by
 * restart / continue-fresh to re-mount the same servers); only the copy that
 * crosses the tool or HTTP boundary is narrowed here.
 */

import type { AcpMcpServer } from "@agentproto/acp"
import { redactOrchestratorScopeRef } from "./orchestrator-scope-ref.js"
import type { SessionDescriptor } from "./sessions.js"

/** Stand-in for a redacted mount `env` / `headers` value. */
export const REDACTED_MOUNT_VALUE = "[redacted]"

const redactValues = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(record).map(key => [key, REDACTED_MOUNT_VALUE]))

/** `mcpServers` with every secret-bearing facet blanked: `env` and `headers`
 *  keep their keys but not their values (a mount routinely carries a bearer
 *  token in either), and an `/mcp/orchestrator` ref loses its scope-token.
 *  Returns new objects; the input is never mutated. */
export function redactMcpServers(servers: readonly AcpMcpServer[]): AcpMcpServer[] {
  return servers.map(server => ({
    ...server,
    ...(server.ref !== undefined ? { ref: redactOrchestratorScopeRef(server.ref) } : {}),
    ...(server.env !== undefined ? { env: redactValues(server.env) } : {}),
    ...(server.headers !== undefined ? { headers: redactValues(server.headers) } : {}),
  }))
}

/** A descriptor (or any row built on one) with its `mcpServers` redacted.
 *  Every other field is passed through untouched. */
export function redactSessionMounts<T extends { mcpServers?: AcpMcpServer[] }>(session: T): T {
  if (!session.mcpServers) return session
  return { ...session, mcpServers: redactMcpServers(session.mcpServers) }
}

/** Public descriptor projection. Resume environment (`ptyResumeEnv`) is
 * required by the registry to reattach native PTYs, but must never cross the
 * tool boundary. The AGENT.md system-prompt text (`appendSystemPrompt`) is
 * kept for restart re-application only and is not echoed either. Mount
 * secrets are redacted (see `redactMcpServers`). */
export function publicSessionDescriptor(
  session: SessionDescriptor,
): Omit<SessionDescriptor, "ptyResumeEnv" | "appendSystemPrompt"> {
  const { ptyResumeEnv: _privateResumeEnv, appendSystemPrompt: _privateSystemPrompt, ...publicDescriptor } = session
  return redactSessionMounts(publicDescriptor)
}
