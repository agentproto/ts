/**
 * @agentproto/runtime — long-running gateway around an agentproto
 * workspace dir.
 *
 * Composes:
 *   - `@agentproto/mcp-server` (CRUD verbs over registered specs)
 *   - HTTP transport (Streamable HTTP) on a configurable port
 *   - HEARTBEAT.md autonomy loop
 *   - Append-only conversation persistence (`conversations/<id>.md`)
 *   - Workspace filesystem adapter (compatible with the
 *     `McpWorkspace.filesystem` shape used by `@guilde/mcp`)
 *
 * Single entry point: `createGateway(opts)`. Returns a handle with
 * `url` and `stop()` — the rest of the surface lives on the HTTP
 * server.
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import type { DoctypeSpec } from "@agentproto/manifest"

import { writeRuntimeMeta } from "./agentproto-dir.js"
import { registerCommandTools } from "./command-tools.js"
import { fileConversationStore } from "./conversations.js"
import { createRuntimeEvents } from "./events.js"
import { registerFsTools } from "./fs-tools.js"
import {
  registerSessionTools,
  registerExportSessionTool,
  registerConversationReadTool,
} from "./session-tools.js"
import {
  registerBrowserTools,
  type BrowserAdapterResolver,
  type BrowserAdapterLister,
} from "./browser-tools.js"
import { registerAuthProfileTools } from "./auth-profile-tools.js"
import { registerMcpApps } from "./mcp-apps-adapter.js"
import { makeSessionsPanelApp } from "./sessions-panel-app.js"
import {
  makeAgentsOverviewApp,
  registerSummarizeSessionTool,
} from "./agents-overview-app.js"
import { makeBureauSessionsApp } from "./bureau-sessions-app.js"
import { makeSessionStoryPanelApp } from "./session-story-panel-app.js"
import { makeTerminalPanelApp } from "./terminal-panel-app.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  getActiveWorkspace,
} from "./workspaces-config.js"
import {
  type WorktreeStatusLister,
} from "./worktree-status.js"
import type { WorktreeGcRunner } from "./worktree-gc.js"
import { startHeartbeat, type BuildHeartbeatAgent } from "./heartbeat.js"
import {
  startHttpServer,
  type AuthOptions,
  type AgentAdapterResolver,
  type AgentAdapterLister,
  type AgentAdapterInstaller,
  type CatalogModelsLister,
} from "./http-server.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type PtyFactory,
} from "./sessions.js"
import { loadConfig } from "./config.js"
import { langfuseSessionTracer } from "./langfuse-session-tracer.js"
import { makeEvalReporterCredsStore } from "@agentproto/eval-reporters"
import { McpProxyRegistry } from "./mcp-proxy.js"
import { registerOrchestrationTools } from "./orchestration-tools.js"
import { createSessionEventBus } from "./session-event-bus.js"
import { createEventRing } from "./event-ring.js"
import { createWebhookNotifier } from "./webhook-notifier.js"
import { createRoutineRunner } from "./routine-runner.js"
import { createWorkflowRunner } from "./workflow-runner.js"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { createFileStepCache } from "./workflow-step-cache.js"
import { withDeferredTools } from "./deferred-tools.js"
import { withToolExclusion } from "./tool-subset.js"
import { createCompletionPolicySupervisor } from "./supervisor.js"
import { createPrProvenanceReconciler, type OpenPrResolver } from "./pr-provenance-reconciler.js"
import { createActivityProjector, type PrStateResolver } from "./activities.js"
import { createTaskLedger } from "./task-ledger.js"
import { createInboundWatcher } from "./inbound-watcher.js"
import { createCronScheduler } from "./cron-scheduler.js"
export type {
  WatcherStartInput,
  WatcherDescriptor,
  InboundWatcher,
} from "./inbound-watcher.js"
import {
  createScopeTokenRegistry,
  createOrchestratorMcpServerFactory,
  createOrchestratorInjector,
  reapOrphanedDescendants,
  type OrchestratorScope,
} from "./orchestrator-gateway.js"

export type {
  AgentAdapterResolver,
  AgentAdapterLister,
  AgentAdapterInstaller,
  AdapterInstallResult,
  AdapterListEntry,
  CatalogModelsLister,
} from "./http-server.js"
export type {
  WorktreeStatusLister,
  WorktreeStatusView,
} from "./worktree-status.js"
export { toWorktreeStatusView } from "./worktree-status.js"
export type {
  WorktreeGcRunner,
  WorktreeGcRunInput,
  WorktreeGcResult,
  WorktreeGcClass,
  WorktreeGcPlanEntryView,
  WorktreeGcOutcomeView,
} from "./worktree-gc.js"
export { createPrProvenanceReconciler } from "./pr-provenance-reconciler.js"
export type { OpenPrResolver } from "./pr-provenance-reconciler.js"
export { createActivityProjector } from "./activities.js"
export type {
  ActivityProjector,
  ActivityProjectorRegistry,
  ActivityProjectorSession,
  ActivityPolicyLister,
  ActivityRoutineLister,
  ActivityWorkflowLister,
  PrStateResolver,
} from "./activities.js"
export {
  policyToActivities,
  turnToActivities,
  routineToActivities,
  workflowToActivities,
  prToActivities,
  filterActivities,
  activityCounts,
  isTerminalActivityState,
} from "./activity-projection.js"
export type {
  ActivityRecord,
  ActivityState,
  ActivityKind,
  ActivitySource,
  ActivityWaitingOn,
  ActivityListFilter,
  PrResolvedState,
} from "./activity-projection.js"
export {
  createTaskLedger,
  createSupervisorTaskGateRunner,
  parseTaskStatus,
  isClosedTaskStatus,
  TASK_STATUSES,
} from "./task-ledger.js"
export type {
  TaskRecord,
  TaskStatus,
  TaskVerification,
  TaskCaller,
  TaskLedger,
  TaskLedgerRegistry,
  TaskLedgerSessionSlice,
  TaskVerifySupervisor,
  TaskGateRunner,
  TaskGateOutcome,
  TaskCreateInput,
  TaskListFilter,
  TaskClaimInput,
  TaskUpdateInput,
  TaskWriteResult,
} from "./task-ledger.js"
export type { TaskChangedEvent } from "./session-event-bus.js"
export {
  userPresetsPath,
  loadUserPresets,
  listUserPresets,
  getUserPreset,
  saveUserPreset,
  deleteUserPreset,
} from "./user-presets.js"
export type { UserPreset, UserPresetsFile } from "./user-presets.js"
export {
  buildCatalogModels,
  type CatalogAdapterInput,
  type CatalogAdapterModelInput,
  type CatalogModelsQuery,
  type CatalogModelsResponse,
  type CatalogVendor,
  type CatalogProduct,
  type CatalogRoute,
  type CatalogRouteSummary,
  type CatalogPricing,
} from "./catalog-models.js"
export type { BrowserAdapterResolver, BrowserAdapterLister, BrowserAdapterInfo } from "./browser-tools.js"
export { makeBrowserAdapterLister } from "./browser-adapters.js"
export type { BrowserAdapterHandle } from "./browser-adapters.js"
export type {
  SandboxProviderResolver,
  SandboxProviderLister,
  SandboxAdapterInfo,
} from "./sandbox-adapters.js"
export type {
  SandboxProviderHandle,
  SandboxProviderCapabilities,
} from "./sandbox-providers/types.js"
export type {
  AgentSessionLike,
  AgentStreamEvent,
  SessionDescriptor,
  SessionKind,
  SessionStatus,
  SpawnSessionInput,
  SpawnAgentInput,
  SessionsRegistry,
  RegisterBrowserInput,
  RegisterSessionInput,
  PendingPermission,
  PermissionRespondInput,
  PermissionRespondResult,
} from "./sessions.js"
export { formatToolCall, formatToolResult } from "./tool-presenter.js"
export { deriveSessionUsage, projectSessionUsage } from "./usage.js"
export {
  composeSessionObservers,
  type SessionObserver,
} from "./session-observer.js"
export {
  getMcpCredentialDeps,
  setMcpCredentialDeps,
  type McpCredentialDeps,
} from "./mcp-credential-deps.js"
export type {
  UsageSource,
  SessionUsage,
  UsageComputeInput,
  PricingResolver,
  TokenPricing,
} from "./usage.js"
import { RemoteController } from "./remote-controller.js"
import { registerRemoteTools } from "./remote-tools.js"
import { registerPairingTools } from "./pairing-tools.js"
import type { PairingRegistry } from "./pairing-registry.js"
import { registerDaemonHealthTools } from "./daemon-health-tools.js"
import { TunnelRegistry } from "./tunnel-registry.js"
import { registerTunnelTools } from "./tunnel-tools.js"
import {
  registerTunnelAdapterTools,
  makeTunnelCredsStore,
} from "./tunnel-adapters.js"
import {
  registerSandboxAdapterTools,
  makeSandboxResolver,
  makeSandboxCredsStore,
  type SandboxProviderResolver,
  type SandboxProviderLister,
} from "./sandbox-adapters.js"
import type { WorktreeProvisioner } from "./worktree-isolation.js"
import { registerEvalReporterTools } from "./eval-reporter-tools.js"
import { registerPresetTools } from "./preset-tools.js"
import { createWorkspaceFs, type WorkspaceFs } from "./workspace-fs.js"

export type { ConversationStore, ConversationMeta, ConversationTurn } from "./conversations.js"
export type { HeartbeatRunner, BuildHeartbeatAgent, HeartbeatAgent } from "./heartbeat.js"
export type { RuntimeEvent, RuntimeEvents } from "./events.js"
export type { WorkspaceFs } from "./workspace-fs.js"
export type { TunnelDescriptor, TunnelStatus, TunnelProvider } from "./tunnel-registry.js"
export {
  decideWorktreeIsolation,
  loadWorktreeIsolation,
  normalizeWorktreeField,
  parseWorktreeIsolationMode,
  WORKTREE_ISOLATION_ENV,
  DEFAULT_WORKTREE_ISOLATION,
} from "./worktree-isolation.js"
export type {
  WorktreeField,
  WorktreeIsolationMode,
  WorktreeProvisioner,
  WorktreeProvisionRequest,
  WorktreeProvisionOutcome,
  WorktreeDecision,
  WorktreeRequest,
} from "./worktree-isolation.js"
export {
  createPairingRegistry,
  PAIRINGS_VERSION,
  type PairingRegistry,
  type PairingRegistryDeps,
  type PairingRecord,
  type PairingChannelContext,
  type PairingChannelHandle,
  type PairingChannelMode,
  type CreatedOffer,
  type CreateOfferInput,
} from "./pairing-registry.js"
export { registerPairingTools, type RegisterPairingToolsOptions } from "./pairing-tools.js"
export {
  createReconnectLogGate,
  type ReconnectLogGate,
} from "./reconnect-log-gate.js"
export { listPresets, declaredPresetToProviderPreset } from "./preset-tools.js"
export type { PresetInfo, DeclaredAdapterPreset } from "./preset-tools.js"
export { decomposeMode, composeMode } from "./session-config.js"
export type {
  SessionConfig,
  EffortLevel,
  CanonicalPosture,
  Posture,
  RouteSpec,
  ContextProfile,
  AuthMethod,
  DeclaredAdapterMode,
} from "./session-config.js"
export {
  resolvePosture,
  findNativeMode,
  canonicalForModeId,
  normalizeModeId,
  POSTURE_PREAMBLES,
  POSTURE_NATIVE_ALIASES,
} from "./canonical-posture.js"
export type { PostureResolution, SessionMode } from "./canonical-posture.js"
export { parseDuration } from "./heartbeat.js"
export { createWorkspaceFs } from "./workspace-fs.js"
export {
  BUCKETS_ROOT,
  DEFAULT_BUCKET,
  LEGACY_SESSIONS_FILE,
  bucketDir,
  bucketSessionsFile,
  bucketTranscriptDir,
  isSafeBucketSlug,
  listBuckets,
  migrateLegacySessionsFile,
  migrationMarkerPath,
  readRegisteredSlugs,
  resolveBucketSlug,
  type MigrationMarker,
} from "./workspace-buckets.js"
export {
  appendConversationRecord,
  conversationIndexPath,
  findConversationRecord,
  locateConversationByNativePath,
  locateConversationBySessionId,
  readConversationIndex,
  resolveNativeLink,
  type ClaudeNativeRef,
  type ConversationIndexRecord,
  type ConversationNativeRef,
  type HermesNativeRef,
  type LocatedConversation,
  type LocatedConversationByPath,
  type ResolveNativeLinkInput,
} from "./conversation-index.js"
export { createFileStepCache } from "./workflow-step-cache.js"
export {
  sweepStaleRuntimeMetas,
  unlinkRuntimeMeta,
  readRuntimeMeta,
  daemonRegistryDir,
  readDaemonRegistry,
  sweepStaleDaemonRegistry,
  writeDaemonRegistryEntry,
  unlinkDaemonRegistryEntry,
  type RuntimeMeta,
} from "./agentproto-dir.js"
export { fileConversationStore } from "./conversations.js"
export { claudeProjectSlug } from "./conversation-store.js"
export {
  loadProviders,
  setProviderKey,
  removeProviderKey,
  getProviderKey,
  injectProviderKeysIntoEnv,
  providerEnvVar,
  providersPath,
  PROVIDER_ENV_VARS,
  type ProviderEntry,
  type ProvidersFile,
} from "./providers-store.js"
export { isAgentCliAuthConfigured } from "./auth-probe.js"
export {
  resolveSpawnDefaults,
  normalizeSkillsOption,
  credentialFingerprint,
  resolveAuthSpec,
  resolveSubscriptionCredential,
  AuthResolutionError,
  SubscriptionSourceError,
  CLAUDE_CODE_OAUTH_SOURCE,
  type SpawnDefaultsConfig,
  type DefaultsAdapterConfig,
  type DefaultsAdapterAuthConfig,
  type ResolvedSpawnDefaults,
  type ResolvedSpawnAuthMaterial,
  type AdapterAuthDescriptor,
  type ResolvedAuthSpec,
  type AuthEcho,
  type CredentialSource,
  type ResolveSubscriptionCredentialInput,
  type SubscriptionCredentialResolution,
  type DeclaredAdapterOption,
} from "./spawn-defaults.js"
export {
  DEFAULT_ORCHESTRATOR_TOOLS,
  narrowOrchestratorTools,
  createScopeTokenRegistry,
  createOrchestratorMcpServerFactory,
  createOrchestratorInjector,
  type OrchestratorScope,
  type ScopeTokenRegistry,
  type OrchestratorMcpServerFactory,
  type OrchestratorGatewayDeps,
  type OrchestratorInjector,
  type OrchestratorInjection,
  type OrchestratorInjectorDeps,
  reapOrphanedDescendants,
  type OrphanReaperRegistry,
} from "./orchestrator-gateway.js"

// Blocking-wait service functions + supervisor types — shared between the
// MCP tool surface (session_monitor / policy_status) and the REST HTTP
// surface (GET /sessions/:id/wait, GET /policies/:id/wait).
export {
  monitorSessionWait,
  monitorPolicyWait,
  type SessionWaitEvent,
  type SessionWaitResult,
} from "./orchestration-tools.js"
export type {
  AttachPolicyInput,
  CommitSpec,
  CompletionPolicySupervisor,
  GateSpec,
  JudgeGateSpec,
  OnFailSpec,
  PolicyRunState,
  PolicyRunStatus,
  ShellGateSpec,
} from "./supervisor.js"
// The policy→session link read backwards — shared by the `policy_list`
// MCP filter and the `GET /policies?sessionId=` route so both transports
// agree on what "attached to this session" means.
export { policyWatchesSession } from "./supervisor.js"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpec = DoctypeSpec<any, any>

export interface CreateGatewayOptions {
  /** Absolute path to the workspace dir. */
  workspace: string
  /** AIP doctype specs to expose as MCP CRUD verbs. */
  specs: readonly AnySpec[]
  /** Port to bind. Default 18790. */
  port?: number
  /** Bind host. Default `127.0.0.1` (loopback). Set `0.0.0.0` for LAN. */
  bind?: string
  /** Auth mode. Default `none` (safe only on loopback). */
  auth?: AuthOptions
  /**
   * Resolves a heartbeat-runnable agent from its workspace id.
   * Required for HEARTBEAT.md to do anything; without it ticks emit
   * `heartbeat-error` events instead of generating.
   */
  buildAgent?: BuildHeartbeatAgent
  /** Server name advertised over MCP. */
  name?: string
  /** Server version advertised over MCP. */
  version?: string
  /**
   * Run BOOT.md once at startup. Pass `false` to disable. Defaults to
   * `true`. The boot file is plain markdown — frontmatter-free; the
   * agent named in `defaultBootAgent` (or skipped if unset) gets the
   * body as a single prompt and the reply is appended to a `boot-<iso>`
   * conversation.
   */
  boot?: boolean
  /** Agent id used for BOOT.md if no per-file frontmatter. */
  defaultBootAgent?: string
  /** Optional adapter resolver — when provided, enables
   *  `POST /sessions/agent` (long-running agent CLIs like
   *  claude-code / hermes via the @agentproto/cli adapter system).
   *  Without this, /sessions still works for raw `argv` spawns. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Optional adapter lister — when provided, enables
   *  `GET /adapters` HTTP route + `adapter_list` MCP tool so UIs
   *  can discover what's installed on the host. */
  listAgentAdapters?: AgentAdapterLister
  /** Optional adapter installer — when provided, enables
   *  `POST /adapters/:slug/install` HTTP route + `adapter_install` MCP
   *  tool so UIs can install a not-yet-installed harness. Hosts ship the
   *  cli's `installAdapter`. */
  installAgentAdapter?: AgentAdapterInstaller
  /** Optional catalog lister — when provided, enables
   *  `GET /catalog/models` HTTP route + `catalog_models` MCP tool
   *  (SPEC §5) so UIs can discover every runnable model + route without
   *  trial-and-error against a spawn. */
  listCatalogModels?: CatalogModelsLister
  /** Optional browser adapter resolver — when provided, enables the
   *  `start_browser` MCP tool (launches Camofox / Bureau / Chromium). */
  resolveBrowserAdapter?: BrowserAdapterResolver
  /** Optional browser adapter lister — when provided, enables the
   *  `browser_adapter_list` MCP tool. */
  listBrowserAdapters?: BrowserAdapterLister
  /** Optional PTY factory (node-pty wrapper, typically from the cli
   *  layer's `loadNodePtyFactory()`). When provided, enables
   *  `POST /sessions/terminal`, the `terminal_start` MCP
   *  tool family, and the `/sessions/:id/pty` WebSocket. Without it,
   *  those routes return 501 / the MCP tools aren't registered. */
  spawnPty?: PtyFactory
  /** Enable filesystem persistence for every store this gateway owns —
   *  the sessions registry plus the supervisor / routine / cron / workflow
   *  / inbound-watcher run stores. Defaults to `true`, i.e. production is
   *  unchanged.
   *
   *  Tests pass `false`. Without it, a test gateway writes its fake rows
   *  into the *developer's real* `~/.agentproto/sessions.json` (and the
   *  sibling `policies.json` / `routine-runs.json` / `cron-jobs.json` /
   *  `workflow-runs.json`): those paths resolve off `homedir()`, and the
   *  gateway opted each store into persistence unconditionally. Since
   *  `loadHistorySnapshot` re-reads sessions.json at boot, the real daemon
   *  then restores the fakes and shows them in the dashboard — and against
   *  `HISTORY_CAP` (200) they evict genuine history.
   *
   *  The sibling stores already default to persist-off when constructed
   *  directly (see `createRoutineRunner`); this knob is what lets a
   *  gateway stop overriding that on their behalf. */
  persist?: boolean
  /** Override the sessions-registry persistence path — tests pin a tmpdir
   *  so an assertion can look at the file the gateway would have written
   *  instead of the developer's real one. Defaults to
   *  `~/.agentproto/sessions.json`. The structured-transcript dir follows
   *  this path's parent, so pinning it isolates transcripts too. */
  persistPath?: string
  /** Override the per-boot bearer token. Default: `randomUUID()`.
   *  Tests can pin a known value; production should always let
   *  the gateway generate fresh. The token is written into
   *  `<workspace>/.agentproto/runtime.json` (mode 0600) and required
   *  on mutating `/sessions/*` routes + the PTY WS upgrade. */
  token?: string
  /** Trusted browser origins allowed to drive mutating routes
   *  without a bearer token. See `RuntimeHttpServerOptions.allowedOrigins`
   *  for match semantics. Default: localhost on any port. */
  allowedOrigins?: readonly string[]
  /** When true, drop the localhost-wildcard defaults — only the
   *  explicit `allowedOrigins` list is honoured. */
  strictOrigins?: boolean
  /**
   * Opt-in deferred/lazy MCP tool loading (harness-parity item 3, see
   * `deferred-tools.ts`). When set, every root-gateway tool outside
   * `alwaysOn` registers but starts disabled — excluded from the first
   * `tools/list` — until the always-on `tool_search` meta-tool pulls it
   * in by keyword. Omitted (default) → every tool is eagerly enabled,
   * identical to pre-existing behaviour. Does not affect the scoped
   * `/mcp/orchestrator` sub-gateway, which already exposes a small
   * curated allowlist (`DEFAULT_ORCHESTRATOR_TOOLS`).
   */
  deferredTools?: { alwaysOn?: readonly string[] }
  /**
   * Optional sandbox provider resolver — overrides the sandbox family's
   * default resolver (built-ins + `@agentproto/sandbox-<slug>` dynamic
   * import) used by `list_sandbox_providers` / `setup_sandbox_provider`
   * AND `agent_start.sandbox`. Mirrors `resolveAgentAdapter`'s injection
   * shape.
   */
  resolveSandboxProvider?: SandboxProviderResolver
  /** Optional sandbox provider lister — mirrors `listAgentAdapters`.
   *  Overrides the default catalog-driven lister behind `list_sandbox_providers`. */
  listSandboxProviders?: SandboxProviderLister
  /**
   * Optional git-worktree provisioner powering `agent_start.worktree` and the
   * `worktrees.isolation` policy. Injected here (rather than defaulted inside
   * the runtime like `resolveSandboxProvider`) because provisioning runs the
   * `@agentproto/worktree` TOOL, a dependency the runtime deliberately does
   * NOT take — see `worktree-identity.ts` / `worktree-isolation.ts`. The CLI
   * wires it. Omitted → a spawn the policy says to isolate is rejected with
   * `worktree_provisioner_not_enabled` (never silently spawned unisolated).
   */
  provisionWorktree?: WorktreeProvisioner
  /**
   * Optional git-worktree status lister powering `worktree_status`.
   * Injected here (rather than defaulted inside the runtime) because the join
   * runs over `@agentproto/worktree`, a dependency the runtime deliberately
   * does NOT take. The CLI wires it. Omitted → `worktree_status` returns a
   * clear "not enabled" error.
   */
  listWorktreeStatuses?: WorktreeStatusLister
  /**
   * Optional git-worktree `gc` runner powering `worktree_gc` (+ the parallel
   * HTTP surface). Injected for the same reason as `listWorktreeStatuses`:
   * the plan/apply engine runs over `@agentproto/worktree`, a dependency the
   * runtime deliberately does NOT take. The CLI wires it. Omitted →
   * `worktree_gc` returns a clear "not enabled" error.
   */
  runWorktreeGc?: WorktreeGcRunner
  /**
   * Optional resolver: given a session's cwd, return the OPEN PR for that
   * cwd's git branch (or null). Powers the daemon PR-provenance reconciler,
   * which stamps the `@agentproto-bot` footer onto PRs an executor session
   * opened through its OWN shell — the path `command_execute` (the only other
   * stamp trigger) never observes. Injected here because branch→PR resolution
   * runs over `@agentproto/worktree`, a dependency the runtime deliberately
   * does NOT take. The CLI wires it. Omitted → the reconciler is not started
   * (footer stamping stays limited to the `command_execute` path).
   */
  resolveOpenPr?: OpenPrResolver
  /**
   * Optional resolver: given a PR url, return its current forge state
   * (`"open" | "merged" | "closed"`, or `null` when unresolvable). Powers the
   * Activity projector's PR settlement pass — a `pr` activity pending on the
   * forge becomes terminal (`done` when merged, `cancelled` when closed) once
   * this port reports the verdict. Injected here because forge access runs
   * over `@agentproto/worktree`, a dependency the runtime deliberately does
   * NOT take. The CLI wires it. Omitted → pr activities never settle (they
   * stay pending on the forge, the pre-settlement behaviour).
   */
  resolvePrState?: PrStateResolver
  /**
   * Optional E2E pairing registry (see `createPairingRegistry`). When wired,
   * the gateway mounts the `/pairings/*` REST routes and the `pair_*` MCP
   * tools, and exposes the registry on the handle. The CLI builds it (injecting
   * the ws `dial` + a `createTunnelServer`-backed `serve`) and passes it here so
   * the runtime stays free of pty/adapter concerns while the pairing surface is
   * reachable over MCP + HTTP. Autoconnect is the caller's to start (after this
   * returns) so the injected `serve` can capture the finished gateway.
   */
  pairingRegistry?: PairingRegistry
}

