/**
 * MCP tools that expose the sessions registry to agents connected to
 * the daemon. This module is now a FACADE over the agent-session,
 * terminal-session, session-tree, and MCP-import tool families.
 *
 * The agent-family tools live in `agent-tools.ts` and are imported here
 * so existing callers of `registerSessionTools` continue to work
 * unchanged.
 *
 * Lets a remote operator (Mastra agent in cloud Guilde,
 * Claude Code as a sub-agent, …) spawn + drive agent CLIs on the
 * user's machine through the same MCP connection they already use
 * for fs/exec.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { SessionDescriptor, SessionsRegistry } from "./sessions.js"
import { registerAgentTools, registerExportSessionTool, collectSubtree } from "./agent-tools.js"
import type { RegisterAgentToolsOptions } from "./agent-tools.js"
import { discoverMcps } from "./mcp-discovery.js"
import {
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
  tokenizeCommand,
} from "./resume-strategies.js"
import {
  loadImportedMcps,
  saveImportedMcps,
  addImport,
  removeImport,
} from "./mcp-imports.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import { projectSessionUsage } from "./usage.js"
import { withToolSubset } from "./tool-subset.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import type { AgentAdapterResolver, AgentAdapterLister } from "./http-server.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  getActiveWorkspace,
} from "./workspaces-config.js"

/** Re-exported from agent-tools.ts for backwards compatibility. */
export { stripAnsi } from "./agent-tools.js"

/**
 * One node in the session-tree output (WP5). Mirrors the descriptor
 * fields most useful for observability + recursion, plus a `children`
 * array so consumers can walk the tree without building the index
 * themselves, and an `isOrchestrator` flag that's true when the
 * session spawned at least one child (i.e. any session carries its id
 * as `parentSessionId`).
 */
export interface SessionTreeNode {
  id: string
  label?: string
  status: string
  depth: number
  adapterSlug?: string
  parentSessionId?: string
  isOrchestrator: boolean
  children: SessionTreeNode[]
}

/**
 * Build a nested session tree from a (scoped) flat list. Roots are
 * sessions whose `parentSessionId` is absent or points outside the
 * provided list (the list is already scoped when called from the
 * tool handler). Each root carries its descendants as nested
 * `children`, breadth-first insertion, depth-sorted within siblings.
 *
 * Exported for testing.
 */
export function buildSessionTree(
  sessions: readonly import("./sessions.js").SessionDescriptor[],
): SessionTreeNode[] {
  const idSet = new Set(sessions.map(s => s.id))
  // Build parent→children index.
  const childrenOf = new Map<string, import("./sessions.js").SessionDescriptor[]>()
  for (const s of sessions) {
    if (s.parentSessionId && idSet.has(s.parentSessionId)) {
      const arr = childrenOf.get(s.parentSessionId)
      if (arr) arr.push(s)
      else childrenOf.set(s.parentSessionId, [s])
    }
  }
  // Identify nodes that spawned at least one child (isOrchestrator).
  const orchestratorIds = new Set(childrenOf.keys())

  const toNode = (s: import("./sessions.js").SessionDescriptor): SessionTreeNode => ({
    id: s.id,
    ...(s.label ? { label: s.label } : {}),
    status: s.status,
    depth: s.depth ?? 0,
    ...(s.adapterSlug ? { adapterSlug: s.adapterSlug } : {}),
    ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
    isOrchestrator: orchestratorIds.has(s.id),
    children: (childrenOf.get(s.id) ?? [])
      .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))
      .map(toNode),
  })

  // Roots: no parentSessionId, or parent is outside the scoped list.
  return sessions
    .filter(s => !s.parentSessionId || !idSet.has(s.parentSessionId))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map(toNode)
}

