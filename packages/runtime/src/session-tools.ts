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

import { addReviewWorktree, ownerRepoOfReviewWorktree, removeReviewWorktrees } from "./review-worktree.js"
import type { ReviewRunner } from "./review-runner.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type {
  QueuedPromptView,
  SessionDescriptor,
  SessionsRegistry,
} from "./sessions.js"
import { applyBracketedPasteWrap } from "./sessions.js"
import type { SpawnDefaultsConfig } from "./spawn-defaults.js"
import {
  registerAgentTools,
  registerExportSessionTool,
  collectSubtree,
  stripAnsi,
} from "./agent-tools.js"
import type { RegisterAgentToolsOptions } from "./agent-tools.js"
import { discoverMcps } from "./mcp-discovery.js"
import type { DiscoveredMcp } from "./mcp-discovery.js"
import {
  decideRestartStrategy,
  augmentWithFsResume,
  describeResumePath,
  probeNativeTranscript,
  tokenizeCommand,
  RESUME_STRATEGIES,
} from "./resume-strategies.js"
import {
  restartAgentSession,
  tryRestartInPlace,
  resolveResumeAuth,
  RestartOverrideError,
  type RestartOverrides,
} from "./session-restart-core.js"
import {
  loadImportedMcps,
  saveImportedMcps,
  addImportWithSecrets,
  removeImport,
  type ImportedMcpEntry,
} from "./mcp-imports.js"
import { getMcpCredentialDeps } from "./mcp-credential-deps.js"
import {
  loadBundles,
  createBundle,
  updateBundle,
  deleteBundle,
  danglingImports,
  BundleValidationError,
  type Bundle,
} from "./bundles.js"
import type { McpProxyRegistry, ProxyToolDescriptor } from "./mcp-proxy.js"
import { computeCapabilitiesInventory } from "./capabilities-inventory.js"
import { projectSessionUsage } from "./usage.js"
import { rollupSessionSubtree } from "./usage-subtree.js"
import { parseWindow, rollupUsage } from "./usage-rollup.js"
import {
  computeContextContinuityStatus,
  computeContextPct,
} from "./context-continuity.js"
import { buildSessionCapabilities } from "./session-capabilities.js"
import type { McpObservationStore } from "./mcp-session-observer.js"
import { buildContextCheckpoint, persistCheckpoint, renderCheckpointPrompt } from "./context-checkpoint.js"
import { continueAgentSessionFresh } from "./session-continue-fresh.js"
import { createCheckpointSources } from "./checkpoint-extract.js"
import type { TaskLedger } from "./task-ledger.js"
import { continueInterruptedSessions } from "./continue-interrupted.js"
import {
  compactOutcome,
  OUTCOME_SUMMARY_MAX,
  readLastAssistantTextSync,
  trimOutcomeText,
  type SessionOutcomeCompact,
} from "./session-outcome.js"
import { processTreeRss } from "./process-memory.js"
import {
  applySessionListFilters,
  pickSessionListFilters,
  sessionListFilterShape,
  sortNewestActivityFirst,
} from "./session-list-filters.js"
import { sessionEventsPath } from "./transcript-writer.js"
import {
  INDEX_DEFAULT_LIMIT,
  buildSessionRecap,
  indexEntryFromDescriptor,
  matchesSessionQuery,
  readSessionIndex,
} from "./session-index.js"
import {
  buildLabeledStatsReport,
  statsDetailOf,
  statsParamSchema,
  withSessionStats,
  type ProcessStatsService,
} from "./process-stats.js"
import { getHostLoadService, type HostLoadReport, type HostLoadService } from "./host-load.js"
import {
  planSessionWrapup,
  type SessionWrapupClass,
  type SessionWrapupEntry,
  type SessionWrapupSignals,
} from "./session-wrapup.js"
import {
  buildSessionEvidence,
  readLastMessageTimesSync,
  readRecentToolCallRecordsSync,
  readRecentTurnsSync,
  summarizeToolCalls,
} from "./session-evidence.js"
import { judgeSessionWithJev, resolveJevApiKey, resolveJevConfig } from "./jev-client.js"
import type { SpawnAgentSessionDeps } from "./session-spawn.js"
import {
  collectSessionSnapshots,
  enrichRollupWithAccountCredits,
  enrichRollupWithProviderQuota,
} from "./usage-rollup-service.js"
import { withToolSubset } from "./tool-subset.js"
import { pageParamsShape } from "./tool-envelope.js"
import { catchErrors, paginated } from "@agentproto/tool"
import { registerBuiltinTool } from "@agentproto/mcp-server"
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
  sessionWorktreeScope,
  type WorktreeStatusLister,
  type WorktreeStatusView,
} from "./worktree-status.js"
import { livingSessionCwds, type WorktreeGcResult, type WorktreeGcRunner } from "./worktree-gc.js"
import {
  createBackgroundJobRegistry,
  timedOutWaiting,
  type BackgroundJob,
} from "./background-jobs.js"
import {
  BRANCH_GC_PAGE_MAX,
  sliceBranchGcResult,
  summarizeBranchGcApply,
  withBranchGcApplySummary,
  type BranchGcResultSliceInput,
  type BranchGcResult,
  type BranchGcRunInput,
  type BranchGcRunner,
  type BranchGcVerdictRecorder,
  type BranchGcVerdictReader,
} from "./branch-gc.js"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import {
  ALLOWLIST_REL,
  TERMINAL_GATE_ENV,
  isCommandAllowed,
  loadAllowlistEntries,
  loadTerminalGateMode,
} from "./command-allowlist.js"

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
  /** Set when this session was spawned by `session_continue_fresh` — the
   *  source session's id. A DIFFERENT lineage edge than `parentSessionId`/
   *  the tree nesting itself (a continue-fresh spawn nests under the
   *  source's own parent, as a sibling, not a child of the source), so a
   *  consumer wanting to draw the checkpoint-handoff link needs this field
   *  in addition to the tree shape. See `SessionDescriptor.continuedFrom`
   *  and its `handoff` field (full record only, via `session_list full:true`)
   *  for the harness the checkpoint moved from/to. */
  continuedFrom?: string
  isOrchestrator: boolean
  /** Latest 3 reviews this session requested (`review_run`'s
   *  `requesterSessionId`, default the caller), newest first — settled
   *  attestations from the ledger plus any still-`running`/`cancelled` run
   *  this daemon process has seen (see `ReviewRunner.list()`). Present only
   *  on a node that has requested at least one review. */
  reviews?: ReviewBadge[]
  children: SessionTreeNode[]
}

/** One `session_tree` review badge — see `SessionTreeNode.reviews`. `range`
 *  is `<base7>..<head7>` (short shas); a run with no resolved range yet
 *  omits it rather than showing a misleading placeholder. */