/**
 * Default always-on set when `deferredTools` is enabled without an
 * explicit `alwaysOn` override: the core spawn/drive/observe loop most
 * sessions need immediately. Everything else (fs_*, directory_*,
 * command_*, remote_*, browser_*, terminal_*, mcp_*, routine_*,
 * workflow_*, policy_*, inbound_watcher_*, session_tree, agent_export,
 * adapter_list, ...) starts deferred.
 */
const DEFAULT_ALWAYS_ON_TOOLS: readonly string[] = [
  "daemon_health",
  "agent_start",
  "agent_prompt",
  "agent_output",
  "agent_kill",
  "session_list",
  "session_monitor",
  "session_events_poll",
  "permissions_list",
  "permissions_respond",
]

export interface GatewayHandle {
  url: string
  workspace: string
  workspaceFs: WorkspaceFs
  registered: readonly string[]
  /** Sessions registry — exposed so MCP tools / external spawners
   *  inside the same process can register their child processes for
   *  visibility through /sessions and the CLI TUI. */
  sessions: SessionsRegistry
  /** Tunnel registry — manages public cloudflared tunnels for any
   *  local port. Exposed so embedding hosts can open tunnels
   *  programmatically without going through the HTTP/MCP surface. */
  tunnels: TunnelRegistry
  /** E2E pairing registry, when one was wired via
   *  `CreateGatewayOptions.pairingRegistry`. Undefined otherwise. Exposed so
   *  the CLI can `startAutoconnect()` after boot and `shutdown()` it. */
  pairing?: PairingRegistry
  /** Per-boot bearer token required on mutating /sessions/* routes
   *  + WS PTY upgrades. Exposed so an embedding host (e.g. the CLI
   *  shell that hosts the gateway in-process) can pass it to child
   *  tools without re-reading the runtime.json file. */
  token: string
  /** Mint a scope-token for the scoped orchestrator sub-gateway
   *  (`/mcp/orchestrator`). The returned `token` gates that endpoint
   *  and `tools` is the effective allowlist (⊆ the default orchestrator
   *  subset). WP3 will call this at spawn time and inject the URL into
   *  the child's `mcpServers`; for WP2 it's the internal primitive. */
  mintOrchestratorScope(opts?: {
    tools?: readonly string[]
  }): OrchestratorScope
  stop(): Promise<void>
}

