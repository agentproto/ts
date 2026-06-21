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
import type { AcpMcpServer } from "@agentproto/acp"

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
  "session_tree",
  "kill_agent_session",
  // WP6 — supervisor composition: a child orchestrator may attach /
  // inspect / cancel completion policies on sessions within its own
  // subtree. `ack_policy` is intentionally absent: triggering a host
  // commit is an operator-or-human gesture, not a child-orchestrator one.
  "attach_policy",
  "get_policy_status",
  "list_policies",
  "cancel_policy",
]

/**
 * Recursion guardrail defaults (ADR §4.5 / WP4).
 *   DEFAULT_MAX_DEPTH  — how deep the orchestrator tree may grow by
 *                        default (root spawns at depth 0; a session
 *                        spawned by a depth-d orchestrator is d+1, so
 *                        depth 3 means at most 4 levels: 0,1,2,3).
 *   HARD_MAX_DEPTH     — an unconditional ceiling the schema bound +
 *                        mint both clamp to, so no caller can lift the
 *                        cap past this even with an explicit request.
 *   DEFAULT_MAX_CHILDREN — per-orchestrator alive-child quota.
 */
export const DEFAULT_MAX_DEPTH = 3
export const HARD_MAX_DEPTH = 8
export const DEFAULT_MAX_CHILDREN = 8

export interface OrchestratorScope {
  /** The opaque scope-token handed to (and presented by) the child. */
  token: string
  /** The effective tool allowlist for this scope (⊆ the default and,
   *  for a recursively-spawned child, ⊆ its parent's allowlist). */
  tools: ReadonlySet<string>
  /**
   * Session id of the orchestrator that OWNS this token — i.e. the
   * child session that presents it back on `/mcp/orchestrator`. The
   * token is minted *before* the child session exists (the injector
   * needs the URL to compose the spawn), so this is bound late, after
   * `spawnAgent` returns the id, via `bindOwner`. Until bound, spawns
   * through this scope are attributed to no parent and its subtree is
   * empty (safe degradation). (ADR §4.5 / WP4) */
  ownerSessionId?: string
  /** Recursion depth of the owning orchestrator session. A spawn made
   *  *through* this scope produces a child at `depth + 1`. Root scopes
   *  (minted for a direct `/mcp` spawn) are depth 0. */
  depth: number
  /** Max recursion depth reachable through this scope. A spawn whose
   *  child depth (`depth + 1`) would exceed this is rejected. Clamped
   *  to `HARD_MAX_DEPTH`. */
  maxDepth: number
  /** Max concurrently-alive children the owning orchestrator may spawn
   *  before further spawns are rejected. */
  maxChildren: number
}

/**
 * Narrow a caller-requested tool list to ⊆ a ceiling subset.
 *
 * The `ceiling` is the maximum a caller may end up with — the global
 * `DEFAULT_ORCHESTRATOR_TOOLS` for a root scope, or the *parent's*
 * effective tools for a recursively-spawned child (non-re-grant: a
 * child can never widen beyond what its parent holds — ADR §4.5 #5).
 * The `{ tools: [...] }` form can only REMOVE from the ceiling, never
 * add: any name outside it is dropped. Omitting `requested` yields the
 * full ceiling. Omitting `ceiling` defaults to the global default.
 */
export function narrowOrchestratorTools(
  requested?: readonly string[],
  ceiling?: ReadonlySet<string>,
): Set<string> {
  const cap = ceiling ?? new Set(DEFAULT_ORCHESTRATOR_TOOLS)
  if (!requested) return new Set(cap)
  return new Set(requested.filter(t => cap.has(t)))
}