export interface ReviewBadge {
  runId: string
  verdict: "pass" | "block" | "incomplete" | "running" | "cancelled"
  binding: string
  range?: string
  at: string
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

/** Resolve `session_tree`'s `reviews` badges for a set of visible session
 * ids in ONE ledger lookup (the index-backed `requesterSessionIds` filter,
 * never a per-node query) plus the in-process `ReviewRunner.list()` for
 * runs that never reach the ledger (`running`/`cancelled`/a runner-level
 * `failed`, which has no verdict to fold so it's reported as `incomplete`
 * — the badge enum has no separate slot for it). A `done` run is read from
 * the ledger only (its attestation is authoritative and already covers a
 * cache hit's requester), so a runner-level `done` row is skipped here to
 * avoid a duplicate/stale badge for the same runId. */
async function resolveReviewBadges(
  runner: ReviewRunner,
  sessionIds: readonly string[],
): Promise<Map<string, ReviewBadge[]>> {
  const idSet = new Set(sessionIds)
  const byId = new Map<string, { badge: ReviewBadge; at: string }[]>()
  const push = (sessionId: string, badge: ReviewBadge, at: string): void => {
    const arr = byId.get(sessionId)
    if (arr) arr.push({ badge, at })
    else byId.set(sessionId, [{ badge, at }])
  }
  for (const run of runner.list()) {
    if (run.status === "done") continue // covered by the ledger entry below
    if (!run.requesterSessionId || !idSet.has(run.requesterSessionId)) continue
    const verdict = run.status === "running" ? "running" : run.status === "cancelled" ? "cancelled" : "incomplete"
    const range = run.baseSha && run.headSha ? `${run.baseSha.slice(0, 7)}..${run.headSha.slice(0, 7)}` : undefined
    push(
      run.requesterSessionId,
      { runId: run.runId, verdict, binding: run.binding ?? "", ...(range ? { range } : {}), at: run.startedAt },
      run.startedAt,
    )
  }
  const entries = await runner.ledger.list({ requesterSessionIds: sessionIds })
  for (const entry of entries) {
    const sessionId = entry.attestation.requester?.sessionId
    if (!sessionId) continue
    const a = entry.attestation
    push(
      sessionId,
      {
        runId: a.runId,
        verdict: a.verdict,
        binding: a.binding,
        range: `${a.target.baseSha.slice(0, 7)}..${a.target.headSha.slice(0, 7)}`,
        at: a.createdAt,
      },
      a.createdAt,
    )
  }
  const result = new Map<string, ReviewBadge[]>()
  for (const [sessionId, badges] of byId) {
    result.set(
      sessionId,
      badges
        .sort((x, y) => y.at.localeCompare(x.at))
        .slice(0, 3)
        .map(b => b.badge),
    )
  }
  return result
}

/** Attach `reviews` onto every node (recursively) that `badgesFor` returns a
 * non-empty array for — leaves every other node untouched. Works for the
 * full-dump `tree` (nested `children`) and every navigation slice (flat
 * `children: []` on `children`/`parent`/`siblings` nodes; nested on
 * `descendants`). */
function attachReviewBadges(
  nodes: readonly SessionTreeNode[],
  badgesFor: (id: string) => ReviewBadge[] | undefined,
): SessionTreeNode[] {
  return nodes.map(n => {
    const reviews = badgesFor(n.id)
    return {
      ...n,
      ...(reviews && reviews.length > 0 ? { reviews } : {}),
      children: attachReviewBadges(n.children, badgesFor),
    }
  })
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
    ...(s.continuedFrom ? { continuedFrom: s.continuedFrom } : {}),
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
  /** What each session's harness actually loaded from the daemon's `/mcp`
   *  mount; folded into `session_capabilities.mcpServers`. */
  mcpObservations?: McpObservationStore
  /** Absolute path to the workspace root the daemon is bound to — the
   *  SAME workspace `command_execute` gates against. Required (not
   *  optional) on purpose: `terminal_start` resolves its terminal-gate
   *  mode from this workspace's allowlist file, and an unconfigured
   *  host silently running ungated terminals is exactly the defect
   *  class the gate exists to close. */
  workspace: string
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
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.ensureLlmEndpointRunning`. */
  ensureLlmEndpointRunning?: SpawnAgentSessionDeps["ensureLlmEndpointRunning"]
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
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.deviceMirrorSync` (BOOTSTRAP P7b: the
   *  device-mirror read-sync hook, called before `agent_output` tails). */
  deviceMirrorSync?: RegisterAgentToolsOptions["deviceMirrorSync"]
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
  /** Process-stats sampler behind `session_list({stats})` / `session_stats`.
   *  Defaults to the process-wide shared service; tests inject a fake table. */
  processStats?: ProcessStatsService
  /** Host-load collector behind `host_load`. Defaults to the process-wide
   *  shared service; tests inject fake probes. */
  hostLoad?: HostLoadService
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.resolveWorktreeIsolation`. */
  resolveWorktreeIsolation?: RegisterAgentToolsOptions["resolveWorktreeIsolation"]
  /** Forwarded to `registerAgentTools` — the completion-policy supervisor used
   *  to auto-attach a windowed cost-budget policy for an `agent_start` carrying
   *  `costBudget` (phase 4). See `RegisterAgentToolsOptions.supervisor`. */
  supervisor?: RegisterAgentToolsOptions["supervisor"]
  /** Task ledger — lets `session_checkpoint` / `session_continue_fresh` fill
   *  the checkpoint's `nextStep` from the session's open tasks. Optional:
   *  without it (and without `supervisor` for the last gate result) the
   *  checkpoint falls back to the transcript alone. */
  taskLedger?: TaskLedger
  /** Forwarded to `registerAgentTools` — config.json
   *  `defaults.agentPromptInterrupt`, the unset-default for `interrupt` on
   *  `agent_prompt` / `message_parent`. See
   *  `RegisterAgentToolsOptions.defaultAgentPromptInterrupt`. */
  defaultAgentPromptInterrupt?: RegisterAgentToolsOptions["defaultAgentPromptInterrupt"]
  /** Forwarded to `registerAgentTools` — config.json
   *  `defaults.messaging.allowSiblings`. */
  messagingAllowSiblings?: RegisterAgentToolsOptions["messagingAllowSiblings"]
  /** Forwarded to `registerAgentTools` — config.json
   *  `defaults.messaging.agentInterrupt`. */
  messagingAgentInterrupt?: RegisterAgentToolsOptions["messagingAgentInterrupt"]
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
  /**
   * Optional branch-`gc` runner powering `branch_gc` — same injection reason
   * as `runWorktreeGc` (the engine lives in `@agentproto/worktree`). Omitted
   * → `branch_gc` returns a clear "not enabled" error.
   */
  runBranchGc?: BranchGcRunner
  /** Optional verdict recorder powering `branch_gc_verdict`. Same injection reason. */
  recordBranchGcVerdict?: BranchGcVerdictRecorder
  /** Optional verdict reader powering `branch_gc_verdict_get`. Same injection reason. */
  readBranchGcVerdict?: BranchGcVerdictReader
  /** Directory `branch_gc`'s background jobs write their finished result to
   *  (the file `branch_gc_status`'s `resultPath` points at). Defaults to
   *  `~/.agentproto/branch-gc/jobs`. Injectable so tests can point it at a
   *  temp dir instead of the real home directory. */
  branchGcJobsDir?: string
  /** Same, for `worktree_gc`'s background jobs (`worktree_gc_status`).
   *  Defaults to `~/.agentproto/worktree-gc/jobs`. */
  worktreeGcJobsDir?: string
  /** Same, for `session_wrapup_plan`'s background jobs
   *  (`session_wrapup_status`). Defaults to `~/.agentproto/session-wrapup/jobs`. */
  sessionWrapupJobsDir?: string
  /** Same, for `session_wrapup_apply`'s background jobs (polled through
   *  `session_wrapup_status`, ids `swa_…`). Defaults to
   *  `~/.agentproto/session-wrapup/apply-jobs`. */
  sessionWrapupApplyJobsDir?: string
  /** Forwarded to `registerAgentTools` — see
   *  `RegisterAgentToolsOptions.isSessionChatInstalled`. */
  isSessionChatInstalled?: RegisterAgentToolsOptions["isSessionChatInstalled"]
  /** The gateway-singleton review runner (review-runner.ts) — when wired,
   *  `session_tree` attaches a `reviews` badge (latest 3) to every node that
   *  has requested a review. Omitted ⇒ `session_tree` never carries
   *  `reviews`, same output as before this field existed. */
  reviewRunner?: ReviewRunner
}

/** MCP clients commonly stringify scalar arguments ("true"/"false"/"42").
 *  These coercers let a flag work whether the client sends a real JSON
 *  boolean/number or its string form — avoids opaque "expected boolean,
 *  received string" validation errors over the wire. */
const mcpBool = z.preprocess(
  v => (v === "true" ? true : v === "false" ? false : v),
  z.boolean(),
)
const mcpNumber = z.preprocess(
  v => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
  z.number(),
)

// ── session_list COMPACT projection (PR-10) ──────────────────────────────
// The default per-item shape for `session_list`: the identity fields a
// caller needs to list, filter, and route follow-ups to the right session —
// nothing else. The bulky/rarely-needed descriptor echo (context-continuity
// policy detail, available commands, watcher rosters, AGENTS.md/RULES.md
// content, auth + access-profile echoes, adapter config paths, restart
// bookkeeping, …) stays behind `full: true` / `compact: false`, which
// return the unmodified SessionDescriptor exactly as before.
export interface SessionListCompactItem {
  id: string
  kind: SessionDescriptor["kind"]
  origin?: string
  name?: string
  label?: string
  status: SessionDescriptor["status"]
  /** Worktree-provisioning progress of a `starting` row (`queued` with a
   *  1-based `position`, or `running`, plus the `phase`) — see
   *  `SessionDescriptor.provisioning`. Absent once provisioning is over. */
  provisioning?: SessionDescriptor["provisioning"]
  /** Liveness (stamped at read time by the registry) — the unambiguous
   *  signal; `status` alone is a lifecycle classification, not liveness. */
  alive?: boolean
  pty?: boolean
  /** What was actually run — quoted joined, same string the full record carries. */
  command: string
  cwd?: string
  adapterSlug?: string
  model?: string
  busy?: boolean
  awaitingInput?: boolean
  blockedOn?: SessionDescriptor["blockedOn"]
  /** True when the agent accepts steering (`SessionDescriptor.capabilities`)
   *  — a `steer` message can reach its running turn. Absent when not. */
  steering?: boolean
  /** Prompts still waiting to reach this session (queued behind a running
   *  turn), each with its age — `stale` once past the staleness threshold.
   *  Absent when nothing is pending. */
  pendingPrompts?: SessionDescriptor["pendingPrompts"]
  /** How many background tasks the agent still has running — the
   *  "idle, but waiting on N background tasks" signal. Absent when none;
   *  the task list itself is on the full record (`backgroundTasks`). */
  backgroundTaskCount?: number
  lastActivityAt?: string
  startedAt: string
  exitCode?: number
  depth?: number
  parentSessionId?: string
  /** Set when this session was spawned by `session_continue_fresh` — the
   *  source session's id. A DIFFERENT lineage edge than `parentSessionId`
   *  (a continue-fresh spawn nests under the source's own parent, as a
   *  sibling, not a child of the source) — see `SessionDescriptor.continuedFrom`
   *  and its `handoff` field (full record only) for the harness the
   *  checkpoint moved from/to. */
  continuedFrom?: string
  // Usage scalars (small, and codified as session_list output by
  // session-usage-mcp.test.ts): cheap badge signals for list views.
  usageSource?: SessionDescriptor["usageSource"]
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextSizeSource?: SessionDescriptor["contextSizeSource"]
  contextUsed?: number
  /** What an ENDED agent-cli session produced — the derived outcome's status
   *  plus the first 120 chars of its summary (`compactOutcome`). The full
   *  record (`full: true`) carries the whole `outcome`. */
  outcome?: SessionOutcomeCompact
  /** Mirrors `SessionDescriptor.lastTurnErroredAt` — the last turn that
   *  failed IN-BAND while the adapter process stayed alive (`status` stays
   *  `"running"`). Absent otherwise. Surfaced in the compact projection so
   *  a poller sees an errored turn without reading `full: true` or the raw
   *  transcript — the exact gap that made a session whose turn died on an
   *  upstream API error look identical to a healthy idle one. */
  lastTurnErroredAt?: SessionDescriptor["lastTurnErroredAt"]
  /** Mirrors `SessionDescriptor.lastError` (capped at 2000 chars) — why an
   *  errored session died (spawn failure, crash). Absent otherwise. */
  lastError?: string
  /** Mirrors `SessionDescriptor.lastTurnErrorMessage` — the captured error
   *  text for `lastTurnErroredAt`. Absent when that timestamp is absent, or
   *  when the adapter reported `reason:"error"` with no in-band `error`
   *  event to capture a message from. */
  lastTurnErrorMessage?: SessionDescriptor["lastTurnErrorMessage"]
  /** Mirrors `SessionDescriptor.lastTurnReason` — the last completed turn's
   *  reported reason (e.g. `"completed"`, `"error"`, `"aborted"`). Absent
   *  when no reason was reported. */
  lastTurnReason?: SessionDescriptor["lastTurnReason"]
  /** Mirrors `SessionDescriptor.lastTurnEmpty` — true when the last
   *  completed turn produced zero assistant output and zero tool calls.
   *  Absent (not `false`) on a productive turn. */
  lastTurnEmpty?: SessionDescriptor["lastTurnEmpty"]
  /** Mirrors `SessionDescriptor.firstTurnFailed` — device-spawn only: the
   *  first turn ended errored or empty (bad model id / host-side adapter
   *  error). Absent otherwise. */
  firstTurnFailed?: SessionDescriptor["firstTurnFailed"]
  /** Mirrors the derived `SessionDescriptor.interrupted` — true when a daemon
   *  restart killed this session mid-turn and that turn was NOT re-run
   *  (`session_continue_interrupted` sends it a continue prompt). Absent
   *  otherwise. */
  interrupted?: true
  /** Mirrors `SessionDescriptor.rssBytes` — only present when the request
   *  opted in with `withMemory: true` (it costs a `ps` spawn). */
  rssBytes?: number
  /** Mirrors `SessionDescriptor.stats` - only present when the request opted
   *  in with `stats: true | "full"`. */
  stats?: SessionDescriptor["stats"]
  // Device-sandbox identity mapping (BOOTSTRAP P7a) — see the descriptor
  // fields' docs. A device-mirrored row carries them even in the compact
  // projection so "host: <id>" is list-visible.
  hostSessionId?: SessionDescriptor["hostSessionId"]
  hostFingerprint?: SessionDescriptor["hostFingerprint"]
}

/** Public MCP descriptor projection. Resume environment is required by the
 * registry to reattach native PTYs, but must never cross the tool boundary. */
const publicSessionDescriptor = (
  session: SessionDescriptor,
): Omit<SessionDescriptor, "ptyResumeEnv"> => {
  const { ptyResumeEnv: _privateResumeEnv, ...publicDescriptor } = session
  return publicDescriptor
}

export const compactSessionItem = (s: SessionDescriptor): SessionListCompactItem => ({
  id: s.id,
  kind: s.kind,
  ...(s.origin ? { origin: s.origin } : {}),
  name: s.name,
  label: s.label,
  status: s.status,
  ...(s.provisioning ? { provisioning: { ...s.provisioning } } : {}),
  alive: s.alive,
  pty: s.pty,
  command: s.command,
  cwd: s.cwd,
  adapterSlug: s.adapterSlug,
  model: s.model,
  busy: s.busy,
  awaitingInput: s.awaitingInput,
  blockedOn: s.blockedOn,
  ...(s.capabilities?.steering ? { steering: true } : {}),
  ...(s.pendingPrompts?.length ? { pendingPrompts: s.pendingPrompts } : {}),
  ...(s.backgroundTasks?.length ? { backgroundTaskCount: s.backgroundTasks.length } : {}),
  lastActivityAt: s.lastActivityAt,
  startedAt: s.startedAt,
  exitCode: s.exitCode,
  depth: s.depth,
  parentSessionId: s.parentSessionId,
  continuedFrom: s.continuedFrom,
  usageSource: s.usageSource,
  costUsd: s.costUsd,
  tokensIn: s.tokensIn,
  tokensOut: s.tokensOut,
  contextSize: s.contextSize,
  contextSizeSource: s.contextSizeSource,
  contextUsed: s.contextUsed,
  ...(s.outcome ? { outcome: compactOutcome(s.outcome) } : {}),
  ...(s.lastError ? { lastError: s.lastError.slice(0, 2000) } : {}),
  ...(s.lastTurnErroredAt !== undefined ? { lastTurnErroredAt: s.lastTurnErroredAt } : {}),
  ...(s.lastTurnErrorMessage !== undefined ? { lastTurnErrorMessage: s.lastTurnErrorMessage } : {}),
  ...(s.lastTurnReason !== undefined ? { lastTurnReason: s.lastTurnReason } : {}),
  ...(s.lastTurnEmpty !== undefined ? { lastTurnEmpty: s.lastTurnEmpty } : {}),
  ...(s.firstTurnFailed ? { firstTurnFailed: true as const } : {}),
  ...(s.interrupted ? { interrupted: true as const } : {}),
  ...(s.rssBytes !== undefined ? { rssBytes: s.rssBytes } : {}),
  ...(s.stats !== undefined ? { stats: s.stats } : {}),
  // Device-sandbox identity mapping (BOOTSTRAP P7a) — a device-mirrored row
  // surfaces which HOST session id the real conversation lives under, so a
  // UI can show "host: <id>" straight off the list.
  ...(s.hostSessionId ? { hostSessionId: s.hostSessionId } : {}),
  ...(s.hostFingerprint ? { hostFingerprint: s.hostFingerprint } : {}),
})

// ── batch compact projections (tool-transformer migration) ───────────────
// One compact projection per migrated list tool, same shape philosophy as
// `compactSessionItem`: identity/routing fields + small usage scalars by
// default; bulky, sensitive, or rarely-needed fields stay behind `full: true`.

/** Default per-item shape for `mcp_discovered_list`: enough to identify,
 *  attribute, and route `mcp_import` — never the spawn details. */
export interface DiscoveredMcpCompactItem {
  id: string
  source: DiscoveredMcp["source"]
  scope: string
  name: string
  type: DiscoveredMcp["type"]
}

export const compactDiscoveredMcp = (m: DiscoveredMcp): DiscoveredMcpCompactItem => ({
  id: m.id,
  source: m.source,
  scope: m.scope,
  name: m.name,
  type: m.type,
})

/** Default per-item shape for `mcp_imported_list`: the curated-set bookkeeping
 *  (id/alias/addedAt) plus the snapshot's identity trio. The full snapshot —
 *  command/args/env/headers, some of it secret-bearing — stays behind
 *  `full: true`. */
export interface ImportedMcpCompactEntry {
  id: string
  alias: string
  addedAt: string
  source: DiscoveredMcp["source"]
  name: string
  type: DiscoveredMcp["type"]
}

export const compactImportedMcpEntry = (
  e: ImportedMcpEntry,
): ImportedMcpCompactEntry => ({
  id: e.id,
  alias: e.alias,
  addedAt: e.addedAt,
  source: e.snapshot.source,
  name: e.snapshot.name,
  type: e.snapshot.type,
})

/** Default per-item shape for `mcp_imported_tool_list`: name + description.
 *  The upstream `inputSchema` (the bulky part) and `_meta` stay behind
 *  `full: true` / a `fields` allowlist naming them. */
export interface ProxyToolCompactItem {
  name: string
  description?: string
}

export const compactProxyTool = (t: ProxyToolDescriptor): ProxyToolCompactItem => ({
  name: t.name,
  ...(t.description !== undefined ? { description: t.description } : {}),
})

/** Default per-item shape for `session_queue_list`: position/origin/preview
 *  + the stable id needed to route `session_queue_promote`/`deliver`/`drop`.
 *  `queuedAt` stays behind `full: true`. */
export interface QueuedPromptCompactItem {
  id: string
  origin: string
  preview: string
  position: number
}

export const compactQueuedPromptView = (
  q: QueuedPromptView,
): QueuedPromptCompactItem => ({
  id: q.id,
  origin: q.origin,
  preview: q.preview,
  position: q.position,
})

/** Default per-item shape for `worktree_status`: the worktree identity +
 *  PR/class scalars. The per-session roster (`sessions[]`) stays behind
 *  `full: true`. */
export interface WorktreeStatusCompactItem {
  path: string
  branch: string | null
  class: WorktreeStatusView["class"]
  reclaimable: boolean
  dirty: WorktreeStatusView["dirty"]
  changes?: WorktreeStatusView["changes"]
  base: WorktreeStatusView["base"]
  pr: WorktreeStatusView["pr"]
  liveness: WorktreeStatusView["liveness"]
}

export const compactWorktreeStatus = (
  w: WorktreeStatusView,
): WorktreeStatusCompactItem => ({
  path: w.path,
  branch: w.branch,
  class: w.class,
  reclaimable: w.reclaimable,
  dirty: w.dirty,
  ...(w.changes ? { changes: w.changes } : {}),
  base: w.base,
  pr: w.pr,
  liveness: w.liveness,
})

/** Projection for `terminal_sessions_list` / `command_list`: session_list's
 *  compact shape plus the provenance scalars (`origin`, `callerSessionId`)
 *  those tools' callers route on. */
export interface SessionListCompactItemWithProvenance
  extends SessionListCompactItem {
  origin?: string
  callerSessionId?: string
}

export const compactSessionItemWithProvenance = (
  s: SessionDescriptor,
): SessionListCompactItemWithProvenance => ({
  ...compactSessionItem(s),
  ...(s.origin !== undefined ? { origin: s.origin } : {}),
  ...(s.callerSessionId !== undefined ? { callerSessionId: s.callerSessionId } : {}),
})

// ── background jobs (module scope) ───────────────────────────────────
// `branch_gc`, `worktree_gc` and `session_wrapup_plan` can each run for
// minutes — past the ~49 s an MCP caller should expect per call — so they
// support `wait: false` / `waitMs` and a `*_status` poll tool. The registries
// live at MODULE scope (one per daemon process, shared across the per-
// connection McpServers); the machinery is in `./background-jobs.ts`.
const branchGcJobs = createBackgroundJobRegistry<BranchGcResult>({
  idPrefix: "bgc_",
  defaultDir: join(homedir(), ".agentproto", "branch-gc", "jobs"),
})
const worktreeGcJobs = createBackgroundJobRegistry<WorktreeGcResult>({
  idPrefix: "wgc_",
  defaultDir: join(homedir(), ".agentproto", "worktree-gc", "jobs"),
})
interface SessionWrapupPlanResult {
  entries: SessionWrapupEntry[]
  totals: Partial<Record<SessionWrapupClass, number>>
}
const sessionWrapupJobs = createBackgroundJobRegistry<SessionWrapupPlanResult>({
  idPrefix: "swp_",
  defaultDir: join(homedir(), ".agentproto", "session-wrapup", "jobs"),
})

interface SessionWrapupApplyResult {
  results: Array<{ sessionId: string; ok: boolean; class?: SessionWrapupClass; action?: "closed" | "flagged"; error?: string }>
}
const sessionWrapupApplyJobs = createBackgroundJobRegistry<SessionWrapupApplyResult>({
  idPrefix: "swa_",
  defaultDir: join(homedir(), ".agentproto", "session-wrapup", "apply-jobs"),
})

/** Default window `worktree_gc` / `session_wrapup_plan` block for before
 *  falling back to the background view (under a ~60 s MCP client timeout). */
const BACKGROUND_DEFAULT_WAIT_MS = 25_000

const branchGcBackgroundView = (job: BackgroundJob<BranchGcResult>): object =>
  branchGcJobs.backgroundView(job, {
    tool: "branch_gc_status",
    hint:
      "Running in the background; a plan on a large repo takes a few minutes. " +
      "Call branch_gc_status with this jobId about every 30 s. When done it " +
      "returns the summary and, once the file exists, a resultPath holding " +
      "the full result (pass full: true to get a filtered/paged slice inline).",
  })

/** The `done` view `branch_gc_status` returns — identical for an in-memory
 *  job and one rebuilt from its on-disk result file (Part of the
 *  disk-fallback contract: callers see the same shape either way). */
const branchGcDoneView = (
  jobId: string,
  resultPath: string | undefined,
  result: BranchGcResult,
  slice: BranchGcResultSliceInput | undefined,
  endedAt?: string,
): object => ({
  jobId,
  status: "done",
  ...(endedAt !== undefined ? { endedAt } : {}),
  ...(resultPath !== undefined ? { resultPath } : {}),
  summary: result.summary,
  // Apply results carry the restore log path, a per-outcome tally and the
  // per-scope deleted/skipped/failed summary — exactly what a caller needs
  // to decide "safe?" without fetching the full ~MB result with `full: true`.
  // Result files written before `applySummary` existed are summarised here.
  ...(result.mode === "apply"
    ? {
        restoreLog: result.restoreLog ?? null,
        outcomeCounts: result.outcomes.reduce<Record<string, number>>((acc, o) => {
          acc[o.result] = (acc[o.result] ?? 0) + 1
          return acc
        }, {}),
        applySummary: result.applySummary ?? summarizeBranchGcApply(result),
      }
    : {}),
  ...(slice ? sliceBranchGcResult(result, slice) : {}),
})

const worktreeGcBackgroundView = (job: BackgroundJob<WorktreeGcResult>): object =>
  worktreeGcJobs.backgroundView(job, {
    tool: "worktree_gc_status",
    hint:
      "Running in the background (it keeps going even if you never poll). " +
      "Call worktree_gc_status with this jobId about every 30 s; when done it " +
      "returns the same result worktree_gc returns inline.",
  })

const sessionWrapupApplyBackgroundView = (job: BackgroundJob<SessionWrapupApplyResult>): object =>
  sessionWrapupApplyJobs.backgroundView(job, {
    tool: "session_wrapup_status",
    hint:
      "Running in the background (it keeps going even if you never poll). " +
      "Call session_wrapup_status with this jobId about every 30 s; when " +
      "done, `result` is the same `{ results }` session_wrapup_apply returns inline.",
  })

const sessionWrapupBackgroundView = (job: BackgroundJob<SessionWrapupPlanResult>): object =>
  sessionWrapupJobs.backgroundView(job, {
    tool: "session_wrapup_status",
    hint:
      "Running in the background. Call session_wrapup_status with this " +
      "jobId about every 30 s; when done it returns the same `{ entries, " +
      "totals }` session_wrapup_plan returns inline.",
  })

/** Shared `*_status` handler for jobs whose done view is just the result
 *  itself: memory first, then the on-disk result file, then not-found. */
const backgroundStatusResult = async <T>(
  toolName: string,
  jobs: ReturnType<typeof createBackgroundJobRegistry<T>>,
  jobId: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
  const job = jobs.get(jobId)
  if (!job) {
    const parsed = await jobs.readResultFile(jobId)
    if (parsed === undefined) {
      return {
        content: [
          {
            type: "text",
            text: `${toolName} job '${jobId}' not found (no running job and no result file at ${jobs.resultPathFor(jobId)})`,
          },
        ],
        isError: true,
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ jobId, status: "done", resultPath: jobs.resultPathFor(jobId), result: parsed }) }] }
  }
  if (job.status !== "done") return { content: [{ type: "text", text: JSON.stringify(jobs.progressView(job)) }] }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          jobId: job.id,
          status: "done",
          endedAt: job.endedAt,
          ...(job.resultPath !== undefined ? { resultPath: job.resultPath } : {}),
          result: job.result,
        }),
      },
    ],
  }
}

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
    workspace,
    mcpProxy,
    callerScope,
    callerSessionId,
    resolveAgentAdapter,
    listWorktreeStatuses,
    runWorktreeGc,
    runBranchGc,
    recordBranchGcVerdict,
    readBranchGcVerdict,
    listCatalogModels,
    loadDefaultsConfig,
    reviewRunner,
    listAgentAdapters,
  } = opts
  const checkpointSources = createCheckpointSources({
    ...(opts.supervisor ? { supervisor: opts.supervisor } : {}),
    ...(opts.taskLedger ? { taskLedger: opts.taskLedger } : {}),
  })
  const ptyEnabled = opts.ptyEnabled === true
  // Point the module-level branch_gc job registry at the injected dir (tests
  // use this to avoid writing into the real home directory). Last write wins.
  if (opts.branchGcJobsDir) branchGcJobs.setDir(opts.branchGcJobsDir)
  if (opts.worktreeGcJobsDir) worktreeGcJobs.setDir(opts.worktreeGcJobsDir)
  if (opts.sessionWrapupJobsDir) sessionWrapupJobs.setDir(opts.sessionWrapupJobsDir)
  if (opts.sessionWrapupApplyJobsDir) sessionWrapupApplyJobs.setDir(opts.sessionWrapupApplyJobsDir)

  // Shared registration helper for the list tools migrated onto the AIP
  // contract layer (session_list's pattern): defineTool + implementTool +
  // a single-candidate builtin driver + toMcpTool with catchErrors() and
  // paginated() transformers. `body` returns the FULL, unprojected rows —
  // the compact projection is `project`'s job; errors thrown anywhere in
  // the body surface as the canonical MCP error result.
  const registerPaginatedListTool = <TInput, TItem extends object>(args: {
    id: string
    description: string
    schema: z.ZodType<TInput>
    body: (input: TInput) => Promise<TItem[]>
    project: (item: TItem) => object
    keyOf: (item: TItem) => string | number | null
    itemKey: string
    /** Row cap for a call with no `limit`/`cursor` (default: unbounded). */
    defaultLimit?: number
  }): void => {
    registerBuiltinTool<TInput, TItem[]>(server, {
      id: args.id,
      description: args.description,
      inputSchema: args.schema,
      handler: (input) => args.body(input),
      transformers: [
        catchErrors(),
        paginated({
          project: args.project,
          keyOf: args.keyOf,
          maxLimit: 200,
          itemKey: args.itemKey,
          ...(args.defaultLimit !== undefined ? { defaultLimit: args.defaultLimit } : {}),
        }),
      ],
    })
  }

  // Delegate the agent-family tools to the dedicated module.
  registerAgentTools(server, opts)

  // ── session_list (canonical lister) ──────────────────────────
  // Migrated onto the AIP contract layer (defineTool + implementTool +
  // toMcpTool) as the proof-of-concept for the ToolTransformer mechanism:
  // the pagination/compact/fields concerns are now applied by the
  // `paginated()` transformer at registration instead of hand-rolled in
  // the handler. Observable behavior is unchanged.
  //
  // No conditional-GET / strong-etag support here, unlike `GET /sessions`
  // (http-server.ts) — `registerBuiltinTool`'s handler only ever receives
  // the validated input (see register-builtin-tool.ts), with no access to
  // the underlying request/response, and MCP's `tools/call` has no 304
  // concept: every call is a fresh JSON-RPC result. A poller that wants the
  // byte savings has to go through the REST route instead.
  const sessionListSchema = z.object({
    kind: z
      .enum(["terminal", "agent-cli", "command", "all"])
      .optional()
      .describe("Filter by kind. `all` (default) = terminal + agent-cli, without `command` unless `includeCommands`."),
    includeCommands: z
      .boolean()
      .optional()
      .describe("With kind unset/`all`, also include `kind:'command'` rows. Default false."),
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
      .describe("Also include archived sessions. Default false."),
    withMemory: z
      .boolean()
      .optional()
      .describe("Add `rssBytes` (process-tree RSS) to live sessions with a pid; one `ps` per call. Default false."),
    stats: statsParamSchema.describe(
      "Per-live-session RSS, %CPU, process count and top commands under `stats`; `true` = summary, " +
        "`\"full\"` = every process. Cached ~3s. Host-level view: `session_stats`.",
    ),
    ...sessionListFilterShape,
    ...pageParamsShape,
  })
  type SessionListInput = z.infer<typeof sessionListSchema>

  registerBuiltinTool<SessionListInput, Array<Omit<SessionDescriptor, "ptyResumeEnv">>>(server, {
    id: "session_list",
    description: "List sessions tracked by the daemon (agent-CLI and terminal/PTY). " +
      "Use it to see what's already running before spawning, or to find a session id by name. " +
      "NARROW BEFORE YOU READ: hundreds of sessions are mostly noise and without `limit` all " +
      "come back. Filter (`q`, `excludeNoise`, `rootOnly`, `updatedSince`, …) and/or pass " +
      "`limit`; rows are newest-activity first, `total` is the filtered count. " +
      "E.g. `{q:'X', excludeNoise:true, limit:10}`. " +
      "Rows are COMPACT by default (`fields:[…]` picks keys, `full:true` returns everything). " +
      "Detail: tool_help {name:\"session_list\"}; ranked text search: `session_search`.",
    inputSchema: sessionListSchema,
    handler: async (input) => {
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
      // Inbox-only external rows are not agents; they never appear in this list.
      rows = rows.filter(s => s.kind !== "external")
      if (input.status) {
        rows = rows.filter(s => s.status === input.status)
      } else if (input.onlyAlive) {
        rows = rows.filter(
          s => s.status === "running" || s.status === "starting",
        )
      }
      // Narrow + order BEFORE the per-row `ps` sampling below, so
      // `withMemory`/`stats` only pay for rows that survive.
      const { parentSessionId, ...filterRest } = pickSessionListFilters(input)
      rows = applySessionListFilters(rows, {
        ...filterRest,
        ...(parentSessionId ? { parentSessionId: registry.findByIdOrName(parentSessionId)?.id ?? parentSessionId } : {}),
      })
      rows = sortNewestActivityFirst(rows)
      if (input.withMemory) {
        const live = rows.filter(
          (s): s is SessionDescriptor & { pid: number } =>
            typeof s.pid === "number" && (s.status === "running" || s.status === "starting"),
        )
        if (live.length > 0) {
          const rssByPid = await processTreeRss(live.map(s => s.pid))
          rows = rows.map(s => {
            const rssBytes = typeof s.pid === "number" ? rssByPid.get(s.pid) : undefined
            return rssBytes !== undefined ? { ...s, rssBytes } : s
          })
        }
      }
      const statsDetail = statsDetailOf(input.stats)
      if (statsDetail) {
        rows = await withSessionStats(
          rows,
          registry.list({ includeArchived: true }),
          statsDetail,
          opts.processStats,
        )
      }
      return rows.map(publicSessionDescriptor)
    },
    transformers: [
      catchErrors(),
      paginated({
        project: compactSessionItem,
        keyOf: s => s.id,
        maxLimit: 200,
        itemKey: "sessions",
        includeTotal: true,
      }),
    ],
  })

  // ── session_search ───────────────────────────────────────────────
  // The CLI's `agentproto sessions find <query>` as an MCP verb. Same filters
  // (case-insensitive id-prefix/label/title/cwd/workspaceSlug, optional exact
  // status, default 20 results) and the SAME compact per-item shape as
  // `session_list`, so a caller can pipe a hit straight into `session_recap`.
  // Answers from the live registry (which the index sidecar mirrors) so it is
  // instant even on a store with thousands of rows.
  const sessionSearchSchema = z.object({
    query: z
      .string()
      .describe(
        "Case-insensitive substring to match: a session id PREFIX, or a " +
          "substring of label, title, cwd, or workspace slug. Empty matches all.",
      ),
    status: z
      .enum(["starting", "running", "exited", "killed", "error"])
      .optional()
      .describe("Filter by exact status."),
    ...pageParamsShape,
  })
  type SessionSearchInput = z.infer<typeof sessionSearchSchema>

  registerBuiltinTool<SessionSearchInput, Array<Omit<SessionDescriptor, "ptyResumeEnv">>>(server, {
    id: "session_search",
    description:
      "Find sessions by a case-insensitive query across id prefix, label, title, cwd and " +
      "workspace slug — the daemon-side twin of `agentproto sessions find <query>`. " +
      "Optional `status` filters to an exact lifecycle status; `limit` (default 20) caps " +
      "the result. Each hit uses the same compact shape as `session_list`. Read-only; " +
      "use `session_recap` on a hit to see where that session stopped.",
    inputSchema: sessionSearchSchema,
    handler: async input => {
      let rows = registry.list({ includeArchived: true })
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, rows)
        rows = rows.filter(s => subtree.has(s.id))
      }
      rows = rows.filter(s => matchesSessionQuery(s, input.query))
      if (input.status) rows = rows.filter(s => s.status === input.status)
      const limit = Math.max(1, Math.min(200, input.limit ?? INDEX_DEFAULT_LIMIT))
      rows = rows
        .sort((a, b) => (b.lastActivityAt ?? b.startedAt).localeCompare(a.lastActivityAt ?? a.startedAt))
        .slice(0, limit)
      return rows.map(publicSessionDescriptor)
    },
    transformers: [
      paginated({
        project: compactSessionItem,
        keyOf: s => s.id,
        maxLimit: 200,
        itemKey: "sessions",
      }),
    ],
  })

  // ── session_recap ────────────────────────────────────────────────
  // The CLI's `agentproto sessions recap <id>` as an MCP verb. One glance at
  // "where did we stop": the last K user prompts (with timestamps), the final
  // assistant text of the last turn, and the session's meta (status/alive,
  // model, adapter, cwd, parent, children, cost, queued prompts). Backed by
  // the index sidecar plus a BOUNDED tail read of events.jsonl (seek from
  // end, ≤256KB) — never a whole-file load. Unknown id refuses gracefully.
  registerBuiltinTool<
    { id: string; last?: number },
    ReturnType<typeof buildSessionRecap>
  >(server, {
    id: "session_recap",
    description:
      "One-glance \"where did we stop\" for a session: the last K user prompts with " +
      "timestamps, the final assistant text of the last turn, and meta (status/alive, " +
      "model, adapter, cwd, parent, child ids, cost, queued prompts). Reads the session's " +
      "index sidecar plus a bounded tail of its transcript — never the whole file. Use it " +
      "to resume an interrupted session by id (find the id with `session_search`).",
    inputSchema: z.object({
      id: z.string().min(1).describe("Session id or name — from `session_list`/`session_search`."),
      last: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("How many recent user prompts to include (default 8)."),
    }),
    handler: async input => {
      const resolved = registry.findByIdOrName(input.id)
      if (!resolved) throw new Error(`session_recap: no session "${input.id}"`)
      const desc = registry.get(resolved.id) ?? resolved
      const baseDir = registry.transcriptBaseDir
      const index = readSessionIndex(desc.id, baseDir)
      const entry = indexEntryFromDescriptor(desc, {
        ...(index?.lastUserPrompt ? { lastUserPrompt: index.lastUserPrompt } : {}),
        ...(index?.lastOutputText ? { lastOutputText: index.lastOutputText } : {}),
      })
      const children = registry
        .list({ includeArchived: true })
        .filter(s => s.parentSessionId === desc.id)
        .map(s => s.id)
      return buildSessionRecap({
        entry,
        eventsPath: sessionEventsPath(desc.id, baseDir),
        last: input.last ?? 8,
        children,
        ...(desc.queuedPrompts !== undefined ? { queuedPrompts: desc.queuedPrompts } : {}),
        ...(desc.pendingPrompts?.length ? { pendingPrompts: desc.pendingPrompts } : {}),
      })
    },
    transformers: [catchErrors()],
  })

  // ── session_stats ────────────────────────────────────────────────
  // The host-level companion to `session_list({stats})`: who is eating RAM /
  // CPU right now, per session, plus the buckets a per-session view can't
  // show (the daemon itself, worktree provisioning not yet attached to a
  // session, agentproto-looking orphans of dead sessions) and the host's load
  // + free memory. Read-only: orphans are reported, never killed.
  registerBuiltinTool<
    { detail?: "summary" | "full"; fresh?: boolean },
    Awaited<ReturnType<typeof buildLabeledStatsReport>>
  >(server, {
    id: "session_stats",
    description:
      "Resource usage per session, sampled from the OS process table: RSS bytes, %CPU, " +
      "process count and top commands by RSS for every live session, sorted by RSS " +
      "(each row labelled with the session's `label`/`name`), plus `daemon` " +
      "(the daemon process + its own children), `provisioning` (worktree setup " +
      "work such as `pnpm install` not yet attached to a session, with `inFlight` " +
      "provisions), `orphans` (processes that look agentproto-owned but belong to " +
      "no live session - reported only, never killed), `totals`, and `host` " +
      "(load average, free/total memory). `detail:\"full\"` adds every process " +
      "(pid, command, RSS, CPU, elapsed) per row. Cached ~3s; `fresh:true` " +
      "forces a new sample. A subtree-scoped caller sees only its own sessions " +
      "(no daemon/provisioning/orphan buckets).",
    inputSchema: z.object({
      detail: z.enum(["summary", "full"]).optional().describe('Default "summary".'),
      fresh: mcpBool.optional().describe("Bypass the ~3s cache and sample now."),
    }),
    handler: async input => {
      const all = registry.list({ includeArchived: true })
      const visible = callerScope
        ? collectSubtree(callerScope.ownerSessionId, all)
        : undefined
      return buildLabeledStatsReport({
        sessions: all,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.fresh ? { fresh: true } : {}),
        ...(visible ? { visible } : {}),
        ...(opts.processStats ? { service: opts.processStats } : {}),
      })
    },
    transformers: [catchErrors()],
  })

  // ── host_load ────────────────────────────────────────────────────
  // Host-wide load: loadavg vs cores, CPU split, RAM/swap, per-disk IO, the
  // heaviest processes with their owning session, and WARNINGS (swap
  // pressure, old busy orphans, deleted-cwd loops, filesystem-wide scans,
  // duplicate servers on a port). Read-only; nothing here kills anything.
  registerBuiltinTool<{ detail?: "summary" | "full"; fresh?: boolean; budgetMs?: number }, HostLoadReport>(server, {
    id: "host_load",
    description:
      "Host-level load report: load average vs core count, CPU user/sys/idle, RAM " +
      "(used/wired/compressor/free) and swap, per-disk transfers/s + MB/s, the top 10 " +
      "processes by CPU and by memory footprint (compressed pages included on macOS) " +
      "each tagged with its owning session (`session`/`daemon`/`provisioning`/" +
      "`orphan`/`system`/`other`), and `warnings` (swap > 50%, orphaned processes " +
      "older than 30 min that are busy or serving, deleted-cwd processes, " +
      "filesystem-wide `find`/`bfs`/`du` scans, several servers on one port, load > " +
      "4x cores). `detail:\"full\"` adds a per-session rollup and every process. " +
      "Bounded to ~2s: a probe that is slow or unavailable is named in `partial` and " +
      "the rest still ships (raise `budgetMs` to give the macOS `top` footprint " +
      "probe longer on a saturated host). Cached ~2s; `fresh:true` resamples. Never " +
      "needs sudo. A subtree-scoped caller sees host metrics plus only its own " +
      "sessions' processes.",
    inputSchema: z.object({
      detail: z.enum(["summary", "full"]).optional().describe('Default "summary".'),
      fresh: mcpBool.optional().describe("Bypass the ~2s cache and sample now."),
      budgetMs: z.coerce
        .number()
        .int()
        .min(300)
        .max(60_000)
        .optional()
        .describe("Time budget for the sample in ms (default 1900)."),
    }),
    handler: async input => {
      const all = registry.list({ includeArchived: true })
      const visible = callerScope ? collectSubtree(callerScope.ownerSessionId, all) : undefined
      return (opts.hostLoad ?? getHostLoadService()).report(all, {
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.fresh ? { fresh: true } : {}),
        ...(input.budgetMs ? { budgetMs: input.budgetMs } : {}),
        ...(visible ? { visible } : {}),
      })
    },
    transformers: [catchErrors()],
  })

  // ── session_continue_interrupted ─────────────────────────────────
  // Manual twin of `daemon.continueInterruptedOnBoot` — see
  // continue-interrupted.ts for eligibility. Dry-run by default: the first
  // call is a look, not a send.
  server.tool(
    "session_continue_interrupted",
    "List the sessions the LAST daemon restart cut off mid-turn " +
      "(`interrupted: true`) and — with `dryRun: false` — send each a one-shot " +
      "\"continue\" prompt (the interrupted prompt itself is never re-run). " +
      "Goes through the normal prompt path, so a dead-but-resumable session " +
      "resumes in place first. Skips sessions that aren't interrupted, were " +
      "interrupted by an older restart, aren't resumable, hit the resume " +
      "attempt cap, are already busy, or whose cwd no longer exists. Returns a per-session outcome " +
      "(`eligible` on a dry run, else `sent`/`skipped` with a reason/`failed`).",
    {
      dryRun: mcpBool
        .optional()
        .describe("Default true: only report what would be sent. Pass false to send."),
      ids: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "Restrict to these sessions (id or name). Omitted ⇒ every session " +
            "interrupted by the last restart.",
        ),
      prompt: z
        .string()
        .optional()
        .describe("Custom continue prompt. Omitted ⇒ a default telling the agent " +
          "its turn was cut off by a restart and to check the state on disk."),
    },
    async input => {
      const subtree = callerScope
        ? collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        : undefined
      const result = await continueInterruptedSessions({
        registry,
        mode: "manual",
        dryRun: input.dryRun ?? true,
        ...(input.ids
          ? { ids: input.ids.map(ref => registry.findByIdOrName(ref)?.id ?? ref) }
          : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(subtree ? { visible: (d: SessionDescriptor) => subtree.has(d.id) } : {}),
      })
      return { content: [{ type: "text", text: JSON.stringify(result) }] }
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
      "measured). Also reports `cacheReadTokens` / `cacheWriteTokens` / " +
      "`reasoningTokens` where the adapter exposes them, plus `turns`, " +
      "`toolCalls`, `durationMs` (time inside turns). Absent fields are " +
      "omitted rather than zeroed. `includeSubtree: true` returns " +
      "`{ sessionId, self, subtree, children }` instead: `subtree` sums cost + " +
      "tokens over this session and everything it (transitively) spawned, " +
      "`children` lists the direct children with their own cost/tokens. Same " +
      "lookup as `session_list` / `session_restart` (by id or name).",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`, alive or historical."),
      includeSubtree: z
        .boolean()
        .optional()
        .describe(
          "Also roll usage up over every session this one (transitively) spawned. " +
            "Totals only sum sessions that report a field; a field no session " +
            "reports is omitted.",
        ),
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
      if (input.includeSubtree) {
        const rollup = rollupSessionSubtree(desc, registry.list({ includeArchived: true }))
        return {
          content: [
            { type: "text", text: JSON.stringify({ sessionId: desc.id, ...rollup }) },
          ],
        }
      }
      const usage = projectSessionUsage(desc)
      return {
        content: [
          { type: "text", text: JSON.stringify({ sessionId: desc.id, ...usage }) },
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
        content: [{ type: "text", text: JSON.stringify(status) }],
      }
    },
  )

  // ── session_capabilities ─────────────────────────────────────────
  server.tool(
    "session_capabilities",
    "Return everything one session can do and has attached, in a single " +
      "read: harness slash commands (`commands`/`commandsSupported`), " +
      "modes/posture (`availableModes`/`posture`/`canonicalPostures`), " +
      "model/effort, mounted MCP servers (name/transport/ref only — never " +
      "headers/env/credentials), resolved skills, and permission-hold state " +
      "(`permissionHold`/`pendingPermissions`). Same lookup as `session_list` " +
      "/ `session_restart` (by id or name); the REST twin is " +
      "`GET /sessions/:id/capabilities`.",
    {
      sessionId: z
        .string()
        .min(1)
        .optional()
        .describe("Session id or name — from `session_list`. Alias: `id`."),
      id: z
        .string()
        .min(1)
        .optional()
        .describe("Alias for `sessionId`."),
    },
    async input => {
      const idOrName = input.sessionId ?? input.id
      if (!idOrName) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "missing sessionId (or id)" }) },
          ],
          isError: true,
        }
      }
      const desc = registry.findByIdOrName(idOrName)
      if (!desc) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `no session "${idOrName}" found` }) },
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
                    `session_capabilities: session "${desc.id}" is not in your subtree.`,
                  sessionId: desc.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      // `get()` (not `findByIdOrName`'s own stamping) is what freshens
      // `availableModes` from the live agent session — see `stampLiveModes`.
      const fresh = registry.get(desc.id) ?? desc
      const pendingPermissions = registry.listPendingPermissions({ sessionId: fresh.id }).length
      return {
        content: [
          { type: "text", text: JSON.stringify(buildSessionCapabilities(fresh, pendingPermissions, opts.mcpObservations?.get(fresh.id))) },
        ],
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
      notes: z
        .string()
        .max(4000)
        .optional()
        .describe(
          "Operator notes to carry over verbatim in the checkpoint's `notes` " +
            "section — decisions, constraints, anything the next session must know."
        ),
      askSource: z
        .boolean()
        .optional()
        .describe(
          "Ask the live source session to summarise itself (goal, decisions, " +
            "tests, risks, next step) as a short handoff turn before the " +
            "checkpoint is built. Default true; ignored (falls back to " +
            "transcript extraction) when the session is dead, busy or doesn't " +
            "answer within ~60s. Set false to avoid sending the session a prompt."
        ),
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
      const checkpoint = await buildContextCheckpoint(desc, {
        contextPct: pct,
        registry,
        sources: checkpointSources,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.askSource !== undefined ? { askSource: input.askSource } : {}),
      })
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
                schemaVersion: checkpoint.schemaVersion,
                contextPct: checkpoint.contextPct,
                nextAction: checkpoint.nextAction,
                handoffTurn: checkpoint.handoffTurn,
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
      "session with a structured checkpoint as its initial prompt. By " +
      "default the new session uses the same adapter, harness, model, " +
      "route, access profile, posture, effort, and cwd — pass `harness`/" +
      "`adapter`, `model`, and/or `access.profileRef` to override any of " +
      "those three axes, enabling a CROSS-harness handoff (e.g. claude-code " +
      "-> opencode). An overridden axis is validated for model x profile " +
      "eligibility the same way `agent_start` validates it — an ineligible " +
      "profile or an adapter that can't reach the model fails the spawn " +
      "instead of silently landing on a wrong wallet or a 404. The original " +
      "session is linked via `continuedFrom`/`continuedTo`, its transcript " +
      "is preserved, and the new descriptor carries `handoff: { fromHarness, " +
      "toHarness, at }` recording which harness the checkpoint moved from/to.",
    {
      idOrName: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
      harness: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Override the canonical harness slug for the fresh session — the " +
            "cross-harness handoff axis (e.g. 'opencode'). Alias of `adapter`; " +
            "set either or both. Omitted -> carried forward from the prior " +
            "session, unchanged."
        ),
      adapter: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Override the adapter slug for the fresh session — alias of " +
            "`harness`. Set either or both. Omitted -> carried forward from " +
            "the prior session, unchanged."
        ),
      model: z
        .string()
        .min(1)
        .optional()
        .describe("Override the model for the fresh session (route-identity ref)."),
      access: z
        .object({
          profileRef: z
            .string()
            .min(1)
            .describe(
              "Attach this NAMED auth profile to the fresh session. Rejected " +
                "400 if it's not eligible for the resolved (adapter x route)."
            ),
        })
        .optional()
        .describe("Switch the fresh session's billing wallet to a named auth profile."),
      notes: z
        .string()
        .max(4000)
        .optional()
        .describe(
          "Operator notes to carry over verbatim in the checkpoint's `notes` " +
            "section — decisions, constraints, anything the next session must know."
        ),
      askSource: z
        .boolean()
        .optional()
        .describe(
          "Ask the live source session to summarise itself (goal, decisions, " +
            "tests, risks, next step) as a short handoff turn before the " +
            "checkpoint is built. Default true; ignored (falls back to " +
            "transcript extraction) when the session is dead, busy or doesn't " +
            "answer within ~60s. Set false to avoid sending the session a prompt."
        ),
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
        ...(opts.ensureLlmEndpointRunning
          ? { ensureLlmEndpointRunning: opts.ensureLlmEndpointRunning }
          : {}),
      }
      try {
        const result = await continueAgentSessionFresh(spawnDeps, desc, {
          ...(input.harness !== undefined ? { harness: input.harness } : {}),
          ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.access !== undefined ? { access: input.access } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.askSource !== undefined ? { askSource: input.askSource } : {}),
          sources: checkpointSources,
        })
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
                  handoff: result.descriptor.handoff,
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
        // Attribute the prompt to the calling session (same rule as
        // `agent_prompt`) so a session whose policy reserves compaction to
        // the operator (`compactRequiresOperator`) can tell this isn't one.
        const promptSource = callerScope?.ownerSessionId ?? callerSessionId
        await registry.sendPrompt(
          desc.id,
          "/compact",
          promptSource ? { source: `agent:${promptSource}` } : undefined,
        )
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
        content: [{ type: "text", text: JSON.stringify(result) }],
      }
    },
  )

  // ── terminal_sessions_list ──────────────────────────────────────
  // Migrated onto the AIP contract layer (session_list's pattern): the
  // pagination/compact/fields concerns + error normalization are the
  // catchErrors()/paginated() transformers' job; the handler keeps only
  // the filters (subtree scoping left hand-rolled, see session_list).
  const terminalSessionsListSchema = z.object({
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
  })
  registerPaginatedListTool<
    z.infer<typeof terminalSessionsListSchema>,
    Omit<SessionDescriptor, "ptyResumeEnv">
  >({
    id: "terminal_sessions_list",
    description:
      "List terminal/PTY sessions tracked by the daemon. Equivalent to `session_list({kind: 'terminal'})`. " +
      "Each entry includes `kind`, `pty`, `status`, age, etc. Use this when you only want " +
      "the terminal subset. COMPACT BY DEFAULT: each entry is session_list's slim " +
      "projection; pass `full: true` (or `compact: false`) for the complete, " +
      "unprojected per-session record. Without `limit`/`cursor` at most 50 rows " +
      "come back; when there are more the reply carries `total`, " +
      "`truncated: true` and a `nextCursor` — pass it as `cursor` (with a " +
      "`limit`) for the rest, or filter with `onlyAlive` / `status`.",
    schema: terminalSessionsListSchema,
    body: async input => {
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
      return rows.map(publicSessionDescriptor)
    },
    project: compactSessionItemWithProvenance,
    keyOf: s => s.id,
    itemKey: "sessions",
    // Dead terminals pile up: an unpaged call used to return every row
    // (65k+ chars, over the MCP output cap). Cap it and say so.
    defaultLimit: 50,
  })

  // ── command_list ────────────────────────────────────────────────
  // Migrated onto the AIP contract layer (session_list's pattern) — see
  // terminal_sessions_list above.
  const commandListSchema = z.object({
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
  })
  registerPaginatedListTool<
    z.infer<typeof commandListSchema>,
    Omit<SessionDescriptor, "ptyResumeEnv">
  >({
    id: "command_list",
    description:
      "List command sessions tracked by the daemon. Equivalent to `session_list({kind: 'command'})`. " +
      "Each entry includes `kind`, `status`, age, exit code, etc. Use this when you only want " +
      "the command subset. COMPACT BY DEFAULT: each entry is session_list's slim " +
      "projection (stdout/stderr and the rest of the bulky echo stay behind " +
      "`full: true`).",
    schema: commandListSchema,
    body: async input => {
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
      return rows.map(publicSessionDescriptor)
    },
    project: compactSessionItemWithProvenance,
    keyOf: s => s.id,
    itemKey: "sessions",
  })

  // ── mcp_discovered_list ─────────────────────────────────────────
  // Migrated onto the AIP contract layer (session_list's pattern). The
  // discovered entries are COMPACT by default — env/headers (potentially
  // secret-bearing) and spawn details stay behind `full: true`.
  const mcpDiscoveredListSchema = z.object({})
  registerPaginatedListTool<Record<string, never>, DiscoveredMcp>({
    id: "mcp_discovered_list",
    description:
      "Discover MCP servers already configured in the user's other agent " +
      "tooling (claude-code, cursor, goose). Returns the union with source " +
      "attribution so the operator can suggest 'I see you have a chrome-devtools " +
      "MCP set up in claude — want me to use it?' instead of asking the user " +
      "to re-configure. Read-only — does not modify any host's config. " +
      "COMPACT BY DEFAULT: each entry carries id/source/scope/name/type; " +
      "pass `full: true` for the complete entry (command/args/env/headers/url).",
    schema: mcpDiscoveredListSchema,
    body: async () => {
      const mcps = await discoverMcps()
      return mcps
    },
    project: compactDiscoveredMcp,
    keyOf: m => m.id,
    itemKey: "mcps",
  })

  // ── mcp_imported_list ───────────────────────────────────────────
  // Migrated onto the AIP contract layer (session_list's pattern). Each
  // entry is the compact id/alias/addedAt + snapshot-identity projection;
  // the full snapshot (command/args/env/headers) stays behind `full: true`.
  const mcpImportedListSchema = z.object({})
  registerPaginatedListTool<Record<string, never>, ImportedMcpEntry>({
    id: "mcp_imported_list",
    description:
      "Return the user's curated set of MCP servers — the ones they've " +
      "imported from claude / cursor / workspace configs into the daemon. " +
      "Use to know which MCPs the operator may freely call vs. ones still " +
      "showing up in `mcp_discovered_list` waiting on the user's blessing. " +
      "COMPACT BY DEFAULT: each entry carries id/alias/addedAt plus the " +
      "snapshot's source/name/type; pass `full: true` for the complete " +
      "entry including the full snapshot.",
    schema: mcpImportedListSchema,
    body: async () => {
      const config = await loadImportedMcps()
      return config.imports
    },
    project: compactImportedMcpEntry,
    keyOf: e => e.id,
    itemKey: "imports",
  })

  // ── capabilities_inventory ───────────────────────────────────────
  // Read-only, never throws — a failure in one source (MCP discovery, the
  // proxy registry, an adapter package that fails to import) becomes an
  // `error` string on that block alone; the rest of the inventory still
  // returns. See `capabilities-inventory.ts` for the shared builder (also
  // backs the `GET /capabilities/inventory` HTTP twin in http-server.ts).
  server.tool(
    "capabilities_inventory",
    "One read that answers: which MCP servers does the daemon know " +
      "(imported, discovered but not imported), are they up, what tools do " +
      "they have, which harnesses can reach them by default, who's using " +
      "them right now; and which skills are installed, for which harness. " +
      "Read-only and side-effect-free — never connects to an MCP just to " +
      "count its tools, never fetches a skill pack from the network. " +
      "Powers the `@agentproto/config` app's Capabilities section.",
    {},
    async () => {
      const inventory = await computeCapabilitiesInventory({
        registry,
        listAgentAdapters,
        mcpProxy,
      })
      return {
        content: [{ type: "text", text: JSON.stringify(inventory) }],
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
        const added = await addImportWithSecrets(
          cfg,
          {
            snapshot,
            ...(input.alias ? { alias: input.alias } : {}),
          },
          getMcpCredentialDeps()
        )
        await saveImportedMcps(added.config)
        const out =
          added.warnings.length > 0
            ? { ...added.entry, warnings: added.warnings }
            : added.entry
        return {
          content: [{ type: "text", text: JSON.stringify(out) }],
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
            { type: "text", text: JSON.stringify({ ok: true, id: input.id }) },
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
            { type: "text", text: JSON.stringify({ imports: aliases }) },
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
  // Migrated onto the AIP contract layer (session_list's pattern). The
  // bespoke `compact`/`schema` params are replaced by the transformer's
  // shared pagination params: rows are COMPACT (name + description) by
  // default, `full: true` returns the complete upstream descriptor
  // (including `inputSchema`), and `fields` allowlists per-item keys.
  const mcpImportedToolListSchema = z.object({
    alias: z
      .string()
      .min(1)
      .describe(
        "Alias from `mcp_imported_list` / `mcp_imported_status` " +
          "(typically the original MCP name, e.g. 'chrome-devtools')."
      ),
  })
  registerPaginatedListTool<z.infer<typeof mcpImportedToolListSchema>, ProxyToolDescriptor>({
    id: "mcp_imported_tool_list",
    description:
      "List the tools exposed by one imported MCP server. The proxy " +
      "lazily connects on first call — first-use latency includes the " +
      "transport handshake (stdio: ~1-2s for npx-spawned servers; " +
      "http/sse: <100ms). COMPACT BY DEFAULT: each entry carries name + " +
      "description; pass `full: true` for the upstream descriptor verbatim " +
      "including its `inputSchema` (JSON Schema), which you can use to " +
      "build a valid `arguments` object for the follow-up " +
      "`mcp_imported_call` invocation.",
    schema: mcpImportedToolListSchema,
    body: async input => {
      if (!mcpProxy) {
        throw new Error(
          "mcp_imported_tool_list is not enabled — see mcp_imported_status.",
        )
      }
      const out = await mcpProxy.listTools(input.alias)
      if (!out.ok) {
        throw new Error(
          `mcp_imported_tool_list "${input.alias}": ${out.error}`,
        )
      }
      return out.tools
    },
    project: compactProxyTool,
    keyOf: t => t.name,
    itemKey: "tools",
  })

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

  // ── bundle_list (PLAN D phase 1) ──────────────────────────────
  // A capability bundle carries no secrets (unlike an imported-MCP
  // snapshot's command/args/env/headers), so there is no compact/full
  // split here — `project` is the identity function and every field is
  // always returned. `dangling` is computed fresh against the live
  // imported-MCP set on every call, not persisted on the bundle itself.
  const bundleListSchema = z.object({})
  registerPaginatedListTool<Record<string, never>, Bundle & { dangling: string[] }>({
    id: "bundle_list",
    description:
      "List capability bundles — named sets of imported MCPs + skills (+ " +
      "optionally the daemon's own /mcp) attachable to ANY harness in one " +
      "`agent_start({bundles:[...]})` call. Imported MCPs reach the harness " +
      "as their own MCP server with native tool names (via the daemon's " +
      "/mcp/imported/<id> passthrough) — never the two-step " +
      "mcp_imported_tool_list/mcp_imported_call indirection. `dangling` " +
      "flags mcpImports ids whose underlying import was removed " +
      "(mcp_imported_remove) since the bundle was saved; a spawn naming " +
      "this bundle skips those entries with a warning.",
    schema: bundleListSchema,
    body: async () => {
      const [bundlesFile, importedConfig] = await Promise.all([loadBundles(), loadImportedMcps()])
      const importedIds = new Set(importedConfig.imports.map(e => e.id))
      return bundlesFile.bundles.map(b => ({ ...b, dangling: danglingImports(b, importedIds) }))
    },
    project: item => item,
    keyOf: b => b.id,
    itemKey: "bundles",
  })

  // ── bundle_create ──────────────────────────────────────────────
  server.tool(
    "bundle_create",
    "Create a capability bundle. Fails if `id` already exists (use " +
      "bundle_update) or if `mcpImports` names an id not in `mcp_imported_list`.",
    {
      id: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case (letters, digits, hyphens)")
        .describe("Stable machine-local id, e.g. 'research'."),
      label: z.string().min(1).describe("Human-readable name."),
      description: z.string().min(1).optional(),
      mcpImports: z
        .union([z.array(z.string().min(1)), z.literal("*")])
        .optional()
        .describe(
          "Imported-MCP ids from `mcp_imported_list`, or \"*\" for every import present at spawn time (opt-in; floods the tool palette). Default [].",
        ),
      includeDaemon: z
        .boolean()
        .optional()
        .describe("Also mount the daemon's own scoped /mcp for a spawn carrying this bundle."),
      skills: z
        .array(z.string().min(1))
        .optional()
        .describe("Skill ids unioned into a spawn's resolved skill list. Default []."),
    },
    async input => {
      try {
        const bundle = await createBundle({
          id: input.id,
          label: input.label,
          ...(input.description ? { description: input.description } : {}),
          mcpImports: input.mcpImports ?? [],
          ...(input.includeDaemon !== undefined ? { includeDaemon: input.includeDaemon } : {}),
          skills: input.skills ?? [],
        })
        return { content: [{ type: "text", text: JSON.stringify(bundle) }] }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `bundle_create failed: ${err instanceof BundleValidationError ? err.message : err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ── bundle_update ──────────────────────────────────────────────
  server.tool(
    "bundle_update",
    "Update an existing capability bundle. Fields present in the call " +
      "REPLACE the bundle's own (arrays are replaced wholesale, not merged " +
      "element-wise); omitted fields are left as-is. Fails if `id` doesn't " +
      "exist (use bundle_create) or if the merged `mcpImports` names an id " +
      "not in `mcp_imported_list`.",
    {
      id: z.string().min(1).describe("Existing bundle id."),
      label: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      mcpImports: z.union([z.array(z.string().min(1)), z.literal("*")]).optional(),
      includeDaemon: z.boolean().optional(),
      skills: z.array(z.string().min(1)).optional(),
    },
    async input => {
      try {
        const { id, ...patch } = input
        const bundle = await updateBundle(id, patch)
        return { content: [{ type: "text", text: JSON.stringify(bundle) }] }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `bundle_update failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ── bundle_delete ──────────────────────────────────────────────
  server.tool(
    "bundle_delete",
    "Delete a capability bundle. A future `agent_start.bundles` call naming " +
      "this id gets a spawn warning (skipped, not rejected) instead of an error.",
    { id: z.string().min(1) },
    async input => {
      const deleted = await deleteBundle(input.id)
      return { content: [{ type: "text", text: JSON.stringify({ deleted, id: input.id }) }] }
    },
  )

  // ── session_tree (WP5) ────────────────────────────────────────
  server.tool(
    "session_tree",
    "Return the orchestrator session hierarchy as a nested tree. Each root " +
      "is a session with no parent (or whose parent is outside the visible scope); " +
      "its `children` array holds direct sub-sessions, recursively. Each node " +
      "carries `id`, `label`, `status`, `depth`, `adapterSlug`, `parentSessionId`, " +
      "`continuedFrom` (set when the node was spawned by `session_continue_fresh` " +
      "— a checkpoint-handoff edge distinct from tree nesting: the node is the " +
      "SOURCE session's sibling, not its child; the full record's `handoff` " +
      "field names which harness the checkpoint moved from/to), and " +
      "`isOrchestrator` (true when the session itself spawned sub-agents). " +
      "Via a scoped orchestrator token only the caller's subtree is returned; " +
      "from the root `/mcp` endpoint the full daemon tree is visible. " +
      "NAVIGATION (additive): pass `nodeId` + `direction` together to fetch a " +
      "single slice of the tree instead of the whole dump. Shapes per direction: " +
      "`children` → `{ children: SessionTreeNode[] }` (direct children, one level); " +
      "`parent` → `{ parent: SessionTreeNode | null }` (null when the node is a root); " +
      "`siblings` → `{ siblings: SessionTreeNode[] }` (other nodes sharing the node's " +
      "parent, excluding the node itself); `ancestors` → " +
      "`{ ancestors: SessionTreeNode[] }` (chain starting at the node's immediate " +
      "parent and ending at its root, nearest-first); `descendants` → " +
      "`{ tree: SessionTreeNode[] }` (a single-element array holding the subtree " +
      "rooted at the node — same node shape as the full dump, no `byOrigin`). " +
      "`depth` (int ≥ 1) caps how many levels `children`/`ancestors`/`descendants` " +
      "walk, relative to the node; omit it for unlimited walk. `groupByOrigin` is " +
      "ignored in navigation mode. Both `nodeId` and `direction` are required " +
      "together — passing only one is a validation error.",
    {
      onlyAlive: z
        .boolean()
        .optional()
        .describe(
          "When true, only include sessions with status running/starting. " +
            "Pruned nodes also hide their subtree. Default false.",
        ),
      groupByOrigin: z
        .boolean()
        .optional()
        .describe(
          "Set false to suppress the companion `byOrigin` view and trim the " +
            "payload. Default true — `byOrigin` is emitted alongside `tree`. " +
            "Ignored in navigation mode (`nodeId` + `direction`).",
        ),
      nodeId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Scope navigation to the session with this id. Must be paired with " +
            "`direction`; the id must exist in the (scope-filtered) visible " +
            "session list.",
        ),
      direction: z
        .enum(["children", "parent", "siblings", "ancestors", "descendants"])
        .optional()
        .describe(
          "Which slice of `nodeId`'s relationships to return. Must be paired " +
            "with `nodeId`.",
        ),
      depth: z
        .number().int().min(1)
        .optional()
        .describe(
          "Level cap for `children`/`ancestors`/`descendants` navigation, " +
            "relative to the node (1 = the node's direct relations only). " +
            "Omit for unlimited walk. Ignored for `parent`/`siblings`.",
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
      // One index-backed ledger lookup (+ the in-process runner list) for
      // every visible node, never a per-node query — see resolveReviewBadges.
      const reviewBadgesById = reviewRunner
        ? await resolveReviewBadges(reviewRunner, rows.map(s => s.id))
        : undefined
      const badgesFor = reviewBadgesById ? (id: string) => reviewBadgesById.get(id) : undefined
      // ── Navigation mode (nodeId + direction) ──────────────────────
      // Additive slice of the tree: when both params arrive, walk the flat
      // (already scope/onlyAlive/archived-filtered) list instead of building
      // the whole dump. Exactly one of the two params is a validation error,
      // not a silent fallback to the full dump (PR #1194 bug class).
      if (input.nodeId !== undefined || input.direction !== undefined) {
        if (input.nodeId === undefined || input.direction === undefined) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error:
                    "session_tree: `nodeId` and `direction` must be passed " +
                    "together — got " +
                    (input.nodeId === undefined ? "only `direction`" : "only `nodeId`") +
                    ". Omit both for the full tree dump.",
                }),
              },
            ],
            isError: true,
          }
        }
        const nodeDesc = rows.find(s => s.id === input.nodeId)
        if (!nodeDesc) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error:
                    `session_tree: node "${input.nodeId}" not found in the ` +
                    "(scope-filtered) session list — it may be archived, dead " +
                    "under onlyAlive, or outside the caller's subtree.",
                }),
              },
            ],
            isError: true,
          }
        }
        // Same parent→children index buildSessionTree uses, so `isOrchestrator`
        // and depth ordering stay consistent with the full-dump view.
        const idSet = new Set(rows.map(s => s.id))
        const childrenOf = new Map<string, SessionDescriptor[]>()
        for (const s of rows) {
          if (s.parentSessionId && idSet.has(s.parentSessionId)) {
            const arr = childrenOf.get(s.parentSessionId)
            if (arr) arr.push(s)
            else childrenOf.set(s.parentSessionId, [s])
          }
        }
        const orchestratorIds = new Set(childrenOf.keys())
        const toNode = (s: SessionDescriptor): SessionTreeNode => ({
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
          ...(s.continuedFrom ? { continuedFrom: s.continuedFrom } : {}),
          isOrchestrator: orchestratorIds.has(s.id),
          children: [],
        })
        const sortSiblings = (list: SessionDescriptor[]) =>
          [...list].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))

        let body: Record<string, unknown>
        switch (input.direction) {
          case "children": {
            const kids =
              input.depth !== undefined && input.depth < 1
                ? []
                : sortSiblings(childrenOf.get(nodeDesc.id) ?? []).map(toNode)
            body = { children: kids }
            break
          }
          case "parent": {
            const parent =
              nodeDesc.parentSessionId && idSet.has(nodeDesc.parentSessionId)
                ? toNode(rows.find(s => s.id === nodeDesc.parentSessionId)!)
                : null
            body = { parent }
            break
          }
          case "siblings": {
            const sibs = nodeDesc.parentSessionId
              ? sortSiblings(childrenOf.get(nodeDesc.parentSessionId) ?? [])
                  .filter(s => s.id !== nodeDesc.id)
                  .map(toNode)
              : []
            body = { siblings: sibs }
            break
          }
          case "ancestors": {
            const chain: SessionDescriptor[] = []
            let cur = nodeDesc.parentSessionId
            while (cur && idSet.has(cur)) {
              const desc = rows.find(s => s.id === cur)
              if (!desc) break
              chain.push(desc)
              if (input.depth !== undefined && chain.length >= input.depth) break
              cur = desc.parentSessionId
            }
            body = { ancestors: chain.map(toNode) }
            break
          }
          case "descendants": {
            // BFS from the node, at most `depth` levels deep (undefined =
            // unlimited). Only nodes inside the included set are attached, so
            // the nesting stops exactly at the cap.
            const included = new Set<string>([nodeDesc.id])
            let frontier: SessionDescriptor[] = [nodeDesc]
            let level = 0
            while (frontier.length > 0 && (input.depth === undefined || level < input.depth)) {
              const next: SessionDescriptor[] = []
              for (const f of frontier) {
                for (const c of sortSiblings(childrenOf.get(f.id) ?? [])) {
                  if (!included.has(c.id)) {
                    included.add(c.id)
                    next.push(c)
                  }
                }
              }
              frontier = next
              level++
            }
            const subtreeRoot = toNode(nodeDesc)
            const attach = (n: SessionTreeNode): SessionTreeNode => ({
              ...n,
              children: sortSiblings(childrenOf.get(n.id) ?? [])
                .filter(c => included.has(c.id))
                .map(toNode)
                .map(attach),
            })
            body = { tree: [attach(subtreeRoot)] }
            break
          }
          default: {
            body = {}
            break
          }
        }
        if (badgesFor) {
          if ("children" in body) body = { children: attachReviewBadges(body.children as SessionTreeNode[], badgesFor) }
          else if ("parent" in body) {
            const parent = body.parent as SessionTreeNode | null
            body = { parent: parent ? attachReviewBadges([parent], badgesFor)[0]! : null }
          } else if ("siblings" in body) body = { siblings: attachReviewBadges(body.siblings as SessionTreeNode[], badgesFor) }
          else if ("ancestors" in body) body = { ancestors: attachReviewBadges(body.ancestors as SessionTreeNode[], badgesFor) }
          else if ("tree" in body) body = { tree: attachReviewBadges(body.tree as SessionTreeNode[], badgesFor) }
        }
        return {
          content: [{ type: "text", text: JSON.stringify(body) }],
        }
      }
      const tree = badgesFor ? attachReviewBadges(buildSessionTree(rows), badgesFor) : buildSessionTree(rows)
      // Additive companion view: the same roots bucketed by `origin` so a
      // client can show "claude-code desktop vs vscode extension vs cron"
      // groups — the human-launched roots have no agent parent to nest under,
      // so origin is their only cluster key. `tree` is unchanged.
      const byOrigin = groupRootsByOrigin(tree)
      const body =
        input.groupByOrigin === false
          ? { tree }
          : { tree, byOrigin }
      return {
        content: [
          { type: "text", text: JSON.stringify(body) },
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
  // MCP and REST surfaces can't drift. Migrated onto the AIP contract layer
  // (session_list's pattern): entries are COMPACT by default (id/origin/
  // preview/position; `queuedAt` stays behind `full: true`).
  const sessionQueueListSchema = z.object({
    sessionId: z
      .string()
      .min(1)
      .describe("Session id or name — from `session_list`, alive or historical."),
  })
  registerPaginatedListTool<z.infer<typeof sessionQueueListSchema>, QueuedPromptView>({
    id: "session_queue_list",
    description:
      "List the prompts currently queued on a live session (its prompt FIFO — " +
      "prompts that arrived mid-turn with queueing enabled and are waiting " +
      "to dispatch once the current turn ends). Each entry carries `position` " +
      "(0 = next to dispatch), `origin` (who queued it: \"user\", \"agent " +
      "<sessionId>\", \"child <sessionId>\"), and `preview` (short text of the " +
      "message); pass `full: true` to also get `queuedAt`. " +
      "Pair with `session_queue_promote` (jump an " +
      "item to the front without touching the in-flight turn), " +
      "`session_queue_deliver` (interrupt the current turn and dispatch this " +
      "item NOW), and `session_queue_drop` (remove without delivering).",
    schema: sessionQueueListSchema,
    body: async input => {
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        throw new Error(`no session "${input.sessionId}" found`)
      }
      // Subtree scoping (WP4/WP5): same gate as session_list/session_tree —
      // a scoped orchestrator only sees its own subtree's queues.
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(desc.id)) {
          throw new Error(
            `session "${input.sessionId}" is outside the caller's subtree`,
          )
        }
      }
      return registry.listQueuedPrompts(desc.id) ?? []
    },
    project: compactQueuedPromptView,
    keyOf: q => q.id,
    itemKey: "queue",
  })

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
            text: JSON.stringify({ ok: true, sessionId: desc.id, queueId: input.queueId, position: result.position }),
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
      "current turn finish. The delivered prompt opens with a one-line " +
      "`[agentproto]` notice telling the agent its turn was cut to deliver " +
      "it, not stopped; the rest of the queue drains FIFO once that turn " +
      "ends on its own. No-op (error) if the item is not in the queue. " +
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

  // ── session_bg_task_tail ─────────────────────────────────────────
  // A currently-running background task's info plus a tail of its output —
  // the MCP twin of `GET /sessions/:id/background-tasks/:taskId/tail`. See
  // `SessionsRegistry.readBackgroundTaskTail`'s doc for the taskId-only
  // (never a raw path) scoping that keeps this from becoming an arbitrary-
  // file-read tool. `taskId` comes from `SessionDescriptor.backgroundTasks`
  // (`session_list` / `session_get`'s `backgroundTasks` field).
  server.tool(
    "session_bg_task_tail",
    "Peek at a currently-RUNNING background task's output (a backgrounded " +
      "Bash command, a monitor, ...) — the last lines of its output file, " +
      "plus the task's own info (kind, description, status). Only works " +
      "while the task is still tracked as running on " +
      "`SessionDescriptor.backgroundTasks`; a settled task is dropped from " +
      "that list moments after it reports terminal status, so this errors " +
      "for one that already finished — use the `session:bg-task` event's " +
      "own `summary` for that instead. `taskId` comes from " +
      "`backgroundTasks` on `session_list` / `session_get`.",
    {
      sessionId: z
        .string()
        .min(1)
        .describe("Session id or name — from `session_list`."),
      taskId: z
        .string()
        .min(1)
        .describe("The running task's id, from `SessionDescriptor.backgroundTasks`."),
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
      const result = registry.readBackgroundTaskTail(desc.id, input.taskId)
      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `no running background task "${input.taskId}" on session "${desc.id}"`,
              }),
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, sessionId: desc.id, ...result }, null, 2) },
        ],
      }
    },
  )

  // ── worktree_status ─────────────────────────────────────────────
  // Read-only view of the repo's linked worktrees + their live PR
  // integration + the sessions that opened them. The heavy join is
  // delegated to an injected `listWorktreeStatuses` port so the runtime
  // stays free of `@agentproto/worktree`. Migrated onto the AIP contract
  // layer (session_list's pattern): entries are COMPACT by default (the
  // per-session roster stays behind `full: true`).

  const worktreeStatusSchema = z.object({
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
    sessionId: z
      .string()
      .optional()
      .describe(
        "Session id or name: return ONLY the worktree that session runs in " +
          "(its `worktreePath`), computed alone instead of scanning every " +
          "worktree of the repo. Wins over `repoRoot`/`workspaceSlug`. An " +
          "empty list means the session isn't in a linked worktree."
      ),
  })
  registerPaginatedListTool<z.infer<typeof worktreeStatusSchema>, WorktreeStatusView>({
    id: "worktree_status",
    description:
      "List the linked git worktrees for a repo and their live PR/session " +
      "linkage. Each entry includes path, branch, class, reclaimability, " +
      "dirty flag, ahead/behind vs the base branch, PR state/number/url, " +
      "the sessions whose cwd sits in the worktree, and liveness. Use this " +
      "to power a 'PRs in progress + linked sub-agents' panel. Pass " +
      "`openOnly: true` to surface only worktrees whose PR is still open, " +
      "or `sessionId` to read just the one worktree a session runs in. " +
      "COMPACT BY DEFAULT: each entry carries path/branch/class/reclaimable/" +
      "dirty/changes/base/pr/liveness; pass `full: true` to also get the " +
      "per-session roster (`sessions[]`).",
    schema: worktreeStatusSchema,
    body: async input => {
      if (!listWorktreeStatuses) {
        throw new Error(
          "worktree_status is not enabled — the daemon was started without " +
            "a worktree status lister. The host must wire `listWorktreeStatuses` " +
            "in createGateway.",
        )
      }

      if (input.sessionId !== undefined) {
        const desc = registry.findByIdOrName(input.sessionId)
        if (!desc) throw new Error(`worktree_status: no session "${input.sessionId}"`)
        const scope = sessionWorktreeScope(desc)
        if (!scope) return []
        return listWorktreeStatuses(scope.repoRoot, { paths: [scope.worktreePath] })
      }

      const resolved = await resolveWorktreeQueryRoot({
        repoRoot: input.repoRoot,
        workspaceSlug: input.workspaceSlug,
      })
      if (!resolved.ok) {
        throw new Error(resolved.error)
      }

      let worktrees = await listWorktreeStatuses(resolved.repoRoot)
      if (input.openOnly) {
        worktrees = worktrees.filter(w => w.pr?.state === "open")
      }
      return worktrees
    },
    project: compactWorktreeStatus,
    keyOf: w => w.path,
    itemKey: "worktrees",
  })

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
      "refused rather than acted on. A plan with forge lookups (or an apply " +
      "over many worktrees) can take minutes: this call waits up to 25 s " +
      "(`waitMs`), then returns `{ jobId, status: \"running\", followUp }` — " +
      "poll `worktree_gc_status` with that jobId. The run keeps going in the " +
      "background either way.",
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
      noisePaths: z
        .array(z.string())
        .optional()
        .describe(
          "Worktree-relative paths whose dirt is known noise (a worktree dirty " +
            "ONLY on these counts as clean). Default `.opencode/package-lock.json`; " +
            "pass [] to disable."
        ),
      wait: mcpBool
        .optional()
        .describe(
          "false ⇒ return a jobId immediately; poll `worktree_gc_status`. " +
            "true ⇒ block until the gc finishes (no background fallback). " +
            "Default: wait up to `waitMs`, then fall back to background."
        ),
      waitMs: mcpNumber
        .optional()
        .describe(
          "Block at most this many milliseconds, then fall back to background. " +
            "Default 25000."
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
              text: JSON.stringify({ error: resolved.error }),
            },
          ],
          isError: true,
        }
      }

      try {
        const { job, promise } = worktreeGcJobs.start(() =>
          runWorktreeGc({
            repoRoot: resolved.repoRoot,
            apply: input.apply === true,
            salvageDirty: input.salvageDirty === true,
            includeDetached: input.includeDetached === true,
            // The daemon's own live in-memory registry, not a disk re-read —
            // see `livingSessionCwds`'s doc.
            protectedPaths: livingSessionCwds(registry),
            ...(input.noisePaths ? { noisePaths: input.noisePaths } : {}),
          })
        )
        if (input.wait === false) {
          return { content: [{ type: "text", text: JSON.stringify(worktreeGcBackgroundView(job)) }] }
        }
        const waitMs = input.wait === true ? undefined : (input.waitMs ?? BACKGROUND_DEFAULT_WAIT_MS)
        if (waitMs !== undefined && (await timedOutWaiting(promise, waitMs))) {
          return { content: [{ type: "text", text: JSON.stringify(worktreeGcBackgroundView(job)) }] }
        }
        const result = await promise
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
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

  server.tool(
    "worktree_gc_status",
    "Poll a worktree_gc run that fell back to the background (`wait: false`, " +
      "or it outlasted `waitMs`). While running: status + elapsed time and " +
      "`followUp.pollAfterMs`. When done: the same result `worktree_gc` " +
      "returns inline (plan or outcomes), also saved at `resultPath`. When " +
      "failed: the error.",
    {
      jobId: z.string().describe("Job id returned by `worktree_gc` (`wgc_…`)."),
    },
    async input => backgroundStatusResult("worktree_gc", worktreeGcJobs, input.jobId),
  )

  const branchGcKind = z.enum(["local", "remote", "orphan"])
  server.tool(
    "branch_gc",
    "Garbage-collect a repo's branches. DEFAULTS TO A DRY RUN: returns a plan " +
      "classifying every local branch, base-remote branch and orphan tracking " +
      "ref (refs/remotes/<ns>/* of a removed remote) as `reclaim` (work " +
      "provably in base: the head commit of a merged PR, merged, " +
      "squash-merged, patch-merged or content-merged), `review` (unmerged, " +
      "old enough, not protected — " +
      "carries coverage + the files not provably in base for a reviewer), or " +
      "`hold` (base/protected, checked out in a worktree or its remote twin, " +
      "open PR head, PR check unavailable, or younger than `minAgeDays`). " +
      "`apply: true` (requires explicit `scopes`) deletes only `reclaim` " +
      "entries, re-classifying each right before deleting it, and returns " +
      "the path of a restore log (sha + re-create command per deleted ref) " +
      "plus a top-level `status` and an `applySummary` (deleted / skipped / " +
      "failed counts per scope, and the restore log path). " +
      "A plan can take minutes on a big repo: as an MCP caller, pass " +
      "`wait: false` (or `waitMs: 40000`) and poll `branch_gc_status` with " +
      "the returned jobId instead of blocking. A `wait: false` (or `waitMs` " +
      "timed-out) response returns a jobId plus a `followUp` block naming the " +
      "poll tool and cadence — poll `branch_gc_status` with that jobId.",
    {
      repoRoot: z.string().optional().describe("Absolute path to the git repo. Wins over `workspaceSlug`."),
      workspaceSlug: z
        .string()
        .optional()
        .describe("Workspace slug from `agentproto workspace list`. The active workspace when omitted."),
      base: z.string().optional().describe("Base ref the work must be in. Default `origin/main`."),
      scopes: z
        .array(branchGcKind)
        .optional()
        .describe("Ref kinds to consider: local, remote, orphan. Default all three for a plan; REQUIRED for apply."),
      minAgeDays: mcpNumber
        .optional()
        .describe("Unmerged refs younger than this many days are held. Default 3."),
      includeReviewed: mcpBool
        .optional()
        .describe(
          "When true, a `review` ref whose stored verdict (branch_gc_verdict) has gate.agree=true for the SAME tip sha becomes `reclaim` (`reviewed`). Default false.",
        ),
      anchor: z.string().optional().describe("Explicit anchor commit for a re-rooted base. Auto-detected when omitted."),
      apply: mcpBool.optional().describe("When true, EXECUTE the plan for `scopes`. Default false — a dry run."),
      wait: mcpBool
        .optional()
        .describe("Block until the gc finishes (default true — today's behaviour). false ⇒ return a jobId immediately; poll `branch_gc_status`."),
      waitMs: mcpNumber
        .optional()
        .describe("Block at most this many milliseconds, then fall back to background: returns `{ jobId, status: \"running\" }` to poll with `branch_gc_status`. Only meaningful with the default `wait: true`."),
    },
    async input => {
      if (!runBranchGc) {
        return {
          content: [
            {
              type: "text",
              text:
                "branch_gc is not enabled — the daemon was started without a " +
                "branch gc runner. The host must wire `runBranchGc` in createGateway.",
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
        return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }], isError: true }
      }
      if (input.apply === true && !input.scopes?.length) {
        return {
          content: [{ type: "text", text: "branch_gc: `apply: true` requires explicit `scopes` (any of local, remote, orphan)." }],
          isError: true,
        }
      }
      try {
        const runInput: BranchGcRunInput = {
          repoRoot: resolved.repoRoot,
          apply: input.apply === true,
          includeReviewed: input.includeReviewed === true,
          ...(input.base ? { base: input.base } : {}),
          ...(input.scopes?.length ? { scopes: input.scopes } : {}),
          ...(input.minAgeDays !== undefined ? { minAgeDays: input.minAgeDays } : {}),
          ...(input.anchor ? { anchor: input.anchor } : {}),
        }
        const { job, promise } = branchGcJobs.start(async () => withBranchGcApplySummary(await runBranchGc(runInput)))
        if (input.wait === false) {
          return { content: [{ type: "text", text: JSON.stringify(branchGcBackgroundView(job)) }] }
        }
        if (input.waitMs !== undefined && (await timedOutWaiting(promise, input.waitMs))) {
          return { content: [{ type: "text", text: JSON.stringify(branchGcBackgroundView(job)) }] }
        }
        const result = await promise
        return { content: [{ type: "text", text: JSON.stringify(result) }] }
      } catch (err) {
        return {
          content: [{ type: "text", text: `branch_gc failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    "branch_gc_status",
    "Poll a branch_gc run started with `wait: false` (or one that fell back to " +
      "the background via `waitMs`). While running: status + elapsed time. When " +
      "done: the plan's own summary (plus, for an apply, `applySummary` — " +
      "deleted/skipped/failed per scope and the restore log path) and the path " +
      "of the full result saved on disk (`resultPath`). The full result is " +
      "too big to return whole, so `full: true` (or any of `section`, " +
      "`classes`, `scopes`, `results`, `limit`, `cursor`) returns ONE filtered " +
      "page of it: `result` (summary + plan metadata + the selected list) and " +
      "`page { section, total, returned, nextCursor }` — default 100 rows, " +
      "pass `nextCursor` back as `cursor` for the next page. Use " +
      "`classes: [\"reclaim\"]` to see only what an apply would delete. " +
      "While running the view carries `followUp.pollAfterMs` (poll every " +
      "30 s). When failed: the error.",
    {
      jobId: z.string().describe("Job id returned by `branch_gc` (`bgc_…`)."),
      full: mcpBool.optional().describe("Include a filtered/paged slice of the full result (see description). Implied by any other slice param. Default false."),
      section: z
        .enum(["entries", "outcomes"])
        .optional()
        .describe("Which list to return: plan `entries` or apply `outcomes`. Default `entries` for a plan, `outcomes` for an apply."),
      classes: z
        .array(z.enum(["reclaim", "review", "hold"]))
        .optional()
        .describe("Entries only: keep these classes (e.g. [\"reclaim\"])."),
      scopes: z.array(branchGcKind).optional().describe("Keep these ref kinds (local, remote, orphan)."),
      results: z
        .array(
          z.enum(["deleted", "held", "skipped-review", "aborted-moved", "aborted-vanished", "aborted-reclassified", "failed"]),
        )
        .optional()
        .describe("Outcomes only: keep these outcome results."),
      limit: mcpNumber.optional().describe(`Rows per page. Default 100, max ${BRANCH_GC_PAGE_MAX}.`),
      cursor: z.string().optional().describe("`page.nextCursor` from the previous page."),
    },
    async input => {
      const wantsSlice =
        input.full === true ||
        input.section !== undefined ||
        input.classes !== undefined ||
        input.scopes !== undefined ||
        input.results !== undefined ||
        input.limit !== undefined ||
        input.cursor !== undefined
      const slice: BranchGcResultSliceInput | undefined = wantsSlice
        ? {
            ...(input.section ? { section: input.section } : {}),
            ...(input.classes ? { classes: input.classes } : {}),
            ...(input.scopes ? { scopes: input.scopes } : {}),
            ...(input.results ? { results: input.results } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          }
        : undefined
      const doneView = (...args: Parameters<typeof branchGcDoneView>): { content: Array<{ type: "text"; text: string }>; isError?: boolean } => {
        try {
          return { content: [{ type: "text", text: JSON.stringify(branchGcDoneView(...args)) }] }
        } catch (err) {
          return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true }
        }
      }
      const job = branchGcJobs.get(input.jobId)
      if (!job) {
        // The map is per-process: an id from a prior daemon lifetime (or one
        // whose map entry was already evicted) is not in it — but the job's
        // full result is still on disk. Fall back to the result file before
        // declaring the job lost.
        const parsed = await branchGcJobs.readResultFile(input.jobId)
        if (!parsed) {
          return {
            content: [
              {
                type: "text",
                text: `branch_gc job '${input.jobId}' not found (no running job and no result file at ${branchGcJobs.resultPathFor(input.jobId)})`,
              },
            ],
            isError: true,
          }
        }
        return doneView(input.jobId, branchGcJobs.resultPathFor(input.jobId), parsed, slice)
      }
      if (job.status !== "done") {
        return { content: [{ type: "text", text: JSON.stringify(branchGcJobs.progressView(job)) }] }
      }
      return doneView(job.id, job.resultPath, job.result!, slice, job.endedAt)
    },
  )

  const branchVerdictEnum = z.enum(["obsolete", "superseded", "salvage", "in-progress", "unclear"])
  server.tool(
    "branch_gc_verdict",
    "Record one reviewer verdict for a branch tip, keyed by repo + tip sha " +
      "(a verdict for a tip that later moves is ignored). `gate.agree: true` " +
      "is what lets `branch_gc` with `includeReviewed` reclaim an unmerged " +
      "ref, and it must cite evidence. This tool only stores verdicts; it " +
      "never deletes anything.",
    {
      repoRoot: z.string().optional().describe("Absolute path to the git repo. Wins over `workspaceSlug`."),
      workspaceSlug: z.string().optional().describe("Workspace slug. The active workspace when omitted."),
      name: z.string().describe("Branch name the verdict is about (informational; the key is the sha)."),
      sha: z.string().describe("Full tip sha that was reviewed."),
      triage: z.object({
        verdict: branchVerdictEnum,
        confidence: mcpNumber.describe("0..1"),
        reason: z.string(),
        salvage: z.string().optional().describe("What is worth keeping, if anything."),
      }),
      gate: z
        .object({
          agree: mcpBool.describe("true only if deleting the branch loses nothing of value"),
          verdict: branchVerdictEnum,
          reason: z.string(),
          evidence: z.array(z.string()).describe("Concrete shas/paths. Required non-empty when agree is true."),
        })
        .optional(),
      reviewer: z.string().describe("Who reviewed, e.g. `claude-sonnet reviewer`."),
    },
    async input => {
      if (!recordBranchGcVerdict) {
        return {
          content: [
            {
              type: "text",
              text:
                "branch_gc_verdict is not enabled — the host must wire `recordBranchGcVerdict` in createGateway.",
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
        return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }], isError: true }
      }
      try {
        const { repoRoot: _r, workspaceSlug: _w, ...verdict } = input
        // A reviewer names its review worktree; the verdict keys on the repo.
        const repoRoot = await ownerRepoOfReviewWorktree(resolved.repoRoot)
        const record = await recordBranchGcVerdict({ repoRoot, verdict })
        return { content: [{ type: "text", text: JSON.stringify({ recorded: true, record }) }] }
      } catch (err) {
        return {
          content: [{ type: "text", text: `branch_gc_verdict failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    "branch_gc_verdict_get",
    "Read the stored reviewer verdict (branch_gc_verdict) for one branch tip, " +
      "keyed by repo + tip sha. Returns `{ sha, found, missing, record }` — " +
      "`record` is null when no verdict exists for that exact sha. Read-only.",
    {
      repoRoot: z.string().optional().describe("Absolute path to the git repo. Wins over `workspaceSlug`."),
      workspaceSlug: z.string().optional().describe("Workspace slug. The active workspace when omitted."),
      sha: z.string().describe("Full tip sha to look up."),
    },
    async input => {
      if (!readBranchGcVerdict) {
        return {
          content: [
            {
              type: "text",
              text: "branch_gc_verdict_get is not enabled — the host must wire `readBranchGcVerdict` in createGateway.",
            },
          ],
          isError: true,
        }
      }
      const resolved = await resolveWorktreeQueryRoot({ repoRoot: input.repoRoot, workspaceSlug: input.workspaceSlug })
      if (!resolved.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }], isError: true }
      }
      try {
        const repoRoot = await ownerRepoOfReviewWorktree(resolved.repoRoot)
        const record = await readBranchGcVerdict({ repoRoot, sha: input.sha })
        // `missing` is the plain-truthy mirror of `!found`, so a workflow
        // `branch` step's bare-ref `when` can test it directly.
        return {
          content: [
            { type: "text", text: JSON.stringify({ sha: input.sha, found: record !== null, missing: record === null, record }) },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `branch_gc_verdict_get failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    "branch_gc_review_worktree",
    "Create or remove disposable DETACHED review worktrees for branch review " +
      "(the maintain workflow gives every reviewer its own, so nothing a " +
      "reviewer does can touch the live checkout). `add` checks out `sha` at " +
      "`path`; `remove` force-removes every path in `paths` (missing ones are " +
      "fine) and prunes. Every path must be a direct child of the review root " +
      "under the OS tmp dir — this tool can never remove the repo itself or a " +
      "human's worktree.",
    {
      repoRoot: z.string().optional().describe("Absolute path to the git repo. Wins over `workspaceSlug`."),
      workspaceSlug: z.string().optional().describe("Workspace slug. The active workspace when omitted."),
      action: z.enum(["add", "remove"]),
      path: z.string().optional().describe("`add`: where to create the worktree."),
      sha: z.string().optional().describe("`add`: the commit to check out (detached)."),
      paths: z.array(z.string()).optional().describe("`remove`: worktrees to remove."),
    },
    async input => {
      const resolved = await resolveWorktreeQueryRoot({ repoRoot: input.repoRoot, workspaceSlug: input.workspaceSlug })
      if (!resolved.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: resolved.error }) }], isError: true }
      }
      try {
        if (input.action === "add") {
          if (!input.path || !input.sha) throw new Error("`add` needs `path` and `sha`")
          const out = await addReviewWorktree({ repoRoot: resolved.repoRoot, path: input.path, sha: input.sha })
          return { content: [{ type: "text", text: JSON.stringify(out) }] }
        }
        const out = await removeReviewWorktrees({ repoRoot: resolved.repoRoot, paths: input.paths ?? [] })
        return { content: [{ type: "text", text: JSON.stringify(out) }] }
      } catch (err) {
        return {
          content: [{ type: "text", text: `branch_gc_review_worktree failed: ${err instanceof Error ? err.message : String(err)}` }],
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
            ...(opts.resolveSandboxProvider ? { resolveSandboxProvider: opts.resolveSandboxProvider } : {}),
            ...(opts.daemonMcpUrl ? { daemonMcpUrl: opts.daemonMcpUrl } : {}),
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

      // ── In-place restart (same-id revival) ────────────────────────
      // An ended-but-resumable agent-cli row first tries the registry's own
      // in-place resume (`triggerResume` — the primitive lazy resume-on-
      // prompt uses): the conversation comes back on the SAME id, no new
      // row, no continuedFrom/continuedTo chain. Only when that is
      //  ineligible (alive / PTY / command / archived / overrides / a
      // resume-capped row) or the resume doesn't take do we fall through
      // to today's strategy decision below, unchanged. `allowDeliberateEnd`
      // is true here: session_restart is an EXPLICIT operator action, so a
      // deliberate end (operator-completed / steward-*) may still be
      // revived in place — the never-revive guard protects the AUTOMATIC
      // path (the sentinel), not a human asking for this session back.
      const inPlace = await tryRestartInPlace(registry, prev, {
        allowDeliberateEnd: true,
      })
      if (inPlace) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...publicSessionDescriptor(inPlace),
                  resumedFrom: prev.id,
                  resumeVia: "in-place",
                  sameId: true,
                },
                null,
                2,
              ),
            },
          ],
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
          let argv =
            strategy.kind === "pty-native"
              ? strategy.argv
              : Array.isArray(prev.argv) && prev.argv.length > 0
                ? [...prev.argv]
                : tokenizeCommand(prev.command)
          // Prefer resuming by ABSOLUTE transcript path over a bare
          // conversation id when the provider accepts one
          // (`claude --resume /abs/….jsonl`): the path form works from any
          // directory and doesn't depend on the provider re-deriving the
          // project-slug folder from the spawn cwd. Only when the isolated
          // file verifiably exists — otherwise keep the bare id, which may
          // still resolve via the threaded config-dir env below.
          if (strategy.kind === "pty-native" && prev.adapterSlug) {
            const probe = await probeNativeTranscript(augmented)
            if (probe?.exists) {
              const upgraded = RESUME_STRATEGIES[prev.adapterSlug]?.spawnArgs?.(probe.path)
              if (upgraded) {
                argv = upgraded
                console.log(
                  `[session_restart] ${prev.id} pty-native resume upgraded to absolute transcript path ${probe.path}`
                )
              }
            }
          }
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
                : // A pty-native restart of a row that is ITSELF a restarted
                  // PTY (conversation terminal): no adapterConfigDir, but the
                  // env the earlier hop recorded still names the isolated
                  // store — replay it rather than dropping to the global one.
                  prev.ptyResumeEnv
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
                text: JSON.stringify(publicSessionDescriptor(desc)),
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
        // Honest decline diagnostics: the caller explicitly asked for a
        // native terminal but the decision still landed on ACP resume.
        // Name the ACTUAL blocker instead of letting the client blame "the
        // transcript could not be recovered" for every fallback — response-
        // only, never persisted. Absent entirely when the caller never
        // opted in (a plain restart's output shape is unchanged).
        let nativeResumeDecline:
          | {
              reason: "capability-missing" | "no-resume-id" | "transcript-not-found"
              probedDir?: string
            }
          | undefined
        if (
          input.preferNativeTerminal === true &&
          prev.adapterSlug &&
          RESUME_STRATEGIES[prev.adapterSlug]?.spawnArgs
        ) {
          if (prev.nativeTerminalResume !== true) {
            // Legacy/pre-capability row: the adapter never stamped
            // `nativeTerminalResume` on this descriptor, so the origin gate
            // was passed but the capability check wasn't.
            nativeResumeDecline = { reason: "capability-missing" }
          } else {
            // A probe result here means an id existed but its exact file
            // didn't (exact-bind never falls through to a sibling); no
            // probe at all means there was never an id to look up.
            const probe = await probeNativeTranscript(augmented)
            nativeResumeDecline = probe
              ? { reason: "transcript-not-found", probedDir: probe.dir }
              : { reason: "no-resume-id" }
          }
        }
        // Shared with the cron scheduler's `prompt-session` action —
        // see session-restart-core.ts. Overrides take the forced-agent path
        // handled earlier, so a restart reaching HERE never carries any.
        const restarted = await restartAgentSession(registry, resolveAgentAdapter, prev, {
          ...(opts.resolveSandboxProvider ? { resolveSandboxProvider: opts.resolveSandboxProvider } : {}),
          ...(opts.daemonMcpUrl ? { daemonMcpUrl: opts.daemonMcpUrl } : {}),
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...publicSessionDescriptor(restarted.desc),
                  resumedFrom: restarted.resumedFrom,
                  resumeVia: restarted.resumeVia,
                  ...(restarted.resumeFallback ? { resumeFallback: true } : {}),
                  ...(nativeResumeDecline ? { nativeResumeDecline } : {}),
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
          content: [{ type: "text", text: JSON.stringify(publicSessionDescriptor(desc)) }],
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
      return { content: [{ type: "text", text: JSON.stringify(res) }] }
    }
  )

  // ── session_wrapup_plan / session_wrapup_apply — session steward ─────
  // (FIX-9A part 4). All classification logic lives in `planSessionWrapup`
  // (session-wrapup.ts, pure, zero LLM calls) — this is just the transport
  // + the live-signal gathering the pure planner can't do itself (worktree
  // merge status, a transcript tail read, RSS). FIX-9B adds a judge agent
  // for the ambiguous `judge` class; nothing here ever calls one.

  const WRAPUP_STUCK_STARTING_MS = 10 * 60_000
  const wrapupCallerSessionId = callerSessionId ?? callerScope?.ownerSessionId

  const isWrapupCandidate = (d: SessionDescriptor): boolean =>
    d.kind === "agent-cli" && (d.status === "running" || d.status === "starting")

  const isStuckStarting = (d: SessionDescriptor, nowMs: number): boolean => {
    if (d.status !== "starting" || d.pid !== null) return false
    const tsStr = d.lastActivityAt ?? d.startedAt
    const ts = tsStr ? Date.parse(tsStr) : Number.NaN
    return Number.isFinite(ts) && nowMs - ts >= WRAPUP_STUCK_STARTING_MS
  }

  /** Gather everything `planSessionWrapup` needs but can't compute itself:
   *  worktree merge status (one `listWorktreeStatuses` call per distinct
   *  repo root, batched across every candidate in that repo), parent-ended,
   *  a pending tool call, the stuck-starting check, a transcript tail, and
   *  RSS (one `ps` call for every candidate with a pid, via `processTreeRss`
   *  — Part 1). Returns the full session universe (needed for parent-alive
   *  lookups) with `rssBytes` merged onto the candidates that have it. */
  const gatherWrapupInputs = async (
    nowMs: number,
    gatherScope: { onlyIds?: ReadonlySet<string> } = {},
  ): Promise<{ all: SessionDescriptor[]; sessionsForPlan: SessionDescriptor[]; signals: Map<string, SessionWrapupSignals> }> => {
    const all = registry.list({ includeArchived: true })
    const byId = new Map(all.map(d => [d.id, d]))
    // `onlyIds` (the apply path): gather live signals for just those
    // sessions — no `ps`, no transcript tails, no worktree lookups for
    // anyone else. `all` still carries the full universe, since the pure
    // planner needs it for parent lookups.
    const candidates = all.filter(d => isWrapupCandidate(d) && (!gatherScope.onlyIds || gatherScope.onlyIds.has(d.id)))

    const withPid = gatherScope.onlyIds ? [] : candidates.filter((d): d is SessionDescriptor & { pid: number } => typeof d.pid === "number")
    const rssByPid = withPid.length > 0 ? await processTreeRss(withPid.map(d => d.pid)) : new Map<number, number>()

    const prStateByWorktreePath = new Map<string, string | undefined>()
    if (listWorktreeStatuses) {
      const pathsByRepo = new Map<string, Set<string>>()
      for (const d of candidates) {
        const scope = sessionWorktreeScope(d)
        if (!scope) continue
        const set = pathsByRepo.get(scope.repoRoot) ?? new Set<string>()
        set.add(scope.worktreePath)
        pathsByRepo.set(scope.repoRoot, set)
      }
      // Repos are independent — look them up concurrently (each is a forge
      // round-trip), one call per repo however many sessions live in it.
      await Promise.all(
        [...pathsByRepo].map(async ([repoRoot, paths]) => {
          try {
            const views = await listWorktreeStatuses(repoRoot, { paths: [...paths] })
            for (const v of views) prStateByWorktreePath.set(v.path, v.pr?.state)
          } catch {
            // Best-effort signal only — a lister failure never blocks the plan.
          }
        }),
      )
    }

    const signals = new Map<string, SessionWrapupSignals>()
    const rssById = new Map<string, number>()
    for (const d of candidates) {
      const scope = sessionWorktreeScope(d)
      const worktreePrState = scope ? prStateByWorktreePath.get(scope.worktreePath) : undefined
      const worktreeMerged = worktreePrState === "merged"
      const worktreePrOpen = worktreePrState === "open"
      const parent = d.parentSessionId ? byId.get(d.parentSessionId) : undefined
      const parentEnded =
        d.parentSessionId !== undefined &&
        (parent === undefined || (parent.status !== "running" && parent.status !== "starting"))
      const pendingToolCall = (d.pendingBgTasks ?? 0) > 0 || (d.backgroundTasks?.length ?? 0) > 0
      const lastAssistantTail = d.eventsPath && !gatherScope.onlyIds
        ? trimOutcomeText(readLastAssistantTextSync(d.eventsPath), OUTCOME_SUMMARY_MAX, "tail")
        : undefined
      signals.set(d.id, {
        ...(worktreeMerged ? { worktreeMerged: true } : {}),
        ...(worktreePrOpen ? { worktreePrOpen: true } : {}),
        ...(parentEnded ? { parentEnded: true } : {}),
        ...(lastAssistantTail !== undefined ? { lastAssistantTail } : {}),
        ...(pendingToolCall ? { pendingToolCall: true } : {}),
        ...(isStuckStarting(d, nowMs) ? { stuckStarting: true } : {}),
      })
      if (typeof d.pid === "number") {
        const rss = rssByPid.get(d.pid)
        if (rss !== undefined) rssById.set(d.id, rss)
      }
    }

    const sessionsForPlan = all.map(d => (rssById.has(d.id) ? { ...d, rssBytes: rssById.get(d.id) } : d))
    return { all, sessionsForPlan, signals }
  }

  server.tool(
    "session_wrapup_plan",
    "DRY RUN, mutates nothing — classify every idle agent-cli session for " +
      "the session steward: `close` (safe to auto-close: idle past " +
      "`idleMinutes` AND the session's worktree merged or its parent already " +
      "ended, with no tool call pending, and not `keepAlive`), `stuck` " +
      "(stuck in `status:'starting'` with no pid for 10+ minutes — closing it " +
      "is free, it never ran), `judge` (idle-enough but ambiguous — no merge/" +
      "parent-ended signal, a pending tool call, or a `keepAlive` session " +
      "that would otherwise close, since `keepAlive` can only ever reach " +
      "`judge`, never `close`), or `keep` (not idle long enough yet, still " +
      "`status:'starting'` and not yet stuck, or busy/awaitingInput/awaitingPermission/archived/pinned/has busy " +
      "children/has a live parent/is the caller's own session — NEVER " +
      "eligible for `session_wrapup_apply`; omitted here unless " +
      "`includeKeep` is set). Also reports `rssBytes` (process-tree RSS) per " +
      "entry and summed per class in `totals`. Feed `close`/`stuck` ids " +
      "straight to `session_wrapup_apply`; `judge` ids need a judge's " +
      "verdict first (FIX-9B). Computing worktree merge status can take " +
      "minutes: this call waits up to 25 s (`waitMs`), then returns " +
      "`{ jobId, status: \"running\", followUp }` — poll " +
      "`session_wrapup_status` with that jobId.",
    {
      idleMinutes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Idle threshold in minutes a `close` candidate must clear. Default 20."),
      includeKeep: mcpBool
        .optional()
        .describe(
          "Include `keep`-class entries too. Default false — `keep` rows are " +
            "never acted on, so they're omitted to keep the plan focused on " +
            "what the steward might actually do.",
        ),
      wait: mcpBool
        .optional()
        .describe(
          "false ⇒ return a jobId immediately; poll `session_wrapup_status`. " +
            "true ⇒ block until the plan is computed. Default: wait up to " +
            "`waitMs`, then fall back to background.",
        ),
      waitMs: mcpNumber
        .optional()
        .describe("Block at most this many milliseconds, then fall back to background. Default 25000."),
    },
    async input => {
      const computePlan = async (): Promise<SessionWrapupPlanResult> => {
        const nowMs = Date.now()
        const { all, sessionsForPlan, signals } = await gatherWrapupInputs(nowMs)
        const subtree = callerScope ? collectSubtree(callerScope.ownerSessionId, all) : undefined

        let entries = planSessionWrapup({
          sessions: sessionsForPlan,
          nowMs,
          ...(input.idleMinutes !== undefined ? { idleMinutes: input.idleMinutes } : {}),
          signals,
          ...(wrapupCallerSessionId ? { callerSessionId: wrapupCallerSessionId } : {}),
        })

        if (subtree) entries = entries.filter(e => subtree.has(e.sessionId))
        if (!input.includeKeep) entries = entries.filter(e => e.class !== "keep")

        const totals: Partial<Record<SessionWrapupClass, number>> = {}
        for (const e of entries) {
          if (e.rssBytes === undefined) continue
          totals[e.class] = (totals[e.class] ?? 0) + e.rssBytes
        }
        return { entries, totals }
      }

      const { job, promise } = sessionWrapupJobs.start(computePlan)
      if (input.wait === false) {
        return { content: [{ type: "text", text: JSON.stringify(sessionWrapupBackgroundView(job)) }] }
      }
      const waitMs = input.wait === true ? undefined : (input.waitMs ?? BACKGROUND_DEFAULT_WAIT_MS)
      if (waitMs !== undefined && (await timedOutWaiting(promise, waitMs))) {
        return { content: [{ type: "text", text: JSON.stringify(sessionWrapupBackgroundView(job)) }] }
      }
      try {
        return { content: [{ type: "text", text: JSON.stringify(await promise) }] }
      } catch (err) {
        return {
          content: [
            { type: "text", text: `session_wrapup_plan failed: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    "session_wrapup_status",
    "Poll a session_wrapup_plan or session_wrapup_apply run that fell back to " +
      "the background (`wait: false`, or it outlasted `waitMs`). While running: status + " +
      "elapsed time and `followUp.pollAfterMs`. When done: `result` is the " +
      "same `{ entries, totals }` (plan) or `{ results }` (apply) the tool " +
      "returns inline. When failed: the error.",
    {
      jobId: z.string().describe("Job id returned by `session_wrapup_plan` (`swp_…`) or `session_wrapup_apply` (`swa_…`)."),
    },
    async input =>
      input.jobId.startsWith("swa_")
        ? backgroundStatusResult("session_wrapup_apply", sessionWrapupApplyJobs, input.jobId)
        : backgroundStatusResult("session_wrapup_plan", sessionWrapupJobs, input.jobId),
  )

  server.tool(
    "session_wrapup_apply",
    "Record a verdict on specific sessions — the mutating half of " +
      "`session_wrapup_plan`. Each id is RE-CLASSIFIED from scratch " +
      "immediately before acting (a plan computed moments earlier can be " +
      "stale) and is only acted on if it is STILL `close` or `stuck`. Pass " +
      "`judgedBy` (a judge session id) to also accept a `judge`-class id — " +
      "the judge's verdict is what makes it safe to act on. `keep`-class ids " +
      "are ALWAYS refused, no exception. `verdict: \"done\"` or " +
      "`\"abandoned\"` actually CLOSES the session (tagged " +
      "`endedReason:'steward-completed'`/`'steward-abandoned'`) and leaves it " +
      "resumable (same as the idle reaper) — this never deletes anything. " +
      "`verdict: \"blocked\"` or `\"needs-input\"` is NOT a completion: the " +
      "session is left running untouched and the verdict is recorded as a " +
      "flag (`SessionDescriptor.wrapupFlag`) instead — the per-id result's " +
      "`action` says `closed` vs `flagged`. Also refused (result `ok:false`, " +
      "`error:'refused_stale_or_busy'`) if the session is busy/awaitingInput/" +
      "awaitingPermission or has a background task outstanding at the moment " +
      "of the call, for either kind of action. A scoped orchestrator may only " +
      "act on its own subtree. Returns a per-id result. Only the requested " +
      "sessions are re-checked (never a full plan). If it outlasts 25 s " +
      "(`waitMs`) it returns `{ jobId, status: \"running\", followUp }` — " +
      "poll `session_wrapup_status`; the apply keeps running regardless.",
    {
      sessionIds: z
        .array(z.string().min(1))
        .min(1)
        .describe("Session ids or names, from `session_wrapup_plan`."),
      verdict: z
        .enum(["done", "abandoned", "partial", "failed", "blocked", "needs-input"])
        .describe(
          "What the session's work amounted to. \"done\"/\"abandoned\"/" +
            "\"partial\"/\"failed\" CLOSE the session (`endedReason:" +
            "'steward-completed'`/`'steward-abandoned'` — done only), the " +
            "verdict nuance kept on the outcome; \"blocked\"/\"needs-input\" " +
            "only FLAG it (`SessionDescriptor.wrapupFlag`) — the session " +
            "keeps running.",
        ),
      note: z.string().optional().describe("Free-text note recorded on the outcome or the flag."),
      judgedBy: z
        .string()
        .optional()
        .describe(
          "A judge session id. When set, the outcome's `source` is " +
            "`'judged'` and a `judge`-class session also becomes eligible " +
            "(not just `close`/`stuck`). Omitted ⇒ `source:'declared'`, " +
            "`judgedBy:'steward-rules'`, and only `close`/`stuck` are eligible.",
        ),      wait: mcpBool
        .optional()
        .describe(
          "false ⇒ return a jobId immediately; poll `session_wrapup_status`. " +
            "true ⇒ block until done. Default: wait up to `waitMs`, then " +
            "fall back to background (the apply keeps running).",
        ),
      waitMs: mcpNumber
        .optional()
        .describe("Block at most this many milliseconds, then fall back to background. Default 25000."),
    },
    async input => {
      const computeApply = async (): Promise<SessionWrapupApplyResult> => {
        const nowMs = Date.now()
        // Resolve the requested refs first (in-memory) so signal gathering
        // — the slow part, a forge lookup per worktree — is limited to
        // exactly these sessions, never a plan over the whole registry.
        const requestedIds = new Set<string>()
        for (const ref of input.sessionIds) {
          const desc = registry.findByIdOrName(ref)
          if (desc) requestedIds.add(desc.id)
        }
        const { all, sessionsForPlan, signals } = await gatherWrapupInputs(nowMs, { onlyIds: requestedIds })
        const subtree = callerScope ? collectSubtree(callerScope.ownerSessionId, all) : undefined

        const entries = planSessionWrapup({
          sessions: sessionsForPlan,
          nowMs,
          signals,
          ...(wrapupCallerSessionId ? { callerSessionId: wrapupCallerSessionId } : {}),
        })
        const entryById = new Map(entries.map(e => [e.sessionId, e]))

        const source: "judged" | "declared" = input.judgedBy ? "judged" : "declared"
        const judgedBy = input.judgedBy ?? "steward-rules"

        const results = input.sessionIds.map(ref => {
          const desc = registry.findByIdOrName(ref)
          if (!desc) return { sessionId: ref, ok: false as const, error: "not_found" }
          if (subtree && !subtree.has(desc.id)) {
            return { sessionId: desc.id, ok: false as const, error: "orchestrator_session_out_of_scope" }
          }
          const entry = entryById.get(desc.id)
          if (!entry) return { sessionId: desc.id, ok: false as const, error: "not_a_candidate" }
          if (entry.class === "keep") {
            return { sessionId: desc.id, ok: false as const, class: entry.class, error: "keep_class_never_touched" }
          }
          if (entry.class === "judge" && !input.judgedBy) {
            return { sessionId: desc.id, ok: false as const, class: entry.class, error: "ambiguous_needs_judge" }
          }
          const action: "closed" | "flagged" =
            (input.verdict === "done" || input.verdict === "abandoned"
              ? "closed"
              : "flagged")
          const applied = registry.closeWithOutcome(desc.id, {
            verdict: input.verdict,
            ...(input.note !== undefined ? { note: input.note } : {}),
            judgedBy,
            source,
          })
          return applied
            ? { sessionId: desc.id, ok: true as const, class: entry.class, action }
            : { sessionId: desc.id, ok: false as const, class: entry.class, error: "refused_stale_or_busy" }
        })
        return { results }
      }

      const { job, promise } = sessionWrapupApplyJobs.start(computeApply)
      if (input.wait === false) {
        return { content: [{ type: "text", text: JSON.stringify(sessionWrapupApplyBackgroundView(job)) }] }
      }
      const waitMs = input.wait === true ? undefined : (input.waitMs ?? BACKGROUND_DEFAULT_WAIT_MS)
      if (waitMs !== undefined && (await timedOutWaiting(promise, waitMs))) {
        return { content: [{ type: "text", text: JSON.stringify(sessionWrapupApplyBackgroundView(job)) }] }
      }
      try {
        return { content: [{ type: "text", text: JSON.stringify(await promise) }] }
      } catch (err) {
        return {
          content: [
            { type: "text", text: `session_wrapup_apply failed: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        }
      }
    }
  )

  // ── session_mark_completed — steward combo verb ─────────────────────
  // Set a Level-2 outcome (verdict + summary + judgedBy) AND close in one
  // call — the "combo: set outcome + stop" composition over
  // `registry.closeWithOutcome`, same primitive `session_wrapup_apply`
  // drives, minus the plan/classifier gate: this is the DECLARED path, an
  // operator (or an agent with judgedBy) reaching a verdict directly.
  // `closeWithOutcome` carries its own guards: refuses anything that isn't a
  // live idle agent-cli row, and records blocked/needs-input as a non-closing
  // wrapupFlag — the same liveness contract every steward close obeys.
  server.tool(
    "session_mark_completed",
    "Mark a live session as completed — closes it with verdict:'done' and " +
      "tags it as steward-completed. Use when a human (or an agent's judge) " +
      "decides the session's work is done — the declared path: no wrapup " +
      "plan, no classification. One call fuses what would otherwise be " +
      "`session_wrapup_apply` without a plan: the verdict (with an optional " +
      "summary + who judged it) is written onto the session's Level-2 " +
      "`SessionOutcome` and the session is closed gracefully "
      + "the same way wrapup-apply does, left lazy-resumable (never deleted). " +
      "`verdict:'partial'`/'failed'/'abandoned' close as not-completed " +
      "(`endedReason:'steward-abandoned'`); `'blocked'`/'needs-input' are " +
      "NOT completions — the session stays running and the verdict is " +
      "recorded as a flag instead. Refused (result ok:false) when the " +
      "session is missing, not agent-cli, already terminal, mid-turn/" +
      "awaiting input/permission, or has a background task in flight.",
    {
      sessionId: z.string().min(1).describe("Session id or name — from `session_list`, must be a live agent-cli session."),
      verdict: z
        .enum(["done", "abandoned", "partial", "failed", "blocked", "needs-input"])
        .optional()
        .describe(
          "Default 'done'. 'done' closes as completed " +
            "(`endedReason:'steward-completed'`); 'partial'/'failed'/" +
            "'abandoned' close as not-completed (steward-abandoned) with the " +
            "verdict nuance kept on the outcome; 'blocked'/'needs-input' " +
            "flag instead — the session keeps running.",
        ),
      summary: z.string().optional().describe("Overrides the outcome's derived summary (trimmed to the same cap as the derived one)."),
      note: z.string().optional().describe("Free-text note explaining the verdict."),
      judgedBy: z
        .string()
        .optional()
        .describe(
          "A judge session id — sets the outcome's source to 'judged'. " +
            "Omitted ⇒ 'declared', judgedBy:'steward-rules'.",
        ),
    },
    async input => {
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "not_found", sessionId: input.sessionId }) }] }
      }
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(desc.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_mark_completed: session "${desc.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only mark sessions it (transitively) spawned.",
                  sessionId: desc.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      const verdict = input.verdict ?? "done"
      // A TERMINAL session has no turn left to complete — refuse it as a
      // distinct error instead of letting closeWithOutcome fold it into the
      // generic stale refusal, so the caller sees NOT-live vs BUSY as two
      // different things.
      const status = registry.get(desc.id)?.status ?? desc.status
      if (status !== "running" && status !== "starting") {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "not_live", status, sessionId: desc.id }) }],
          isError: true,
        }
      }
      const source: "judged" | "declared" = input.judgedBy ? "judged" : "declared"
      const applied = registry.closeWithOutcome(desc.id, {
        verdict,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        judgedBy: input.judgedBy ?? "steward-rules",
        source,
      })
      const out = {
        ok: applied,
        sessionId: desc.id,
        verdict,
        action: verdict === "blocked" || verdict === "needs-input" ? "flagged" : "closed",
        ...(!applied ? { error: "refused_stale_or_busy" } : {}),
      }
      return { content: [{ type: "text", text: JSON.stringify(applied ? { ...out, endedReason: registry.get(desc.id)?.endedReason } : out) }] }
    },
  )

  // ── session_evidence — read-only judge input (FIX-9B) ─────────────
  // The session-steward workflow's `evidence` step: one compact object per
  // `judge`-class session for its judge agent. Read-only, cheap, in-process
  // (a bounded transcript tail + at most one worktree lookup). Deliberately
  // separate from the wrapup tools — it classifies nothing and acts on
  // nothing.
  server.tool(
    "session_evidence",
    "READ-ONLY — a compact evidence object for ONE session, as fed to the " +
      "session-steward judge: label, cwd, adapter, status, keepAlive, " +
      "awaitingInput, busy, idle minutes, the last ~10 user/assistant turns " +
      "(trimmed to ~3 KB total, newest kept first), and — for a session in a " +
      "linked worktree — branch, dirty counts, ahead/behind and PR state/number. " +
      "Mutates nothing.",
    {
      sessionId: z.string().min(1).describe("Session id or name."),
    },
    async input => {
      const desc = registry.findByIdOrName(input.sessionId)
      if (!desc) {
        return {
          content: [{ type: "text", text: `session_evidence: no session "${input.sessionId}"` }],
          isError: true,
        }
      }
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(desc.id)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "orchestrator_session_out_of_scope" }) }],
            isError: true,
          }
        }
      }
      const turns = desc.eventsPath ? readRecentTurnsSync(desc.eventsPath) : []
      const records = desc.eventsPath ? readRecentToolCallRecordsSync(desc.eventsPath) : []
      const times = desc.eventsPath ? readLastMessageTimesSync(desc.eventsPath) : {}
      const lastRecord = records.length > 0 ? records[records.length - 1] : undefined
      const lastToolCall = lastRecord
        ? {
            tool: lastRecord.tool ?? "unknown",
            ...(lastRecord.command ? { command: lastRecord.command } : {}),
            ...(lastRecord.ts ? { ts: lastRecord.ts } : {}),
            ...(lastRecord.isError ? { isError: true } : {}),
          }
        : undefined
      const liveChildren = registry
        .list({ includeArchived: false })
        .filter(s => s.parentSessionId === desc.id && (s.status === "running" || s.status === "starting")).length
      let worktree: WorktreeStatusView | undefined
      const scope = sessionWorktreeScope(desc)
      if (scope && listWorktreeStatuses) {
        try {
          const views = await listWorktreeStatuses(scope.repoRoot, { paths: [scope.worktreePath] })
          worktree = views[0]
        } catch {
          // Best-effort — evidence without the worktree view is still evidence.
        }
      }
      const prState = worktree?.pr?.state ?? null
      const evidence = buildSessionEvidence({
        desc,
        turns,
        ...(worktree ? { worktree } : {}),
        nowMs: Date.now(),
        ...(records.length > 0 ? { toolStats: summarizeToolCalls(records) } : {}),
        ...(lastToolCall ? { lastToolCall } : {}),
        liveChildren,
        ...(times.lastUserAt ? { lastUserAt: times.lastUserAt } : {}),
        ...(times.lastAgentAt ? { lastAgentAt: times.lastAgentAt } : {}),
        pullRequests: {
          opened: desc.openedPrs?.length ?? 0,
          merged: prState === "merged" ? 1 : 0,
          state: prState,
        },
      })
      return { content: [{ type: "text", text: JSON.stringify(evidence) }] }
    },
  )

  // ── session_judge_jev — Jev judge backend for the steward (FIX-9B) ──
  // One Jev (TypeSafe System One) `choice` call over the five wrap-up
  // verdicts, state = a `session_evidence` object. Never an MCP error: a
  // missing key or any Jev failure comes back as `ok:false` so the workflow
  // falls back to its agent judge. Acts on nothing.
  server.tool(
    "session_judge_jev",
    "Judge ONE idle session with Jev (TypeSafe System One): a calibrated " +
      "`choice` over done/abandoned/blocked/needs-input/active, with " +
      "probabilities. `evidence` is the session's `session_evidence` object. " +
      "The key is JEV_API_KEY from the daemon env (or the host secret " +
      "resolver). Returns `{ ok:true, verdict, confidence, probabilities, " +
      "model }` or `{ ok:false, error, noKey? }` — never an error result, " +
      "never a mutation.",
    {
      sessionId: z.string().min(1).describe("The judged session's id (echoed back)."),
      evidence: z.record(z.string(), z.unknown()).describe("The `session_evidence` object, sent as Jev's `state`."),
      model: z.string().optional().describe("Jev model. Default `jev-latest`."),
    },
    async input => {
      const jevCfg = await resolveJevConfig()
      const judgement = await judgeSessionWithJev({
        sessionId: input.sessionId,
        evidence: input.evidence,
        apiKey: await resolveJevApiKey(),
        ...(input.model ? { model: input.model } : jevCfg.model ? { model: jevCfg.model } : {}),
        ...(jevCfg.baseUrl ? { baseUrl: jevCfg.baseUrl } : {}),
      })
      return { content: [{ type: "text", text: JSON.stringify(judgement) }] }
    },
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
          content: [{ type: "text", text: JSON.stringify(publicSessionDescriptor(desc)) }],
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
          content: [{ type: "text", text: JSON.stringify(publicSessionDescriptor(desc)) }],
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
          content: [{ type: "text", text: JSON.stringify(publicSessionDescriptor(desc)) }],
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
          content: [{ type: "text", text: JSON.stringify(publicSessionDescriptor(desc)) }],
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
          content: [{ type: "text", text: JSON.stringify(publicSessionDescriptor(desc)) }],
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

  // ── session_reorder_pinned ─────────────────────────────────────────
  // Manually reorder the pinned group — the MCP twin of `POST
  // /sessions/pinned/order`. Modeled on session_set_pinned: resolve each id,
  // subtree-scope ALL of them, then delegate to the registry, which assigns
  // positions 0..n-1 in the given order, persists, and emits
  // `session:pinned-reordered`. Pure sort/display state — never touches the
  // live agent, keepAlive, or the idle-reaper.
  server.tool(
    "session_reorder_pinned",
    "Manually reorder pinned sessions. `ids` is the desired order — each " +
      "listed session is assigned its position (0..n-1) in that order; every " +
      "other pinned session keeps its relative order and follows. Every id " +
      "must exist and be pinned. Persists across daemon restarts. Pure " +
      "sort/display state — does NOT touch the running agent, keepAlive, " +
      "or the idle-reaper.",
    {
      ids: z
        .array(z.string().min(1))
        .min(1)
        .describe("Session ids in the desired pinned order — from `session_list`."),
    },
    async input => {
      const resolved = input.ids.map(idOrName => registry.findByIdOrName(idOrName))
      for (let i = 0; i < input.ids.length; i++) {
        if (!resolved[i]) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: `no session "${input.ids[i]}" found` }),
              },
            ],
            isError: true,
          }
        }
      }
      const descs = resolved as SessionDescriptor[]
      // Subtree scoping (WP4): a scoped orchestrator may only reorder when
      // ALL the listed sessions are in its (transitive) subtree.
      if (callerScope) {
        const subtree = collectSubtree(
          callerScope.ownerSessionId,
          registry.list({ includeArchived: true }),
        )
        const outOfScope = descs.find(desc => !subtree.has(desc.id))
        if (outOfScope) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_reorder_pinned: session "${outOfScope.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only reorder sessions it (transitively) spawned.",
                  ok: false,
                  sessionId: outOfScope.id,
                }),
              },
            ],
            isError: true,
          }
        }
      }
      try {
        const reordered = registry.reorderPinned(descs.map(desc => desc.id))
        return {
          content: [{ type: "text", text: JSON.stringify(reordered.map(publicSessionDescriptor)) }],
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `session_reorder_pinned: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        }
      }
    }
  )

  server.tool(
    "session_artifact_add",
    "Materialize a durable artifact (document, image, pdf, html, presentation, " +
      "site, or generic file) into this session's artifact store — the thing " +
      "that shows as an inline card in the conversation and lists in the " +
      "session's 'Artifacts' section, kept across restarts (unlike a plain " +
      "chat attachment). Pass EITHER `bytes` (base64, for content the agent " +
      "produced in-memory) OR `sourcePath` (an absolute path to an existing " +
      "file, or a directory for a `kind: \"site\"` — e.g. a canvakit export). " +
      "Re-adding the same `key` with different content records a new version; " +
      "re-adding identical bytes is a no-op (content-addressed dedup).",
    {
      idOrName: z.string().min(1).describe("Session id or name — from `session_list`."),
      key: z
        .string()
        .optional()
        .describe(
          "Stable id to version under. Omit to derive one from `name`, else the " +
            "content hash — pass an explicit key when you intend to re-add a " +
            "later version of the same artifact.",
        ),
      kind: z
        .enum(["image", "document", "pdf", "html", "presentation", "site", "file"])
        .optional()
        .describe("Defaults to an inference from `mimeType`/`name`/`sourcePath`."),
      label: z.string().optional().describe("Display label for the inline card / Artifacts section."),
      sourceRef: z
        .string()
        .optional()
        .describe("Free-form provenance, e.g. 'workflow-run:<runId>/<key>' or 'canvakit:<exportPath>'."),
      bytes: z.string().optional().describe("Inline content, base64-encoded. Mutually exclusive with `sourcePath`."),
      name: z.string().optional().describe("Display name — also the default `key`/extension source."),
      mimeType: z.string().optional().describe("Content type, when known."),
      sourcePath: z
        .string()
        .optional()
        .describe(
          "Absolute path to an existing file or directory to copy in. A directory " +
            "implies `kind: \"site\"` unless overridden. Mutually exclusive with `bytes`.",
        ),
    },
    async input => {
      const prev = registry.findByIdOrName(input.idOrName)
      if (!prev) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `no session "${input.idOrName}" found` }) }],
          isError: true,
        }
      }
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_artifact_add: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only touch sessions it (transitively) spawned.",
                }),
              },
            ],
            isError: true,
          }
        }
      }
      try {
        const record = registry.addSessionArtifact(prev.id, {
          ...(input.key ? { key: input.key } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.label ? { label: input.label } : {}),
          createdBy: "agent",
          ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
          ...(input.bytes ? { bytes: input.bytes } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        })
        return { content: [{ type: "text", text: JSON.stringify(record) }] }
      } catch (err) {
        return {
          content: [{ type: "text", text: `session_artifact_add: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    "session_artifact_list",
    "List every artifact in this session's store — each key's current label/" +
      "kind/pin plus its full version history. Empty array for a session with " +
      "none yet.",
    {
      idOrName: z.string().min(1).describe("Session id or name — from `session_list`."),
    },
    async input => {
      const prev = registry.findByIdOrName(input.idOrName)
      if (!prev) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `no session "${input.idOrName}" found` }) }],
          isError: true,
        }
      }
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_artifact_list: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only touch sessions it (transitively) spawned.",
                }),
              },
            ],
            isError: true,
          }
        }
      }
      const records = registry.listSessionArtifacts(prev.id)
      return { content: [{ type: "text", text: JSON.stringify({ artifacts: records }) }] }
    },
  )

  server.tool(
    "session_artifact_get",
    "Fetch one artifact version's metadata plus its bounded file content — " +
      "capped, a larger file still resolves (`truncated: true`) with its " +
      "first bytes. A `kind: \"site\"` version returns metadata only (no " +
      "`content`); browse it via `GET /sessions/:id/artifacts/:key/raw/...` " +
      "instead.",
    {
      idOrName: z.string().min(1).describe("Session id or name — from `session_list`."),
      key: z.string().min(1).describe("Artifact key, from `session_artifact_list`."),
      version: z.number().int().positive().optional().describe("Defaults to the latest version."),
      maxBytes: z.number().int().positive().optional().describe("Content cap in bytes. Defaults to 512 KiB."),
    },
    async input => {
      const prev = registry.findByIdOrName(input.idOrName)
      if (!prev) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `no session "${input.idOrName}" found` }) }],
          isError: true,
        }
      }
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_artifact_get: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only touch sessions it (transitively) spawned.",
                }),
              },
            ],
            isError: true,
          }
        }
      }
      const result = registry.getSessionArtifact(prev.id, input.key, {
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      })
      if (!result) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `no artifact "${input.key}" found` }) }],
          isError: true,
        }
      }
      const isText =
        result.version.contentType?.startsWith("text/") ||
        result.version.contentType === "application/json" ||
        result.version.contentType === "text/html"
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              record: result.record,
              version: result.version,
              truncated: result.truncated,
              ...(result.content
                ? isText
                  ? { text: result.content.toString("utf8") }
                  : { base64: result.content.toString("base64") }
                : {}),
            }),
          },
        ],
      }
    },
  )

  server.tool(
    "session_artifact_pin",
    "Set or clear an artifact's pin — a pinned artifact surfaces in the " +
      "session's derived outcome (the ended block) as a `type: \"file\"` ref, " +
      "in addition to always listing in `session_artifact_list`.",
    {
      idOrName: z.string().min(1).describe("Session id or name — from `session_list`."),
      key: z.string().min(1).describe("Artifact key, from `session_artifact_list`."),
      pinned: mcpBool.describe("true to pin, false to unpin."),
    },
    async input => {
      const prev = registry.findByIdOrName(input.idOrName)
      if (!prev) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `no session "${input.idOrName}" found` }) }],
          isError: true,
        }
      }
      if (callerScope) {
        const subtree = collectSubtree(callerScope.ownerSessionId, registry.list({ includeArchived: true }))
        if (!subtree.has(prev.id)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "orchestrator_session_out_of_scope",
                  message:
                    `session_artifact_pin: session "${prev.id}" is not in your subtree — ` +
                    "a scoped orchestrator can only touch sessions it (transitively) spawned.",
                }),
              },
            ],
            isError: true,
          }
        }
      }
      const record = registry.setArtifactPinned(prev.id, input.key, input.pinned)
      if (!record) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `no artifact "${input.key}" found` }) }],
          isError: true,
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(record) }] }
    },
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
      // ── terminal gate (same allowlist as command_execute) ─────────
      // `command_execute` refuses anything outside the workspace
      // allowlist; without this check `terminal_start` spawns arbitrary
      // argv under a PTY and the gate is decorative — anyone refused by
      // one tool just uses the other. Resolve the mode per workspace:
      //   "allowlist" (shipped default) — argv[0] must pass the SAME
      //     allowlist check `command_execute` applies;
      //   "all" — no check (a deliberate operator decision);
      //   "off" — refused outright. NOTE: off means the door is CLOSED,
      //     not that the gate is disabled.
      const gateMode = await loadTerminalGateMode(workspace)
      if (gateMode === "off") {
        return {
          content: [
            {
              type: "text",
              text:
                "terminal_start is disabled for this workspace by its " +
                'terminal gate ("terminalGate": "off"). To re-enable ' +
                'terminals, set "terminalGate": "allowlist" or "all" in ' +
                `${join(workspace, ALLOWLIST_REL)}.`,
            },
          ],
          isError: true,
        }
      }
      if (gateMode === "allowlist") {
        const allowlistEntries = await loadAllowlistEntries(workspace)
        // noUncheckedIndexedAccess: argv is min(1)-validated, but fall back
        // to "" (which matches no entry) rather than failing open.
        const baseName = basename(input.argv[0] ?? "")
        if (!isCommandAllowed(allowlistEntries, baseName, input.argv.slice(1))) {
          const allowedBasenames =
            [...new Set(allowlistEntries.map(e => e.command))].sort().join(", ") ||
            "(empty)"
          return {
            content: [
              {
                type: "text",
                text:
                  `terminal_start: command '${baseName}' is not in the ` +
                  `allowlist (the same one command_execute is gated by). ` +
                  `Add it to ${join(workspace, ALLOWLIST_REL)} under ` +
                  `"commands": [...]. Currently allowed: ${allowedBasenames}. ` +
                  `To run any command from terminals in this workspace, set ` +
                  `"terminalGate": "all" in that file, or globally set the ` +
                  `${TERMINAL_GATE_ENV}=all environment variable.`,
              },
            ],
            isError: true,
          }
        }
      }
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
          content: [{ type: "text", text: JSON.stringify(publicSessionDescriptor(desc)) }],
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
      // Multi-line `content` gets wrapped in the bracketed-paste markers
      // (`\x1b[200~`…`\x1b[201~`) when the session's PTY has last announced
      // paste mode ON (`\x1b[?2004h`) — otherwise a paste-detecting TUI's
      // readline interprets each embedded `\n` as an Enter keystroke and
      // re-echoes/garbles the input. `applyBracketedPasteWrap` treats an
      // unseen/`"unknown"` mode the same as off, so sessions that never
      // toggle bracketed paste see byte-identical behavior to before. This
      // is the SAME helper used by the HTTP `terminal/input` route and the
      // PTY WebSocket `input` frame — see sessions.ts's doc.
      let ok = true
      if (content.length > 0) {
        const toWrite = applyBracketedPasteWrap(registry, desc.id, content)
        ok = registry.writeTerminalInput(desc.id, toWrite) && ok
      }
      if (input.enter) {
        ok = registry.writeTerminalInput(desc.id, "\r") && ok
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, sessionId: desc.id }),
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
      "`clean: true` for ANSI-stripped plain text instead. Capped at the " +
      "last 4096 bytes of the ring by default — pass `lastBytes` explicitly " +
      "(up to 64 KiB) to widen the window. When a window is applied the " +
      "result carries a `truncated` flag (true when the window was filled to " +
      "capacity).",
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
          "Max bytes from the tail. Default 4096; the full ~64 KiB ring " +
            "remains reachable by passing `lastBytes: 65536` explicitly."
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
      // PR-10: the read window defaults to the last 4096 bytes when
      // `lastBytes` is omitted; an explicit `lastBytes` (up to 64 KiB)
      // keeps today's wider-window behaviour.
      const windowBytes = input.lastBytes ?? 4096
      const buf = registry.readTerminalOutput(
        desc.id,
        windowBytes,
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
                truncated: buf.byteLength >= windowBytes,
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
            text: JSON.stringify({ ok, sessionId: desc.id }),
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
