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
import type { SessionsRegistry } from "./sessions.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"
import {
  registerAgentTools,
  registerExportSessionTool,
  collectSubtree,
  stripAnsi,
} from "./agent-tools.js"
import type { RegisterAgentToolsOptions } from "./agent-tools.js"
import { discoverMcps } from "./mcp-discovery.js"
import {
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
  tokenizeCommand,
  RESUME_STRATEGIES,
} from "./resume-strategies.js"
import {
  restartAgentSession,
  resolveResumeAuth,
  RestartOverrideError,
  type RestartOverrides,
} from "./session-restart-core.js"
import {
  loadImportedMcps,
  saveImportedMcps,
  addImport,
  removeImport,
} from "./mcp-imports.js"
import type { McpProxyRegistry } from "./mcp-proxy.js"
import { projectSessionUsage } from "./usage.js"
import { parseWindow, rollupUsage } from "./usage-rollup.js"
import {
  computeContextContinuityStatus,
  computeContextPct,
} from "./context-continuity.js"
import { buildContextCheckpoint, persistCheckpoint, renderCheckpointPrompt } from "./context-checkpoint.js"
import { continueAgentSessionFresh } from "./session-continue-fresh.js"
import type { SpawnAgentSessionDeps } from "./session-spawn.js"
import {
  collectSessionSnapshots,
  enrichRollupWithAccountCredits,
  enrichRollupWithProviderQuota,
} from "./usage-rollup-service.js"
import { withToolSubset } from "./tool-subset.js"
import { paginate, pageParamsShape, toolText } from "./tool-envelope.js"
import type { OrchestratorScope } from "./orchestrator-gateway.js"
import type { WebhookNotifier } from "./webhook-notifier.js"
import type {
  AgentAdapterResolver,
  AgentAdapterLister,
  AgentAdapterInstaller,
  CatalogModelsLister,
  AdapterCapabilitiesLister,
} from "./http-server.js"
import type { SandboxProviderResolver } from "./sandbox-adapters.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  findWorkspaceByPath,
  getActiveWorkspace,
} from "./workspaces-config.js"
import {
  resolveWorktreeQueryRoot,
  type WorktreeStatusLister,
} from "./worktree-status.js"
import { livingSessionCwds, type WorktreeGcRunner } from "./worktree-gc.js"

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
  currentPhase?: import("./sessions.js").SessionCurrentPhase
  secondsSinceLastActivity?: number
  toolCallsThisTurn?: number
  depth: number
  adapterSlug?: string
  parentSessionId?: string
  /** Source label this session was spawned from ("claude-code", "vscode",
   *  "cron", …) — the descriptor's `origin`. Present on every node, but it's
   *  the ROOT nodes (client-launched sessions) whose origin is the meaningful
   *  grouping key; see `groupRootsByOrigin`. */
  origin?: string
  isOrchestrator: boolean
  children: SessionTreeNode[]
}

/** The stable bucket key for a root with no `origin` on its descriptor (a
 *  client that connected without announcing a `clientInfo`, or an in-repo
 *  spawn that set none). Kept explicit so the grouped view never drops roots
 *  into an unlabeled void. */
export const UNKNOWN_ORIGIN = "unknown"

/**
 * One origin bucket: the source label and the root session subtrees launched
 * from it. Built by {@link groupRootsByOrigin} for the "group my sessions by
 * where they came from" view (claude-code desktop vs vscode extension vs
 * cron), which flat `parentSessionId` nesting can't express — a human-launched
 * root has no agent parent to nest under, so origin is its only cluster key.
 */
export interface OriginGroup {
  origin: string
  sessions: SessionTreeNode[]
}

/**
 * Group already-built tree ROOTS by their `origin`, preserving each root's
 * nested `children` untouched. Only top-level roots are bucketed — a child
 * keeps nesting under its real parent regardless of its own origin. Buckets
 * are ordered by first appearance (roots arrive pre-sorted by `startedAt`);
 * within a bucket, root order is preserved. Roots with no origin fall into the
 * `UNKNOWN_ORIGIN` bucket rather than being dropped.
 */