/**
 * Spin up the gateway. Order:
 *   1. Build MCP server + load AIP-40 extensions
 *   2. Build conversation store + workspace fs adapter
 *   3. (optional) Run BOOT.md once
 *   4. Start HTTP server
 *   5. Start heartbeat ticker
 *
 * `stop()` reverses 4–5 (heartbeat first, then HTTP). The MCP server
 * is owned by the HTTP server's per-session transports and is closed
 * implicitly when those close.
 */
export async function createGateway(
  opts: CreateGatewayOptions,
): Promise<GatewayHandle> {
  const startedAt = Date.now()
  const workspace = resolve(opts.workspace)
  if (!existsSync(workspace)) {
    throw new Error(`runtime: workspace dir does not exist: ${workspace}`)
  }
  const port = opts.port ?? 18790
  // Loopback URL for the daemon's own plain `/mcp` gateway — always
  // 127.0.0.1 regardless of `opts.bind`, mirroring the orchestrator
  // injector's loopback default (orchestrator-gateway.ts), since a
  // spawned child is co-located on the same host and reaches the
  // daemon over loopback, never the LAN-bind address.
  const daemonMcpUrl = `http://127.0.0.1:${port}/mcp`
  // Sandbox provider resolver — powers both `list_sandbox_providers` /
  // `setup_sandbox_provider` (registerSandboxAdapterTools below) AND
  // `agent_start.sandbox` (registerSessionTools → spawnAgentSession). Built
  // once here (rather than each call defaulting separately) so both surfaces
  // resolve the exact same provider set for the exact same slug. Falls back
  // to the family's own built-in resolver (built-ins + `@agentproto/sandbox-
  // <slug>` dynamic import) when the host doesn't inject an override —
  // mirrors `resolveAgentAdapter`'s optional-injection shape.
  const resolveSandboxProviderResolved: SandboxProviderResolver =
    opts.resolveSandboxProvider ?? makeSandboxResolver(makeSandboxCredsStore())
  // Same loopback reasoning as `daemonMcpUrl` above, for the terminal MCP
  // app's PTY WebSocket: this process already knows its own bind/port, so
  // there's no need to shell out to `.agentproto/runtime.json` (the CLI's
  // discovery path in packages/cli — see sessions.ts) just to re-learn
  // something we're holding in a local variable. Prototype shortcut: a
  // genuinely remote host would need the daemon's LAN-reachable address
  // instead, which isn't modelled here.
  //
  // Override via AGENTPROTO_PUBLIC_WS_ORIGIN when the daemon sits behind a
  // public reverse proxy/tunnel (e.g. a Cloudflare Quick Tunnel) — hosts
  // like Claude.ai appear to reject a `connectDomains` CSP entry pointing
  // at `ws://` + a private/loopback address outright, before ever trying
  // the WS handshake. Pointing this at the tunnel's public `wss://` origin
  // instead makes the panel's WebSocket ride the same hostname the `/mcp`
  // endpoint is already reachable on (Quick Tunnel proxies the whole port,
  // including the WS upgrade). No trailing slash expected — it's used as
  // `${origin}/sessions/:id/pty`.
  const ptyWsBaseUrl =
    process.env.AGENTPROTO_PUBLIC_WS_ORIGIN?.trim().replace(/\/+$/, "") ||
    `ws://127.0.0.1:${port}`

  const events = createRuntimeEvents()
  const conversations = fileConversationStore({ workspace })
  const workspaceFs = createWorkspaceFs({ workspace })

  // Singleton controller for "publish to the internet" state. Created
  // disabled — auth stays `mode: "none"` until `remote_enable` is
  // called. Tunnel logs flow through the events stream so `/events`
  // subscribers see cloudflared chatter.
  const remote = new RemoteController({
    workspace,
    port,
    onLog: line =>
      events.emit({
        type: "remote-log",
        at: new Date().toISOString(),
        line,
      }),
  })

  // Multi-tunnel registry — independent from RemoteController. Manages
  // the general "create a public URL for any local port" surface
  // (tunnel_create / tunnel_list / tunnel_stop MCP tools + /tunnels HTTP
  // routes). Logs flow through the same events stream.
  // Shared tunnel creds store (~/.agentproto/tunnel-creds/, 0600) — lets the
  // registry rebuild a provider that keeps its secrets off the descriptor
  // (ngrok authtoken, third-party creds) when restoring on boot / creating.
  const tunnelCredsStore = makeTunnelCredsStore()
  const tunnels = new TunnelRegistry({
    workspace,
    onLog: line =>
      events.emit({
        type: "remote-log",
        at: new Date().toISOString(),
        line,
      }),
    readCreds: slug => tunnelCredsStore.read(slug),
  })
  // Relaunch any `autostart` (named) tunnels that were live before this
  // daemon restarted. Non-blocking — boot must not wait on cloudflared,
  // and a failed restore leaves that one tunnel `error` without gating
  // the rest of the gateway.
  void tunnels.restoreOnBoot().catch(() => {
    // restoreOnBoot already logs per-tunnel failures via onLog.
  })

  // Build a server once eagerly so we can capture `registered` for
  // `/health`. The server is NOT used for serving — every `/mcp`
  // request gets its own freshly-constructed pair, mirroring the
  // SDK's official stateless pattern. See the comment on
  // `RuntimeHttpServerOptions.mcpServerFactory` for why.
  const { registered } = await createMcpServer({
    specs: opts.specs,
    workspace,
    name: opts.name ?? "agentproto-runtime",
    version: opts.version ?? "0.1.0-alpha",
  })

  // Event bus + ring for orchestration tools (session_events_poll / session_monitor).
  // Declared before the sessions registry so we can pass the bus into it.
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  // Wire the ring so every session:* event is buffered for session_events_poll.
  eventRing.wire(sessionEvents)
  // Wire the webhook notifier so per-session and global URLs are
  // notified on turn-end / awaiting-input / exited events.
  const webhookNotifier = createWebhookNotifier()
  sessionEvents.onAny(ev => webhookNotifier.onSessionEvent(ev))
  // Unregister per-session URLs on exit so the notifier map doesn't
  // leak memory across sessions.
  sessionEvents.on("session:exited", ev => {
    webhookNotifier.unregister(ev.sessionId)
  })

  // Opt-in Langfuse session tracer — built once here (shared, pure) from the
  // eval-reporter's stored langfuse creds, same store `setup_eval_reporter`
  // writes to. Absent creds ⇒ undefined, and the registry never gates
  // anything on a tracer that doesn't exist — tracing-off behaviour is
  // unchanged from before this existed.
  const configDefaults = (await loadConfig()).defaults
  const lfCreds = await makeEvalReporterCredsStore().read("langfuse").catch(() => null)
  const langfuseTracer = lfCreds
    ? langfuseSessionTracer({
        publicKey: lfCreds.publicKey,
        secretKey: lfCreds.secretKey,
        baseUrl: lfCreds.baseUrl,
        ...(lfCreds.environment ? { environment: lfCreds.environment } : {}),
        redactor: configDefaults?.traceRedactor ?? "secrets",
      })
    : undefined

  // Persistence switch for every store this gateway owns. Production
  // (and any caller that omits it) keeps today's behaviour: persist on,
  // default paths. Tests pass `persist: false` so their fakes never reach
  // the real ~/.agentproto/ — see `CreateGatewayOptions.persist`.
  const persist = opts.persist ?? true

  // Sessions registry — single instance per gateway, captured by
  // the per-request mcpServerFactory closure below + handed to
  // startHttpServer for the /sessions HTTP routes. Declared here
  // (above the factory) so its identifier is visible at closure-
  // build time, even though the factory only invokes later.
  const sessions = createSessionsRegistry({
    sessionEvents,
    persist,
    ...(opts.persistPath ? { persistPath: opts.persistPath } : {}),
    ...(opts.spawnPty ? { spawnPty: opts.spawnPty } : {}),
    ...(langfuseTracer ? { langfuseTracer } : {}),
    langfuseTracingDefault: configDefaults?.langfuseTracing ?? false,
    // Resume hook: when a prompt arrives for a dead agent-cli row
    // (typical after daemon restart), the registry calls back into
    // the adapter resolver to re-create the AgentSession with
    // `resumeSessionId = adapterSessionId`. ACP semantics: the
    // upstream provider reattaches to the prior conversation.
    // Unwired (no resolveAgentAdapter) → legacy "not an agent
    // session" error, user must spawn fresh.
    ...(opts.resolveAgentAdapter
      ? {
          resumeAgent: async ({
            adapterSlug,
            cwd,
            resumeSessionId,
            mcpServers,
            onActivity,
          }) => {
            const adapter = await opts.resolveAgentAdapter!(adapterSlug)
            if (!adapter) return null
            try {
              return await adapter.startSession({
                cwd,
                resumeSessionId,
                // Re-mount the persisted spawn-time toolset on resume
                // (orchestrator WP1) — closes the gap where re-spawn
                // dropped mcpServers.
                ...(mcpServers ? { mcpServers } : {}),
                ...(onActivity ? { onActivity } : {}),
              })
            } catch (err) {
              console.warn(
                `[agentproto] resumeAgent('${adapterSlug}', ${resumeSessionId}) failed: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
              return null
            }
          },
        }
      : {}),
  })

  // Completion-policy supervisor — watches sessions and runs shell gates.
  // Declared after `sessions` so it can resolve session cwd at gate time.
  const supervisor = createCompletionPolicySupervisor({
    registry: sessions,
    sessionEvents,
    workspace,
    persist,
    // WP6: daemon-wide cap on policies concurrently gating/acting. Excess
    // queue (FIFO) until a slot frees. Override via AGENTPROTO_POLICY_CONCURRENCY.
    concurrencyCap: (() => {
      const raw = process.env.AGENTPROTO_POLICY_CONCURRENCY
      const n = raw ? Number.parseInt(raw, 10) : NaN
      return Number.isFinite(n) && n > 0 ? n : undefined
    })(),
    // WP7: judge-agent gate spawns a short-lived agent via the same resolver
    // agent_start uses. Absent → judge gates fail-safe (FAIL).
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
  })

  // PR-provenance reconciler — stamps the `@agentproto-bot` footer onto a PR an
  // executor session opened through its OWN shell, which `command_execute` (the
  // only other stamp trigger) never observes. Subscribes to turn-end/exited and
  // resolves the session's open PR via the injected `resolveOpenPr` port. Only
  // started when the CLI wired that port; best-effort, never fails a session.
  const prReconciler = opts.resolveOpenPr
    ? createPrProvenanceReconciler({
        registry: sessions,
        sessionEvents,
        resolveOpenPr: opts.resolveOpenPr,
      })
    : undefined

  // Routine runner — singleton per daemon, shared across all MCP connections.
  // Persists run state to ~/.agentproto/routine-runs.json so runs survive
  // daemon restarts (interrupted runs are marked "failed" on load).
  // Declared after `sessions` and `supervisor` so it shares the same
  // registry + event bus. Only wired when `resolveAgentAdapter` is
  // available (routine steps need to spawn agent sessions).
  const routineRunner = opts.resolveAgentAdapter
    ? createRoutineRunner({
        registry: sessions,
        sessionEvents,
        resolveAgentAdapter: opts.resolveAgentAdapter,
        webhookNotifier,
        persist,
      })
    : undefined

  // Cron scheduler — singleton per daemon, persisted to
  // ~/.agentproto/cron-jobs.json. Jobs survive daemon restarts;
  // skipped fires during downtime are NOT backfilled (documented behaviour).
  // Declared after `sessions` so it can spawn agent sessions via the registry.
  // Agent jobs need `resolveAgentAdapter`; command jobs work without it.
  const cronScheduler = createCronScheduler({
    sessionEvents,
    registry: sessions,
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
    workspace,
    persist,
  })

  // Workflow runner — sibling primitive to routineRunner (stage-barrier
  // parallel orchestration rather than a flat sequential list). Same
  // singleton-per-daemon, same persistence pattern, own persist file
  // (~/.agentproto/workflow-runs.json) so the two run stores never collide.
  const workflowRunner = opts.resolveAgentAdapter
    ? createWorkflowRunner({
        registry: sessions,
        sessionEvents,
        resolveAgentAdapter: opts.resolveAgentAdapter,
        webhookNotifier,
        persist,
        // Sandbox-capable agent steps (`AgentStep.sandbox` / workflow_start's
        // step `sandbox`) resolve providers through the same resolver
        // `agent_start.sandbox` uses.
        resolveSandboxProvider: resolveSandboxProviderResolved,
        // Compile a loaded WORKFLOW.md handle into a runnable RuntimeWorkflow
        // for `workflow_run_file` / `startFromFile`. The daemon's workflow
        // surface is agent-step based (like the stage primitive), so no tool/
        // driver registry is wired here — `tool` steps in a WORKFLOW.md fail
        // clearly ("no tool registered") until a workflow tool registry is
        // added. Agent-step workflows compile + run.
        compileWorkflow: handle => compileWorkflow(handle, { tools: {}, candidates: [] }),
      })
    : undefined

  // Task ledger — the multi-party write-model over declared intent
  // (task-ledger.ts). Declared after `sessions` (board resolution walks
  // lineage) and `supervisor` (Tier-1 done runs its gate through the real
  // completion-policy machinery — the default gate-runner). The operator's
  // default board is `ws:<active workspace slug>`; falls back to "default"
  // when no workspace registry exists. Same persistence switch as every
  // other store this gateway owns; disposed (+ sync-flushed) in stop().
  // Declared BEFORE the Activity projector so the projector can join task
  // links (`Activity.taskId`) against the ledger's edges.
  const operatorWorkspaceSlug = await loadWorkspacesConfig()
    .then(cfg => getActiveWorkspace(cfg)?.slug)
    .catch(() => undefined)
  const taskLedger = createTaskLedger({
    registry: sessions,
    sessionEvents,
    supervisor,
    workspace,
    persist,
    ...(operatorWorkspaceSlug ? { operatorWorkspaceSlug } : {}),
  })

  // Activity projector — the unified active/pending read-model over
  // completion policies, session turns, routine/workflow steps, and opened
  // PRs (activities.ts). A projection, not a registry: `list()` recomputes
  // from the owners above on every call; the projector's only state is a
  // diff cache that powers the `activity:changed` bus event. Declared after
  // the owners it projects over; disposed in stop(). The `taskLedger` lets it
  // derive `Activity.taskId` from the ledger's edges at read time.
  const activityProjector = createActivityProjector({
    registry: sessions,
    sessionEvents,
    supervisor,
    taskLedger,
    ...(routineRunner ? { routineRunner } : {}),
    ...(workflowRunner ? { workflowRunner } : {}),
    // PR settlement port (CLI-wired, like `resolveOpenPr`) — lets a
    // pending-on-forge pr activity settle to done/cancelled once the forge
    // reports merged/closed.
    ...(opts.resolvePrState ? { resolvePrState: opts.resolvePrState } : {}),
  })

  // Per-boot bearer token. Required on mutating /sessions/* routes
  // and on the WS upgrade for /sessions/:id/pty. Persisted to
  // runtime.json (mode 0600) so the same-user CLI can read it; a
  // browser-loaded localhost page can't.
  const token = opts.token ?? randomUUID()

  // MCP proxy — single registry that holds open Client connections
  // to every imported MCP server. The per-request mcpServerFactory
  // captures it so each /mcp request reuses the same upstream
  // sessions instead of re-spawning stdio children.
  const mcpProxy = new McpProxyRegistry()

  // Inbound watcher — polls an agentpush source on a timer and spawns
  // one agent per new contact_ref. Wired when an adapter resolver is
  // available (otherwise the watcher would have nowhere to spawn).
  const inboundWatcher =
    opts.resolveAgentAdapter
      ? createInboundWatcher({
          mcpProxy,
          registry: sessions,
          resolveAgentAdapter: opts.resolveAgentAdapter,
          persist,
        })
      : undefined

  // Scope-token registry (WP2) — mints/validates the per-child tokens
  // that gate `/mcp/orchestrator` and carry each orchestrator's identity
  // (owner session, depth, tools, limits — WP4). The injector + scoped
  // factory below both close over it.
  const scopeTokens = createScopeTokenRegistry()

  // Orchestrator auto-injection (WP3). Closed over the scope-token
  // registry + the session-event bus + the HTTP port: when
  // `agent_start` is called with `orchestrator`, this mints a
  // scoped token, builds the `mcpServers` entry pointing the child at
  // `/mcp/orchestrator?scope=<token>` on the daemon's own loopback
  // port, and revokes the token on the child's `session:exited`. The
  // port is the daemon's configured listener port (`startHttpServer`
  // binds `opts.port` directly), reachable by the co-located child
  // over loopback.
  // The injected entry is named "agentproto" (the default) so the
  // child's orchestration tools surface under a stable namespace,
  // independent of the daemon's advertised server name.
  // Defined BEFORE the scoped factory so the factory can hand it to the
  // scoped server's `agent_start` — that's what lets a child
  // orchestrator recursively spawn its OWN sub-orchestrators (WP4),
  // bounded by depth/quota/tools inheritance.
  const orchestratorInjector = createOrchestratorInjector({
    scopeTokens,
    sessionEvents,
    port,
    // WP-B: when an orchestrator session exits/is killed, reap its live
    // descendants (SIGTERM via the same `registry.kill` path `agent_kill`
    // uses) alongside the scope-token revocation that already fires here —
    // no orphaned children left running under a dead parent.
    reapChildren: parentSessionId => {
      const reaped = reapOrphanedDescendants(sessions, parentSessionId)
      if (reaped.length > 0) {
        console.warn(
          `[orchestrator] reaped ${reaped.length} orphaned ` +
            `${reaped.length === 1 ? "child" : "children"} of exited ` +
            `session ${parentSessionId}: ${reaped.join(", ")}`,
        )
      }
    },
  })

  // Scoped orchestrator sub-gateway (WP2). The scope-token registry
  // mints/validates per-child tokens; the factory builds a scoped MCP
  // server exposing only the curated orchestration subset for a verified
  // scope. Mounted by the HTTP server at `/mcp/orchestrator` (no
  // loopback bypass — token required). The verified scope is also the
  // calling orchestrator's identity, so the scoped server enforces the
  // WP4 depth/quota guards + subtree scoping against it.
  const orchestratorMcpServerFactory = createOrchestratorMcpServerFactory({
    workspace,
    name: opts.name ?? "agentproto-runtime",
    version: opts.version ?? "0.1.0-alpha",
    registry: sessions,
    sessionEvents,
    eventRing,
    supervisor,
    taskLedger,
    orchestratorInjector,
    webhookNotifier,
    daemonMcpUrl,
    // Same resolver the root /mcp gateway threads into registerSessionTools
    // (below) — so a child spawned THROUGH the scoped orchestrator gateway
    // can declare `sandbox` and resolve a provider, instead of throwing
    // `sandbox_provider_not_found`.
    resolveSandboxProvider: resolveSandboxProviderResolved,
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
    ...(opts.listAgentAdapters
      ? { listAgentAdapters: opts.listAgentAdapters }
      : {}),
  })

  const mcpServerFactory = async (
    denyTools?: ReadonlySet<string>,
    callerSessionId?: string,
  ) => {
    const { server: rawServer } = await createMcpServer({
      specs: opts.specs,
      workspace,
      name: opts.name ?? "agentproto-runtime",
      version: opts.version ?? "0.1.0-alpha",
    })
    // Deferred/lazy tool loading (opt-in — see deferred-tools.ts). Wraps
    // every subsequent `registerXTools(server, ...)` pass below so tools
    // outside `alwaysOn` register but start disabled (hidden from the
    // first `tools/list`) until `tool_search` pulls them in. Omitted →
    // `server` is the raw, fully-eager gateway, today's behaviour.
    let server = opts.deferredTools
      ? withDeferredTools(rawServer, { alwaysOn: new Set(opts.deferredTools.alwaysOn ?? DEFAULT_ALWAYS_ON_TOOLS) })
      : rawServer
    // Spawn-role-profiles tool gate (the hard part of the executor/
    // supervisor primitive — see role.ts). Per-request denylist parsed
    // from `?denyTools=a,b` on THIS `/mcp` call (see `handleMcp` in
    // http-server.ts) — outermost wrap so it wins over deferred-tools
    // unconditionally: an excluded name never reaches registration at
    // all, regardless of `alwaysOn`.
    if (denyTools && denyTools.size > 0) {
      server = withToolExclusion(server, denyTools)
    }
    // Canonical filesystem tools so remote MCP clients (cloud
    // workspace-providers, IDEs, ad-hoc tooling) can read/write the
    // workspace without each implementing AIP-aware glue. Names match
    // `@modelcontextprotocol/server-filesystem` for drop-in compat.
    registerFsTools(server, { workspace })
    // Cheap, read-only liveness probe. Registered early so it is available
    // even when deferred tools hide the rest of the surface.
    registerDaemonHealthTools(server, { workspace, registered, startedAt })
    // Subprocess execution — the runtime's superpower for cloud
    // agents. Any allowlisted CLI on the user's machine (claude, gh,
    // pnpm, …) is reachable via `command_execute`. Allowlist lives at
    // `.agentproto/allowed-commands.json`; default-deny. `callerSessionId`
    // (PR 7 / Gap 7) comes from THIS request's `?callerSessionId=` query
    // param — set when the caller is an agent session spawned with the
    // daemon's own self-ref `mcpServers` entry (see `session-spawn.ts`) —
    // and is recorded on every command session this request mints.
    registerCommandTools(server, {
      workspace,
      registry: sessions,
      ...(callerSessionId ? { callerSessionId } : {}),
    })
    // Remote-tunnel lifecycle. The controller is a singleton on the
    // gateway, so registering its tools per-request is just rebinding
    // the same closures — the underlying state lives in `remote`.
    registerRemoteTools(server, { controller: remote })
    // E2E daemon-pairing tools (pair_offer / pair_list / pair_revoke) — only
    // when a pairing registry was wired. Same closure-rebind pattern as the
    // remote tools above; the registry singleton lives on the gateway.
    if (opts.pairingRegistry) {
      registerPairingTools(server, { registry: opts.pairingRegistry })
    }
    // Agent-session orchestration — operators (Mastra agents in
    // cloud Guilde, Claude Code as a sub-agent, …) drive long-running
    // claude/hermes/aider sessions on the user's machine through
    // these MCP tools. The registry + adapter resolver are
    // singletons on the gateway, same closure-rebind pattern.
    registerSessionTools(server, {
      registry: sessions,
      mcpProxy,
      ptyEnabled: opts.spawnPty != null,
      buildOrchestratorMcp: orchestratorInjector,
      webhookNotifier,
      daemonMcpUrl,
      resolveSandboxProvider: resolveSandboxProviderResolved,
      ...(opts.provisionWorktree ? { provisionWorktree: opts.provisionWorktree } : {}),
      ...(opts.resolveAgentAdapter
        ? { resolveAgentAdapter: opts.resolveAgentAdapter }
        : {}),
      ...(opts.listAgentAdapters
        ? { listAgentAdapters: opts.listAgentAdapters }
        : {}),
      ...(opts.installAgentAdapter
        ? { installAgentAdapter: opts.installAgentAdapter }
        : {}),
      ...(opts.listCatalogModels
        ? { listCatalogModels: opts.listCatalogModels }
        : {}),
      ...(opts.listWorktreeStatuses
        ? { listWorktreeStatuses: opts.listWorktreeStatuses }
        : {}),
      ...(opts.runWorktreeGc ? { runWorktreeGc: opts.runWorktreeGc } : {}),
    })
    // Named auth-profile lifecycle (auth_profile_create/delete/list). No
    // host wiring — `@agentproto/auth` reads/writes the fixed
    // `~/.agentproto/auth-profiles.json` + keychain slots directly, same as
    // the profile readers already mounted in session-spawn.ts.
    registerAuthProfileTools(server)
    registerBrowserTools(server, {
      registry: sessions,
      ...(opts.resolveBrowserAdapter
        ? { resolveBrowserAdapter: opts.resolveBrowserAdapter }
        : {}),
      ...(opts.listBrowserAdapters
        ? { listBrowserAdapters: opts.listBrowserAdapters }
        : {}),
    })
    registerOrchestrationTools(server, {
      registry: sessions,
      sessionEvents,
      eventRing,
      supervisor,
      activityProjector,
      taskLedger,
      ...(routineRunner ? { routineRunner } : {}),
      ...(workflowRunner ? { workflowRunner } : {}),
      ...(inboundWatcher ? { inboundWatcher } : {}),
      cronScheduler,
    })
    // MCP Apps — agentproto_sessions panel via the AgnoMcpApp adapter.
    // Tool: agentproto_sessions  Resource: ui://agentproto_sessions/view
    const listSessionsFiltered = (filter?: "running" | "all") => {
      // `kind:"command"` rows are a shell-execution log, not a resumable
      // session — every consumer of this (sessions/agents-overview/bureau/
      // session-story panels) either wants the live-able agent/PTY set or
      // filters to a specific non-command kind of its own, so they're
      // excluded here too, matching `session_list`'s default-view semantics.
      let rows = sessions.list().filter(s => s.kind !== "command")
      if (filter === "running") {
        rows = rows.filter(s => s.status === "running" || s.status === "starting")
      }
      return rows
    }
    registerMcpApps(server, [
      makeSessionsPanelApp({ listSessions: listSessionsFiltered }),
      makeAgentsOverviewApp({ listSessions: listSessionsFiltered }),
      makeBureauSessionsApp({ listSessions: listSessionsFiltered }),
      makeSessionStoryPanelApp({ listSessions: listSessionsFiltered }),
      // Same ptyEnabled gate as terminal_start/terminal_input/… in
      // session-tools.ts — the panel would be able to open the WS but
      // every spawn/attach would fail once node-pty isn't available, so
      // just don't register the tool/resource at all in that case.
      ...(opts.spawnPty != null
        ? [
            makeTerminalPanelApp({
              wsBaseUrl: ptyWsBaseUrl,
              ...(token ? { token } : {}),
              async spawnOrAttach(input) {
                if (input.sessionId) {
                  const desc = sessions.findByIdOrName(input.sessionId)
                  if (!desc) {
                    throw new Error(
                      `agentproto_terminal: no session "${input.sessionId}"`,
                    )
                  }
                  if (desc.pty !== true) {
                    throw new Error(
                      `agentproto_terminal: session "${input.sessionId}" is not a PTY session`,
                    )
                  }
                  return { sessionId: desc.id }
                }
                let cwd = input.cwd
                let resolvedSlug = input.workspaceSlug ?? "default"
                if (!cwd) {
                  const config = await loadWorkspacesConfig()
                  const ws = input.workspaceSlug
                    ? findWorkspace(config, input.workspaceSlug)
                    : getActiveWorkspace(config)
                  if (ws) {
                    cwd = ws.path
                    resolvedSlug = ws.slug
                  }
                }
                if (!cwd) cwd = workspace
                const desc = sessions.spawnPty({
                  argv: input.argv && input.argv.length > 0 ? input.argv : ["bash"],
                  cwd,
                  workspaceSlug: resolvedSlug,
                  cols: input.cols ?? 80,
                  rows: input.rows ?? 24,
                })
                return { sessionId: desc.id }
              },
            }),
          ]
        : []),
    ])
    // Server-side per-session summariser backing the agents-overview panel.
    // Heuristic today (no LLM in @agentproto/runtime) — see agents-overview-app.ts.
    registerSummarizeSessionTool(server, {
      getSession: (id) => sessions.get(id),
      tailLines: (id, lastN) => {
        // Same source as agent_output: attach replays the ring
        // buffer synchronously, then we unsubscribe immediately.
        const lines: string[] = []
        const unsub = sessions.attach(id, (line) => { lines.push(line) })
        if (unsub) unsub()
        return lines.slice(-lastN)
      },
    })
    // Transcript exporter — reads the adapter's native persistence
    // (claude-code JSONL / hermes SQLite) and renders a clean markdown or
    // JSON transcript. Co-located with the session tools; registry access
    // mirrors the summarise_session pattern above.
    registerExportSessionTool(server, { registry: sessions })
    // Conversation reader — works on ANY session kind (agent-cli or PTY):
    // discovers the provider-native conversation behind a session instead
    // of requiring one already recorded on the descriptor. Co-located with
    // the tools above; same registry-access pattern.
    registerConversationReadTool(server, { registry: sessions })
    // Multi-tunnel tools — same closure-rebind pattern.
    registerTunnelTools(server, { registry: tunnels })
    // Tunnel adapter introspection/setup, riding on @agentproto/provider-kit
    // (list_tunnel_adapters + setup_tunnel_provider). Stateless wrt the
    // gateway — creds/ledger live under ~/.agentproto.
    await registerTunnelAdapterTools(server, {})
    // Sandbox adapter introspection/setup, riding on @agentproto/provider-kit
    // (list_sandbox_providers + setup_sandbox_provider) — same resolver
    // `agent_start.sandbox` resolves slugs through above.
    await registerSandboxAdapterTools(server, {
      resolveSandboxProvider: resolveSandboxProviderResolved,
      ...(opts.listSandboxProviders
        ? { listSandboxProviders: opts.listSandboxProviders }
        : {}),
    })
    // Eval-reporter introspection/setup, riding on @agentproto/eval-reporters
    // (list_eval_reporters + setup_eval_reporter). Credentials live 0600 under
    // ~/.agentproto and are never exposed by the list tool.
    registerEvalReporterTools(server)
    // Provider-gateway preset introspection (list_provider_presets), riding on
    // @agentproto/provider-presets via the thin honest lister. Static data —
    // no install/setup/creds; status is key-env presence in this process.
    // Stage 4: thread loaded adapters' manifest-declared `presets` (AIP-45)
    // into `adapterPresets` here so adapter-contributed gateways surface in
    // the catalog. Today the seam exists and is tested but is passed none.
    registerPresetTools(server)
    return server
  }

  // ── boot ─────────────────────────────────────────────────────────
  if (opts.boot !== false) {
    await runBoot(workspace, opts, conversations, events).catch((err) => {
      events.emit({
        type: "heartbeat-error",
        at: new Date().toISOString(),
        agent: opts.defaultBootAgent,
        error: `BOOT.md failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    })
  }

  const heartbeat = startHeartbeat({
    workspace,
    conversations,
    events,
    buildAgent: opts.buildAgent ?? noopBuildAgent,
  })

  const http = await startHttpServer({
    port,
    bind: opts.bind,
    // Auth is read on every request via this getter. `opts.auth`
    // (when provided) is the startup default and represents the
    // operator's intent — bearer-only deployments stay bearer-only
    // even when no remote tunnel is up. The controller's auth wins
    // once a tunnel is enabled (it issues a fresh token); on disable
    // we fall back to `opts.auth` if set, otherwise `mode: "none"`.
    auth: () => {
      const remoteAuth = remote.readAuth()
      if (remoteAuth.mode === "bearer") return remoteAuth
      return opts.auth ?? { mode: "none" }
    },
    mcpServerFactory,
    orchestratorMcpServerFactory,
    verifyOrchestratorScope: scopeTokens.verify,
    conversations,
    events,
    heartbeat,
    sessions,
    mcpProxy,
    token,
    ptyEnabled: opts.spawnPty != null,
    tunnels,
    ...(opts.pairingRegistry ? { pairings: opts.pairingRegistry } : {}),
    sessionEvents,
    eventRing,
    supervisor,
    activityProjector,
    taskLedger,
    ...(routineRunner ? { routineRunner } : {}),
    ...(workflowRunner ? { workflowRunner } : {}),
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.strictOrigins ? { strictOrigins: true } : {}),
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
    // Same injector + gateway URL passed to `registerAgentTools` above —
    // lets POST /sessions/agent mint the same scoped orchestrator
    // sub-gateway + hermes default-mcpServers safety net the MCP
    // `agent_start` tool gets (session-spawn.ts is the shared logic).
    buildOrchestratorMcp: orchestratorInjector,
    daemonMcpUrl,
    ...(opts.provisionWorktree ? { provisionWorktree: opts.provisionWorktree } : {}),
    ...(opts.listAgentAdapters
      ? { listAgentAdapters: opts.listAgentAdapters }
      : {}),
    ...(opts.installAgentAdapter
      ? { installAgentAdapter: opts.installAgentAdapter }
      : {}),
    ...(opts.listCatalogModels
      ? { listCatalogModels: opts.listCatalogModels }
      : {}),
    ...(opts.listWorktreeStatuses
      ? { listWorktreeStatuses: opts.listWorktreeStatuses }
      : {}),
    ...(opts.runWorktreeGc ? { runWorktreeGc: opts.runWorktreeGc } : {}),
    ...(opts.resolveBrowserAdapter
      ? { resolveBrowserAdapter: opts.resolveBrowserAdapter }
      : {}),
    ...(opts.listBrowserAdapters
      ? { listBrowserAdapters: opts.listBrowserAdapters }
      : {}),
    meta: { workspace, registered, startedAt },
    cronScheduler,
  })

  heartbeat.start()
  events.emit({
    type: "boot",
    at: new Date().toISOString(),
    workspace,
    registered,
  })

  // Record a snapshot of the running config so external tooling /
  // shell users can introspect a live gateway via
  // `cat <workspace>/.agentproto/runtime.json`. Best-effort — failure
  // here doesn't gate the gateway being functional.
  void writeRuntimeMeta(workspace, {
    workspace,
    port,
    bind: opts.bind ?? "127.0.0.1",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    name: opts.name ?? "agentproto-runtime",
    registered,
    token,
  })

  return {
    url: http.url,
    workspace,
    workspaceFs,
    registered,
    sessions,
    tunnels,
    ...(opts.pairingRegistry ? { pairing: opts.pairingRegistry } : {}),
    token,
    mintOrchestratorScope: scopeTokens.mint,
    async stop() {
      heartbeat.stop()
      // Flush inbound-watcher cursor state before sessions shut down.
      inboundWatcher?.shutdown()
      // Stop the cron scheduler tick loop before sessions shut down.
      cronScheduler.shutdown()
      // Flush completion-policy state before sessions shut down so
      // policies referencing live sessions are persisted with their
      // current status (not "killed" sessions).
      supervisor.shutdown()
      // Detach the PR-provenance reconciler's bus subscriptions.
      prReconciler?.dispose()
      // Detach the activity projector's bus subscription + diff cache.
      activityProjector.dispose()
      // Detach the task ledger's bus subscription + sync-flush tasks.json
      // (same debounce-then-flush contract as supervisor.shutdown()).
      taskLedger.dispose()
      // Kill all live sessions before tearing down HTTP — otherwise
      // long-running children inherit the daemon's listening socket
      // and stay around as zombies after the parent exits.
      sessions.shutdown()
      // Tear down pairing rendezvous connections + served channels before HTTP
      // so no half-open E2E channel outlives the gateway it forwards to.
      if (opts.pairingRegistry) {
        await opts.pairingRegistry.shutdown().catch(() => {})
      }
      // Close upstream MCP clients (their stdio children would
      // otherwise leak the same way).
      await mcpProxy.closeAll()
      // Stop all active tunnels (TunnelRegistry) then the remote
      // controller's single-gateway tunnel. Both before HTTP so
      // cloudflared doesn't briefly proxy to a dead port.
      await tunnels.shutdown()
      await remote.shutdown()
      await http.stop()
    },
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const noopBuildAgent: BuildHeartbeatAgent = async () => null

async function runBoot(
  workspace: string,
  opts: CreateGatewayOptions,
  conversations: import("./conversations.js").ConversationStore,
  events: import("./events.js").RuntimeEvents,
): Promise<void> {
  const path = join(workspace, "BOOT.md")
  if (!existsSync(path)) return
  const body = (await readFile(path, "utf8")).trim()
  if (!body) return
  if (!opts.buildAgent || !opts.defaultBootAgent) return

  const agent = await opts.buildAgent(opts.defaultBootAgent)
  if (!agent) return

  const conversationId = `boot-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}`
  await conversations.open(conversationId, { agent: opts.defaultBootAgent })
  await conversations.appendTurn(conversationId, "user", body, {
    attribution: "boot",
  })
  const reply = await agent.generate(body)
  await conversations.appendTurn(conversationId, "assistant", reply.text, {
    attribution: opts.defaultBootAgent,
  })
  events.emit({
    type: "heartbeat-fired",
    at: new Date().toISOString(),
    agent: opts.defaultBootAgent,
    conversationId,
    prompt: body,
    reply: reply.text,
    durationMs: 0,
  })
}
