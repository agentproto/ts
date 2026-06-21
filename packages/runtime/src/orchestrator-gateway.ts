/**
 * Orchestrator sub-gateway (ADR §4.2 / WP2) — the security primitive
 * that lets a spawned agent become a *scoped* orchestrator without
 * handing it the daemon's full toolset.
 *
 * The plain `/mcp` endpoint registers EVERY tool (execute_command,
 * fs_*, remote_*, import_mcp, terminals, driver CRUD) and bypasses auth
 * on loopback — pointing a child at it would be a privilege handout.
 * This module builds a second, scoped MCP server that registers ONLY a
 * curated orchestration allowlist, gated by an unguessable per-child
 * scope-token. The HTTP layer mounts it at `/mcp/orchestrator`
 * (`http-server.ts`); WP3 will auto-mint a token and inject the URL at
 * spawn time. WP2 only builds the primitive.
 *
 * Three pieces:
 *   - DEFAULT_ORCHESTRATOR_TOOLS — the curated allowlist.
 *   - createScopeTokenRegistry() — mint / verify / revoke scope-tokens.
 *   - createOrchestratorMcpServerFactory() — build a scoped server for
 *     a verified scope.
 */

import { randomBytes } from "node:crypto"
import { createMcpServer } from "@agentproto/mcp-server"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import { registerSessionTools } from "./session-tools.js"
import { registerOrchestrationTools } from "./orchestration-tools.js"
import { withToolSubset } from "./tool-subset.js"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionEventBus } from "./session-event-bus.js"
import type { EventRing } from "./event-ring.js"
import type { CompletionPolicySupervisor } from "./supervisor.js"
import type {
  AgentAdapterResolver,
  AgentAdapterLister,
} from "./http-server.js"

/**
 * The curated set of tools a scoped child orchestrator may call.
 *
 * INCLUDED — the orchestration primitives:
 *   start_agent_session, prompt_agent_session, get_agent_session_output,
 *   wait_for_any, poll_events  (spawn + drive + fan-in)
 *   list_sessions, list_agent_sessions, kill_agent_session  (observe +
 *     halt). NB: list/kill are NOT yet scoped to the child's own
 *     subtree — that subtree filter is WP4 (parentSessionId/depth). For
 *     WP2 they are exposed daemon-wide; documented debt.
 *
 * EXCLUDED — the danger surface (each a separate trust boundary):
 *   execute_command, terminal/PTY tools (raw shell), fs tools
 *   (read/write/delete file, create_directory, …), remote_* (publish
 *   the daemon to the internet), import_mcp / mcp_imported_* /
 *   list_discovered_mcps / remove_imported_mcp (widen the daemon's own
 *   MCP surface), and driver CRUD (create_/delete_/update_driver — these
 *   never register here because the scoped server is built with no
 *   doctype specs).
 */
export const DEFAULT_ORCHESTRATOR_TOOLS: readonly string[] = [
  "start_agent_session",
  "prompt_agent_session",
  "get_agent_session_output",
  "wait_for_any",
  "poll_events",
  "list_sessions",
  "list_agent_sessions",
  "kill_agent_session",
]

export interface OrchestratorScope {
  /** The opaque scope-token handed to (and presented by) the child. */
  token: string
  /** The effective tool allowlist for this scope (⊆ the default). */
  tools: ReadonlySet<string>
}

/**
 * Narrow a caller-requested tool list to ⊆ the default subset.
 *
 * The `{ tools: [...] }` form a caller supplies can only REMOVE tools,
 * never add: any name outside `DEFAULT_ORCHESTRATOR_TOOLS` is dropped.
 * Omitting `requested` yields the full default. This is the invariant
 * that stops a caller from widening their own scope.
 */
export function narrowOrchestratorTools(
  requested?: readonly string[],
): Set<string> {
  const def = new Set(DEFAULT_ORCHESTRATOR_TOOLS)
  if (!requested) return def
  return new Set(requested.filter(t => def.has(t)))
}

export interface ScopeTokenRegistry {
  /** Mint a fresh scope-token. `tools` (when given) narrows ⊆ default. */
  mint(opts?: { tools?: readonly string[] }): OrchestratorScope
  /** Resolve a presented token to its scope, or null when unknown. */
  verify(token: string | null | undefined): OrchestratorScope | null
  /** Drop a token (e.g. when the child session ends). */
  revoke(token: string): void
}

/**
 * In-memory registry of live scope-tokens. Tokens are random 256-bit
 * hex (unguessable, never persisted) — see ADR §5.3. Single-user-host
 * trust assumption mirrors the loopback auth bypass on `/mcp`.
 */
export function createScopeTokenRegistry(): ScopeTokenRegistry {
  const scopes = new Map<string, OrchestratorScope>()
  return {
    mint(opts) {
      const token = randomBytes(32).toString("hex")
      const scope: OrchestratorScope = {
        token,
        tools: narrowOrchestratorTools(opts?.tools),
      }
      scopes.set(token, scope)
      return scope
    },
    verify(token) {
      if (!token) return null
      return scopes.get(token) ?? null
    },
    revoke(token) {
      scopes.delete(token)
    },
  }
}

export interface OrchestratorGatewayDeps {
  workspace: string
  name?: string
  version?: string
  registry: SessionsRegistry
  sessionEvents: SessionEventBus
  eventRing: EventRing
  supervisor?: CompletionPolicySupervisor
  resolveAgentAdapter?: AgentAdapterResolver
  listAgentAdapters?: AgentAdapterLister
}

export type OrchestratorMcpServerFactory = (
  scope: OrchestratorScope,
) => Promise<McpServer>

/**
 * Build a factory that produces a scoped MCP server for a verified
 * scope. The server is created with NO doctype specs and NO workspace
 * (so no CRUD verbs, no `self_inspect`, no driver tools leak in), then
 * the orchestration passes run against a `withToolSubset` wrapper so
 * only `scope.tools` survive. Critically, `mcpProxy` and the PTY
 * factory are never wired here — import + terminal tools stay unwired
 * AND are excluded from the subset (defense in depth).
 */
export function createOrchestratorMcpServerFactory(
  deps: OrchestratorGatewayDeps,
): OrchestratorMcpServerFactory {
  return async (scope: OrchestratorScope): Promise<McpServer> => {
    const { server } = await createMcpServer({
      specs: [],
      name: `${deps.name ?? "agentproto-runtime"}-orchestrator`,
      version: deps.version ?? "0.1.0-alpha",
    })
    registerSessionTools(server, {
      registry: deps.registry,
      toolSubset: scope.tools,
      ...(deps.resolveAgentAdapter
        ? { resolveAgentAdapter: deps.resolveAgentAdapter }
        : {}),
      ...(deps.listAgentAdapters
        ? { listAgentAdapters: deps.listAgentAdapters }
        : {}),
    })
    registerOrchestrationTools(server, {
      registry: deps.registry,
      sessionEvents: deps.sessionEvents,
      eventRing: deps.eventRing,
      toolSubset: scope.tools,
      ...(deps.supervisor ? { supervisor: deps.supervisor } : {}),
    })
    return server
  }
}