export function groupRootsByOrigin(
  roots: readonly SessionTreeNode[],
): OriginGroup[] {
  const order: string[] = []
  const byOrigin = new Map<string, SessionTreeNode[]>()
  for (const root of roots) {
    const key = root.origin ?? UNKNOWN_ORIGIN
    const bucket = byOrigin.get(key)
    if (bucket) bucket.push(root)
    else {
      byOrigin.set(key, [root])
      order.push(key)
    }
  }
  return order.map(origin => ({ origin, sessions: byOrigin.get(origin)! }))
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
    currentPhase: s.currentPhase,
    secondsSinceLastActivity: s.secondsSinceLastActivity,
    toolCallsThisTurn: s.toolCallsThisTurn,
    depth: s.depth ?? 0,
    ...(s.adapterSlug ? { adapterSlug: s.adapterSlug } : {}),
    ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
    ...(s.origin ? { origin: s.origin } : {}),
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
  /** Optional harness capability-discovery lister — when wired, exposes
   *  `harness_capabilities` MCP tool. Without it the tool returns a clear
   *  "not configured" error pointing at the host wiring. */
  listHarnessCapabilities?: AdapterCapabilitiesLister
  /** Optional adapter installer — when wired, exposes `adapter_install`
   *  MCP tool. Without it the tool returns a clear "not configured" error
   *  pointing at the host wiring. */
  installAgentAdapter?: AgentAdapterInstaller
  /** Optional catalog lister — when wired, exposes the read-only
   *  `catalog_models` MCP tool. Without it the tool returns a clear "not
   *  configured" error pointing at the host wiring. */
  listCatalogModels?: CatalogModelsLister
  /** config.json `defaults` loader — same seam as
   *  `RestartAgentSessionOptions.loadDefaultsConfig` in session-restart-core.ts.
   *  Threaded into `session_restart`'s pty-native billing-auth re-resolution
   *  (`resolveResumeAuth`) so tests can inject a stub instead of touching the
   *  real `~/.agentproto/config.json`. Defaults to reading the real file via
   *  `loadConfig` when omitted, same as every other restart call site. */
  loadDefaultsConfig?: () => Promise<SpawnDefaultsConfig | undefined>
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
  /** Forwarded to `registerAgentTools` — the trusted `?callerSessionId=` of
   *  this `/mcp` request, used as the implicit auto-parent for attach-by-
   *  default. See `RegisterAgentToolsOptions.callerSessionId`. */
  callerSessionId?: string
  /** Forwarded to `registerAgentTools` — the connecting client's source label
   *  from this `/mcp` request's `?origin=` query, used as the default origin
   *  for a spawn that doesn't set its own. See
   *  `RegisterAgentToolsOptions.mcpBridgeOrigin`. */
  mcpBridgeOrigin?: string
  /** Optional webhook notifier — when provided, per-session `notifyUrl`
   *  values from `agent_start` are registered on spawn and
   *  unregistered on exit via the session-event bus. */
  webhookNotifier?: WebhookNotifier
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.loadRoleRegistry`. */
  loadRoleRegistry?: RegisterAgentToolsOptions["loadRoleRegistry"]
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.resolveSandboxProvider`. */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.provisionWorktree`. */
  provisionWorktree?: RegisterAgentToolsOptions["provisionWorktree"]
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.resolveWorktreeIsolation`. */
  resolveWorktreeIsolation?: RegisterAgentToolsOptions["resolveWorktreeIsolation"]
  /** Forwarded to `registerAgentTools` — the completion-policy supervisor used
   *  to auto-attach a windowed cost-budget policy for an `agent_start` carrying
   *  `costBudget` (phase 4). See `RegisterAgentToolsOptions.supervisor`. */
  supervisor?: RegisterAgentToolsOptions["supervisor"]
  /**
   * Optional git-worktree status lister powering `worktree_status`.
   * Injected here (rather than defaulted inside the runtime) because the join
   * runs over `@agentproto/worktree`, a dependency the runtime deliberately
   * does NOT take. The CLI wires it. Omitted → `worktree_status` returns a
   * clear "not enabled" error.
   */
  listWorktreeStatuses?: WorktreeStatusLister
  /**
   * Optional git-worktree `gc` runner powering `worktree_gc`. Injected here
   * (rather than defaulted inside the runtime) for the same reason as
   * `listWorktreeStatuses`: the plan/apply engine runs over
   * `@agentproto/worktree`, a dependency the runtime deliberately does NOT
   * take. The CLI wires it. Omitted → `worktree_gc` returns a clear "not
   * enabled" error.
   */
  runWorktreeGc?: WorktreeGcRunner
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
    listWorktreeStatuses,
    runWorktreeGc,
    listCatalogModels,
    loadDefaultsConfig,
  } = opts
  const ptyEnabled = opts.ptyEnabled === true

  // Delegate the agent-family tools to the dedicated module.
  registerAgentTools(server, opts)

  // ── session_list (canonical lister) ──────────────────────────
  server.tool(
    "session_list",
    "List sessions tracked by the daemon — agent-CLI sessions (claude-code, " +
      "hermes, …) and terminal/PTY sessions (claude TUI, bash, …). Each " +
      "entry includes `kind`, `pty` (true for real PTYs), `name` (when set " +
      "at spawn), `status`, `command`, age + exit code. Use this when you " +
      "need to know what's already running before spawning anything new, " +
      "or to discover a session id by name. Raw shell-command runs " +
      "(`kind:'command'`) are a log, not a resumable session, so they're " +
      "excluded from the default view — pass `kind:'command'` or " +
      "`includeCommands:true` to see them, or use `command_list`.",
    {
      kind: z
        .enum(["terminal", "agent-cli", "command", "all"])
        .optional()
        .describe(
          "Filter by session kind. `all` (default) returns every " +
            "live-able kind (terminal + agent-cli) but excludes `command` " +
            "unless `includeCommands` is set. Use `terminal` to list only " +
            "PTY sessions, `agent-cli` for structured ACP agents, or " +
            "`command` to list only raw shell-command runs.",
        ),
      includeCommands: z
        .boolean()
        .optional()
        .describe(
          "When true and `kind` is unset/`all`, also include `kind:'command'` " +
            "rows in the result (they're excluded by default — see `kind`). " +
            "No effect when `kind` is set explicitly. Default false.",
        ),
      onlyAlive: z
        .boolean()
        .optional()
        .describe("When true, only running/starting sessions. Default false."),
      status: z
        .enum(["starting", "running", "exited", "killed", "error"])
        .optional()
        .describe("Filter by exact status (overrides onlyAlive)."),
      includeArchived: z
        .boolean()
        .optional()
        .describe(
          "When true, also include archived sessions (hidden from every " +
            "other view by `session_archive`). Default false.",
        ),
      ...pageParamsShape,
    },
    async input => {
      // Always pull the FULL list (archived included) — subtree scoping
      // below needs every row to keep the parent→child graph connected
      // (an archived ancestor excluded from the base list would silently
      // orphan its non-archived descendants from `collectSubtree`'s BFS).
      // The archived-hide is applied afterwards, per `input.includeArchived`.
      let rows = registry.list({ includeArchived: true })
      // Subtree scoping (WP4): on the scoped sub-gateway a child
      // orchestrator only sees the sessions in its own subtree, never
      // the whole daemon.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      if (!input.includeArchived) {
        rows = rows.filter(s => !s.archived)
      }
      if (input.kind && input.kind !== "all") {
        rows = rows.filter(s => s.kind === input.kind)
      } else if (!input.includeCommands) {
        // Default view = live-able sessions only. `kind:"command"` rows are
        // a shell-execution LOG (already reachable via `command_list` / an
        // explicit `kind:"command"` filter), not resumable sessions — left
        // in, hundreds of finished-command rows bury the real agent/PTY
        // sessions this tool exists to surface.
        rows = rows.filter(s => s.kind !== "command")
      }
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      // Pagination (PR-2): ALWAYS last — after subtree scoping and the
      // archived/kind/status filters. Without limit/cursor the output is
      // byte-identical to the pre-pagination handler. `full` is accepted
      // but a no-op until the projection flip (PR-10).
      if (input.limit !== undefined || input.cursor !== undefined) {
        const page = paginate(rows, input, { maxLimit: 200, keyOf: s => s.id })
        return {
          content: [{ type: "text", text: toolText(page) }],
        }
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
      // only sees usage for sessions in its own subtree. Full list
      // (includeArchived) so an archived ancestor doesn't sever the
      // parent→child graph collectSubtree's BFS walks.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
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

  // ── session_context_status ───────────────────────────────────────
  server.tool(
    "session_context_status",
    "Return the context-continuity status for one session — current context " +
      "percentage, resolved policy thresholds, and the next automatic action " +
      "(warn / compact / continue-fresh / hard-stop).",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
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
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(desc.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_context_status: session "${desc.id}" is not in your subtree.`,
                  sessionId: desc.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      const policy = desc.contextContinuity ?? {
        mode: "ask",
        warnAtPct: 55,
        compactAtPct: 65,
        continueFreshAtPct: 75,
        hardStopAtPct: 90,
        goal: true,
        plan: true,
        decisions: true,
        changedFiles: true,
        gitStatus: true,
        tests: true,
        errors: true,
        risks: true,
        nextStep: true,
        config: true,
        label: "ask",
      }
      const status = computeContextContinuityStatus(
        desc.id,
        policy,
        desc.contextSize,
        desc.contextUsed,
      )
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      }
    },
  )

  // ── session_checkpoint ───────────────────────────────────────────
  server.tool(
    "session_checkpoint",
    "Build and persist a structured context-continuity checkpoint for a " +
      "session. The checkpoint is a bounded handoff document saved next to " +
      "the session's events.jsonl; the original transcript is never discarded.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
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
      if (desc.kind !== "agent-cli") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `session "${desc.id}" is not an agent-cli session`,
              }),
            },
          ],
          isError: true,
        }
      }
      const policy = desc.contextContinuity
      if (!policy) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `session "${desc.id}" has no resolved context continuity policy`,
              }),
            },
          ],
          isError: true,
        }
      }
      const pct = computeContextPct(desc.contextSize, desc.contextUsed) ?? policy.continueFreshAtPct
      const checkpoint = await buildContextCheckpoint(desc, { contextPct: pct })
      await persistCheckpoint(checkpoint)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                sessionId: desc.id,
                checkpointId: checkpoint.checkpointId,
                checkpointPath: checkpoint.checkpointPath,
                contextPct: checkpoint.contextPct,
                nextAction: checkpoint.nextAction,
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // ── session_continue_fresh ───────────────────────────────────────
  server.tool(
    "session_continue_fresh",
    "Spawn a NEW agent session that continues the work of an existing " +
      "session with a structured checkpoint as its initial prompt. The new " +
      "session uses the same adapter, harness, model, route, access profile, " +
      "posture, effort, and cwd. The original session is linked via " +
      "`continuedFrom`/`continuedTo` and its transcript is preserved.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
    },
    async input => {
      if (!resolveAgentAdapter) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "session_continue_fresh requires an adapter resolver; none is configured.",
              }),
            },
          ],
          isError: true,
        }
      }
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
      if (desc.kind !== "agent-cli") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `session "${desc.id}" is not an agent-cli session`,
              }),
            },
          ],
          isError: true,
        }
      }
      const spawnDeps: SpawnAgentSessionDeps = {
        registry,
        resolveAgentAdapter,
        ...(opts.daemonMcpUrl ? { daemonMcpUrl: opts.daemonMcpUrl } : {}),
        ...(opts.buildOrchestratorMcp ? { buildOrchestratorMcp: opts.buildOrchestratorMcp } : {}),
        ...(opts.webhookNotifier ? { webhookNotifier: opts.webhookNotifier } : {}),
        ...(opts.resolveSandboxProvider ? { resolveSandboxProvider: opts.resolveSandboxProvider } : {}),
        ...(opts.provisionWorktree ? { provisionWorktree: opts.provisionWorktree } : {}),
        ...(opts.resolveWorktreeIsolation ? { resolveWorktreeIsolation: opts.resolveWorktreeIsolation } : {}),
        ...(opts.loadRoleRegistry ? { loadRoleRegistry: opts.loadRoleRegistry } : {}),
        ...(listCatalogModels ? { listCatalogModels } : {}),
      }
      try {
        const result = await continueAgentSessionFresh(spawnDeps, desc)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  continuedFrom: result.continuedFrom,
                  continuedTo: result.descriptor.id,
                  checkpointId: result.checkpoint.checkpointId,
                  checkpointPath: result.checkpoint.checkpointPath,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `continue fresh failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ── session_compact ──────────────────────────────────────────────
  server.tool(
    "session_compact",
    "Best-effort request to the harness to compact the session's context. " +
      "This sends a '/compact' prompt to the live session; adapters that do " +
      "not support compaction will report an error or ignore it. Use this " +
      "opportunistically before continuing fresh.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
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
      if (desc.kind !== "agent-cli") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `session "${desc.id}" is not an agent-cli session`,
              }),
            },
          ],
          isError: true,
        }
      }
      const isAlive = desc.status === "running" || desc.status === "starting"
      if (!isAlive) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `session "${desc.id}" is not live`,
              }),
            },
          ],
          isError: true,
        }
      }
      try {
        await registry.sendPrompt(desc.id, "/compact")
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionId: desc.id,
                compactRequested: true,
                note: "Compaction is adapter-dependent; verify with session_context_status.",
              }),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `compact failed: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ── usage_rollup ─────────────────────────────────────────────────
  server.tool(
    "usage_rollup",
    "Local-derived, provider-agnostic spend ESTIMATE over a rolling window — " +
      "\"how much did profile X / model Y / harness Z spend in the last 5h / " +
      "7d?\". Aggregated from the durable per-session `usage_snapshot` records " +
      "the daemon writes at every turn-end/exit, NOT the provider's actual " +
      "bill: `basis` is always `\"local-estimate\"`. Cost comes straight from " +
      "the pre-priced snapshots (adapter-reported or catalog-computed) and is " +
      "never re-priced here; tokens for models with no catalog price are " +
      "surfaced separately in `unpricedTokens` (never fabricated as $0). " +
      "Broken down by profile, model, and harness. On the scoped orchestrator " +
      "gateway it is subtree-scoped — a child orchestrator only sees sessions " +
      "it (transitively) spawned.",
    {
      window: z
        .string()
        .min(1)
        .describe(
          "Rolling window: shorthand `<int><s|m|h|d|w>` (e.g. \"5h\", \"7d\", " +
            "\"30m\", \"2w\") or an ISO-8601 duration (e.g. \"P7D\", \"PT5H\", " +
            "\"P1DT12H\"). The window is `[now − duration, now]`.",
        ),
      groupBy: z
        .array(z.enum(["profile", "model", "harness"]))
        .optional()
        .describe(
          "Which breakdowns to return. Omit for all three (profile + model + " +
            "harness). `total` and the window metadata are always returned.",
        ),
      profileRef: z
        .string()
        .optional()
        .describe("Filter to a single auth profile by its `profileRef`."),
      probe: z
        .boolean()
        .optional()
        .describe(
          "Opt in to a LIVE provider refresh of `byProfile[].remaining`. " +
            "Default false — this read is side-effect-free and reports only " +
            "the last-seen provider value (or omits `remaining` when none is " +
            "known; never fabricated). When true, a best-effort minimal " +
            "metadata call is made per Anthropic OAuth profile to refresh the " +
            "value; that call consumes a sliver of that profile's OWN " +
            "rate-limit budget and never blocks or fails the rollup.",
        ),
    },
    async input => {
      const parsed = parseWindow(input.window)
      if ("error" in parsed) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "invalid_window", message: parsed.error }),
            },
          ],
          isError: true,
        }
      }
      // Subtree scoping (WP4): a scoped orchestrator only rolls up sessions in
      // its own subtree. Full list (includeArchived) so an archived ancestor
      // doesn't sever the parent→child graph collectSubtree's BFS walks.
      let onlyIds: Set<string> | undefined
      if (callerScope) {
        onlyIds = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
      }
      const sessions = await collectSessionSnapshots(registry, {
        ...(onlyIds ? { onlyIds } : {}),
        ...(input.profileRef ? { profileRef: input.profileRef } : {}),
      })
      const baseRollup = rollupUsage(sessions, { window: input.window, nowMs: Date.now() })
      // Best-effort per-provider "remaining quota" enrichment — never fatal:
      // any failure returns the un-enriched rollup unchanged.
      const rollup = await enrichRollupWithProviderQuota(baseRollup, input.window, {
        probe: input.probe ?? false,
      })
      // Best-effort per-provider "account credits" (prepaid balance) enrichment
      // — also never fatal: any failure returns the rollup unchanged. Rides on
      // the same byProfile entries, so it survives the groupBy pruning below.
      const rollupWithCredits = await enrichRollupWithAccountCredits(rollup)
      // Prune the breakdowns not requested; always keep total + window metadata.
      let result: unknown = rollupWithCredits
      if (input.groupBy) {
        const want = new Set(input.groupBy)
        const {
          byProfile: _byProfile,
          byModel: _byModel,
          byHarness: _byHarness,
          ...rest
        } = rollupWithCredits
        result = {
          ...rest,
          ...(want.has("profile") ? { byProfile: rollupWithCredits.byProfile } : {}),
          ...(want.has("model") ? { byModel: rollupWithCredits.byModel } : {}),
          ...(want.has("harness") ? { byHarness: rollupWithCredits.byHarness } : {}),
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
      ...pageParamsShape,
    },
    async input => {
      // Full list (includeArchived) for subtree correctness — see
      // session_list's docblock; archived rows are hidden below,
      // unconditionally (this tool has no includeArchived opt-in).
      let rows = registry.list({ includeArchived: true })
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      rows = rows.filter(s => !s.archived)
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
      // Pagination last — see session_list. Without limit/cursor the
      // output is byte-identical to the pre-pagination handler.
      if (input.limit !== undefined || input.cursor !== undefined) {
        const page = paginate(rows, input, { maxLimit: 200, keyOf: s => s.id })
        return {
          content: [{ type: "text", text: toolText(page) }],
        }
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
      ...pageParamsShape,
    },
    async input => {
      // Full list (includeArchived) for subtree correctness — see
      // session_list's docblock; archived rows are hidden below,
      // unconditionally (this tool has no includeArchived opt-in).
      let rows = registry.list({ includeArchived: true })
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      rows = rows.filter(s => !s.archived)
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
      // Pagination last — see session_list. Without limit/cursor the
      // output is byte-identical to the pre-pagination handler.
      if (input.limit !== undefined || input.cursor !== undefined) {
        const page = paginate(rows, input, { maxLimit: 200, keyOf: s => s.id })
        return {
          content: [{ type: "text", text: toolText(page) }],
        }
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
      // Full list (includeArchived) for subtree correctness — see
      // session_list's docblock; archived rows are hidden below,
      // unconditionally (this tool has no includeArchived opt-in).
      let rows = registry.list({ includeArchived: true })
      // Subtree scoping (WP5 / WP4): same gate as session_list.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      rows = rows.filter(s => !s.archived)
      if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      const tree = buildSessionTree(rows)
      // Additive companion view: the same roots bucketed by `origin` so a
      // client can show "claude-code desktop vs vscode extension vs cron"
      // groups — the human-launched roots have no agent parent to nest under,
      // so origin is their only cluster key. `tree` is unchanged.
      const byOrigin = groupRootsByOrigin(tree)
      return {
        content: [
          { type: "text", text: JSON.stringify({ tree, byOrigin }, null, 2) },
        ],
      }
    },
  )

  // ── session_queue_list ───────────────────────────────────────
  // After-the-fact inspection of a session's prompt FIFO: what's sitting in
  // the queue RIGHT NOW (origin, preview, queuedAt, position), not just the
  // enqueue-time acknowledgment `POST /sessions/:id/prompt` already echoes.
  // Position 0 is next to dispatch. Reads `registry.listQueuedPrompts`, the
  // same projection the HTTP route / GET /sessions/:id/queue serves, so the
  // MCP and REST surfaces can't drift.
  server.tool(
    "session_queue_list",
    "List the prompts currently queued on a live session (its prompt FIFO — " +
      "prompts that arrived mid-turn with queueing enabled and are waiting " +
      "to dispatch once the current turn ends). Each entry carries `position` " +
      "(0 = next to dispatch), `origin` (who queued it: \"user\", \"agent " +
      "<sessionId>\", \"child <sessionId>\"), `preview` (short text of the " +
      "message), and `queuedAt`. Pair with `session_queue_promote` (jump an " +
      "item to the front without touching the in-flight turn), " +
      "`session_queue_deliver` (interrupt the current turn and dispatch this " +
      "item NOW), and `session_queue_drop` (remove without delivering).",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`, alive or historical."),
    },
    async input => {
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `no session "${input.sessionId}" found` }) },
          ],
          isError: true,
        }
      }
      // Subtree scoping (WP4/WP5): same gate as session_list/session_tree —
      // a scoped orchestrator only sees its own subtree's queues.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(desc.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: `session "${input.sessionId}" is outside the caller's subtree` }),
              },
            ],
            isError: true,
          }
        }
      }
      const queue = registry.listQueuedPrompts(desc.id)
      return {
        content: [{ type: "text", text: JSON.stringify({ sessionId: desc.id, queue }, null, 2) }],
      }
    },
  )

  // ── session_queue_promote ──────────────────────────────────────
  // Reorder-only force: jump an already-queued item to the front WITHOUT
  // touching the in-flight turn. Distinct from `session_queue_deliver`.
  server.tool(
    "session_queue_promote",
    "Move an already-queued prompt to the FRONT of a session's queue (position 0, " +
      "next to dispatch once the current turn ends) WITHOUT cancelling or touching " +
      "the in-flight turn — a queue-reordering operation only. This is the " +
      "after-the-fact counterpart of `force` on `POST /sessions/:id/prompt`, but " +
      "acting on an item already in the queue. Distinct from `session_queue_deliver` " +
      "(which interrupts and dispatches immediately). The queueId comes from " +
      "`session_queue_list`.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
      queueId: z
        .string()
        .min(1)
        .describe("The queued item's id, from `session_queue_list`."),
    },
    async input => {
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `no session "${input.sessionId}" found` }) },
          ],
          isError: true,
        }
      }
      const result = registry.promoteQueuedPrompt(desc.id, input.queueId)
      if (!result.promoted) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `no queued item "${input.queueId}" on session "${desc.id}"` }),
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, sessionId: desc.id, queueId: input.queueId, position: result.position }, null, 2),
          },
        ],
      }
    },
  )

  // ── session_queue_deliver ──────────────────────────────────────
  // Deliver-now (interrupt): cancel the in-flight turn and dispatch a
  // SPECIFIC queued item as the new turn, removing it from the queue. The
  // "I need this NOW" op — deliberately distinct from promote.
  server.tool(
    "session_queue_deliver",
    "Immediately dispatch a SPECIFIC queued prompt by interrupting whatever " +
      "turn is currently running on the session and delivering this item as " +
      "the new turn (removing it from the queue). The \"I need this NOW\" op — " +
      "distinct from `session_queue_promote`, which only reorders and lets the " +
      "current turn finish. No-op (error) if the item is not in the queue. " +
      "The queueId comes from `session_queue_list`.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
      queueId: z
        .string()
        .min(1)
        .describe("The queued item's id, from `session_queue_list`."),
    },
    async input => {
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `no session "${input.sessionId}" found` }) },
          ],
          isError: true,
        }
      }
      try {
        const result = await registry.deliverQueuedPrompt(desc.id, input.queueId)
        if (!result.delivered) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: `no queued item "${input.queueId}" on session "${desc.id}"` }),
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
                { ok: true, sessionId: desc.id, queueId: input.queueId, interrupted: result.interrupted },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            { type: "text", text: `session_queue_deliver: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        }
      }
    },
  )

  // ── session_queue_drop ─────────────────────────────────────────
  server.tool(
    "session_queue_drop",
    "Remove a prompt from a session's queue WITHOUT ever delivering it — it is " +
      "cancelled, not dispatched. Idempotent: an unknown session or an item that's " +
      "already gone (dispatched, removed, or never existed) reports `removed:false` " +
      "rather than erroring, matching the no-op-is-not-an-error shape of " +
      "`POST /sessions/:id/interrupt`. The queueId comes from `session_queue_list`.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
      queueId: z
        .string()
        .min(1)
        .describe("The queued item's id, from `session_queue_list`."),
    },
    async input => {
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `no session "${input.sessionId}" found` }) },
          ],
          isError: true,
        }
      }
      const { removed } = registry.removeQueuedPrompt(desc.id, input.queueId)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, sessionId: desc.id, queueId: input.queueId, removed },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  // ── worktree_status ─────────────────────────────────────────────
  // Read-only view of the repo's linked worktrees + their live PR
  // integration + the sessions that opened them. The heavy join is
  // delegated to an injected `listWorktreeStatuses` port so the runtime
  // stays free of `@agentproto/worktree`.

  server.tool(
    "worktree_status",
    "List the linked git worktrees for a repo and their live PR/session " +
      "linkage. Each entry includes path, branch, class, reclaimability, " +
      "PR state/number, the sessions whose cwd sits in the worktree, and " +
      "liveness. Use this to power a 'PRs in progress + linked sub-agents' " +
      "panel. Pass `openOnly: true` to surface only worktrees whose PR is " +
      "still open.",
    {
      repoRoot: z
        .string()
        .optional()
        .describe(
          "Absolute path to the git repo root whose worktrees to list. " +
            "Wins over `workspaceSlug` when both are set."
        ),
      workspaceSlug: z
        .string()
        .optional()
        .describe(
          "Workspace slug from `agentproto workspace list`. Resolves the " +
            "repo root via the active workspace when omitted."
        ),
      openOnly: mcpBool
        .optional()
        .describe(
          "When true, only return worktrees whose `pr.state` is `open`. " +
            "Default false."
        ),
    },
    async input => {
      if (!listWorktreeStatuses) {
        return {
          content: [
            {
              type: "text",
              text:
                "worktree_status is not enabled — the daemon was started without " +
                "a worktree status lister. The host must wire `listWorktreeStatuses` " +
                "in createGateway.",
            },
          ],
          isError: true,
        }
      }

      const resolved = await resolveWorktreeQueryRoot({
        repoRoot: input.repoRoot,
        workspaceSlug: input.workspaceSlug,
      })
      if (!resolved.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: resolved.error }, null, 2),
            },
          ],
          isError: true,
        }
      }

      try {
        let worktrees = await listWorktreeStatuses(resolved.repoRoot)
        if (input.openOnly) {
          worktrees = worktrees.filter(w => w.pr?.state === "open")
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ worktrees }, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `worktree_status failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ── worktree_gc ──────────────────────────────────────────────────
  // The transport surface over the `gc` engine (`planGc` / `applyGc` in
  // `@agentproto/worktree`). All classification + safety logic lives in the
  // engine and is untouched here: `reclaim` fires only when integration ∈
  // {merged, fresh} AND the tree is clean (teardown is merge-gated), an OPEN
  // PR is always `hold` and never touched, and a dirty-but-integrated
  // worktree is only ever archived with `salvageDirty`. This tool defaults to
  // a DRY RUN — `apply` is false unless explicitly set — and delegates every
  // fact and mutation to the injected `runWorktreeGc` port.

  server.tool(
    "worktree_gc",
    "Garbage-collect the linked git worktrees for a repo. DEFAULTS TO A DRY " +
      "RUN: with `apply` false (the default) it returns the plan — each " +
      "worktree classified as `reclaim` (merged/fresh + clean → safe to " +
      "remove), `salvage` (integrated but dirty), or `hold` (open PR, live " +
      "sessions, or anything unresolved) — and mutates nothing. Pass " +
      "`apply: true` to execute: `reclaim` entries are removed and their " +
      "branch deleted, and `salvage` entries are archived first (only when " +
      "`salvageDirty` is also true), never silently discarded. `hold` " +
      "entries are never touched. Each entry is re-classified from scratch " +
      "immediately before it is touched, so a plan that has gone stale is " +
      "refused rather than acted on.",
    {
      repoRoot: z
        .string()
        .optional()
        .describe(
          "Absolute path to the git repo root whose worktrees to gc. " +
            "Wins over `workspaceSlug` when both are set."
        ),
      workspaceSlug: z
        .string()
        .optional()
        .describe(
          "Workspace slug from `agentproto workspace list`. Resolves the " +
            "repo root via the active workspace when omitted."
        ),
      apply: mcpBool
        .optional()
        .describe(
          "When true, EXECUTE the plan (reclaim/salvage). Default false — a " +
            "dry run that returns the plan and mutates nothing."
        ),
      salvageDirty: mcpBool
        .optional()
        .describe(
          "When true, archive (snapshot-then-remove) every `salvage`-class " +
            "worktree during `apply`. Default false — salvage entries are " +
            "left untouched. Ignored on a dry run."
        ),
      includeDetached: mcpBool
        .optional()
        .describe(
          "When true, a clean, idle detached worktree is reclaimed instead " +
            "of held. Default false. This is the only flag that can promote " +
            "an entry toward reclaim; no flag ever weakens a hold otherwise."
        ),
    },
    async input => {
      if (!runWorktreeGc) {
        return {
          content: [
            {
              type: "text",
              text:
                "worktree_gc is not enabled — the daemon was started without " +
                "a worktree gc runner. The host must wire `runWorktreeGc` " +
                "in createGateway.",
            },
          ],
          isError: true,
        }
      }

      const resolved = await resolveWorktreeQueryRoot({
        repoRoot: input.repoRoot,
        workspaceSlug: input.workspaceSlug,
      })
      if (!resolved.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: resolved.error }, null, 2),
            },
          ],
          isError: true,
        }
      }

      try {
        const result = await runWorktreeGc({
          repoRoot: resolved.repoRoot,
          apply: input.apply === true,
          salvageDirty: input.salvageDirty === true,
          includeDetached: input.includeDetached === true,
          // The daemon's own live in-memory registry, not a disk re-read —
          // see `livingSessionCwds`'s doc.
          protectedPaths: livingSessionCwds(registry),
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `worktree_gc failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
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
      "ACP-level resume via the adapter's own session id for an agent-cli/ACP-" +
      "origin session (retried as a fresh spawn if the adapter rejects the id " +
      "with \"not found\" — typical when the prior session died before its " +
      "first turn); provider-native resume (spawns a PTY running the " +
      "provider's own resume command, e.g. `claude --resume <id>`) for a " +
      "session that was ITSELF already a raw PTY, or when `preferNativeTerminal` " +
      "explicitly opts an ACP-origin session in (its isolated config dir was " +
      "never TUI-onboarded, so defaulting there can strand the terminal on the " +
      "provider's first-run wizard with no one attached to answer it); else a " +
      "plain PTY re-run for raw terminal sessions with no adapter match. " +
      "Generic `command` sessions have no resume path and return an error. " +
      "Returns the NEW session's descriptor plus `resumedFrom` (the prior id) " +
      "and `resumeVia` (which path was used, empty string for a fresh respawn).",
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
      // ── Restart-with-override axes (SPEC §4.3, step 6) — the single path
      //    for all four restart-only axes. Each optional; an omitted axis is
      //    carried forward from the prior session, an axis set here wins.
      model: z
        .string()
        .min(1)
        .optional()
        .describe("Override the model on restart (route-identity ref)."),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max", "ultracode"])
        .optional()
        .describe("Override the reasoning-effort level on restart."),
      access: z
        .object({
          profileRef: z
            .string()
            .min(1)
            .describe("Attach this NAMED auth profile (SPEC §1c). Rejected 400 " +
              "if it's not eligible for the resolved (adapter × route)."),
        })
        .optional()
        .describe("Switch the session's billing wallet to a named auth profile."),
      route: z
        .object({
          gateway: z.string().min(1).describe("Endpoint/gateway id (anthropic|moonshot|…)."),
          baseUrl: z.string().url().optional().describe("Explicit base URL for a custom gateway."),
        })
        .optional()
        .describe("Override the endpoint/gateway rail on restart (access is downstream)."),
      posture: z
        .union([
          z.enum(["default", "plan", "accept-edits", "bypass", "read-only"]),
          z.object({ harnessModeId: z.string().min(1) }),
        ])
        .optional()
        .describe("Override the posture (what the agent may DO) on restart."),
      contextProfile: z
        .string()
        .min(1)
        .optional()
        .describe("Override what enters context (full|lean|…) on restart."),
      harness: z
        .string()
        .min(1)
        .optional()
        .describe("Override the canonical harness slug on restart."),
      mode: z
        .string()
        .min(1)
        .optional()
        .describe("Legacy AIP-45 mode id override, forwarded verbatim to the driver at spawn."),
      preferNativeTerminal: z
        .boolean()
        .optional()
        .describe(
          "Explicit opt-in to provider-native terminal resume (e.g. `claude --resume <id>` " +
            "in a raw PTY) for a session that did NOT itself start as a PTY — an agent-cli/ACP " +
            "session's isolated config dir was never TUI-onboarded (no theme/trust state), so " +
            "the resumed terminal can otherwise block forever on the provider's first-run " +
            "wizard with no one attached to answer it. Default false: an ACP-origin session " +
            "always resumes at the ACP level instead. A session that WAS itself already a raw " +
            "PTY still prefers native resume regardless of this flag."
        ),
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
      // may only restart sessions it (transitively) spawned. Full list
      // (includeArchived) so an archived ancestor doesn't sever the
      // parent→child graph collectSubtree's BFS walks.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
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

      // ── Restart-with-override (step 6) ───────────────────────────
      // Fold the per-axis override inputs into the single overrides map — only
      // present fields. A restart carrying ANY override is a config change that
      // needs auth re-resolution + a fresh descriptor, so it routes through
      // `restartAgentSession` on the FORCED agent path (`forceAgentResume`),
      // bypassing the PTY-native `claude --resume` branch that can't re-resolve
      // billing or apply an axis. A plain restart (no overrides) falls through
      // to the strategy decision below, byte-identical to before.
      const overrides: RestartOverrides = {
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.access !== undefined ? { access: input.access } : {}),
        ...(input.route !== undefined ? { route: input.route } : {}),
        ...(input.posture !== undefined ? { posture: input.posture } : {}),
        ...(input.contextProfile !== undefined ? { contextProfile: input.contextProfile } : {}),
        ...(input.harness !== undefined ? { harness: input.harness } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
      }
      if (Object.keys(overrides).length > 0) {
        if (!prev.adapterSlug || !resolveAgentAdapter) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "restart_override_invalid",
                  status: 400,
                  message:
                    "session_restart: restart-with-override only applies to agent-cli " +
                    "sessions (a PTY/command session has no config axes to override).",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
        try {
          const restarted = await restartAgentSession(registry, resolveAgentAdapter, prev, {
            forceAgentResume: true,
            overrides,
            ...(listCatalogModels ? { listCatalogModels } : {}),
          })
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...restarted.desc,
                    resumedFrom: restarted.resumedFrom,
                    resumeVia: restarted.resumeVia,
                    ...(restarted.resumeFallback ? { resumeFallback: true } : {}),
                  },
                  null,
                  2
                ),
              },
            ],
          }
        } catch (err) {
          if (err instanceof RestartOverrideError) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: err.code,
                    status: err.status,
                    message: err.message,
                    ok: false,
                    sessionId: prev.id,
                  }),
                },
              ],
              isError: true,
            }
          }
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

      const augmented = await augmentWithFsResume(prev)
      const strategy = decideRestartStrategy(augmented, {
        preferNativeTerminal: input.preferNativeTerminal === true,
      })
      // Trace WHICH restart path was chosen and why — the branching in
      // `decideRestartStrategy` depends on state that can differ between two
      // restarts of the SAME lineage (whether the output sniffer or the fs
      // probe caught a resume id this time, whether the row is still an
      // agent-cli descriptor or has already degraded to a bare PTY from a
      // prior restart), so two consecutive restarts silently landing on
      // different strategies is expected, not a bug — this line is what
      // makes that legible in daemon.log instead of only inferable from argv.
      console.log(
        `[session_restart] ${prev.id} (kind=${prev.kind}, adapterSlug=${prev.adapterSlug ?? "-"}, ` +
          `pty=${prev.pty === true}, nativeTerminalResume=${prev.nativeTerminalResume === true}) -> ${strategy.kind}` +
          (strategy.kind === "pty-native" ? ` argv=${JSON.stringify(strategy.argv)}` : "") +
          (strategy.kind === "agent"
            ? ` resumeSessionId=${strategy.resumeSessionId ?? "none"}` +
              (strategy.resumeFallback ? " (capability-downgrade fallback, no id attempted)" : "")
            : "") +
          (strategy.kind === "unsupported" ? ` reason="${strategy.reason}"` : "")
      )

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
          // Thread the adapter's isolated config dir into the resumed PTY's
          // env so the provider's own native resume looks in the SAME store
          // its transcript actually lives in (see
          // `ConversationStore.configDirEnvVar`'s doc) — this is the fix for
          // the "No conversation found" failure a `claude --resume <id>`
          // hits when it inherits the daemon's ambient (or no) config dir
          // instead of the session's isolated one. `pty-native`: `prev` is
          // still the agent-cli descriptor being restarted, so look up its
          // strategy fresh. `pty-plain`: `prev` is ALREADY a bare PTY row
          // (adapterSlug/adapterConfigDir gone by design), so replay
          // whatever env the earlier hop recorded — see `ptyResumeEnv`'s doc
          // on why that's the only way this survives more than one restart.
          const envVarName =
            strategy.kind === "pty-native" && prev.adapterSlug
              ? RESUME_STRATEGIES[prev.adapterSlug]?.configDirEnvVar
              : undefined
          const ptyEnv: Record<string, string> | undefined =
            strategy.kind === "pty-native"
              ? envVarName && augmented.adapterConfigDir
                ? { [envVarName]: augmented.adapterConfigDir }
                : undefined
              : prev.ptyResumeEnv
          if (strategy.kind === "pty-native") {
            console.log(
              `[session_restart] ${prev.id} pty-native env: ` +
                (ptyEnv
                  ? `${Object.keys(ptyEnv).join(",")} threaded from adapterConfigDir`
                  : envVarName
                    ? "no adapterConfigDir on descriptor — resume may miss the isolated store"
                    : `adapter "${prev.adapterSlug}" declares no configDirEnvVar — resume uses the global store`)
            )
          }
          // Re-resolve billing-auth for a pty-native resume — same
          // money-safety resolver the "agent" branch uses (`resolveResumeAuth`,
          // session-restart-core.ts), never the daemon's own ambient env. A raw
          // `claude --resume` PTY inherits `process.env` wholesale
          // (sessions.ts's `spawnPty`), so without this it silently picks up
          // whatever conflicting credential (e.g. an ambient `ANTHROPIC_API_KEY`
          // set for some unrelated reason) happens to be in the daemon's own
          // environment instead of THIS session's own resolved auth — the exact
          // ambient-credential leak #824/#490 already closed for the ACP/agent
          // paths. Concretely: an ambient `ANTHROPIC_API_KEY` the session's
          // isolated config dir has never seen trips claude-code's own
          // "detected a custom API key" prompt, which blocks forever with no
          // one attached to answer it. `unsetEnv` scrubs that conflict;
          // `setEnv`/`credential` inject the session's OWN resolved credential.
          let authEnv: Record<string, string> | undefined
          let authUnsetEnv: string[] | undefined
          if (strategy.kind === "pty-native" && prev.adapterSlug && resolveAgentAdapter) {
            const resolvedAdapter = await resolveAgentAdapter(prev.adapterSlug)
            if (resolvedAdapter?.authDescriptor) {
              const { authSpec } = await resolveResumeAuth(prev, resolvedAdapter, {
                adapterSlug: prev.adapterSlug,
                ...(prev.model ? { model: prev.model } : {}),
                ...(prev.route ? { route: prev.route } : {}),
                ...(prev.accessProfile?.profileRef
                  ? { accessProfileRef: prev.accessProfile.profileRef }
                  : {}),
                prefix: "restart",
                ...(loadDefaultsConfig ? { loadDefaultsConfig } : {}),
                ...(listCatalogModels ? { listCatalogModels } : {}),
              })
              if (authSpec) {
                authUnsetEnv = authSpec.unsetEnv
                if (authSpec.credential !== undefined) {
                  authEnv = { [authSpec.setEnv]: authSpec.credential }
                }
              }
            }
          }
          const combinedPtyEnv: Record<string, string> | undefined =
            ptyEnv || authEnv ? { ...ptyEnv, ...authEnv } : undefined
          // Persist the resume lineage onto the STORED descriptor (not just
          // grafted onto this response's JSON, as it used to be) — see
          // `SessionDescriptor.resumedFrom`'s doc for why that matters.
          const desc = registry.spawnPty({
            argv,
            cwd,
            workspaceSlug: prev.workspaceSlug,
            cols: input.cols ?? 80,
            rows: input.rows ?? 24,
            ...(combinedPtyEnv ? { env: combinedPtyEnv } : {}),
            ...(authUnsetEnv && authUnsetEnv.length > 0 ? { unsetEnv: authUnsetEnv } : {}),
            ...(prev.name ? { name: prev.name } : {}),
            ...(prev.label ? { label: prev.label } : {}),
            // Lineage carry-forward (#session-visibility) — same reasoning as
            // the agent branch in session-restart-core.ts: a restart keeps the
            // logical session's origin/parent/depth rather than resetting it to
            // a bare root.
            ...(prev.origin ? { origin: prev.origin } : {}),
            ...(prev.parentSessionId ? { parentSessionId: prev.parentSessionId } : {}),
            ...(prev.depth !== undefined ? { depth: prev.depth } : {}),
            resumedFrom: prev.id,
            resumeVia: describeResumePath(augmented, {
              preferNativeTerminal: input.preferNativeTerminal === true,
            }),
          })
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(desc, null, 2),
              },
            ],
          }
        }

        // strategy.kind === "agent" — decideRestartStrategy only returns
        // this when `adapterSlug` is set, but TS can't see across the
        // two objects, so re-check at runtime rather than casting.
        if (!prev.adapterSlug) {
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
        // Shared with the cron scheduler's `prompt-session` action —
        // see session-restart-core.ts. Overrides take the forced-agent path
        // handled earlier, so a restart reaching HERE never carries any.
        const restarted = await restartAgentSession(registry, resolveAgentAdapter, prev)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...restarted.desc,
                  resumedFrom: restarted.resumedFrom,
                  resumeVia: restarted.resumeVia,
                  ...(restarted.resumeFallback ? { resumeFallback: true } : {}),
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

  // ── session_archive / session_unarchive ─────────────────────────
  // Pure housekeeping over `SessionDescriptor.archived` — no daemon
  // consequence, unlike every other verb above. `archiveSession` carries
  // its own terminal-status guard (sessions.ts), so this handler's job is
  // just lookup + subtree scoping + translating the thrown error.
  server.tool(
    "session_archive",
    "Archive a terminal-status session (exited/killed/error) so it drops " +
      "out of `session_list`'s / `GET /sessions`'s default view — a " +
      "housekeeping flag, not a daemon action: the session's history and " +
      "transcript are untouched and stay fully readable (`session_usage`, " +
      "`agent_export`, or `session_list({ includeArchived: true })`). " +
      "Refuses a still-alive session (running/starting) — archiving one " +
      "would hide it from view while it keeps working unattended. Use " +
      "`session_unarchive` to restore visibility.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe(
          "Session id or name to archive — from `session_list`, must be terminal-status."
        ),
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
      // Subtree scoping (WP4): mirrors session_restart — a scoped
      // orchestrator may only archive sessions it (transitively) spawned.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_archive: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only archive sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      try {
        const desc = registry.archiveSession(prev.id)
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_archive: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── session_gc — bulk housekeeping over terminal sessions ─────
  server.tool(
    "session_gc",
    "Bulk garbage-collect TERMINAL-status sessions (exited/killed/error) so " +
      "the list stops accumulating dead rows. Default ARCHIVES them (reversible " +
      "— hidden from the default view, still readable + importable). `forget:true` " +
      "instead DROPS each descriptor to reclaim `~/.agentproto/sessions.json` " +
      "space; the harness native conversation on disk survives and stays " +
      "importable. NEVER touches a live (running/starting) session. " +
      "`olderThanDays` keeps anything more recent. A scoped orchestrator only " +
      "GCs its own subtree.",
    {
      olderThanDays: z
        .number()
        .positive()
        .optional()
        .describe(
          "Only GC sessions whose end (or start) is older than this many days. " +
            "Omit to GC every terminal session."
        ),
      forget: z
        .boolean()
        .optional()
        .describe(
          "Drop the descriptor entirely (reclaim disk) instead of archiving. The " +
            "native conversation on disk is untouched. Default false = archive."
        ),
    },
    async input => {
      const onlyIds = callerScope
        ? collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        : undefined
      const res = registry.gcSessions({
        ...(input.olderThanDays !== undefined ? { olderThanDays: input.olderThanDays } : {}),
        ...(input.forget ? { forget: true } : {}),
        ...(onlyIds ? { onlyIds } : {}),
      })
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] }
    }
  )

  server.tool(
    "session_unarchive",
    "Restore an archived session to `session_list`'s default view — the " +
      "inverse of `session_archive`. No status guard: archiving never " +
      "touches daemon state, so there is nothing to re-validate — any " +
      "archived session can be unarchived at any time.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe(
          "Session id or name to unarchive — find it via " +
            "`session_list({ includeArchived: true })`."
        ),
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
      // Subtree scoping (WP4): mirrors session_archive.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_unarchive: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only unarchive sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      try {
        const desc = registry.unarchiveSession(prev.id)
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_unarchive: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── session_flag_status ───────────────────────────────────────────
  // The ONE external write path over `awaitingInput`/`awaitingQuestion` —
  // otherwise set only by the internal heuristic (`deriveHeuristicQuestion`
  // in sessions.ts) or a driver-reported `agent-prompt`, and cleared
  // automatically on the next prompt/turn start. Lets a human, another
  // agent, or the future session watchdog correct a missed real question or
  // clear a false positive. `flagAwaitingInput` carries its own liveness
  // guard (sessions.ts) — the inverse of `session_archive`'s terminal-only
  // one — so this handler's job is just lookup + subtree scoping +
  // cross-field validation + translating the thrown error.
  server.tool(
    "session_flag_status",
    "Manually correct a session's `awaitingInput`/`awaitingQuestion` " +
      "classification. This is the ONLY write path for that pair besides " +
      "the daemon's own internal heuristic (which guesses from the tail of " +
      "the transcript) and a driver-reported structured prompt — use this " +
      "when the heuristic missed a real question (set `awaitingInput:true`, " +
      "optionally attaching `question`) or flagged a false positive (set " +
      "`awaitingInput:false`, which also clears any attached " +
      "`awaitingQuestion` — a question can't outlive its awaiting-input " +
      "flag). `reason` is required — a short justification that rides on " +
      "the emitted `session:awaiting-input-flagged` event, visible via " +
      "`session_events_poll`, for audit. Only allowed on a LIVE session " +
      "(running/starting) — mirrors the inverse of `session_archive`'s " +
      "terminal-only guard: a terminal session has no turn left to be " +
      "awaiting anything. The override itself is NOT sticky — it's cleared " +
      "automatically like any other awaiting-input signal on the session's " +
      "next prompt/turn start.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name to flag — from `session_list`, must be live."),
      awaitingInput: z
        .boolean()
        .describe(
          "New value for the session's awaiting-input classification — true " +
            "if it's actually blocked on a question/decision the heuristic " +
            "missed, false to clear a false positive."
        ),
      question: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The question text to attach when `awaitingInput:true` — stored as " +
            '`awaitingQuestion` (`source:"structured"`). Only meaningful ' +
            "alongside `awaitingInput:true`; passing it with " +
            "`awaitingInput:false` is a validation error."
        ),
      reason: z
        .string()
        .min(1)
        .describe(
          "Required short justification for this override — audit/log only, " +
            "rides on the emitted `session:awaiting-input-flagged` event."
        ),
    },
    async input => {
      if (!input.awaitingInput && input.question !== undefined) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "session_flag_status: `question` is only meaningful when " +
                  "`awaitingInput:true` (got `awaitingInput:false` with a " +
                  "`question` set).",
              }),
            },
          ],
          isError: true,
        }
      }
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
      // Subtree scoping (WP4): mirrors session_archive.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_flag_status: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only flag sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      try {
        const desc = registry.flagAwaitingInput(prev.id, {
          awaitingInput: input.awaitingInput,
          ...(input.question !== undefined ? { question: input.question } : {}),
          reason: input.reason,
        })
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_flag_status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── session_rename ──────────────────────────────────────────────
  // The headless twin of the VS Code rename UX + `PATCH /sessions/:id`.
  // Pure display state (the descriptor's `title`/`label`) — never touches the
  // live agent — so, like archive, it just resolves + scopes + delegates to
  // the registry, which trims/caps, persists, and emits `session:renamed`.
  server.tool(
    "session_rename",
    "Set or clear a session's user-facing name — the label the sessions tree, " +
      "transcript header, and tab show. `label` out-ranks `title` in that " +
      "display chain, so a user rename should write `label` (the default a UI " +
      "picks) to be sure it shows; `title` is the auto-derived first-sentence " +
      "fallback. For EACH of `title`/`label`: a non-empty string sets it " +
      "(trimmed + length-capped), an empty string clears it (reverting to the " +
      "derived title / a friendly `adapter · id` fallback), and omitting it " +
      "leaves that field untouched. Persists across daemon restarts. Does NOT " +
      "rename the adapter-native session or touch the running agent.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name to rename — from `session_list`."),
      label: z
        .string()
        .optional()
        .describe(
          "New label (the winning display field). Empty string clears it. " +
            "Omit to leave the label untouched.",
        ),
      title: z
        .string()
        .optional()
        .describe(
          "New title (the auto-derived fallback slot). Empty string clears it, " +
            "reverting to the first-sentence derivation. Omit to leave it untouched.",
        ),
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
      // Subtree scoping (WP4): mirrors session_archive — a scoped orchestrator
      // may only rename sessions it (transitively) spawned.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_rename: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only rename sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      if (input.title === undefined && input.label === undefined) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "nothing_to_rename",
                message: "session_rename: supply at least one of `title` or `label`.",
                ok: false,
                sessionId: prev.id,
              }),
            },
          ],
          isError: true,
        }
      }
      try {
        const desc = registry.renameSession(prev.id, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
        })
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_rename: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── session_set_keepalive ───────────────────────────────────────
  // The headless twin of `agent_start`'s `keepAlive` spawn option — lets an
  // already-running session opt in/out of the idle-reaper exemption after
  // the fact (e.g. a supervisor that only realizes it needs to park once
  // it's already spawned). Modeled EXACTLY on session_rename: resolve +
  // subtree-scope + delegate to the registry, which flips the field and
  // persists.
  server.tool(
    "session_set_keepalive",
    "Set or clear a session's idle-reaper exemption. When `keepAlive` is " +
      "true, the idle-reaper (`isReapable`) never auto-retires this session " +
      "no matter how long it sits idle — for a supervisor that legitimately " +
      "parks waiting on a child or a scheduled wake, which otherwise looks " +
      "identical to a finished session. Set false to clear the exemption. " +
      "Persists across daemon restarts. Does NOT touch the running agent.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name to update — from `session_list`."),
      keepAlive: mcpBool.describe(
        "true to exempt this session from the idle-reaper, false to clear " +
          "the exemption.",
      ),
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
      // Subtree scoping (WP4): mirrors session_rename — a scoped orchestrator
      // may only touch sessions it (transitively) spawned.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_set_keepalive: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only update sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      try {
        const desc = registry.setKeepAlive(prev.id, input.keepAlive)
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_set_keepalive: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  // ── session_set_pinned ──────────────────────────────────────────
  // A quiet, structural list-visibility flag — lets an operator favorite a
  // session so it sorts to the top of the CLI table / VS Code webview list.
  // Modeled EXACTLY on session_set_keepalive (itself modeled on
  // session_rename): resolve + subtree-scope + delegate to the registry,
  // which flips the field and persists. Deliberately does NOT touch
  // keepAlive, reaper eligibility, or any notification path — see
  // `SessionDescriptor.pinned`'s doc for why pin is distinct from those.
  server.tool(
    "session_set_pinned",
    "Set or clear a session's list-visibility pin. When `pinned` is true, " +
      "the session sorts to the top of `agentproto sessions` and the VS Code " +
      "sessions webview's dedicated Pinned group. Set false to clear it. " +
      "Persists across daemon restarts. Purely a sort/display flag — does " +
      "NOT touch the idle-reaper, keepAlive, or emit any notification, and " +
      "does NOT touch the running agent.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name to update — from `session_list`."),
      pinned: mcpBool.describe(
        "true to pin this session to the top of the list, false to unpin it.",
      ),
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
      // Subtree scoping (WP4): mirrors session_rename / session_set_keepalive
      // — a scoped orchestrator may only touch sessions it (transitively)
      // spawned.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_set_pinned: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only update sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: prev.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      try {
        const desc = registry.setPinned(prev.id, input.pinned)
        return {
          content: [{ type: "text", text: JSON.stringify(desc, null, 2) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_set_pinned: ${err instanceof Error ? err.message : String(err)}`,
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
      } else if (!input.workspaceSlug) {
        // cwd given but no explicit slug — reverse-map it, exactly as
        // spawnAgentSession does (session-spawn.ts). Without this the session
        // lands in "default" even when its cwd sits inside a registered
        // workspace, so it can never be grouped or filtered by project.
        try {
          const config = await loadWorkspacesConfig()
          const ws = findWorkspaceByPath(config, cwd)
          if (ws) resolvedSlug = ws.slug
        } catch {
          // no registry readable — keep "default"
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
          // Parent attribution + depth (orchestrator WP4) — same rule as
          // `agent_start` (session-spawn.ts): a spawn through a scoped
          // sub-gateway is attributed to the owning orchestrator so
          // `session_tree` shows the PTY as its child. Depth caps and
          // child quotas stay agent_start-only for now.
          ...(callerScope?.ownerSessionId
            ? {
                parentSessionId: callerScope.ownerSessionId,
                depth: callerScope.depth + 1,
              }
            : {}),
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
    "Send keystrokes to a PTY session's stdin. `text`/`b64` are CONTENT written " +
      "verbatim (a `\\n` inside `text` is a real line break in the composer). " +
      "`enter: true` presses Enter as an ISOLATED keystroke: the content is " +
      "written first, then a lone carriage return (\\r) is written in a SECOND, " +
      "separate write. This matters for TUIs that do paste-detection (Claude " +
      "Code in bracketed-paste mode): a text block ending in CR arrives as a " +
      "multi-line PASTE (the CR becomes a newline, no submit), whereas a CR " +
      "arriving on its own is seen as the Enter key → reliable submit. Use " +
      "`b64` to send exact control bytes (CR, arrows, Esc, Ctrl-*) that JSON " +
      "can't carry cleanly.",
    {
      sessionId: z
        .string()
        .describe("Session id OR name from terminal_start."),
      text: z
        .string()
        .optional()
        .describe(
          "Content to write. Sent as-is to the PTY's stdin; a `\\n` here is a " +
            "real line break (not a submit)."
        ),
      enter: z
        .boolean()
        .optional()
        .describe(
          "Press Enter as an isolated keystroke: writes a lone carriage " +
            "return (\\r) in a separate write AFTER any content, so paste-" +
            "detecting TUIs (e.g. Claude Code) submit reliably instead of " +
            "treating the trailing CR as a pasted newline."
        ),
      b64: z
        .string()
        .optional()
        .describe(
          "Base64-encoded exact bytes to send instead of/around `text` (for " +
            "control keys: CR, arrows, Esc, Ctrl-*). Decoded as latin1 (1-to-1 " +
            "byte mapping) and written verbatim. Intended for ASCII control " +
            "keys; binary bytes >0x7f may not transit unchanged."
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
      const content =
        input.b64 !== undefined
          ? Buffer.from(input.b64, "base64").toString("latin1")
          : (input.text ?? "")
      // Enter is sent as an ISOLATED write so paste-detecting TUIs treat the
      // CR as the Enter key (submit) rather than a trailing pasted newline.
      // See the tool description for the paste-detection rationale.
      //
      // TODO(follow-up): for multi-line `text` + `enter`, when the session is
      // in bracketed-paste mode (PTY emitted `\x1b[?2004h`), wrap the content
      // in `\x1b[200~`…`\x1b[201~` before the isolated CR. Skipped here: it
      // needs per-session 2004h/2004l tracking in sessions.ts onData (with
      // escape-sequence-split handling across chunk boundaries) plus a new
      // registry method — more than the isolated-CR fix warrants on its own.
      let ok = true
      if (content.length > 0) {
        ok = registry.writeTerminalInput(desc.id, content) && ok
      }
      if (input.enter) {
        ok = registry.writeTerminalInput(desc.id, "\r") && ok
      }
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
      "bytes (the buffer is RAW including ANSI escapes) by default; pass " +
      "`clean: true` for ANSI-stripped plain text instead. `lastBytes` caps " +
      "the read from the tail; when a `lastBytes` window is applied the " +
      "result carries a `truncated` flag (true when the window was filled to " +
      "capacity). Future default: the read will be capped at 4096 bytes — " +
      "pass `lastBytes` explicitly for stable behaviour.",
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
        .describe(
          "Max bytes from the tail. Default: full ring buffer (~64 KiB). " +
            "Note: a future default caps this at 4096 bytes — pass " +
            "`lastBytes` explicitly for stable behaviour."
        ),
      clean: mcpBool
        .optional()
        .describe(
          "Strip ANSI codes, returning human-readable text (as `text` " +
            "instead of `b64`). Default false = raw base64."
        ),
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
                currentPhase: desc.currentPhase,
                toolCallsThisTurn: desc.toolCallsThisTurn,
                ...(desc.secondsSinceLastActivity !== undefined
                  ? { secondsSinceLastActivity: desc.secondsSinceLastActivity }
                  : {}),
                bytes: buf.byteLength,
                ...(input.lastBytes !== undefined
                  ? { truncated: buf.byteLength >= input.lastBytes }
                  : {}),
                ...(input.clean
                  ? { text: stripAnsi(buf.toString("utf8")) }
                  : { b64: buf.toString("base64") }),
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

/**
 * Re-exported from conversation-read.ts so callers of session-tools.ts
 * (e.g. index.ts, which registers `agent_export` from this module too)
 * have one import site for both. The canonical definition lives there.
 */
export { registerConversationReadTool, readConversation } from "./conversation-read.js"
export type { ConversationReadOps, ConversationReadInput, ConversationReadResult } from "./conversation-read.js"
/**
 * Re-exported from conversation-locate-tool.ts so index.ts has one import
 * site with the other conversation tools. Canonical definition lives there.
 */
export {
  registerConversationLocateTool,
  locateConversation,
} from "./conversation-locate-tool.js"
export type {
  ConversationLocateInput,
  ConversationLocateResult,
} from "./conversation-locate-tool.js"

/**
 * Re-exported from conversation-export.ts so callers of session-tools.ts
 * (e.g. index.ts) have one import site for the cross-adapter conversation
 * writer next to the reader above. The canonical definition lives there.
 */
export {
  registerConversationExportTool,
  exportConversation,
  writeToNativeStore,
} from "./conversation-export.js"
export type {
  ConversationExportOps,
  ConversationExportInput,
  ConversationExportResult,
  ConversationExportTarget,
} from "./conversation-export.js"
