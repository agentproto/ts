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
  registerConversationLocateTool,
  registerConversationExportTool,
} from "./session-tools.js"
import { registerBrainTools } from "./brain-tools.js"
import { createWorkspaceBrains } from "./workspace-brains.js"
import { createWorkspaceBrainSubscriber } from "./workspace-brain-subscriber.js"
import {
  registerBrowserTools,
  type BrowserAdapterResolver,
  type BrowserAdapterLister,
} from "./browser-tools.js"
import { registerAuthProfileTools } from "./auth-profile-tools.js"
import { registerHarnessPresetTools } from "./harness-preset-tools.js"
import { registerCredentialDiscoveryTools } from "./credential-discovery.js"
import { registerMcpApps } from "./mcp-apps-adapter.js"
import { makeBuiltinPanelApps } from "./builtin-apps.js"
import { registerSummarizeSessionTool } from "./summarize-session-tool.js"
import { makeTerminalPanelApp } from "./terminal-panel-app.js"
import { registerAppPullTools } from "./app-pull-tools.js"
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
  type AdapterCapabilitiesLister,
} from "./http-server.js"
import {
  createSessionsRegistry,
  SESSION_ID_ENV,
  WORKSPACE_SLUG_ENV,
  type SessionsRegistry,
  type SessionDescriptor,
  type PtyFactory,
} from "./sessions.js"
import { runEagerResumePass, type EagerResumeSummary } from "./eager-resume.js"
import { runIdleReapPass, type IdleReapSummary } from "./idle-reaper.js"
import { runCrashDetectPass } from "./crash-reaper.js"
import { runStallWatchdogPass } from "./stall-watchdog.js"
import { createRestartScheduler, runRestartSweepPass } from "./restart-scheduler.js"
import { loadConfig } from "./config.js"
import { resolveResumeAuth, restartAgentSession } from "./session-restart-core.js"
import { createTransmitterBindingStore } from "./transmitter-bindings.js"
import { createInboundEndpointStore } from "./inbound-endpoints.js"
import { routeInboundMessage } from "./inbound-router.js"
import { makeTelegramBotCredsStore, registerTelegramBotTools } from "./telegram-bot-creds.js"
import type { InboundMessage, InboundRouteMode } from "./inbound-router.js"
import { langfuseSessionTracer } from "./langfuse-session-tracer.js"
import { makeEvalReporterCredsStore } from "@agentproto/eval-reporters"
import { McpProxyRegistry } from "./mcp-proxy.js"
import { registerOrchestrationTools } from "./orchestration-tools.js"
import { registerAppTools, resolveAgentRefsForWorkflow, performInstall } from "./app-tools.js"
import { registerAppDataTools } from "./app-data.js"
import { APP_STATE_APPEND_TOOL_NAME } from "./app-state.js"
import { registerAppExternalTools } from "./app-external.js"
import { createAppRegistry } from "./app-registry.js"
import { makeInstalledAppUiApps, createUiHtmlCache } from "./app-ui-apps.js"
import { createSessionEventBus } from "./session-event-bus.js"
import { createEventRing } from "./event-ring.js"
import { createWebhookNotifier } from "./webhook-notifier.js"
import { createWorkflowRunner } from "./workflow-runner.js"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { createFileStepCache } from "./workflow-step-cache.js"
import { withDeferredTools } from "./deferred-tools.js"
import { withToolExclusion } from "./tool-subset.js"
import { createCompletionPolicySupervisor } from "./supervisor.js"
import { createPrProvenanceReconciler, type OpenPrResolver } from "./pr-provenance-reconciler.js"
import { createActivityProjector, type PrStateResolver } from "./activities.js"
import { createTaskLedger } from "./task-ledger.js"
import { wireSupervisorNotify } from "./supervisor-notify.js"
import { createInboundWatcher } from "./inbound-watcher.js"
import { createCronScheduler } from "./cron-scheduler.js"
import { createRoutineRegistrar } from "./routine-registrar.js"
import { createDaemonToolRegistry } from "./workflow-tool-registry.js"
export type {
  WatcherStartInput,
  WatcherDescriptor,
  InboundWatcher,
} from "./inbound-watcher.js"
export type {
  InboundMessage,
  InboundRouteMode,
  InboundRouterDeps,
  InboundEnqueuePrompt,
  InboundIsSessionAlive,
  InboundRestartSession,
  InboundSpawnForContact,
  InboundRouterLog,
} from "./inbound-router.js"
export type { TransmitterBinding, TransmitterBindingStore } from "./transmitter-bindings.js"
export {
  createInboundEndpointStore,
  type InboundEndpoint,
  type InboundEndpointStore,
  type InboundEndpointStoreOptions,
} from "./inbound-endpoints.js"
export {
  normalizeInbound,
  verifyInboundSignature,
  type InboundProvider,
  INBOUND_PROVIDERS,
  type NormalizeInboundResult,
} from "./inbound-adapters.js"
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
  AdapterCapabilitiesLister,
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
  WorktreeGcReclaimReason,
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
  ActivityWorkflowLister,
  PrStateResolver,
} from "./activities.js"
export { registerBrainTools } from "./brain-tools.js"
export type { RegisterBrainToolsOptions } from "./brain-tools.js"
export { createWorkspaceBrains, readSessionForBrain } from "./workspace-brains.js"
export type { WorkspaceBrains } from "./workspace-brains.js"
export {
  createWorkspaceBrainSubscriber,
  type WorkspaceBrainSubscriber,
  type WorkspaceBrainSubscriberOptions,
} from "./workspace-brain-subscriber.js"
export type { BrainManager, BrainStats, IngestResult, IngestReport } from "@agentproto/workspace-brain"
export {
  policyToActivities,
  turnToActivities,
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
  harnessPresetsPath,
  loadHarnessPresets,
  listHarnessPresets,
  getHarnessPreset,
  getDefaultHarnessPreset,
  addHarnessPreset,
  updateHarnessPreset,
  removeHarnessPreset,
  setDefaultPreset,
  HarnessPresetValidationError,
} from "./harness-preset-store.js"
export type {
  HarnessPreset,
  HarnessPresetsFile,
  HarnessPresetValidationDeps,
} from "./harness-preset-store.js"
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
// NOTE: as of this export, `registerBuiltinRoutes` is `async` (it now also
// loads operator routes from `~/.agentproto/routes.json`). Callers MUST
// `await` it — an un-awaited call will silently skip operator-route loading.
export { registerBuiltinRoutes } from "./builtin-routes.js"
export {
  buildCatalogProviderModels,
  type CatalogProviderModelsQuery,
  type CatalogProviderModelsResponse,
  type CatalogProviderModel,
  type CatalogProviderPricing,
} from "./catalog-provider-models.js"
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
export {
  attachSandbox,
  buildMcpConfigSnippet,
  registerSandboxAttachTool,
  type AttachSandboxOpts,
  type AttachSandboxResult,
  type SandboxConnectionDescriptor,
} from "./sandbox-attach.js"
export type {
  AgentSessionLike,
  AgentStreamEvent,
  SessionDescriptor,
  SessionCurrentPhase,
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
// Value export (a class, used with `instanceof` at the HTTP/MCP boundary and by
// PR-4's eager pass) — not a type-only export like the block above.
export { ResumeDisabledError } from "./sessions.js"
// Session identity env var names injected into every spawned process
// (assigned last, after caller-supplied env, so they cannot be forged).
export { SESSION_ID_ENV, WORKSPACE_SLUG_ENV } from "./sessions.js"
export type {
  EagerResumeOutcome,
  EagerResumeSkipReason,
  EagerResumeFailReason,
} from "./sessions.js"
export { runEagerResumePass, type EagerResumeSummary } from "./eager-resume.js"
export {
  runIdleReapPass,
  type IdleReapSummary,
  type IdleReaperRegistry,
} from "./idle-reaper.js"
export {
  runCrashDetectPass,
  type CrashDetectSummary,
  type CrashReaperRegistry,
} from "./crash-reaper.js"
export {
  runStallWatchdogPass,
  type StallWatchdogSummary,
  type StallWatchdogRegistry,
} from "./stall-watchdog.js"
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
export { parseWindow, rollupUsage } from "./usage-rollup.js"
export type {
  UsageSnapshotRecord,
  SessionSnapshots,
  UsageBucket,
  UsageRollup,
} from "./usage-rollup.js"
// Phase-2: best-effort per-provider live remaining-quota enrichment.
export {
  AnthropicRemainingQuotaReader,
  parseAnthropicRateLimitHeaders,
} from "./remaining-quota.js"
export type {
  RemainingQuota,
  QuotaReadableProfile,
  RemainingQuotaReader,
  AnthropicReaderConfig,
} from "./remaining-quota.js"
export {
  loadQuotaStore,
  readProfileQuota,
  recordProfileQuota,
} from "./remaining-quota-store.js"
export type { StoredProfileQuota, QuotaStoreFile, QuotaStoreOptions } from "./remaining-quota-store.js"
export {
  enrichWithRemainingQuota,
  enrichRollupWithProviderQuota,
} from "./usage-rollup-service.js"
export { readUsageSnapshots } from "./usage-snapshot-log.js"
import { RemoteController } from "./remote-controller.js"
import { registerRemoteTools } from "./remote-tools.js"
import { registerPairingTools } from "./pairing-tools.js"
import type { PairingRegistry } from "./pairing-registry.js"
import { registerDaemonHealthTools } from "./daemon-health-tools.js"
import { TunnelRegistry } from "./tunnel-registry.js"
import { registerTunnelTools } from "./tunnel-tools.js"
import { LlmEndpointRegistry } from "./llm-endpoint-registry.js"
import { registerLlmEndpointTools } from "./llm-endpoint-tools.js"
import { registerBuiltinRoutes } from "./builtin-routes.js"
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
import { registerSandboxAttachTool } from "./sandbox-attach.js"
import type { WorktreeProvisioner, WorktreeAutoReclaimer } from "./worktree-isolation.js"
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
  WorktreeAutoReclaimer,
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
  buildRouteAwareLaunchConfig,
  type RouteAwareLaunchConfig,
  type RouteAwareLaunchConfigInput,
} from "./launch-config.js"
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
  /** Opt-in eager resume-on-boot (§5 "Opt-in vs automatic", PR-4). Mirrors the
   *  `daemon.resumeSessionsOnBoot` config knob; the CLI resolves the knob and
   *  passes it here. When true, the `resumeSessionsOnBoot()` handle method
   *  actually runs the bounded boot pass; when false/omitted it short-circuits
   *  to an `enabled: false` summary. Also surfaced in `daemon_health` /
   *  `GET /health` so an operator can see the effective value. */
  resumeSessionsOnBoot?: boolean
  /** Idle agent-session reaper threshold in ms (PR-6). Mirrors the
   *  `daemon.idleReapAfterMs` config knob; the CLI resolves it (env >
   *  config > off) and passes it here. When positive, the gateway starts a
   *  periodic sweep that retires agent-cli sessions idle longer than this
   *  (SIGTERM the adapter child, flip to `killed`/`endedReason:"idle-reaped"`,
   *  kept lazy-resumable). Unset / 0 / negative ⇒ the reaper never runs.
   *  Surfaced in `daemon_health` / `GET /health`. */
  idleReapAfterMs?: number
  /** Crash-detect sweep interval in ms (crash-detect PR-1). Mirrors the
   *  `daemon.crashDetectIntervalMs` config knob; the CLI resolves it (env >
   *  config > a sane default — DEFAULT ON, unlike `idleReapAfterMs`) and
   *  passes it here. The gateway starts a periodic sweep that probes every
   *  live agent-cli session's OS process and marks the row `error`/
   *  `endedReason:"crashed"` when it's provably gone
   *  (`registry.markCrashed`, driven by `runCrashDetectPass`). Non-positive ⇒
   *  the sweep never runs. Surfaced in `daemon_health` / `GET /health`. */
  crashDetectIntervalMs?: number
  /** Restart-scheduler sweep interval in ms (restart-scheduler PR-2). Mirrors
   *  the `daemon.restartSweepIntervalMs` config knob; the CLI resolves it
   *  (env > config > off) and passes it here. OFF by default — unlike
   *  `crashDetectIntervalMs`, a positive value here doesn't itself opt any
   *  session in, it only arms the periodic sweep that EXECUTES an already-
   *  scheduled restart for a session that carries a per-session
   *  `restartPolicy` (`agent_start.restartPolicy`). The event-driven half
   *  that SCHEDULES a restart (`createRestartScheduler`, subscribing to
   *  `session:exited`) runs regardless of this knob — it just has nothing to
   *  execute against until the sweep is armed. Non-positive / undefined ⇒
   *  the sweep never runs, so a scheduled `nextRestartAt` sits inert.
   *  Surfaced in `daemon_health` / `GET /health`. */
  restartSweepIntervalMs?: number
  /** Turn-liveness watchdog threshold in ms (turn-liveness-watchdog
   *  chantier). Mirrors the `daemon.turnStallAfterMs` config knob; the CLI
   *  resolves it (env > config > a sane default — DEFAULT ON, same shape as
   *  `crashDetectIntervalMs`) and passes it here. The gateway starts a
   *  periodic sweep that flags a BUSY agent-cli session mid-turn, not
   *  legitimately `blockedOn` a subagent/command, and silent past this
   *  threshold: stamps `stalledSinceMs` and emits `session:stalled`
   *  (`registry.markStalled`, driven by `runStallWatchdogPass`). Non-positive
   *  ⇒ the sweep never runs. Detects only; never kills or restarts. Surfaced
   *  in `daemon_health` / `GET /health`. */
  turnStallAfterMs?: number
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
  /** Build identity of the binary actually serving — surfaced verbatim via
   *  `/health` and `daemon_health` so an operator can tell a workspace dist
   *  from the published tarball of the same version. `sha`/`builtAt` are
   *  stamped into the CLI at build time (tsup `define`); `source` is the
   *  serve command's runtime judgement of where its own entry lives. */
  build?: {
    /** Short git sha of the checkout the dist was built from ("" when the
     *  build ran outside git). */
    sha?: string
    /** ISO timestamp of the build. */
    builtAt?: string
    /** "workspace" (a checkout's dist), "published" (npm/npx install), or
     *  "unknown". */
    source?: string
  }
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
  /** Optional harness capability-discovery lister — when provided, enables
   *  the `harness_capabilities` MCP tool so callers can introspect what an
   *  installed adapter can actually DO on this host (creds present,
   *  reachable providers, model-discovery mechanism, endpoint compat,
   *  application contract), not just its static manifest fields. */
  listHarnessCapabilities?: AdapterCapabilitiesLister
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
   *  sibling `policies.json` / `cron-jobs.json` / `workflow-runs.json`):
   *  those paths resolve off `homedir()`, and the gateway opted each store
   *  into persistence unconditionally. Since `loadHistorySnapshot` re-reads
   *  sessions.json at boot, the real daemon then restores the fakes and
   *  shows them in the dashboard — and against `HISTORY_CAP` (200) they
   *  evict genuine history.
   *
   *  The sibling stores already default to persist-off when constructed
   *  directly (see `createWorkflowRunner`); this knob is what lets a
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
   * Optional best-effort exit-time reclaim of ONE policy-provisioned
   * (implicit) session's own worktree — powers `SessionDescriptor.
   * worktreeAutoProvisioned` (see that field's doc in `sessions.ts`).
   * Injected for the same reason as `runWorktreeGc`: the classify/remove
   * logic runs over `@agentproto/worktree`, a dependency the runtime
   * deliberately does NOT take. The CLI wires it (over `reclaimOneWorktree`).
   * Omitted → exit-time auto-reclaim is simply skipped; an implicit
   * worktree is still reclaimable manually or via a scheduled `gc` sweep.
   */
  runWorktreeAutoReclaim?: WorktreeAutoReclaimer
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
  /** Enable the local LLM Endpoint proxy sidecar (route registration,
   *  MCP tools, child-process lifecycle). Default false — the endpoint is
   *  an opt-in feature; when off, the `llm-endpoint` custom route is not
   *  registered and the `llm_endpoint_*` MCP tools are not exposed. */
  llmEndpoint?: boolean
}

/**
 * Default always-on set when `deferredTools` is enabled without an
 * explicit `alwaysOn` override: the core spawn/drive/observe loop most
 * sessions need immediately. Everything else (fs_*, directory_*,
 * command_*, remote_*, browser_*, terminal_*, mcp_*, routine_*,
 * workflow_*, policy_*, inbound_watcher_*, session_tree, agent_export,
 * adapter_list, ...) starts deferred.
 */
/** Default crash-detect sweep interval (crash-detect PR-1) when
 *  `crashDetectIntervalMs` is left unset — detection is default-on, so this
 *  is what actually arms the sweep for the common case of a caller never
 *  touching the knob. 30s is frequent enough to notice a crashed parked
 *  session promptly without meaningfully taxing an idle daemon. */
const DEFAULT_CRASH_DETECT_INTERVAL_MS = 30_000

/** Default turn-liveness watchdog threshold (turn-liveness-watchdog
 *  chantier) when `turnStallAfterMs` is left unset — detection is
 *  default-on, same reasoning as `DEFAULT_CRASH_DETECT_INTERVAL_MS`. 5
 *  minutes is generous enough that a slow-starting turn or a burst of
 *  legitimate thinking time never trips it, while still catching a dead
 *  stream long before the 36-minute silence that motivated this chantier. */
const DEFAULT_TURN_STALL_AFTER_MS = 5 * 60_000

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
  "app_tool_call",
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
  /** Run the opt-in eager resume-on-boot pass (§5, PR-4) and return its tally.
   *  A no-op returning `{ enabled: false, ... }` when the
   *  `resumeSessionsOnBoot` config knob is off. The caller (serve.ts) invokes
   *  this AFTER the stale-runtime sweeps — which is after `createGateway`
   *  returned, hence after the supervisor was re-armed (§5 "Event ordering") —
   *  and turns the summary into the boot-banner line. `isServed` is the
   *  cross-process gate: serve.ts supplies a predicate that keeps a daemon from
   *  resuming a sibling daemon's workspace rows out of the shared buckets. */
  resumeSessionsOnBoot(opts?: {
    isServed?: (desc: SessionDescriptor) => boolean
  }): Promise<EagerResumeSummary>
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
  // Activate the built-in custom routes (the local `llm-endpoint` proxy) before
  // anything resolves a model ref or builds the catalog — `resolveLlmModelRoute`
  // reads the custom-route map at call time, so a curated `@llm-endpoint` row is
  // only priced + reachable once this has run (`builtin-routes.ts`). Idempotent.
  await registerBuiltinRoutes({ llmEndpoint: opts.llmEndpoint === true })
  // Effective idle-reap threshold (PR-6): a positive ms value enables the
  // periodic reaper, anything else (unset / 0 / negative) keeps it off. Kept as
  // a plain `0`-means-off number so `daemon_health` / `GET /health` can surface
  // one unambiguous figure.
  const idleReapAfterMs =
    typeof opts.idleReapAfterMs === "number" && opts.idleReapAfterMs > 0
      ? opts.idleReapAfterMs
      : 0
  // Effective crash-detect interval (crash-detect PR-1): DEFAULT ON, unlike
  // idleReapAfterMs — an unset knob still gets a sane default sweep cadence
  // since detection is non-destructive observability. A caller must pass an
  // explicit non-positive value to actually disable the sweep.
  const crashDetectIntervalMs =
    typeof opts.crashDetectIntervalMs === "number"
      ? opts.crashDetectIntervalMs > 0
        ? opts.crashDetectIntervalMs
        : 0
      : DEFAULT_CRASH_DETECT_INTERVAL_MS
  // Effective restart-sweep interval (restart-scheduler PR-2): OFF by
  // default, same shape as idleReapAfterMs — a caller must opt in with a
  // positive ms value before the sweep ever runs.
  const restartSweepIntervalMs =
    typeof opts.restartSweepIntervalMs === "number" && opts.restartSweepIntervalMs > 0
      ? opts.restartSweepIntervalMs
      : 0
  // Effective turn-stall threshold (turn-liveness-watchdog chantier):
  // DEFAULT ON, same shape as crashDetectIntervalMs — an unset knob still
  // gets a sane default since this is non-destructive observability. A
  // caller must pass an explicit non-positive value to disable the sweep.
  const turnStallAfterMs =
    typeof opts.turnStallAfterMs === "number"
      ? opts.turnStallAfterMs > 0
        ? opts.turnStallAfterMs
        : 0
      : DEFAULT_TURN_STALL_AFTER_MS
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

  // Single-sidecar registry for the @agentproto/llm-endpoint proxy — gated
  // behind `opts.llmEndpoint` (default false). When off, no registry is
  // created, no MCP tools are registered, and the route is absent too
  // (`registerBuiltinRoutes` above already skipped it).
  const llmEndpoint = opts.llmEndpoint
    ? new LlmEndpointRegistry({
        workspace,
        onLog: line =>
          events.emit({
            type: "remote-log",
            at: new Date().toISOString(),
            line,
          }),
      })
    : undefined

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

  // Per-workspace brain: auto-ingest a workspace's conversations when its
  // sessions exit (debounced, fire-and-forget), and expose them queryably
  // via the workspace_brain_* MCP tools. Same wiring discipline as the
  // webhook notifier — a brain failure never throws into the exit path.
  const workspaceBrains = createWorkspaceBrains()
  const brainSubscriber = createWorkspaceBrainSubscriber({
    bus: sessionEvents,
    brains: workspaceBrains,
  })
  brainSubscriber.start()

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
    ...(opts.resolveAgentAdapter ? { resolveAgentAdapter: opts.resolveAgentAdapter } : {}),
    ...(opts.persistPath ? { persistPath: opts.persistPath } : {}),
    ...(opts.spawnPty ? { spawnPty: opts.spawnPty } : {}),
    ...(opts.runWorktreeAutoReclaim ? { runWorktreeAutoReclaim: opts.runWorktreeAutoReclaim } : {}),
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
            descriptor,
            mcpServers,
            onActivity,
          }) => {
            const adapter = await opts.resolveAgentAdapter!(adapterSlug)
            if (!adapter) return null
            try {
              // Re-resolve billing-auth the SAME way a fresh spawn /
              // `session_restart` does — mode from the descriptor's `auth.mode`
              // echo (or its pinned `accessProfile`), credential re-resolved
              // fresh from config/providers.json/keychain, NEVER inherited from
              // the daemon's ambient env. Before this, the lazy in-place resume
              // called `startSession` with no `auth` at all, so a session
              // pinned to `subscription` silently came back billing on whatever
              // `ANTHROPIC_API_KEY` the daemon held — the "money bug" already
              // fixed for `session_restart` (session-restart-core.ts). Fail-loud:
              // an unresolvable pinned mode throws here (or the driver throws
              // `missing_auth_credential`) → caught below → resume returns null,
              // the session stays dead rather than starting on the wrong wallet.
              const { authSpec } = await resolveResumeAuth(descriptor, adapter, {
                adapterSlug,
                ...(descriptor.model ? { model: descriptor.model } : {}),
                ...(descriptor.route ? { route: descriptor.route } : {}),
                ...(descriptor.accessProfile?.profileRef
                  ? { accessProfileRef: descriptor.accessProfile.profileRef }
                  : {}),
                prefix: "resume",
              })
              const resolvedBaseUrl = authSpec?.baseUrl ?? descriptor.route?.baseUrl
              return await adapter.startSession({
                cwd,
                resumeSessionId,
                // Point the respawned adapter at the SAME persistent
                // isolated-config dir the original spawn used — the
                // provider's conversation store lives inside it, so this is
                // what makes `resumeSessionId` restore full context instead
                // of degrading to the daemon-transcript digest. Absent on
                // legacy rows spawned before adapterConfigDir existed (those
                // keep today's digest-fallback behaviour).
                ...(descriptor.adapterConfigDir
                  ? { configDir: descriptor.adapterConfigDir }
                  : {}),
                // Re-mount the persisted spawn-time toolset on resume
                // (orchestrator WP1) — closes the gap where re-spawn
                // dropped mcpServers.
                ...(mcpServers ? { mcpServers } : {}),
                ...(authSpec ? { auth: authSpec } : {}),
                ...(typeof resolvedBaseUrl === "string" && resolvedBaseUrl.length > 0
                  ? { options: { base_url: resolvedBaseUrl } }
                  : {}),
                ...(onActivity ? { onActivity } : {}),
                // Lazy in-place resume (daemon restart / crash): unlike
                // `session_restart` this revives the SAME descriptor row, not
                // a fresh one — `descriptor.id` never changes across this
                // call, so the identity env carries forward unchanged.
                env: {
                  [SESSION_ID_ENV]: descriptor.id,
                  [WORKSPACE_SLUG_ENV]: descriptor.workspaceSlug,
                },
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

  // Restart scheduler (restart-scheduler PR-2) — the EVENT-driven half only;
  // it subscribes to session:exited and stamps/gives-up a schedule on an
  // eligible, opted-in death. Runs regardless of `restartSweepIntervalMs`:
  // that knob only arms the periodic sweep further below that EXECUTES a
  // landed schedule. Declared right after `sessions` (needs the registry +
  // its own event bus); disposed in stop().
  const restartScheduler = createRestartScheduler({ registry: sessions, sessionEvents })

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

  // In-process caller for ANY registered daemon MCP tool by name — the
  // universal escape hatch behind AIP-41 routine `target.tool` (+ the
  // `agent`/`workflow` sugar, which lower to it — see routine-registrar.ts)
  // and cron's `kind:"tool"` action. `McpServer` is NOT a gateway singleton
  // (`mcpServerFactory` below builds a fresh one per `/mcp` connection), so
  // this closes over a box filled in once `mcpServerFactory` exists further
  // down — a tick firing before boot completes is not a real scenario, but
  // the box makes "not ready yet" a clear error instead of a crash either way.
  const dispatchToolBox: { fn?: (name: string, inputs: Record<string, unknown>) => Promise<unknown> } = {}
  const dispatchTool = async (name: string, inputs: Record<string, unknown>): Promise<unknown> => {
    if (!dispatchToolBox.fn) {
      throw new Error(`routine/cron tool dispatch: not ready yet (daemon still booting) — tool "${name}"`)
    }
    return dispatchToolBox.fn(name, inputs)
  }

  // Same forward-reference trick as `dispatchToolBox` above, for `app_install`'s
  // WORKFLOW.md tool-step validation (app-tools.ts) — it needs the SET of
  // dispatchable tool ids, not a dispatcher. Wired to the real internal
  // McpServer's `_registeredTools` keys alongside `dispatchToolBox.fn` below.
  const listToolIdsBox: { fn?: () => Promise<string[]> } = {}
  const listRegisteredToolIds = async (): Promise<string[]> => {
    if (!listToolIdsBox.fn) {
      throw new Error("app_install: tool registry not ready yet (daemon still booting)")
    }
    return listToolIdsBox.fn()
  }

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
    dispatchTool,
    workspace,
    persist,
  })

  // AIP-41 routine registrar — reads `.routines/*/ROUTINE.md`, validates,
  // and reconciles live CronScheduler jobs for every enabled cron-scheduled
  // routine. `reconcile()` runs once at boot, below (after `dispatchTool`
  // is wired to a real server). See packages/routine/README.md "Runtime
  // bridge" section for the design.
  const routineRegistrar = createRoutineRegistrar({
    workspace,
    cronScheduler,
    dispatchTool,
  })

  // Installed-app registry — singleton per daemon, shared between
  // `registerAppTools` (app_install/app_run/…) and the workflow runner's
  // `compileWorkflow` closure below, so a declarative `kind:"agent"` step's
  // `agent.ref` resolves against every app this daemon has installed (WP-B4).
  // Declared here (not inside `registerAppTools`) purely so both consumers
  // share the one instance — same persistence defaults as before this WP.
  const appRegistry = createAppRegistry({ persist })

  // HTML cache for installed apps' `ui.path` panels (app-ui-apps.ts) —
  // gateway-scope singleton so a `/mcp` request doesn't re-read an
  // unchanged panel's HTML off disk every time `mcpServerFactory` rebuilds
  // the server. Keyed by (path, app.updatedAt), so a re-install invalidates.
  const appUiHtmlCache = createUiHtmlCache()

  // Workflow runner — singleton per daemon, shared across all MCP
  // connections. Persists run state to ~/.agentproto/workflow-runs.json so
  // runs survive daemon restarts (interrupted runs are marked "failed" on
  // load). Declared after `sessions` and `supervisor` so it shares the same
  // registry + event bus. Only wired when `resolveAgentAdapter` is
  // available (workflow steps need to spawn agent sessions).
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
        // for `workflow_run_file` / `startFromFile`. `tool` steps resolve
        // through `createDaemonToolRegistry` — a per-handle registry scanning
        // the step graph for referenced tool ids and routing each through
        // the same `dispatchTool` the routine registrar / cron scheduler use
        // (see `workflow-tool-registry.ts`). Agent-step workflows are
        // unaffected: an empty tool registry compiles them exactly as before.
        // `agentRefs` resolves a declarative agent-step's `agent.ref` against
        // whichever installed app bundles this workflow id (undefined when
        // none does — a plain `workflow_run_file` outside any app).
        compileWorkflow: handle =>
          compileWorkflow(handle, {
            ...createDaemonToolRegistry(handle, dispatchTool),
            agentRefs: resolveAgentRefsForWorkflow(appRegistry, handle.id),
          }),
        // App state ledger bridge: runs whose workflow belongs to an
        // installed app append stage-started/gate-report/stage-done/blocked
        // events to that app's ledger (see workflow-runner.ts, WP-Q).
        appRegistry,
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

  // Supervisor crash-notification (crash-detect PR-4). Opt-in per child
  // (`notifyParentOnCrash`) — delivers a `[child-crashed] …` notice into a
  // crashed child's live parent, without ever interrupting a busy one. See
  // supervisor-notify.ts's header doc for the full contract.
  wireSupervisorNotify({ registry: sessions, sessionEvents })

  // Activity projector — the unified active/pending read-model over
  // completion policies, session turns, workflow steps, and opened PRs
  // (activities.ts). A projection, not a registry: `list()` recomputes from
  // the owners above on every call; the projector's only state is a diff
  // cache that powers the `activity:changed` bus event. Declared after the
  // owners it projects over; disposed in stop(). The `taskLedger` lets it
  // derive `Activity.taskId` from the ledger's edges at read time.
  const activityProjector = createActivityProjector({
    registry: sessions,
    sessionEvents,
    supervisor,
    taskLedger,
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

  // Same proxy `mcp_imported_call` (session-tools.ts) dispatches through —
  // unwraps `{ok,result}|{ok:false,error}` into a plain return-or-throw for
  // `app_tool_call`'s `imported:<alias>/<toolName>` ids. Hoisted so the MCP
  // verb (registerAppTools below) and the REST twin (startHttpServer's
  // `appToolCallDeps`) share one definition.
  const callImportedAppTool = async (
    alias: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const out = await mcpProxy.callTool(alias, tool, args)
    if (!out.ok) throw new Error(`app_tool_call: imported "${alias}".${tool}: ${out.error}`)
    return out.result
  }

  // Transmitter binding store — single shared instance mapping an
  // agentpush (alias, source, contactRef) triple to the agentproto
  // session its replies should route into. Shared by the inbound
  // watcher (poll ingress), the `transmit_message` tool (binds on
  // send), and `POST /inbound` (push ingress) below. No `persist`
  // knob (mirrors policies.json/cron-jobs.json, per gateway-persist.
  // test.ts's documented precedent for gateway-owned stores with no
  // path knob) — writes only happen on an explicit bind, which no
  // test exercises incidentally the way session spawns do.
  const transmitterBindings = createTransmitterBindingStore()
  // Keyed off the SAME `persist` switch every sibling store uses (see its
  // definition above) -- an endpoint registered via inbound_endpoint_create
  // must survive a daemon restart in production, or every provider webhook
  // already pointed at it (e.g. a live Telegram bot's setWebhook) starts
  // 404ing as unknown_inbound_endpoint with no signal to the remote caller.
  // Hardcoding persist:true here (an earlier version of this fix) ignored
  // opts.persist entirely -- a test gateway created with `persist: false`
  // would still flushSync on stop() and overwrite the developer's real
  // ~/.agentproto/inbound-endpoints.json with an empty store.
  const inboundEndpointStore = createInboundEndpointStore({
    persist,
  })
  const telegramBotCreds = makeTelegramBotCredsStore()

  // Adapts SessionsRegistry to InboundRouterDeps' liveness/restart
  // shape (inbound-router.ts) — same primitives cron-scheduler.ts's
  // `prompt-session` action uses (`desc.processAlive`, forceAgentResume).
  // `processAlive` is only stamped for a pid-bearing session (sessions.ts
  // `stampProcessAlive`) — it's `undefined`, not `false`, for a pid-less
  // ACP-native/remote session, and cron-scheduler.ts's own dead check
  // (`desc.processAlive === false`) treats that as "still fine, don't
  // restart". Mirror that exactly: only a MISSING session or an explicit
  // `false` counts as not-alive.
  const isSessionAlive = (id: string): boolean => {
    const desc = sessions.get(id)
    if (!desc) return false
    return desc.processAlive !== false
  }
  const restartInboundSession = async (id: string): Promise<string> => {
    const desc = sessions.get(id)
    if (!desc) {
      throw new Error(`restartInboundSession: no session "${id}"`)
    }
    if (!opts.resolveAgentAdapter) {
      throw new Error(
        `restartInboundSession: session "${id}" is not alive and agent restart is not enabled (no resolveAgentAdapter)`,
      )
    }
    const restarted = await restartAgentSession(sessions, opts.resolveAgentAdapter, desc, {
      forceAgentResume: true,
    })
    return restarted.desc.id
  }

  // Inbound watcher — polls an agentpush source on a timer and spawns
  // one agent per new contact_ref (mode "spawn", default), or routes
  // into a bound session (mode "route"/"route-or-spawn") via the
  // shared transmitterBindings store. Wired when an adapter resolver
  // is available (otherwise the watcher would have nowhere to spawn).
  const inboundWatcher =
    opts.resolveAgentAdapter
      ? createInboundWatcher({
          mcpProxy,
          registry: sessions,
          resolveAgentAdapter: opts.resolveAgentAdapter,
          persist,
          bindings: transmitterBindings,
          enqueuePrompt: sessions.enqueuePrompt,
          isSessionAlive,
          restartSession: restartInboundSession,
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
    ...(opts.listHarnessCapabilities
      ? { listHarnessCapabilities: opts.listHarnessCapabilities }
      : {}),
  })

  const mcpServerFactory = async (
    denyTools?: ReadonlySet<string>,
    callerSessionId?: string,
    origin?: string,
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
    // App state ledger write gate (app-state.ts's access rule): a request
    // identified as coming from a daemon-spawned agent session
    // (`?callerSessionId=` — the same identity plumbing command provenance
    // uses) never gets `app_state_append` registered. App agents cannot
    // self-certify state; the daemon runner and UI actions (no caller
    // session id) keep it. Same hard-gate style as denyTools: the name is
    // stripped at registration, not merely unlisted.
    if (callerSessionId) {
      server = withToolExclusion(server, new Set([APP_STATE_APPEND_TOOL_NAME]))
    }
    // Canonical filesystem tools so remote MCP clients (cloud
    // workspace-providers, IDEs, ad-hoc tooling) can read/write the
    // workspace without each implementing AIP-aware glue. Names match
    // `@modelcontextprotocol/server-filesystem` for drop-in compat.
    registerFsTools(server, { workspace })
    // Cheap, read-only liveness probe. Registered early so it is available
    // even when deferred tools hide the rest of the surface.
    registerDaemonHealthTools(server, {
      workspace,
      registered,
      startedAt,
      resumeSessionsOnBoot: opts.resumeSessionsOnBoot === true,
      idleReapAfterMs,
      crashDetectIntervalMs,
      restartSweepIntervalMs,
      turnStallAfterMs,
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.build ? { build: opts.build } : {}),
    })
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
      workspace,
      mcpProxy,
      ptyEnabled: opts.spawnPty != null,
      // Phase 4: lets an `agent_start` carrying `costBudget` auto-attach a
      // windowed cost-budget governance policy on the spawned session.
      supervisor,
      buildOrchestratorMcp: orchestratorInjector,
      // Same `?callerSessionId=` query that attributes `command_execute` back
      // to the calling session (above) — here it's the implicit auto-parent so
      // a spawn made by an agent session attaches under it by default (see
      // spawn-attach.ts). Absent on a human/root `/mcp` call → no auto-parent.
      ...(callerSessionId ? { callerSessionId } : {}),
      // `?origin=` query (#session-visibility) — the connecting client's source
      // label, used as the default origin for a spawn that doesn't set its own.
      ...(origin ? { mcpBridgeOrigin: origin } : {}),
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
      ...(opts.listHarnessCapabilities
        ? { listHarnessCapabilities: opts.listHarnessCapabilities }
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
    // Per-workspace brain — query/status/ingest over the shared brain
    // registry declared at gateway boot (workspaceBrains).
    registerBrainTools(server, {
      brains: workspaceBrains,
      registry: sessions,
      ...(callerSessionId ? { callerSessionId } : {}),
    })
    // Named auth-profile lifecycle (auth_profile_create/delete/list). No
    // host wiring — `@agentproto/auth` reads/writes the fixed
    // `~/.agentproto/auth-profiles.json` + keychain slots directly, same as
    // the profile readers already mounted in session-spawn.ts.
    registerAuthProfileTools(server)
    // Persisted harness→profile bindings (harness_preset_list/create/delete/
    // set_default). Same no-host-wiring stance as the auth-profile tools —
    // the store reads/writes the fixed `~/.agentproto/harness-presets.json`.
    registerHarnessPresetTools(server)
    // Read-only scanner: report locally-present credentials (Claude Code /
    // Codex / Gemini logins, ~/.hermes/config.yaml, provider env keys) with
    // provenance, so onboarding can offer an import. Never returns a value.
    registerCredentialDiscoveryTools(server)
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
      ...(workflowRunner ? { workflowRunner } : {}),
      ...(inboundWatcher ? { inboundWatcher } : {}),
      cronScheduler,
      routineRegistrar,
      mcpProxy,
      bindingStore: transmitterBindings,
      endpointStore: inboundEndpointStore,
      telegramCreds: telegramBotCreds,
    })
    // @agentproto/app-kit app lifecycle — install/list/run/status/stop
    // (app-tools.ts). `resolveAgentAdapter` gates the adapter-resolves check
    // (app_install) and the spawn (app_run) the same way it gates
    // `workflowRunner` above; `listRegisteredToolIds` is always wired (the
    // same lazy internal-server reach-in `dispatchTool` uses).
    registerAppTools(server, {
      registry: sessions,
      listRegisteredToolIds,
      appRegistry,
      dispatchTool,
      callImportedTool: callImportedAppTool,
      ...(opts.resolveAgentAdapter ? { resolveAgentAdapter: opts.resolveAgentAdapter } : {}),
      ...(workflowRunner ? { workflowRunner } : {}),
    })
    // App-scoped durable data plane (app-data.ts) — app_data_read/write/list/
    // migrate, anchored to each installed app's own dir with traversal guard.
    registerAppDataTools(server, { appRegistry })
    // Read-only external filesystem plane (app-external.ts) —
    // app_external_list/app_external_read, anchored to each installed app's
    // opted-in InstalledApp.externalReadRoots (never the app's own sandbox
    // dir). No write/delete tool exists here by design; binary files are
    // never read into a tool response — see GET /apps/:appId/external-blob
    // in http-server.ts for that.
    registerAppExternalTools(server, { appRegistry })
    registerTelegramBotTools(server, { telegramCreds: telegramBotCreds })
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
    // App-only pull tools (visibility:["app"]) the live-session widget calls
    // over the postMessage bridge to refresh WITHOUT hitting the model:
    // `app_session_tree` (left pane) + `app_session_events` (right-pane poll
    // fallback). Registered THROUGH `server` so the subset/exclusion proxies
    // (tool-subset.ts, now registerTool-aware) can drop them on scoped/child
    // gateways — they belong only on the full /mcp surface a host connects to.
    registerAppPullTools(server, { registry: sessions })
    // The five daemon-builtin panels — now house-app-quality code in
    // @agentproto/apps, mounted here without an app_install step (see
    // builtin-apps.ts for why they aren't AppHandles).
    const builtinPanelApps = [
      ...makeBuiltinPanelApps({
        listSessions: listSessionsFiltered,
        // httpBaseUrl = this daemon's own origin (SSE stream + bridge
        // fallback for the live-session widget).
        httpBaseUrl: `http://127.0.0.1:${port}`,
      }),
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
    ]
    // Dynamic UI panels for installed `@agentproto/app-kit` apps that ship
    // a `ui` block (app-ui-apps.ts) — appended after the built-in panels so
    // their tool ids can be checked for collisions against them. Never
    // throws: a bad app record is skipped with a `console.warn` instead of
    // failing the whole `/mcp` request.
    const installedAppUiApps = await makeInstalledAppUiApps(
      appRegistry,
      appUiHtmlCache,
      new Set(builtinPanelApps.map(app => app.id)),
    )
    registerMcpApps(server, [...builtinPanelApps, ...installedAppUiApps])
    // Server-side per-session summariser backing the agents-overview panel.
    // Heuristic today (no LLM in @agentproto/runtime) — see summarize-session-tool.ts.
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
    // Conversation locator — bidirectional session ↔ native-transcript
    // lookup over the persisted per-workspace index. Stateless (bucketsRoot
    // resolves straight off HOME), so it needs no injected deps.
    registerConversationLocateTool(server)
    // Conversation exporter — WRITE side of the cross-adapter pivot above:
    // copies a daemon session's events.jsonl transcript into a target
    // adapter's native conversation store (today claude-code JSONL) and
    // hands back a `claude --resume <uuid>` handle. Read-only with respect
    // to the daemon's own capture; the session is never modified or resumed.
    registerConversationExportTool(server, { registry: sessions })
    // Multi-tunnel tools — same closure-rebind pattern.
    registerTunnelTools(server, { registry: tunnels })
    // llm-endpoint proxy sidecar lifecycle — only when the feature is on.
    if (llmEndpoint) registerLlmEndpointTools(server, { registry: llmEndpoint })
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
    // Phase 1 `sandbox attach` — connect to an ALREADY-EXISTING sandbox
    // without tearing it down. Same shared resolver as above so it sees
    // the exact same provider set `list_sandbox_providers` reports ready.
    registerSandboxAttachTool(server, {
      resolveSandboxProvider: resolveSandboxProviderResolved,
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

  // Wire `dispatchTool` to a real in-process McpServer now that
  // `mcpServerFactory` exists. Lazily built + cached on first use (not
  // here) so a daemon that never fires a `kind:"tool"` cron/routine job
  // pays nothing extra at boot — see `dispatchToolBox`'s declaration above.
  let internalToolServerPromise: ReturnType<typeof mcpServerFactory> | undefined
  dispatchToolBox.fn = async (name, inputs) => {
    if (!internalToolServerPromise) internalToolServerPromise = mcpServerFactory()
    const internalServer = await internalToolServerPromise
    // `_registeredTools` is undeclared on `McpServer`'s public type — same
    // reach-in `__tests__/tool-subset.test.ts` already uses to read tool
    // names back out; here it's used to CALL a handler in-process,
    // bypassing the wire entirely (no transport, no client).
    const internal = internalServer as unknown as {
      _registeredTools?: Record<string, { handler: (args: unknown, extra: unknown) => unknown }>
    }
    const tool = internal._registeredTools?.[name]
    if (!tool) {
      throw new Error(`routine/cron tool dispatch: unknown daemon tool "${name}"`)
    }
    return tool.handler(inputs, {})
  }
  listToolIdsBox.fn = async () => {
    if (!internalToolServerPromise) internalToolServerPromise = mcpServerFactory()
    const internalServer = await internalToolServerPromise
    const internal = internalServer as unknown as { _registeredTools?: Record<string, unknown> }
    return Object.keys(internal._registeredTools ?? {})
  }

  // AIP-41 routine registrar's first pass — scans `.routines/*/ROUTINE.md`
  // and registers a live cron job for every enabled cron-scheduled routine.
  // Best-effort: a malformed manifest must not block daemon boot (errors are
  // collected in the result, not thrown) — same "never fails a session/boot"
  // posture as the PR-provenance reconciler above.
  try {
    routineRegistrar.reconcile()
  } catch (err) {
    events.emit({
      type: "heartbeat-error",
      at: new Date().toISOString(),
      agent: opts.defaultBootAgent,
      error: `routine registrar reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
    })
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
    ...(workflowRunner ? { workflowRunner } : {}),
    appRegistry,
    performAppInstall: performInstall,
    listRegisteredToolIds,
    // Same dispatch pair registerAppTools gets above — the REST
    // /apps/:appId/tool-call twin must run the exact chain the MCP
    // app_tool_call verb runs.
    appToolCallDeps: { dispatchTool, callImportedTool: callImportedAppTool },
    // POST /inbound push ingress — same shared transmitterBindings store
    // and liveness/restart adapters the inbound watcher's "route"/
    // "route-or-spawn" modes use above. No `spawnForContact`: an
    // unauthenticated webhook payload carries no adapter/prompt template
    // to spawn with, so an unbound contact is "skipped" rather than
    // spawning an arbitrary agent from push input.
    // provider-specific `POST /inbound/:slug` push ingress reads endpoint
    // config (secret, provider, mode) from the SAME store the
    // inbound_endpoint_create/list/delete MCP tools write to — without
    // this, every slug 404s as "unknown_inbound_endpoint" regardless of
    // what's registered, since the http layer never saw the store at all.
    endpointStore: inboundEndpointStore,
    routeInboundMessage: (msg: InboundMessage, mode: InboundRouteMode) =>
      routeInboundMessage(
        {
          bindings: transmitterBindings,
          enqueuePrompt: sessions.enqueuePrompt,
          isSessionAlive,
          restartSession: restartInboundSession,
        },
        msg,
        mode,
      ),
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
    resolveSandboxProvider: resolveSandboxProviderResolved,
    ...(opts.listAgentAdapters
      ? { listAgentAdapters: opts.listAgentAdapters }
      : {}),
    ...(opts.listHarnessCapabilities
      ? { listHarnessCapabilities: opts.listHarnessCapabilities }
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
    meta: {
      workspace,
      registered,
      startedAt,
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.build ? { build: opts.build } : {}),
      resumeSessionsOnBoot: opts.resumeSessionsOnBoot === true,
      idleReapAfterMs,
      crashDetectIntervalMs,
      restartSweepIntervalMs,
      turnStallAfterMs,
    },
    cronScheduler,
    routineRegistrar,
  })

  heartbeat.start()

  // Idle agent-session reaper (PR-6). Only armed when the knob is on
  // (`idleReapAfterMs > 0`); off by default. Sweeps on a fixed cadence —
  // min(threshold, 60s) so a short threshold still gets a timely sweep and a
  // long one doesn't spin needlessly, overridable via
  // AGENTPROTO_IDLE_REAP_INTERVAL_MS (mirroring AGENTPROTO_RESUME_CONCURRENCY).
  // `.unref()` so the ticker never keeps the process alive on its own.
  let idleReapTimer: ReturnType<typeof setInterval> | null = null
  if (idleReapAfterMs > 0) {
    const rawInterval = process.env.AGENTPROTO_IDLE_REAP_INTERVAL_MS
    const parsedInterval = rawInterval ? Number.parseInt(rawInterval, 10) : NaN
    const intervalMs =
      Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : Math.min(idleReapAfterMs, 60_000)
    idleReapTimer = setInterval(() => {
      try {
        const summary = runIdleReapPass({ registry: sessions, idleReapAfterMs })
        if (summary.reaped > 0) {
          // One line per sweep that actually reaped something (silent otherwise
          // so a quiet daemon doesn't log every tick).
          console.log(
            `[idle-reaper] reaped ${summary.reaped}/${summary.candidates} idle ` +
              `agent session(s): ${summary.ids.join(", ")}`,
          )
        }
      } catch (err) {
        // A sweep must never crash the daemon — log and let the next tick retry.
        console.warn(
          `[idle-reaper] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }, intervalMs)
    idleReapTimer.unref?.()
  }

  // Crash-detect sweep (crash-detect PR-1). DEFAULT ON — armed whenever
  // `crashDetectIntervalMs > 0`, which it is unless a caller explicitly
  // disabled it (see the normalization above). Detects (and surfaces) a
  // dead adapter process for a parked agent-cli session that would
  // otherwise stay lying `status:"running"` until its next prompt's RPC
  // throws. Never restarts or notifies — that's a later PR.
  // `.unref()` so the ticker never keeps the process alive on its own.
  let crashDetectTimer: ReturnType<typeof setInterval> | null = null
  if (crashDetectIntervalMs > 0) {
    crashDetectTimer = setInterval(() => {
      try {
        const summary = runCrashDetectPass({ registry: sessions, crashDetectIntervalMs })
        if (summary.crashed > 0) {
          // One line per sweep that actually found something (silent otherwise
          // so a quiet daemon doesn't log every tick).
          console.log(
            `[crash-detect] marked ${summary.crashed}/${summary.candidates} ` +
              `crashed agent session(s): ${summary.ids.join(", ")}`,
          )
        }
      } catch (err) {
        // A sweep must never crash the daemon — log and let the next tick retry.
        console.warn(
          `[crash-detect] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }, crashDetectIntervalMs)
    crashDetectTimer.unref?.()
  }

  // Turn-liveness watchdog sweep (turn-liveness-watchdog chantier). DEFAULT
  // ON — armed whenever `turnStallAfterMs > 0`, which it is unless a caller
  // explicitly disabled it (see the normalization above). Flags a mid-turn
  // agent-cli session whose adapter stream has gone silent past the
  // threshold — a dead stream that would otherwise sit indistinguishable
  // from healthy long work. Never kills or restarts — detection only.
  // Sweeps on a fixed cadence — min(threshold, 60s), same reasoning as
  // idle-reap's ticker — so a short threshold still gets a timely sweep and
  // the default 5-minute one doesn't spin needlessly, overridable via
  // AGENTPROTO_TURN_STALL_INTERVAL_MS. `.unref()` so the ticker never keeps
  // the process alive on its own.
  let turnStallTimer: ReturnType<typeof setInterval> | null = null
  if (turnStallAfterMs > 0) {
    const rawInterval = process.env.AGENTPROTO_TURN_STALL_INTERVAL_MS
    const parsedInterval = rawInterval ? Number.parseInt(rawInterval, 10) : NaN
    const intervalMs =
      Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : Math.min(turnStallAfterMs, 60_000)
    turnStallTimer = setInterval(() => {
      try {
        const summary = runStallWatchdogPass({ registry: sessions, turnStallAfterMs })
        if (summary.stalled > 0) {
          // One line per sweep that actually flagged something (silent
          // otherwise so a quiet daemon doesn't log every tick).
          console.log(
            `[stall-watchdog] flagged ${summary.stalled}/${summary.candidates} ` +
              `stalled agent session(s): ${summary.ids.join(", ")}`,
          )
        }
      } catch (err) {
        // A sweep must never crash the daemon — log and let the next tick retry.
        console.warn(
          `[stall-watchdog] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }, intervalMs)
    turnStallTimer.unref?.()
  }

  // Restart-sweep tick (restart-scheduler PR-2). OFF by default — only armed
  // when `restartSweepIntervalMs > 0`. This is the half that EXECUTES a
  // schedule the event-driven `restartScheduler` above already stamped
  // (`nextRestartAt`); the knob controls the sweep cadence, not whether any
  // given session opted in (that's per-session `restartPolicy`).
  // `.unref()` so the ticker never keeps the process alive on its own.
  let restartSweepTimer: ReturnType<typeof setInterval> | null = null
  if (restartSweepIntervalMs > 0) {
    restartSweepTimer = setInterval(() => {
      runRestartSweepPass({ registry: sessions, restartSweepIntervalMs })
        .then(summary => {
          if (summary.resumed > 0) {
            // One line per sweep that actually resumed something (silent
            // otherwise so a quiet daemon doesn't log every tick).
            console.log(
              `[restart-scheduler] resumed ${summary.resumed}/${summary.candidates} ` +
                `restart-scheduled agent session(s): ${summary.ids.join(", ")}`,
            )
          }
        })
        .catch(err => {
          // A sweep must never crash the daemon — log and let the next tick retry.
          console.warn(
            `[restart-scheduler] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
    }, restartSweepIntervalMs)
    restartSweepTimer.unref?.()
  }

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
    async resumeSessionsOnBoot(passOpts) {
      // Off by default (§5 "Opt-in vs automatic") — lazy resume-on-prompt
      // still works regardless; this only controls the automatic boot pass.
      if (!opts.resumeSessionsOnBoot) {
        return { enabled: false, candidates: 0, resumed: 0, failed: 0, skipped: 0 }
      }
      // Small concurrency cap so a box-wide restart doesn't spawn every adapter
      // at once (§5 "Resume-storm control"). Default 4; override via
      // AGENTPROTO_RESUME_CONCURRENCY, mirroring AGENTPROTO_POLICY_CONCURRENCY.
      const raw = process.env.AGENTPROTO_RESUME_CONCURRENCY
      const parsed = raw ? Number.parseInt(raw, 10) : NaN
      const concurrency = Number.isFinite(parsed) && parsed > 0 ? parsed : 4
      return runEagerResumePass({
        registry: sessions,
        concurrency,
        ...(passOpts?.isServed ? { isServed: passOpts.isServed } : {}),
      })
    },
    async stop() {
      heartbeat.stop()
      // Stop the idle-reaper sweep before sessions shut down (PR-6).
      if (idleReapTimer) clearInterval(idleReapTimer)
      // Stop the crash-detect sweep before sessions shut down (crash-detect PR-1).
      if (crashDetectTimer) clearInterval(crashDetectTimer)
      // Stop the turn-liveness watchdog sweep before sessions shut down
      // (turn-liveness-watchdog chantier).
      if (turnStallTimer) clearInterval(turnStallTimer)
      // Stop the restart-sweep tick before sessions shut down (restart-scheduler PR-2).
      if (restartSweepTimer) clearInterval(restartSweepTimer)
      // Detach the restart-scheduler's session:exited subscription.
      restartScheduler.dispose()
      // Flush inbound-watcher cursor state before sessions shut down.
      inboundWatcher?.shutdown()
      // Flush inbound-endpoint state synchronously -- persistence is a
      // debounced async write, so an endpoint registered via
      // inbound_endpoint_create just before a restart would otherwise be
      // lost inside that window, the exact 404-after-bounce failure
      // persisting the store exists to prevent.
      inboundEndpointStore.flushSync()
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
      // Stop the llm-endpoint proxy child (if running) before HTTP tears down.
      await llmEndpoint?.shutdown()
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

// ── Windowed cost-budget caps (phase 4) ──────────────────────────────────────
// The pure decision helper + its result type, plus a re-export of the shared
// `CostBudget`/`CostBudgetScope` record from `@agentproto/auth` so a runtime
// consumer needn't reach into the auth package for the type. Placed at the end
// of the file (not beside the usage-rollup exports) to avoid colliding with a
// parallel edit in that region.
export { evaluateCostBudget } from "./cost-budget.js"
export type { CostBudgetDecision } from "./cost-budget.js"
export type { CostBudget, CostBudgetScope } from "@agentproto/auth"