export interface MintScopeOptions {
  /** Caller-requested allowlist — narrowed ⊆ `ceiling` (or the default
   *  when no ceiling is given). */
  tools?: readonly string[]
  /** Upper bound on the minted tools (the parent's effective tools for
   *  a recursive child). Omit for a root scope (defaults to the global
   *  default subset). */
  ceiling?: ReadonlySet<string>
  /** Depth of the owning orchestrator (default 0). */
  depth?: number
  /** Max depth reachable through this scope (default DEFAULT_MAX_DEPTH,
   *  clamped to HARD_MAX_DEPTH). */
  maxDepth?: number
  /** Per-orchestrator alive-child quota (default DEFAULT_MAX_CHILDREN). */
  maxChildren?: number
}

export interface ScopeTokenRegistry {
  /** Mint a fresh scope-token. See `MintScopeOptions`. */
  mint(opts?: MintScopeOptions): OrchestratorScope
  /** Resolve a presented token to its scope, or null when unknown. */
  verify(token: string | null | undefined): OrchestratorScope | null
  /** Late-bind the owning child session id onto a minted scope (the
   *  token is minted before the child exists). No-op when the token is
   *  unknown. Mutates the live scope object so `verify` reflects it. */
  bindOwner(token: string, sessionId: string): void
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
        tools: narrowOrchestratorTools(opts?.tools, opts?.ceiling),
        depth: opts?.depth ?? 0,
        maxDepth: Math.min(opts?.maxDepth ?? DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
        maxChildren: opts?.maxChildren ?? DEFAULT_MAX_CHILDREN,
      }
      scopes.set(token, scope)
      return scope
    },
    verify(token) {
      if (!token) return null
      return scopes.get(token) ?? null
    },
    bindOwner(token, sessionId) {
      const scope = scopes.get(token)
      if (scope) scope.ownerSessionId = sessionId
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
  /** Orchestrator injector (WP3/WP4). When wired, a child orchestrator
   *  driving the scoped server can itself spawn sub-orchestrators
   *  (`orchestrator: true` on its `start_agent_session`) — the new
   *  token inherits depth+1 and is bounded by the caller's tools
   *  (non-re-grant). Omitted → recursion injection is unavailable on
   *  the scoped surface (a child can still spawn plain sub-agents). */
  orchestratorInjector?: OrchestratorInjector
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
      // The verified scope IS the calling orchestrator's identity:
      // spawns through this server are attributed to `scope.ownerSessionId`
      // at `scope.depth + 1`, depth/quota guards fire against it, and
      // list/kill are filtered to its subtree (WP4).
      callerScope: scope,
      ...(deps.orchestratorInjector
        ? { buildOrchestratorMcp: deps.orchestratorInjector }
        : {}),
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
      // WP6: pass the caller's scope so supervisor tools can enforce
      // subtree-scoped access (attach only to own sub-agents; list/cancel
      // only policies on own sub-agents; commit refused).
      callerScope: scope,
      ...(deps.supervisor ? { supervisor: deps.supervisor } : {}),
    })
    return server
  }
}

/**
 * The auto-injection assembly (ADR §4.4 / WP3) — turns the "make this
 * child an orchestrator" intent into the concrete `mcpServers` entry
 * the ACP `session/new` call mounts, plus the token lifecycle.
 *
 * One call (`inject`) does three things:
 *   1. mint a scope-token (narrowed ⊆ default when `tools` is given);
 *   2. build the `mcpServers` entry pointing the child at the daemon's
 *      own scoped sub-gateway (`/mcp/orchestrator?scope=<token>`);
 *   3. hand back `bindLifecycle(sessionId)` so the caller can revoke
 *      the token the moment that child session exits — no token leaks
 *      past the life of the session it was minted for.
 *
 * Assembled in `createGateway` (not the CLI resolver) because it needs
 * the gateway's scope-token registry, the session-event bus, and the
 * HTTP listener's port — all of which live there.
 */
export interface OrchestratorInjection {
  /** The `mcpServers` entry to merge into the child's `session/new`. */
  entry: AcpMcpServer
  /** The minted scope — `token` gates the endpoint, `tools` is the
   *  effective (narrowed) allowlist. */
  scope: OrchestratorScope
  /**
   * Revoke the scope-token once `sessionId` exits. Subscribes to the
   * session-event bus for that one session's `session:exited` and
   * self-unsubscribes on fire. Returns an unsubscribe in case the
   * caller wants to drop the binding early (rarely needed).
   */
  bindLifecycle(sessionId: string): () => void
}