export interface RegisterSessionToolsOptions {
  registry: SessionsRegistry
  /** Optional adapter resolver — required for `agent_start`
   *  (the others work with raw spawn sessions too). When unset the
   *  start tool returns a clear error pointing at the host wiring. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional adapter lister — when wired, exposes `adapter_list`
   *  MCP tool. Without it the tool returns a clear "not configured"
   *  error pointing at the host wiring. */
  listAgentAdapters?: AgentAdapterLister
  /** Forwarded to `registerAgentTools` — the daemon's own plain `/mcp`
   *  gateway URL, defaulted onto `hermes` `agent_start` spawns that
   *  pass no `mcpServers`. See `RegisterAgentToolsOptions.daemonMcpUrl`. */
  daemonMcpUrl?: string
  /** Optional MCP proxy registry — when wired, exposes 3 tools that
   *  let the operator drive imported MCPs (chrome-devtools, goose-bridge,
   *  …) through the daemon as a single MCP entry point. */
  mcpProxy?: McpProxyRegistry
  /** Whether the registry was constructed with a PTY factory — when
   *  true, expose the four terminal session tools. When false, the
   *  tools return a clear "not configured" error. */
  ptyEnabled?: boolean
  /** Optional allowlist — when set, only tools whose name is in the
   *  set are registered (the scoped orchestrator sub-gateway, WP2).
   *  Omitted → register everything, today's behaviour. */
  toolSubset?: ReadonlySet<string>
  /** Optional orchestrator-injection builder (WP3). When wired, the
   *  `orchestrator` field on `agent_start` mints a scoped
   *  sub-gateway token, builds the `mcpServers` entry pointing the
   *  child at `/mcp/orchestrator?scope=<token>`, and returns a
   *  `bindLifecycle` hook the handler calls (with the spawned session
   *  id) so the token is revoked when that session exits. Closed over
   *  the gateway's scope-token registry + HTTP port + session-event
   *  bus in `createGateway`. Omitted → `orchestrator` is rejected with
   *  a clear "not enabled" error. */
  buildOrchestratorMcp?: RegisterAgentToolsOptions["buildOrchestratorMcp"]
  /** Calling orchestrator's scope (orchestrator WP4). Present ONLY on
   *  the scoped sub-gateway server (built per-request from a verified
   *  scope-token), absent on the root `/mcp` server. When present it is
   *  the identity of the orchestrator driving these tools, so:
   *    - spawns are attributed (`parentSessionId = ownerSessionId`,
   *      `depth = depth + 1`) and gated by the depth cap + child quota;
   *    - `session_list`/`agent_sessions_list`/`agent_kill` are
   *      restricted to the caller's subtree.
   *  Absent → full visibility, depth-0 spawns, no parent (today's root
   *  behaviour). */
  callerScope?: OrchestratorScope
  /** Optional webhook notifier — when provided, per-session `notifyUrl`
   *  values from `agent_start` are registered on spawn and
   *  unregistered on exit via the session-event bus. */
  webhookNotifier?: WebhookNotifier
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.loadRoleRegistry`. */
  loadRoleRegistry?: RegisterAgentToolsOptions["loadRoleRegistry"]
}

/** MCP clients commonly stringify scalar arguments ("true"/"false"/"42").
 *  These coercers let a flag work whether the client sends a real JSON
 *  boolean/number or its string form — avoids opaque "expected boolean,
 *  received string" validation errors over the wire. */
const mcpBool = z.preprocess(
  v => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
)

export function registerSessionTools(
  rawServer: McpServer,
  opts: RegisterSessionToolsOptions
): void {
  // When a subset is requested, every `server.tool(...)` below is
  // filtered through this one guard (ADR §4.2). No subset → raw server.
  const server = opts.toolSubset
    ? withToolSubset(rawServer, opts.toolSubset)
    : rawServer
  const {
    registry,
    mcpProxy,
    callerScope,
    resolveAgentAdapter,
  } = opts
  const ptyEnabled = opts.ptyEnabled === true

  // Delegate the agent-family tools to the dedicated module.
  registerAgentTools(server, opts)

  // ── session_list (canonical lister) ──────────────────────────
  server.tool(
    "session_list",
    "List sessions tracked by the daemon — agent-CLI sessions (claude-code, " +
      "hermes, …), terminal/PTY sessions (claude TUI, bash, …), and raw " +
      "commands. Each entry includes `kind`, `pty` (true for real PTYs), " +
      "`name` (when set at spawn), `status`, `command`, age + exit code. Use " +
      "this when you need to know what's already running before spawning " +
      "anything new, or to discover a session id by name.",
    {
      kind: z
        .enum(["terminal", "agent-cli", "command", "all"])
        .optional()
        .describe(
          "Filter by session kind. `all` (default) returns every kind. " +
            "Use `terminal` to list only PTY sessions, `agent-cli` for " +
            "structured ACP agents.",
        ),
      onlyAlive: z
        .boolean()
        .optional()
        .describe("When true, only running/starting sessions. Default false."),
      status: z
        .enum(["starting", "running", "exited", "killed", "error"])
        .optional()
        .describe("Filter by exact status (overrides onlyAlive)."),
    },
    async input => {
      let rows = registry.list()
      // Subtree scoping (WP4): on the scoped sub-gateway a child
      // orchestrator only sees the sessions in its own subtree, never
      // the whole daemon.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      if (input.kind && input.kind !== "all") {
        rows = rows.filter(s => s.kind === input.kind)
      }
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessions: rows }, null, 2) },
        ],
      }
    },
  )

  // ── session_usage ────────────────────────────────────────────────
  server.tool(
    "session_usage",
    "Return the usage accounting for one session — model, cumulative cost " +
      "(USD), input/output token counts, and the latest context-window size / " +
      "tokens-in-context. `source` says where `costUsd` came from: `adapter` " +
      "(the adapter's own usage reader, e.g. hermes state.db, or a usage_update " +
      "cost block), `computed` (tokens priced against agentproto's in-repo LLM " +
      "catalog), `no-pricing` (tokens present but the model isn't in the catalog " +
      "— cost is deliberately omitted, never fabricated), or `none` (nothing " +
      "measured). Absent fields are omitted rather than zeroed. Same lookup as " +
      "`session_list` / `session_restart` (by id or name).",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`, alive or historical."),
    },
    async input => {
      const desc = registry.findByIdOrName(input.idOrName)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `no session "${input.idOrName}" found` }),
            },
          ],
          isError: true,
        }
      }
      // Subtree scoping (WP4): mirror session_restart — a scoped orchestrator
      // only sees usage for sessions in its own subtree.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list())
        if (!subtree.has(desc.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_usage: session "${desc.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only inspect sessions it (transitively) spawned.",
                  sessionId: desc.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      const usage = projectSessionUsage(desc)
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessionId: desc.id, ...usage }, null, 2) },
        ],
      }
    },
  )

  // ── terminal_sessions_list ──────────────────────────────────────
  server.tool(
    "terminal_sessions_list",
    "List terminal/PTY sessions tracked by the daemon. Equivalent to `session_list({kind: 'terminal'})`. " +
      "Each entry includes `kind`, `pty`, `status`, age, etc. Use this when you only want " +
      "the terminal subset.",
    {
      kind: z
        .enum(["terminal", "agent-cli", "command", "all"])
        .optional()
        .describe(
          "Optional override of the default `terminal` filter. `all` returns every kind."
        ),
      onlyAlive: z
        .boolean()
        .optional()
        .describe("When true, only running/starting sessions. Default false."),
      status: z
        .enum(["starting", "running", "exited", "killed", "error"])
        .optional()
        .describe("Filter by exact status (overrides onlyAlive)."),
    },
    async input => {
      let rows = registry.list()
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      const kind = input.kind ?? "terminal"
      if (kind !== "all") {
        rows = rows.filter(s => s.kind === kind)
      }
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessions: rows }, null, 2) },
        ],
      }
    },
  )

  // ── command_list ────────────────────────────────────────────────
  server.tool(
    "command_list",
    "List command sessions tracked by the daemon. Equivalent to `session_list({kind: 'command'})`. " +
      "Each entry includes `kind`, `status`, age, exit code, etc. Use this when you only want " +
      "the command subset.",
    {
      kind: z
        .enum(["terminal", "agent-cli", "command", "all"])
        .optional()
        .describe(
          "Optional override of the default `command` filter. `all` returns every kind."
        ),
      onlyAlive: z
        .boolean()
        .optional()
        .describe("When true, only running/starting sessions. Default false."),
      status: z
        .enum(["starting", "running", "exited", "killed", "error"])
        .optional()
        .describe("Filter by exact status (overrides onlyAlive)."),
    },
    async input => {
      let rows = registry.list()
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      const kind = input.kind ?? "command"
      if (kind !== "all") {
        rows = rows.filter(s => s.kind === kind)
      }
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessions: rows }, null, 2) },
        ],
      }
    },
  )

  // ── mcp_discovered_list ───────────────────────────────────────
  server.tool(
    "mcp_discovered_list",
    "Discover MCP servers already configured in the user's other agent " +
      "tooling (claude-code, cursor, goose). Returns the union with source " +
      "attribution so the operator can suggest 'I see you have a chrome-devtools " +
      "MCP set up in claude — want me to use it?' instead of asking the user " +
      "to re-configure. Read-only — does not modify any host's config.",
    {},
    async () => {
      try {
        const mcps = await discoverMcps()
        return {
          content: [{ type: "text", text: JSON.stringify({ mcps }, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_discovered_list failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── mcp_imported_list ─────────────────────────────────────────
  server.tool(
    "mcp_imported_list",
    "Return the user's curated set of MCP servers — the ones they've " +
      "imported from claude / cursor / workspace configs into the daemon. " +
      "Use to know which MCPs the operator may freely call vs. ones still " +
      "showing up in `mcp_discovered_list` waiting on the user's blessing.",
    {},
    async () => {
      try {
        const config = await loadImportedMcps()
        return {
          content: [
            { type: "text", text: JSON.stringify(config, null, 2) },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_list failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── mcp_import ─────────────────────────────────────────────────
  server.tool(
    "mcp_import",
    "Import a discovered MCP into the daemon's curated set. The agent " +
      "calls `mcp_discovered_list` first, asks the user, then commits the " +
      "choice via this tool. The snapshot is captured at import time so " +
      "the entry stays usable if the source config (claude/cursor) is " +
      "later removed.",
    {
      sourceMcpId: z
        .string()
        .min(1)
        .describe(
          "The discovered MCP id from `mcp_discovered_list` " +
            "(e.g. 'claude-code:project:/path:chrome-devtools')."
        ),
      alias: z
        .string()
        .optional()
        .describe(
          "Optional friendly name to display. Defaults to the source MCP's name."
        ),
    },
    async input => {
      try {
        const discovered = await discoverMcps()
        const snapshot = discovered.find(d => d.id === input.sourceMcpId)
        if (!snapshot) {
          return {
            content: [
              {
                type: "text",
                text: `mcp_import: discovered MCP "${input.sourceMcpId}" not found. Re-run mcp_discovered_list to get current ids.`,
              },
            ],
            isError: true,
          }
        }
        const cfg = await loadImportedMcps()
        const next = addImport(cfg, {
          snapshot,
          ...(input.alias ? { alias: input.alias } : {}),
        })
        await saveImportedMcps(next)
        const entry = next.imports.find(e => e.id === snapshot.id)
        return {
          content: [{ type: "text", text: JSON.stringify(entry, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_import failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── mcp_imported_remove ────────────────────────────────────────
  server.tool(
    "mcp_imported_remove",
    "Remove a previously-imported MCP from the daemon's curated set. " +
      "Use when the user no longer wants the operator referencing it.",
    {
      id: z
        .string()
        .min(1)
        .describe(
          "The imported MCP id (matches the discovered MCP id at import time)."
        ),
    },
    async input => {
      try {
        const cfg = await loadImportedMcps()
        if (!cfg.imports.some(e => e.id === input.id)) {
          return {
            content: [
              {
                type: "text",
                text: `mcp_imported_remove: id "${input.id}" not in imports. Use mcp_imported_list to see current entries.`,
              },
            ],
            isError: true,
          }
        }
        await saveImportedMcps(removeImport(cfg, input.id))
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: true, id: input.id }, null, 2) },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_remove failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── mcp_imported_status ────────────────────────────────────────
  // The 3 proxy tools share the same wiring guard — register them
  // only when the host injected a proxy registry, otherwise emit a
  // clear "not enabled" error so the agent doesn't think the daemon
  // silently dropped the call.
  server.tool(
    "mcp_imported_status",
    "Snapshot every imported MCP server with its connection status, " +
      "transport type, and tool count. Use this first when an operator " +
      "wonders 'what MCPs do I actually have access to right now?' — the " +
      "answer covers both 'imported but not yet connected' and 'connected " +
      "with N tools'. Errors during connect surface in `lastError`.",
    {},
    async () => {
      if (!mcpProxy) {
        return {
          content: [
            {
              type: "text",
              text:
                "mcp_imported_status is not enabled — daemon was started without " +
                "an MCP proxy. The host must wire `mcpProxy` in createGateway.",
            },
          ],
          isError: true,
        }
      }
      try {
        const aliases = await mcpProxy.listAliases()
        return {
          content: [
            { type: "text", text: JSON.stringify({ imports: aliases }, null, 2) },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_status failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── mcp_imported_tool_list ────────────────────────────────────
  server.tool(
    "mcp_imported_tool_list",
    "List the tools exposed by one imported MCP server. The proxy " +
      "lazily connects on first call — first-use latency includes the " +
      "transport handshake (stdio: ~1-2s for npx-spawned servers; " +
      "http/sse: <100ms). Returns the upstream `inputSchema` (JSON " +
      "Schema) verbatim so the operator can build a valid `arguments` " +
      "object for the follow-up `mcp_imported_call` invocation.",
    {
      alias: z
        .string()
        .min(1)
        .describe(
          "Alias from `mcp_imported_list` / `mcp_imported_status` " +
            "(typically the original MCP name, e.g. 'chrome-devtools')."
        ),
    },
    async input => {
      if (!mcpProxy) {
        return {
          content: [
            {
              type: "text",
              text: "mcp_imported_tool_list is not enabled — see mcp_imported_status.",
            },
          ],
          isError: true,
        }
      }
      const out = await mcpProxy.listTools(input.alias)
      if (!out.ok) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_tool_list "${input.alias}": ${out.error}`,
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ alias: input.alias, tools: out.tools }, null, 2) },
        ],
      }
    }
  )

  // ── mcp_imported_call ──────────────────────────────────────────
  server.tool(
    "mcp_imported_call",
    "Invoke a tool on an imported MCP server. The daemon proxies the " +
      "call through the live client connection — the upstream server " +
      "validates `arguments` against its own input schema (which you " +
      "can fetch via `mcp_imported_tool_list`). The full upstream " +
      "result is returned verbatim, including `isError` flags so the " +
      "operator sees the original failure shape.",
    {
      alias: z.string().min(1).describe("Imported MCP alias."),
      toolName: z
        .string()
        .min(1)
        .describe(
          "Tool name as it appears in `mcp_imported_tool_list` " +
            "(NOT a namespaced version — pass the upstream's own name)."
        ),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Tool arguments as a JSON object. Schema is the upstream's " +
            "— the proxy doesn't validate, only forwards. Default: empty object."
        ),
    },
    async input => {
      if (!mcpProxy) {
        return {
          content: [
            {
              type: "text",
              text: "mcp_imported_call is not enabled — see mcp_imported_status.",
            },
          ],
          isError: true,
        }
      }
      const out = await mcpProxy.callTool(
        input.alias,
        input.toolName,
        input.args ?? {}
      )
      if (!out.ok) {
        return {
          content: [
            {
              type: "text",
              text: `mcp_imported_call "${input.alias}".${input.toolName}: ${out.error}`,
            },
          ],
          isError: true,
        }
      }
      // Forward the upstream result. The MCP SDK's CallToolResult is
      // already in the {content, isError?} shape we return — pass it
      // through with a note that it came from the proxy.
      return out.result as {
        content: Array<{ type: "text"; text: string }>
        isError?: boolean
      }
    }
  )

  // ── session_tree (WP5) ────────────────────────────────────────
  server.tool(
    "session_tree",
    "Return the orchestrator session hierarchy as a nested tree. Each root " +
      "is a session with no parent (or whose parent is outside the visible scope); " +
      "its `children` array holds direct sub-sessions, recursively. Each node " +
      "carries `id`, `label`, `status`, `depth`, `adapterSlug`, `parentSessionId`, " +
      "and `isOrchestrator` (true when the session itself spawned sub-agents). " +
      "Via a scoped orchestrator token only the caller's subtree is returned; " +
      "from the root `/mcp` endpoint the full daemon tree is visible.",
    {
      onlyAlive: z
        .boolean()
        .optional()
        .describe(
          "When true, only include sessions with status running/starting. " +
            "Pruned nodes also hide their subtree. Default false.",
        ),
    },
    async input => {
      let rows = registry.list()
      // Subtree scoping (WP5 / WP4): same gate as session_list.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      const tree = buildSessionTree(rows)
      return {
        content: [
          { type: "text", text: JSON.stringify({ tree }, null, 2) },
        ],
      }
    },
  )

  // ── Terminal session tools ─────────────────────────────────────
  // Four tools that mirror the agent-session set but operate on raw
  // PTY sessions (real terminal, ANSI bytes, multi-subscriber). Use
  // these to drive interactive CLIs like `claude` in TUI mode, or
  // for one agent to orchestrate other shells. Read/write/exit
  // happen over the byte ring buffer; the WS at /sessions/:id/pty
  // is the streaming alternative.

  const ptyNotConfigured = (toolName: string): {
    content: Array<{ type: "text"; text: string }>
    isError: true
  } => ({
    content: [
      {
        type: "text",
        text:
          `${toolName}: PTY support not enabled — the daemon was started without ` +
          "a node-pty factory. Re-run `agentproto serve` from a build that ships " +
          "node-pty (the optional dep ships with @agentproto/cli).",
      },
    ],
    isError: true,
  })

  // ── session_restart ──────────────────────────────────────────────
  // In-process equivalent of `agentproto sessions restart <id>` — the
  // CLI has to shape an HTTP body and POST it back to this same daemon
  // because it's a separate process; here we can go straight to the
  // registry + adapter resolver. Both sides share `decideRestartStrategy`
  // (resume-strategies.ts) so the two surfaces never diverge on which
  // resume path wins.
  server.tool(
    "session_restart",
    "Respawn a session that has exited or been killed, preferring conversation " +
      "continuity over a blank restart. Looks up the (possibly historical) " +
      "descriptor by id or name — same lookup as `session_list` — and picks " +
      "the same resume strategy `agentproto sessions restart` uses on the CLI: " +
      "provider-native resume (spawns a PTY running the provider's own resume " +
      "command, e.g. `claude --resume <id>`) when the adapter persisted one; " +
      "else ACP-level resume via the adapter's own session id (retried as a " +
      "fresh spawn if the adapter rejects the id with \"not found\" — typical " +
      "when the prior session died before its first turn); else a plain PTY " +
      "re-run for raw terminal sessions with no adapter match. Generic " +
      "`command` sessions have no resume path and return an error. Returns " +
      "the NEW session's descriptor plus `resumedFrom` (the prior id) and " +
      "`resumeVia` (which path was used, empty string for a fresh respawn).",
    {
      idOrName: z
        .string()
        .min(1)
        .describe(
          "Session id or name to restart — from `session_list`, alive or " +
            "historical (killed/exited/error)."
        ),
      cols: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "PTY cols — only used when the restart resolves to a provider-native " +
            "or plain PTY resume. Default 80."
        ),
      rows: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("PTY rows — same case as `cols`. Default 24."),
    },
    async input => {
      const prev = registry.findByIdOrName(input.idOrName)
      if (!prev) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `no session "${input.idOrName}" found` }),
            },
          ],
          isError: true,
        }
      }
      // Subtree scoping (WP4): mirrors agent_kill — a child orchestrator
      // may only restart sessions it (transitively) spawned.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list())
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_restart: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only restart sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }

      const augmented = await augmentWithFsResume(prev)
      const strategy = decideRestartStrategy(augmented)

      if (strategy.kind === "unsupported") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: strategy.reason, sessionId: prev.id }),
            },
          ],
          isError: true,
        }
      }

      // cwd resolution mirrors /sessions/agent + /sessions/terminal:
      // the prior descriptor's cwd is authoritative (it's how the
      // session was actually running); fall back to the daemon's own
      // cwd only for a legacy row that predates the field.
      let cwd = prev.cwd
      if (!cwd) {
        cwd = process.cwd()
        console.warn(
          `[session_restart] no cwd on prior descriptor ${prev.id} — falling back to daemon's cwd ${cwd}`
        )
      }

      try {
        if (strategy.kind === "pty-native" || strategy.kind === "pty-plain") {
          if (!ptyEnabled) return ptyNotConfigured("session_restart")
          const argv =
            strategy.kind === "pty-native"
              ? strategy.argv
              : Array.isArray(prev.argv) && prev.argv.length > 0
                ? [...prev.argv]
                : tokenizeCommand(prev.command)
          const desc = registry.spawnPty({
            argv,
            cwd,
            workspaceSlug: prev.workspaceSlug,
            cols: input.cols ?? 80,
            rows: input.rows ?? 24,
            ...(prev.name ? { name: prev.name } : {}),
            ...(prev.label ? { label: prev.label } : {}),
          })
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ...desc, resumedFrom: prev.id, resumeVia: describeResumePath(augmented) },
                  null,
                  2
                ),
              },
            ],
          }
        }

        // strategy.kind === "agent" — decideRestartStrategy only returns
        // this when `adapterSlug` is set, but TS can't see across the
        // two objects, so re-check at runtime rather than casting.
        const adapterSlug = prev.adapterSlug
        if (!adapterSlug) {
          return {
            content: [
              {
                type: "text",
                text: "session_restart: internal error — agent resume strategy without adapterSlug",
              },
            ],
            isError: true,
          }
        }
        if (!resolveAgentAdapter) {
          return {
            content: [
              {
                type: "text",
                text:
                  "session_restart: agent_start is not enabled — the daemon was started " +
                  "without an adapter resolver.",
              },
            ],
            isError: true,
          }
        }
        const resolved = await resolveAgentAdapter(adapterSlug)
        if (!resolved) {
          return {
            content: [
              { type: "text", text: `session_restart: adapter "${adapterSlug}" not found.` },
            ],
            isError: true,
          }
        }
        const spawnWithResume = async (
          resumeSessionId?: string
        ): Promise<SessionDescriptor> => {
          let liveSessionId: string | undefined
          const agentSession = await resolved.startSession({
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(prev.model ? { model: prev.model } : {}),
            ...(prev.mcpServers ? { mcpServers: prev.mcpServers } : {}),
            onActivity: () => {
              if (liveSessionId) registry.pulseActivity(liveSessionId)
            },
          })
          const desc = registry.spawnAgent({
            workspaceSlug: prev.workspaceSlug,
            cwd,
            agentSession,
            adapterSlug,
            ...(prev.label ? { label: prev.label } : {}),
            ...(prev.mcpServers ? { mcpServers: prev.mcpServers } : {}),
            ...(prev.model ? { model: prev.model } : {}),
            ...(resolved.commandPreview ? { commandPreview: resolved.commandPreview } : {}),
          })
          liveSessionId = desc.id
          return desc
        }

        let desc: SessionDescriptor
        let resumeFallback = false
        try {
          desc = await spawnWithResume(strategy.resumeSessionId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // Adapter doesn't recognize the resume id — typically means the
          // prior session never got past the spawn (no turn happened).
          // Retry as a fresh spawn so the caller at least gets the agent
          // back, same fallback the CLI's `sessions restart` applies.
          if (strategy.resumeSessionId && /not found|Resource not found/i.test(msg)) {
            desc = await spawnWithResume(undefined)
            resumeFallback = true
          } else {
            throw err
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...desc,
                  resumedFrom: prev.id,
                  resumeVia: resumeFallback ? "" : describeResumePath(augmented),
                  ...(resumeFallback ? { resumeFallback: true } : {}),
                },
                null,
                2
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_restart: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  server.tool(
    "terminal_start",
    "Spawn a process under a real PTY (node-pty) on the host. Bytes (including " +
      "ANSI escapes, alt-screen sequences) flow through the daemon's byte ring " +
      "buffer; subscribers attach via the WS at /sessions/:id/pty. Use for " +
      "interactive TUIs (claude, vim, htop) or to orchestrate shells from another " +
      "agent. Returns the session descriptor.",
    {
      argv: z
        .array(z.string())
        .min(1)
        .describe(
          "Argv array. First element is the binary, rest are arguments. " +
            "e.g. ['claude'] or ['bash', '-l']."
        ),
      workspaceSlug: z
        .string()
        .optional()
        .describe(
          "Workspace slug from `agentproto workspace list`. Resolves cwd. Omit " +
            "to use `cwd` explicitly or the active workspace."
        ),
      cwd: z
        .string()
        .optional()
        .describe("Absolute cwd. Wins over workspaceSlug when both set."),
      cols: z.number().int().min(1).max(500).optional().describe("Initial cols. Default 80."),
      rows: z.number().int().min(1).max(200).optional().describe("Initial rows. Default 24."),
      name: z
        .string()
        .optional()
        .describe(
          "User-friendly slug. Becomes an alias for the session id in " +
            "subsequent tool calls (read/write/kill accept either)."
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Free-text label surfaced in agent_sessions_list and the UI."
        ),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("terminal_start")
      let cwd = input.cwd
      let resolvedSlug = input.workspaceSlug ?? "default"
      if (!cwd) {
        try {
          const config = await loadWorkspacesConfig()
          const ws = input.workspaceSlug
            ? findWorkspace(config, input.workspaceSlug)
            : getActiveWorkspace(config)
          if (ws) {
            cwd = ws.path
            resolvedSlug = ws.slug
          }
        } catch {
          // fall through to error
        }
      }
      if (!cwd) {
        return {
          content: [
            {
              type: "text",
              text:
                "terminal_start: no cwd resolvable. Pass `cwd` explicitly " +
                "or `workspaceSlug` matching `agentproto workspace list`.",
            },
          ],
          isError: true,
        }
      }
      try {
        const desc = registry.spawnPty({
          argv: input.argv,
          cwd,
          workspaceSlug: resolvedSlug,
          cols: input.cols ?? 80,
          rows: input.rows ?? 24,
          ...(input.name ? { name: input.name } : {}),
          ...(input.label ? { label: input.label } : {}),
        })
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `terminal_start: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  server.tool(
    "terminal_input",
    "Send keystrokes to a PTY session's stdin. The text is forwarded verbatim — " +
      "include trailing newlines if the target needs them (e.g. shell commands). " +
      "Use after `terminal_start` to drive an interactive CLI. Set `enter: true` " +
      "to append a carriage return (\\r) so a TUI composer (e.g. Claude Code) " +
      "submits — LF alone won't. Use `b64` to send exact control bytes " +
      "(CR, arrows, Esc, Ctrl-*) that JSON can't carry cleanly.",
    {
      sessionId: z
        .string()
        .describe("Session id OR name from terminal_start."),
      text: z
        .string()
        .optional()
        .describe("Text to write. Sent as-is to the PTY's stdin."),
      enter: z
        .boolean()
        .optional()
        .describe(
          "Append a carriage return (\\r) after the text so a TUI composer " +
            "(e.g. Claude Code) submits."
        ),
      b64: z
        .string()
        .optional()
        .describe(
          "Base64-encoded exact bytes to send instead of/around `text` (for " +
            "control keys: CR, arrows, Esc, Ctrl-*). Decoded and written verbatim."
        ),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("terminal_input")
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: `terminal_input: no session "${input.sessionId}"`,
            },
          ],
          isError: true,
        }
      }
      let payload =
        input.b64 !== undefined
          ? Buffer.from(input.b64, "base64").toString("utf8")
          : (input.text ?? "")
      if (input.enter) payload += "\r"
      if (input.b64 === undefined && input.text === undefined && !input.enter) {
        return {
          content: [
            {
              type: "text",
              text: "terminal_input: provide at least one of `text`, `b64`, or `enter`.",
            },
          ],
          isError: true,
        }
      }
      const ok = registry.writeTerminalInput(desc.id, payload)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId: desc.id }, null, 2),
          },
        ],
        ...(ok ? {} : { isError: true as const }),
      }
    }
  )

  server.tool(
    "terminal_output",
    "Snapshot the recent byte buffer of a PTY session. Returns base64-encoded " +
      "bytes (the buffer is RAW including ANSI escapes — strip with a regex if " +
      "you want plain text). `lastBytes` caps the read from the tail.",
    {
      sessionId: z
        .string()
        .describe("Session id OR name from terminal_start."),
      lastBytes: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024)
        .optional()
        .describe("Max bytes from the tail. Default: full ring buffer (~64 KiB)."),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("terminal_output")
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: `terminal_output: no session "${input.sessionId}"`,
            },
          ],
          isError: true,
        }
      }
      const buf = registry.readTerminalOutput(
        desc.id,
        input.lastBytes,
      )
      if (!buf) {
        return {
          content: [
            {
              type: "text",
              text: `terminal_output: session "${desc.id}" is not a PTY`,
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: desc.id,
                status: desc.status,
                bytes: buf.byteLength,
                b64: buf.toString("base64"),
              },
              null,
              2,
            ),
          },
        ],
      }
    }
  )

  server.tool(
    "terminal_kill",
    "SIGTERM a PTY session and drop it from the alive set. Same effect as " +
      "`agent_kill` for the PTY family — separate name so it's obvious " +
      "what's being stopped.",
    {
      sessionId: z
        .string()
        .describe("Session id OR name from terminal_start."),
    },
    async input => {
      if (!ptyEnabled) return ptyNotConfigured("terminal_kill")
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            {
              type: "text",
              text: `terminal_kill: no session "${input.sessionId}"`,
            },
          ],
          isError: true,
        }
      }
      const ok = registry.kill(desc.id)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId: desc.id }, null, 2),
          },
        ],
      }
    }
  )
}

/**
 * Re-exported from agent-tools.ts for backwards compatibility.
 * The canonical definition lives there; callers importing from this
 * module still compile.
 */
export { registerExportSessionTool, collectSubtree } from "./agent-tools.js"
export type { ExportSessionOps } from "./agent-tools.js"