export interface OrchestratorInjectorDeps {
  scopeTokens: ScopeTokenRegistry
  sessionEvents: SessionEventBus
  /** Port the daemon's HTTP listener (and thus `/mcp/orchestrator`)
   *  binds. The child reaches it over loopback. */
  port: number
  /** Loopback host for the injected `ref`. Always loopback — the child
   *  is co-located on the host. Default `127.0.0.1`. */
  host?: string
  /** `name` advertised on the injected `mcpServers` entry. The child
   *  sees its orchestration tools namespaced under this. Default
   *  `agentproto`. */
  entryName?: string
}

export type OrchestratorInjector = (opts?: {
  tools?: readonly string[]
  /** The calling orchestrator's scope, when this spawn arrives via the
   *  scoped sub-gateway (recursive spawn). The minted child token then
   *  inherits `depth = caller.depth + 1`, its tools are bounded by the
   *  caller's tools (non-re-grant — ADR §4.5 #5), and its depth/child
   *  limits never exceed the caller's. Omit for a root spawn (direct
   *  `/mcp`) → depth 0, full default subset, default limits. */
  caller?: OrchestratorScope
  /** Override the max depth reachable through the minted scope (clamped
   *  to the caller's, then to HARD_MAX_DEPTH). Root-only knob. */
  maxDepth?: number
  /** Override the per-orchestrator child quota for the minted scope
   *  (clamped to the caller's). Root-only knob. */
  maxChildren?: number
}) => OrchestratorInjection

/**
 * Build the orchestrator injector. Closed over the gateway's
 * scope-token registry + session-event bus + HTTP port. Returns a
 * function that the `start_agent_session` handler calls when its
 * `orchestrator` field is set.
 */
export function createOrchestratorInjector(
  deps: OrchestratorInjectorDeps,
): OrchestratorInjector {
  const host = deps.host ?? "127.0.0.1"
  const name = deps.entryName ?? "agentproto"
  return (opts) => {
    const caller = opts?.caller
    // A recursive child lands one level below its caller; a root spawn
    // (no caller) is depth 0. Limits never escalate past the caller's.
    const depth = caller ? caller.depth + 1 : 0
    const maxDepth = caller
      ? Math.min(opts?.maxDepth ?? caller.maxDepth, caller.maxDepth)
      : (opts?.maxDepth ?? DEFAULT_MAX_DEPTH)
    const maxChildren = caller
      ? Math.min(opts?.maxChildren ?? caller.maxChildren, caller.maxChildren)
      : (opts?.maxChildren ?? DEFAULT_MAX_CHILDREN)
    const scope = deps.scopeTokens.mint({
      ...(opts?.tools ? { tools: opts.tools } : {}),
      // Non-re-grant: bound the child's tools by the caller's effective
      // tools (not just the global default) — a child can never widen
      // beyond what its parent holds.
      ...(caller ? { ceiling: caller.tools } : {}),
      depth,
      maxDepth,
      maxChildren,
    })
    const entry: AcpMcpServer = {
      name,
      transport: "http",
      ref: `http://${host}:${deps.port}/mcp/orchestrator?scope=${scope.token}`,
    }
    const bindLifecycle = (sessionId: string): (() => void) => {
      // Late-bind the owner: the token was minted before this child
      // session existed; now that we have its id, attribute the scope to
      // it so its own spawns inherit `parentSessionId = sessionId` and
      // its subtree filters resolve.
      deps.scopeTokens.bindOwner(scope.token, sessionId)
      const off = deps.sessionEvents.on("session:exited", ev => {
        if (ev.sessionId !== sessionId) return
        deps.scopeTokens.revoke(scope.token)
        off()
      })
      return off
    }
    return { entry, scope, bindLifecycle }
  }
}
