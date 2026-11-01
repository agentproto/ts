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

import { createLivenessTickGuard } from "./liveness-tick-guard.js"
import { sweepSessionBrowser } from "./browser-mount.js"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createMcpServer, registerEventsMethods, registerUiResource } from "@agentproto/mcp-server"
import type { DoctypeSpec } from "@agentproto/manifest"

import { writeRuntimeMeta } from "./agentproto-dir.js"
import { makeCwdAnchor, registerCommandTools } from "./command-tools.js"
import { isCommandAllowed, loadAllowlistEntries } from "./command-allowlist.js"
import { fileConversationStore } from "./conversations.js"
import { createRuntimeEvents } from "./events.js"
import { callerScopes } from "./caller-scope.js"
import { registerFsTools } from "./fs-tools.js"
import {
  registerSessionTools,
  registerExportSessionTool,
  registerConversationReadTool,
  registerConversationLocateTool,
  registerConversationExportTool,
} from "./session-tools.js"
import { registerCreateAgentTool } from "./create-agent-tool.js"
import { registerCreateToolTools } from "./create-tool-tool.js"
import { collectSubtree } from "./agent-tools.js"
import { registerBrainTools } from "./brain-tools.js"
import { createWorkspaceBrains } from "./workspace-brains.js"
import { resolveBrainIngestLimits } from "./brain-ingest-limits.js"
import { createWorkspaceBrainSubscriber } from "./workspace-brain-subscriber.js"
import {
  registerBrowserTools,
  type BrowserAdapterResolver,
  type BrowserAdapterLister,
} from "./browser-tools.js"
import { registerAuthProfileTools } from "./auth-profile-tools.js"
import { registerConfigTools, type ConfigToolsDeps } from "./config-tools.js"
import { modelRoles, registerModelRolesTools } from "./model-roles-tools.js"
import { resolveModelRole as resolveModelRoleEntry } from "./model-roles.js"
import { registerDecisionTools } from "./decision-tools.js"
import { createDaemonEscalationHost } from "./decision-escalation.js"
import { registerDecisionWorkflowTools } from "./decision-workflow-tools.js"
import { withContextPolicy } from "./context-continuity.js"
export { layerContextSettings, type ContextSettings } from "./context-continuity.js"
export { makeJevDecisionClassifier } from "./decision-tools.js"
export {
  DEFAULT_MODEL_ROLES,
  MODEL_ROLE_PRESETS,
  MODEL_ROLE_PRESET_NAMES,
  MODEL_ROLE_REF_PREFIX,
  adapterForModelId,
  listModelRoles,
  parseModelRoleRef,
  resolveModelRole,
  type ModelRoleContext,
  type ModelRoleEntry,
  type ModelRolePreset,
  type ModelRoleSource,
  type ModelRoleValue,
  type ModelRolesConfig,
  type ResolvedModelRole,
} from "./model-roles.js"
export { createWorkspaceOfCwd } from "./workspace-binding.js"
export { loadWorkspaceModelRoles, type ModelRolesInput, type ModelRolesOutput } from "./model-roles-tools.js"
import { registerHarnessPresetTools } from "./harness-preset-tools.js"
import { registerUserPresetTools } from "./user-preset-tools.js"
import { registerModelListTools } from "./model-list-tools.js"
import { loadModelListSource } from "./model-list-store.js"
import { registerCredentialDiscoveryTools } from "./credential-discovery.js"
import { registerWebSearchTools } from "./web-search-tools.js"
import { registerMcpApps } from "./mcp-apps-adapter.js"
import { DEFAULT_BUCKET, resolveBucketSlug } from "./workspace-buckets.js"
import { makeBuiltinPanelApps } from "./builtin-apps.js"
import { SESSION_CHAT_APP_ID } from "@agentproto/apps"
import { resolvePublicAppOrigins } from "./public-origins.js"
import { registerSummarizeSessionTool } from "./summarize-session-tool.js"
import { makeTerminalPanelApp } from "./terminal-panel-app.js"
import { registerAppPullTools } from "./app-pull-tools.js"
import {
  loadWorkspacesConfig,
  findWorkspace,
  findWorkspaceByPath,
  getActiveWorkspace,
} from "./workspaces-config.js"
import {
  type WorktreeStatusLister,
} from "./worktree-status.js"
import type { WorktreeGcRunner } from "./worktree-gc.js"
import type { BranchGcRunner, BranchGcVerdictRecorder, BranchGcVerdictReader } from "./branch-gc.js"
import type { SandboxCheckpointGcRunner } from "./sandbox-checkpoint-gc.js"
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
  canResume,
  SANDBOX_GONE_DEFAULT_RESTART_POLICY,
  SESSION_ID_ENV,
  WORKSPACE_SLUG_ENV,
  SessionRetiredError,
  type SessionsRegistry,
  type SessionDescriptor,
  type PtyFactory,
} from "./sessions.js"
import { isRetired, resolveSuccessor } from "./session-retirement.js"
import { sweepWiringLifecycle, wireRetirementCleanup } from "./retirement-cleanup.js"
import {
  attachSessionCredentialStore,
  revokeSessionTokens,
  sessionCredentialsFile,
} from "./session-credentials.js"
import { createIdentityModeReader, resolveIdentityDefaults } from "./identity-defaults.js"
import { identityObservationsFile } from "./identity-observations.js"
import { preCompactCommandFor } from "./native-hooks-defaults.js"
import { withSessionToken } from "./session-spawn.js"
import {
  DEFAULT_KEEPALIVE_BOOT_RESUME_MAX_IDLE_MS,
  runEagerResumePass,
  type EagerResumeSummary,
} from "./eager-resume.js"
import {
  DEFAULT_REATTACH_TIMEOUT_MS,
  runSandboxReattachPass,
  type SandboxReattachSummary,
} from "./sandbox-reattach.js"
import {
  runContinueOnBootPass,
  type ContinueOnBootSummary,
} from "./continue-interrupted.js"
import {
  DEFAULT_SANDBOX_IDLE_REAP_AFTER_MS,
  runIdleReapPass,
  type IdleReapSummary,
} from "./idle-reaper.js"
import {
  DEFAULT_SANDBOX_GC_INTERVAL_MS,
  parsePausedBoxMaxAge,
  parseSandboxGcInterval,
  startSandboxGcTimer,
  type SandboxGcSessionLineage,
} from "./sandbox-gc.js"
import { runCrashDetectPass } from "./crash-reaper.js"
import { runStallWatchdogPass } from "./stall-watchdog.js"
import { createRestartScheduler, runRestartSweepPass } from "./restart-scheduler.js"
import { isSandboxBoxGone } from "./sandbox-gone.js"
import {
  createTurnRetryController,
  type FallbackHandoffFn,
  type FallbackRestartFn,
  type MigrateSessionFn,
} from "./turn-retry.js"
import { createModelCooldowns } from "./model-cooldowns.js"
import { createRotationTargetCheck } from "./turn-retry-eligibility.js"
import { migrateSandboxSession } from "./session-migrate.js"
import { createCheckpointSources } from "./checkpoint-extract.js"
import { sweepAppRuns } from "./app-run-liveness.js"
import { loadConfig } from "./config.js"
import { MESSAGE_URGENCIES, type MessageUrgency } from "./session-message.js"
import { resolveMessagingDefaults } from "./messaging-defaults.js"
import { resolveTaskDefaults } from "./task-defaults.js"
import { defaultTranscriptBaseDir, setDefaultSessionsBaseDir } from "./transcript-writer.js"
import { backfillSessionIndexesAsync } from "./session-index.js"
import {
  DEFAULT_SESSION_RETENTION_BOOT_DELAY_MS,
  DEFAULT_SESSION_RETENTION_INTERVAL_MS,
} from "./session-retention.js"
import {
  cloudRelayEnv,
  resolveResumeAuth,
  restartAgentSession,
  restartPreferInPlace,
} from "./session-restart-core.js"
import { continueAgentSessionFresh } from "./session-continue-fresh.js"
import { cloudMetaOf } from "@agentproto/cloud-agent"
import { createTransmitterBindingStore } from "./transmitter-bindings.js"
import { createInboundEndpointStore } from "./inbound-endpoints.js"
import { routeInboundMessage } from "./inbound-router.js"
import { createSentinelStore } from "@agentproto/sentinel"
import { createSentinelRuntime } from "@agentproto/sentinel"
import { resolveSentinelProvider, configureSessionSentinelProvider } from "@agentproto/sentinel"
import { makePublicUrlResolver, setSentinelPublicUrlSource } from "@agentproto/sentinel"
import { builtinProviderCapabilities } from "./remote-providers/registry.js"
import { LOCAL_GH_SLUG } from "@agentproto/sentinel"
import { AGENTPUSH_SLUG } from "@agentproto/sentinel"
import { registerSentinelTools, cancelSentinelWatch } from "@agentproto/sentinel"
import { createSessionFollowStore } from "./session-follow-store.js"
import { wireSessionFollow } from "./session-follow.js"
import {
  defaultFollowTriageConfig,
  resolveFollowTriageConfig,
  type FollowTriageInput,
} from "./follow-triage.js"
import { registerSessionFollowTools } from "./session-follow-tools.js"
import {
  eventsList,
  eventsSubscribe,
  eventsUnsubscribe,
  type EventsListRequest,
  type EventsSubscribeInput,
  type EventsUnsubscribeInput,
} from "./mcp-events/adapter.js"
import { daemonBearerPrincipal, sessionPrincipal } from "./mcp-events/events-registry.js"
import { createSentinelAutoLinker } from "@agentproto/sentinel"
import { createEventsSurfaceServer } from "./mcp-events-surface.js"
import { makeTelegramBotCredsStore, registerTelegramBotTools } from "./telegram-bot-creds.js"
import type { InboundMessage, InboundRouteMode } from "./inbound-router.js"
import { langfuseSessionTracer } from "./langfuse-session-tracer.js"
import { makeEvalReporterCredsStore } from "@agentproto/eval-reporters"
import { McpProxyRegistry } from "./mcp-proxy.js"
import { McpClientPool } from "./mcp-client-pool.js"
import { McpAppsHostService } from "./mcp-apps-host.js"
import { resolveMcpServer } from "./mcp-app-resolve.js"
import { registerMcpAppHostTools } from "./mcp-app-host-tools.js"
import { registerOrchestrationTools } from "./orchestration-tools.js"
import {
  registerAppTools,
  reensureInstalledAppServicesOnBoot,
  resolveAgentRefsForWorkflow,
  resolveAppToolsForWorkflow,
  performInstall,
} from "./app-tools.js"
import { createAppServiceStore } from "./app-services.js"
import { registerAppDataTools } from "./app-data.js"
import { APP_STATE_APPEND_TOOL_NAME } from "./app-state.js"
import { registerAppExternalTools } from "./app-external.js"
import { createAppRegistry } from "./app-registry.js"
import { makeInstalledAppUiApps, createUiHtmlCache } from "./app-ui-apps.js"
import { createSessionEventBus } from "./session-event-bus.js"
import {
  createActionRegistry,
  createAgentOnScanner,
  createBrainIngestReaction,
  createClerkReaction,
  createSessionArchiveAction,
  createReactionReceiptStore,
  createReactionWiring,
  reactionReceiptsPathForBucket,
  createReactionRunner,
  readBrainIngestOwnedWorkspaces,
  readClerkReactionOwnedWorkspaces,
  sessionFactsOf,
  wireSessionCompletion,
  type ClerkReaction,
} from "./action-hooks/index.js"
import { createMcpObservationStore, wireMcpDegradedWarnings } from "./mcp-session-observer.js"
import { createEventRing } from "./event-ring.js"
import { createWebhookNotifier } from "./webhook-notifier.js"
import { createImportedCallGuard } from "./imported-call-gate.js"
import { createPermissionTelegramBridge } from "./permission-telegram-bridge.js"
import { createWorkflowRunner } from "./workflow-runner.js"
import { createReviewRunner } from "./review-runner.js"
import { createReviewLedger } from "./review-ledger.js"
import { createDaemonReviewerHost } from "./review-reviewer-host.js"
import { registerReviewTools, reviewLedgerView } from "./review-tools.js"
import { compileWorkflow } from "@agentproto/workflow-runtime"
import { withDeferredTools } from "./deferred-tools.js"
export { resolveDeferredToolsGatewayOption, type DeferredToolsConfig } from "./deferred-tools.js"
import { withToolExclusion, withToolSubset } from "./tool-subset.js"
import { withToolDenyGate } from "./tool-deny-gate.js"
import { boundaryFromMeta, boundaryRestartOptions } from "./app-boundary.js"
import { createCompletionPolicySupervisor } from "./supervisor.js"
import { createPrProvenanceReconciler, type OpenPrResolver } from "./pr-provenance-reconciler.js"
import { createActivityProjector, type PrStateResolver } from "./activities.js"
import { createTaskLedger } from "./task-ledger.js"
import { createApprovalsEngine, type ApprovalsEngine } from "./approvals/engine.js"
import { registerApprovalTools } from "./approvals/tools.js"
import { registerApprovalCardDecideTool } from "./approvals/card-tool.js"
import { approvalCardResourceUri, renderApprovalCardHtml } from "./approvals/card.js"
import { wireSupervisorNotify } from "./supervisor-notify.js"
import { createInboundWatcher } from "./inbound-watcher.js"
import { createCronScheduler, DEFAULT_OBSERVE_TIMEOUT_MS } from "./cron-scheduler.js"
import { createSessionTurnObserver } from "./cron-turn-observer.js"
import { getAuthProfile } from "@agentproto/auth"
import { AnthropicRemainingQuotaReader } from "./remaining-quota.js"
import { toQuotaReadableProfile } from "./usage-rollup-service.js"
import { createRoutineRegistrar } from "./routine-registrar.js"
import { createClerkTurnEndController } from "@agentproto/clerk"
import { createNativeMemoryCapture } from "./memory-capture.js"
import { createClerkPassRunner } from "@agentproto/clerk"
import type { ClerkSessionLike } from "@agentproto/clerk"
import {
  loadDaemonClerkHook,
  loadWorkspaceClerkHook,
  resolveClerkHookConfig,
} from "@agentproto/clerk"
import { createDaemonToolRegistry, mergeAppAndDaemonToolRegistry } from "./workflow-tool-registry.js"
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
  createOrchestratorScopeHooks,
  reapOrphanedDescendants,
  orchestratorScopesFile,
  adoptLegacyOrchestratorScopes,
  pruneOrchestratorScopesOnBoot,
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
// Header the tunnel server injects on a host-scoped pairing's forwarded
// requests (DEVICES-PLAN item 1) — re-exported so `packages/cli`'s
// `buildDaemonTunnelServerOptions` (which sets it) and http-server.ts's own
// `handleDeviceInference` (which checks it) share one literal, not two.
export { HOST_SCOPE_HEADER } from "./http-server.js"
export type {
  CapabilitiesInventory,
  CapabilitiesInventoryMcp,
  CapabilitiesInventorySkills,
  SkillPackInventoryEntry,
  SkillsByHarnessEntry,
} from "./capabilities-inventory.js"
export type {
  WorktreeStatusLister,
  WorktreeStatusView,
} from "./worktree-status.js"
export { toWorktreeStatusView } from "./worktree-status.js"
export { APP_INSTALL_WORKTREE_REPOINT_REFUSED } from "./app-tools.js"
export type {
  WorktreeGcRunner,
  WorktreeGcRunInput,
  WorktreeGcResult,
  WorktreeGcClass,
  WorktreeGcReclaimReason,
  WorktreeGcPlanEntryView,
  WorktreeGcOutcomeView,
} from "./worktree-gc.js"
export type {
  BranchGcRunner,
  BranchGcRunInput,
  BranchGcResult,
  BranchGcKind,
  BranchGcClass,
  BranchGcStatus,
  BranchGcReclaimReason,
  BranchGcHoldReason,
  BranchGcTriageVerdict,
  BranchGcCoverageView,
  BranchGcPlanEntryView,
  BranchGcPlanView,
  BranchGcSummaryView,
  BranchGcOutcomeView,
  BranchGcVerdictInput,
  BranchGcVerdictRecordView,
  BranchGcVerdictRecorder,
  BranchGcVerdictLookupInput,
  BranchGcVerdictReader,
  BranchGcApplySummary,
  BranchGcApplyScopeCounts,
} from "./branch-gc.js"
export { summarizeBranchGcApply, withBranchGcApplySummary } from "./branch-gc.js"
export type {
  SandboxCheckpointGcRunner,
  SandboxCheckpointGcRunInput,
  SandboxCheckpointGcResult,
  SandboxCheckpointGcPlanView,
  SandboxCheckpointGcEntryView,
  SandboxCheckpointGcVerdict,
  SandboxCheckpointGcSummaryView,
  SandboxCheckpointGcApplyOutcomeView,
  SandboxCheckpointGcApplySummaryView,
} from "./sandbox-checkpoint-gc.js"
export {
  summarizeSandboxCheckpointGcApply,
  summarizeSandboxCheckpointGcPlan,
  withSandboxCheckpointGcApplySummary,
} from "./sandbox-checkpoint-gc.js"
export { createPrProvenanceReconciler } from "./pr-provenance-reconciler.js"
export type { OpenPrResolver } from "./pr-provenance-reconciler.js"
export { openPrForSession } from "./pr-open.js"
export type { OpenPrForSessionInput, OpenPrForSessionOutcome } from "./pr-open.js"
export { createActivityProjector } from "./activities.js"
export type {
  ActivityProjector,
  ActivityProjectorRegistry,
  ActivityProjectorSession,
  ActivityPolicyLister,
  ActivityWorkflowLister,
  PrStateResolver,
} from "./activities.js"
// The app-UI injection pipeline (bridge + display-mode toggle +
// runner-select), exported so a host — or a local harness that stands in for
// one, `scripts/dev/display-mode-host-harness.mjs` — can serve an app UI
// through the exact same path the daemon does instead of re-deriving it.
export { injectMcpAppBridge, MCP_APP_BRIDGE_SCRIPT } from "./app-ui-apps.js"
export { registerBrainTools } from "./brain-tools.js"
export {
  registerWebSearchTools,
  defineBraveSearchHttpDriver,
  defineSerperHttpDriver,
  webSearchTool,
} from "./web-search-tools.js"
export type {
  RegisterWebSearchToolsOptions,
  WebSearchInput,
  WebSearchOutput,
  WebSearchResult,
} from "./web-search-tools.js"
export type { RegisterBrainToolsOptions } from "./brain-tools.js"
export { HOST_CALLER, CallerScopes, callerScopes, CallerRefusedError } from "./caller-scope.js"
export type { CallerScope } from "./caller-scope.js"
export { createWorkspaceBrains, readSessionForBrain } from "./workspace-brains.js"
export type { WorkspaceBrains } from "./workspace-brains.js"
export {
  DEFAULT_BRAIN_MAX_TRANSCRIPT_BYTES,
  DEFAULT_BRAIN_MAX_TRANSCRIPT_TEXT_BYTES,
  resolveBrainIngestLimits,
  type BrainIngestLimits,
} from "./brain-ingest-limits.js"
export {
  createWorkspaceBrainSubscriber,
  type WorkspaceBrainSubscriber,
  type WorkspaceBrainSubscriberOptions,
} from "./workspace-brain-subscriber.js"
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
  createReviewRunner,
  createReviewLaneExecutor,
  hostPlaceholders,
  normalizeRemote,
  runShellLane,
} from "./review-runner.js"
export type {
  ReviewRun,
  ReviewRunInput,
  ReviewRunner,
  ReviewRunStatus,
  ReviewerRunResult,
  ReviewerSessionHost,
  CreateReviewRunnerOptions,
  ReviewComposeContext,
} from "./review-runner.js"
export {
  allowedSignersLine,
  defaultReviewKeysDir,
  ensureReviewSigningKey,
  fileExists,
  resolvePrincipal,
  signAttestation,
  verifySignedAttestation,
  SIGN_NAMESPACE,
} from "./review-signing.js"
export type { ReviewSignature, ReviewSigningKey, VerifySignedAttestationResult } from "./review-signing.js"
export { composedFromRangeSha, findComposeCandidate } from "./review-compose.js"
export type { ComposeCandidate, FindComposeCandidateInput } from "./review-compose.js"
export { createReviewPackLoader, defaultReviewPackCacheDir } from "./review-pack-loader.js"
export { createReviewLedger, defaultReviewLedgerRoot, repoSlug, withPr, withPrStatus } from "./review-ledger.js"
export type {
  ReviewLedger,
  LedgerEntry,
  LedgerHostMeta,
  ReviewLedgerFilter,
  LedgerAnnotations,
  PrStatusSnapshot,
} from "./review-ledger.js"
export {
  PrLookupError,
  execGh,
  fetchPrStatus,
  findPrForCommit,
  githubRepoOf,
  parsePrUrl,
  prHeadSha,
} from "./review-pr.js"
export type { GhRunner, PrLookupErrorCode } from "./review-pr.js"
export { createDaemonReviewerHost, resolveReviewerPreset } from "./review-reviewer-host.js"
export type { DaemonReviewerHostDeps } from "./review-reviewer-host.js"
export { registerReviewTools } from "./review-tools.js"
export type { RegisterReviewToolsOptions } from "./review-tools.js"
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
export { UserPresetValidationError, normalizeUserPreset } from "./user-presets.js"
export {
  resolveSessionConfig,
  presetChain,
  defaultPresetFor,
  presetAxes,
  SessionPresetResolutionError,
} from "./session-preset-resolver.js"
export type {
  SessionConfigAxis,
  SessionConfigLayer,
  SessionConfigAxes,
  SessionConfigResolution,
  HarnessPresetOverlay,
  ResolveSessionConfigInput,
} from "./session-preset-resolver.js"
export { composeModelPolicies } from "./model-policy.js"
export type { ModelPolicy, PolicyVerdict } from "./model-policy.js"
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
export {
  registerBrowserObserver,
  unregisterBrowserObserver,
  loadBrowserObserverModule,
  configureBrowserObservers,
  type BrowserObserver,
  type BrowserObserverRegistration,
  type BrowserAttachEvent,
  type BrowserDetachEvent,
  type BrowserCallEvent,
  type BrowserCallResultEvent,
  type BrowserScreenshotImage,
  type BrowserObserverModuleApi,
} from "./browser-observers.js"
export {
  makeBrowserAdapterLister,
  defaultBrowserAdapterResolution,
  defaultBrowserAdapterIds,
} from "./browser-adapters.js"
export { projectBrowserTools } from "./browser-projection.js"
export type {
  ProjectedBrowserTool,
  ProjectedBrowserTools,
  ProjectedProvider,
  ProjectedToolResult,
  ProjectBrowserToolsOptions,
} from "./browser-projection.js"
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
export {
  SANDBOX_EXEC_STREAM_MAX_CHARS,
  SANDBOX_EXEC_MAX_COMMAND_BYTES,
  SANDBOX_EXEC_MAX_ENV_BYTES,
  execSandboxCommand,
  registerSandboxExecTool,
  type ExecSandboxCommandOptions,
  type RegisterSandboxExecToolOptions,
  type SandboxExecCommandChoices,
  type SandboxExecFile,
  type SandboxExecOutput,
  type SandboxExecResult,
} from "./sandbox-exec.js"
export {
  DEFAULT_SANDBOX_GC_PROVIDER_SLUGS,
  DEFAULT_SANDBOX_PROVIDER_SLUGS,
  makeSandboxResolver,
  makeSandboxCredsStore,
} from "./sandbox-adapters.js"
export {
  readSandboxLedger,
  recordSandboxBoot,
  recordSandboxLiveness,
  recordSandboxOrigin,
  recordSandboxState,
  recordSessionDetach,
  removeSandboxLedgerEntry,
  resolveReuseFromLedger,
  sandboxLedgerPath,
  upsertSandboxLedger,
  type ReuseResolution,
  type SandboxLedgerEntry,
  type SandboxLedgerState,
} from "./sandbox-ledger.js"
export {
  collectGcCandidates,
  reapGcEntry,
  DEAD_SESSION_STATUSES,
  GC_REAPABLE_STATES,
  GONE_RE,
  isGoneError,
  sandboxGcShouldPause,
  type SandboxGcCandidate,
  type SandboxGcSessionLineage,
  type SandboxGcReapDeps,
  type SandboxGcProviderHandle,
  type SandboxGcReapResult,
} from "./sandbox-gc.js"
export {
  collectProviderOrphanCandidates,
  liveSessionBoxIds,
  ORPHAN_GRACE_MS,
  reapSandboxOrphan,
  runSandboxOrphanGcPass,
  scanSandboxProviderOrphans,
  type SandboxGcLiveSession,
  type SandboxOrphanCandidate,
  type SandboxOrphanGcPassResult,
  type SandboxOrphanReapResult,
  type SandboxOrphanScan,
  type SandboxOrphanScanDeps,
} from "./sandbox-orphan-gc.js"
export {
  collectSandboxInventory,
  type CollectSandboxInventoryOpts,
  type SandboxInventory,
  type SandboxInventoryProvider,
  type SandboxInventoryProviderInput,
  type SandboxInventorySource,
  type SandboxInventoryTotals,
} from "./sandbox-inventory.js"
export {
  reconcileSandboxLedger,
  type SandboxReconcileDeps,
  type SandboxReconcileProviderHandle,
  type SandboxReconcileResult,
  type SandboxReconcileRow,
  type SandboxReconcileVerdict,
} from "./sandbox-reconcile.js"
export {
  compactOutcome,
  deriveSessionOutcome,
  isOutcomeCompleted,
  type SessionOutcome,
  type SessionOutcomeArtifact,
  type SessionOutcomeCompact,
  type SessionOutcomeLink,
} from "./session-outcome.js"
export {
  SESSION_END_REASONS,
  isKnownSessionEndReason,
  isProviderLimitError,
  type SessionEndReason,
} from "./session-end-reason.js"
export {
  SESSION_LIST_FILTER_KEYS,
  SessionListFilterError,
  applySessionListFilters,
  compileSessionListFilters,
  hasSessionListFilters,
  isNoiseSession,
  isReviewOrWorkflowSession,
  parseSessionListFilterParams,
  parseTimeBound,
  pickSessionListFilters,
  sessionActivityMs,
  sessionListFilterShape,
  sortNewestActivityFirst,
  type SessionListFilterInput,
} from "./session-list-filters.js"
export { defaultTranscriptBaseDir, sessionEventsPath, sessionTranscriptDir, setDefaultSessionsBaseDir } from "./transcript-writer.js"
export {
  INDEX_DEFAULT_LIMIT,
  INDEX_MAX_OUTPUT,
  INDEX_MAX_PROMPT,
  INDEX_TAIL_BYTES,
  backfillSessionIndexes,
  backfillSessionIndexesAsync,
  buildSessionRecap,
  deriveIndexFromTranscript,
  indexEntryFromDescriptor,
  matchesSessionQuery,
  readAllSessionIndexes,
  readSessionIndex,
  readTranscriptTail,
  searchSessionIndexes,
  sessionIndexPath,
  writeSessionIndex,
  type SessionIndexEntry,
  type SessionRecap,
  type TranscriptPrompt,
  type TranscriptTail,
} from "./session-index.js"
export {
  COLD_TTL_MS,
  coldSessionDescriptor,
  coldSessionRows,
  resetColdSessionCache,
  sessionDescriptorFromIndexEntry,
} from "./session-cold-list.js"
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
  ToolPermissionRequest,
  ToolPermissionOutcome,
  PermissionRespondResult,
} from "./sessions.js"
// Value export (a class, used with `instanceof` at the HTTP/MCP boundary and by
// PR-4's eager pass) — not a type-only export like the block above.
export { ResumeDisabledError, SessionRetiredError } from "./sessions.js"
// Typed restart failures: `code` + human `reason` + optional `action`, so the
// HTTP/MCP/CLI/VS Code surfaces can show a sentence and a button instead of a
// provider's raw string (session-restart-core.ts).
export {
  SessionRestartError,
  RestartOverrideError,
  restartBlockerCode,
  sessionRestartErrorPayload,
  sessionRestartErrorBody,
  sessionRestartErrorStatus,
  SESSION_RESTART_REASONS,
  type SessionRestartErrorCode,
  type SessionRestartAction,
  type SessionRestartErrorPayload,
} from "./session-restart-core.js"
export { isRetired, resolveSuccessor, isAutomatedPromptSource } from "./session-retirement.js"
// Session identity env var names injected into every spawned process
// (assigned last, after caller-supplied env, so they cannot be forged).
export { SESSION_ID_ENV, WORKSPACE_SLUG_ENV } from "./sessions.js"
// Turn error stamped by the stall watchdog when a turn has produced no
// output/usage since its prompt (a provider silently retrying).
export { NO_OUTPUT_STALL_TURN_ERROR } from "./sessions.js"
export type {
  EagerResumeOutcome,
  EagerResumeSkipReason,
  EagerResumeFailReason,
} from "./sessions.js"
export { runEagerResumePass, type EagerResumeSummary } from "./eager-resume.js"
export { runSandboxReattachPass, type SandboxReattachSummary } from "./sandbox-reattach.js"
// Per-session process-tree resource stats (`session_stats`, `GET /sessions/stats`).
export {
  createProcessStatsService,
  getProcessStatsService,
  normalizeCommand,
  trackWorktreeProvision,
} from "./process-stats.js"
export type {
  CommandGroupStats,
  HostInfo,
  LabeledProcessStatsReport,
  LabeledSessionStats,
  OrphanGroup,
  ProcessDetail,
  ProcessStatsReport,
  ProcessStatsService,
  ProvisionInFlight,
  ResourceStats,
  SessionResourceStats,
  StatsDetail,
} from "./process-stats.js"
export {
  DEFAULT_HOST_LOAD_BUDGET_MS,
  DEFAULT_HOST_LOAD_THRESHOLDS,
  buildHostLoadReport,
  collectHostSample,
  computeHostWarnings,
  createDefaultHostProbes,
  createHostLoadService,
  describeOwner,
  getHostLoadService,
} from "./host-load.js"
export type {
  DiskLoad,
  HostLoadCpu,
  HostLoadDetail,
  HostLoadMemory,
  HostLoadReport,
  HostLoadService,
  HostLoadSwap,
  HostLoadThresholds,
  HostProbes,
  HostProcess,
  HostProcessOwner,
  HostSessionRollup,
  HostWarning,
  HostWarningKind,
} from "./host-load.js"
export {
  continueInterruptedSessions,
  continueSkipReason,
  runContinueOnBootPass,
  DEFAULT_CONTINUE_PROMPT,
  CONTINUE_PROMPT_SOURCE,
  MAX_AUTO_CONTINUE_ATTEMPTS,
  type ContinueInterruptedMode,
  type ContinueInterruptedOutcome,
  type ContinueInterruptedResult,
  type ContinueInterruptedSkipReason,
  type ContinueOnBootSummary,
} from "./continue-interrupted.js"
export {
  DEFAULT_REVIEW_SESSION_RETENTION_DAYS,
  DEFAULT_SESSION_RETENTION_BOOT_DELAY_MS,
  DEFAULT_SESSION_RETENTION_INTERVAL_MS,
  isReviewLaneSession,
  runSessionRetentionPass,
  type SessionRetentionOptions,
  type SessionRetentionRegistry,
  type SessionRetentionResult,
} from "./session-retention.js"
export {
  DEFAULT_ADAPTER_CACHE_RETENTION_DAYS,
  LEGACY_CACHE_PATHS,
  runAdapterCacheRetentionPass,
  type AdapterCacheRetentionOptions,
  type AdapterCacheRetentionRegistry,
  type AdapterCacheRetentionResult,
} from "./adapter-config-retention.js"
export {
  DEFAULT_SANDBOX_IDLE_REAP_AFTER_MS,
  runIdleReapPass,
  type IdleReapSummary,
  type IdleReaperRegistry,
} from "./idle-reaper.js"
export {
  DEFAULT_PAUSED_BOX_MAX_AGE_MS,
  DEFAULT_SANDBOX_GC_INTERVAL_MS,
  parsePausedBoxMaxAge,
  startSandboxGcTimer,
  runSandboxGcPass,
  type SandboxGcTimer,
  type SandboxGcPassSummary,
  type SandboxGcReadDeps,
} from "./sandbox-gc.js"
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
export {
  measureTool,
  measureToolList,
  type MeasurableTool,
  type MeasuredToolEntry,
  type ToolListMeasurement,
} from "./tool-schema-measure.js"
export { extractHelpSection, getToolHelp, listToolHelpTopics } from "./tool-help.js"
export { deriveSessionUsage, pickUsageDetail, projectSessionUsage } from "./usage.js"
export { rollupSessionSubtree } from "./usage-subtree.js"
export type {
  SessionUsageWithSubtree,
  SubtreeChildUsage,
  SubtreeUsageTotals,
} from "./usage-subtree.js"
export {
  composeSessionObservers,
  type SessionObserver,
  type SessionMessageSentRecord,
} from "./session-observer.js"
export * from "./session-message.js"
export {
  DEFAULT_ROOT_AGENT,
  DEFAULT_NESTED_AGENT,
  unknownDefaultAgents,
  type DefaultAgentConfig,
} from "./role.js"
export type { DelegationGateMode, DelegationVerdict, DelegationReport } from "./delegation-gate.js"
export type { ProfileGateMode, ProfileVerdict, ProfileReport } from "./profile-gate.js"
export {
  decide as decidePermission,
  collectMessageRelations,
  assertDecisionAllows,
  isPermissionAction,
  PermissionDeniedError,
  PERMISSION_ACTIONS,
  PERMISSION_ACTION_INFO,
  type Decision as PermissionDecision,
  type DecisionBody as PermissionDecisionBody,
  type PermissionAction,
  type PermissionContext,
  type PermissionResource,
  type Principal as PermissionPrincipal,
} from "./permissions.js"
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
  UsageDetail,
  UsageReadContext,
  UsageReadResult,
} from "./usage.js"
export { parseWindow, rollupUsage } from "./usage-rollup.js"
export type {
  UsageSnapshotRecord,
  SessionSnapshots,
  UsageBucket,
  UsageRollup,
} from "./usage-rollup.js"
export { projectRemoteUsage } from "./sandbox-usage.js"
export type { RemoteUsageSnapshot } from "./sandbox-usage.js"
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
export { buildSessionReport } from "./session-report.js"
export type {
  SessionReport,
  SessionReportInput,
  SessionReportOpenedPr,
  SessionReportCountEntry,
  SessionReportCostBucket,
  SessionReportTopEntry,
  SessionReportPrEntry,
  SessionReportActiveEntry,
} from "./session-report.js"
export { collectSessionReportInputs, buildSessionReportFromRegistry } from "./session-report-service.js"
import { RemoteController } from "./remote-controller.js"
import { registerRemoteTools } from "./remote-tools.js"
import { registerPairingTools } from "./pairing-tools.js"
import type { PairingRegistry } from "./pairing-registry.js"
import type { HostRegistry } from "./host-registry.js"
import { createDeviceSandboxProvider } from "./sandbox-providers/device.js"
import type { SandboxProviderHandle } from "./sandbox-providers/types.js"
import type { JoinTokenRegistry } from "./join-token-registry.js"
import { createDeviceRegistry, type DevicePromptSessionsLike } from "./device-registry.js"
import { registerDeviceTools } from "./device-tools.js"
import { syncDeviceMirror } from "./device-mirror.js"
import { registerDaemonHealthTools } from "./daemon-health-tools.js"
import { registerCatalogDiffTool } from "./catalog-diff-tool.js"
import { registerQuotaStatusTool } from "./quota-status-tool.js"
import { registerMemoryTools, resolveMemoryCaller } from "./memory-tools.js"
import { defaultMemoryRoot, memoryStoreAt, setDefaultMemoryRoot } from "./memory-stores.js"
import { respawnMemoryProjection } from "./memory-digest.js"
import { buildRouteAwareLaunchConfig } from "./launch-config.js"
import { registerToolHelpTool } from "./tool-help-mcp.js"
import { TunnelRegistry } from "./tunnel-registry.js"
import { registerTunnelTools } from "./tunnel-tools.js"
import { registerAppTunnelTools } from "./app-tunnel-tools.js"
import { LlmEndpointRegistry } from "./llm-endpoint-registry.js"
import { registerLlmEndpointTools } from "./llm-endpoint-tools.js"
import { registerBuiltinRoutes } from "./builtin-routes.js"
import {
  registerTunnelAdapterTools,
  makeTunnelCredsStore,
} from "./tunnel-adapters.js"
import {
  registerSentinelAdapterTools,
  makeSentinelCredsStore,
} from "@agentproto/sentinel"
import {
  registerSandboxAdapterTools,
  makeSandboxResolver,
  makeSandboxCredsStore,
  type SandboxProviderResolver,
  type SandboxProviderLister,
} from "./sandbox-adapters.js"
import { registerSandboxAttachTool } from "./sandbox-attach.js"
import { registerSandboxExecTool } from "./sandbox-exec.js"
import type { WorktreeProvisioner, WorktreeAutoReclaimer, SandboxCheckpointReclaimer } from "./worktree-isolation.js"
import { registerEvalReporterTools } from "./eval-reporter-tools.js"
import { registerPresetTools } from "./preset-tools.js"
import { createWorkspaceFs, type WorkspaceFs } from "./workspace-fs.js"
import { DELEGATION_TOOL_NAMES } from "./role.js"

import "./sentinel-platform.js"

export type { ConversationStore, ConversationMeta, ConversationTurn } from "./conversations.js"
export type { HeartbeatRunner, BuildHeartbeatAgent, HeartbeatAgent } from "./heartbeat.js"
export type { RuntimeEvent, RuntimeEvents } from "./events.js"
export type { WorkspaceFs } from "./workspace-fs.js"
export type { TunnelDescriptor, TunnelStatus, TunnelProvider } from "./tunnel-registry.js"
export type { TunnelHealth, TunnelHealthState } from "./remote-providers/types.js"
export { TunnelStartAbortedError } from "./remote-providers/types.js"
export { buildSessionLink } from "./tunnel-links.js"
export type { AppTunnelResult } from "./app-tunnel-tools.js"
// Session-follow (wake a session on other sessions' events).
export {
  createSessionFollowStore,
  FOLLOW_EVENTS,
  type FollowEvent,
  type SessionFollow,
  type SessionFollowStore,
} from "./session-follow-store.js"
export { wireSessionFollow, type SessionFollowHandle } from "./session-follow.js"
// Session-follow triage (deterministic pre-wake classification).
export {
  classifyFollowEvent,
  defaultFollowTriageConfig,
  isTriageDecision,
  parseClassifierAnswer,
  resolveFollowTriageConfig,
  runFollowTriageClassifier,
  triageFollowEvent,
  DEFAULT_FOLLOW_TRIAGE_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_FOLLOW_TRIAGE_REPORT_WINDOW_MS,
  DEFAULT_FOLLOW_TRIAGE_RULES,
  FOLLOW_TRIAGE_DECISIONS,
  TRIAGE_RULES,
  type FollowTriageClassifier,
  type FollowTriageConfig,
  type FollowTriageInput,
  type FollowTriageRules,
  type TriageDecision,
  type TriageEvent,
  type TriageFacts,
  type TriageResult,
} from "./follow-triage.js"
// MCP Events adapter (W-C of .plans/sentinel-mcp-events): deterministic
// subscription ids, the per-scheme event registry, and the three native
// methods' logic (`eventsList`/`eventsSubscribe`/`eventsUnsubscribe`). The
// native JSON-RPC transport + `server/discover` capability live in
// `@agentproto/mcp-server` (`registerEventsMethods`).
export {
  eventsList,
  eventsSubscribe,
  eventsUnsubscribe,
  toMcpEvent,
  computeRefreshBefore,
  untilForTtl,
  McpEventsError,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MIN_TTL_MS,
  type EventsListRequest,
  type EventsListContext,
  type EventsListResult,
  type EventsSubscribeInput,
  type EventsSubscribeContext,
  type EventsSubscribeResult,
  type EventsUnsubscribeInput,
  type EventsUnsubscribeContext,
} from "./mcp-events/adapter.js"
export {
  subscriptionId,
  canonicalizeJcs,
  type SubscriptionIdentity,
} from "./mcp-events/subscription-id.js"
export {
  GITHUB_SCHEME,
  EVENT_REGISTRY,
  tenantScope,
  findEventDefinition,
  validateAgainstInputSchema,
  daemonBearerPrincipal,
  sessionPrincipal,
  type Principal,
  type EventDefinition,
  type InternalEventMeta,
  type EventRegistration,
  type SchemeRegistry,
  type ArgumentsResult,
} from "./mcp-events/events-registry.js"
// Webhook egress primitives (W-A of .plans/sentinel-mcp-events):
// Standard Webhooks signing, SSRF-guarded POST gate, challenge verification,
// signed event delivery. Consumed in-process by the mcp-events adapter (W-C).
export {
  signWebhook,
  decodeWhsecSecret,
  encodeWhsecSecret,
  type WebhookSignInput,
  type WebhookSignatureHeaders,
} from "./webhook-egress/signing.js"
export {
  ssrfFetch,
  SsrfFetchError,
  isPubliclyRoutable,
  setEgressDispatcherForTests,
  type SsrfFetchInit,
  type SsrfFetchResult,
  type SsrfFetchReason,
  type EgressDispatcher,
} from "./webhook-egress/ssrf-fetch.js"
export {
  verifyCallback,
  challengeReasonForSsrf,
  normalizeCallbackUrl,
  resetChallengeCacheForTests,
  challengeCacheSize,
  type VerifyCallbackInput,
  type ChallengeOutcome,
  type ChallengeFailureReason,
} from "./webhook-egress/challenge.js"
export {
  deliverEventEnvelope,
  deliveryBackoffDelay,
  serializeEnvelope,
  envelopeClampedBytes,
  CLAMP_LIMIT_BYTES,
  MAX_ATTEMPTS,
  type DeliveryReplay,
  type DeliveryState,
  type DeliveryOutcome,
  type McpEventEnvelope,
} from "./webhook-egress/delivery.js"
export type {
  LlmEndpointStatusReport,
  LlmEndpointDescriptor,
  LlmEndpointStatus,
} from "./llm-endpoint-registry.js"
export { resolveEffectiveLlmEndpointFlag } from "./llm-endpoint-feature-flag.js"
export type { EnableInput, EnableResult, RemoteStatus } from "./remote-controller.js"
export {
  decideWorktreeIsolation,
  loadWorktreeIsolation,
  normalizeWorktreeField,
  parseWorktreeIsolationMode,
  WORKTREE_ISOLATION_ENV,
  DEFAULT_WORKTREE_ISOLATION,
  WORKTREE_PROVISION_CONCURRENCY_ENV,
  DEFAULT_WORKTREE_PROVISION_CONCURRENCY,
} from "./worktree-isolation.js"
export type {
  WorktreeField,
  WorktreeIsolationMode,
  WorktreeProvisioner,
  WorktreeAutoReclaimer,
  SandboxCheckpointReclaimer,
  WorktreeProvisionRequest,
  WorktreeProvisionOutcome,
  WorktreeProvisionPhase,
  WorktreeProvisionProgress,
  WorktreeDecision,
  WorktreeRequest,
} from "./worktree-isolation.js"
export {
  createPairingRegistry,
  readPairingsSnapshot,
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
  createHostRegistry,
  HOSTS_VERSION,
  readHostsSnapshot,
  HOST_HANDSHAKE_REMEDIATION_HINT,
  type HostRegistry,
  type HostRegistryDeps,
  type HostRecord,
  type HostJoinMeta,
  type ForwardHttpRequest,
  type ForwardHttpResponse,
} from "./host-registry.js"
export {
  createJoinTokenRegistry,
  JOIN_TOKENS_VERSION,
  type JoinTokenRegistry,
  type JoinTokenRegistryDeps,
  type JoinTokenRecord,
  type CreateJoinTokenInput,
  type CreatedJoinToken,
} from "./join-token-registry.js"
export {
  createDeviceRegistry,
  promptHostSession,
  promptDeviceSession,
  resolveDevicePromptMapping,
  isNoSessionPromptFailure,
  DEVICE_PROMPT_PATH_PREFIX,
  type Device,
  type DeviceRole,
  type DeviceKind,
  type DeviceRegistry,
  type PromptHostSessionInput,
  type PromptHostSessionResult,
  type DevicePromptSessionsLike,
} from "./device-registry.js"
export { registerDeviceTools, type RegisterDeviceToolsOptions } from "./device-tools.js"
export {
  syncDeviceMirror,
  fetchHostTurns,
  mirrorCursorForSession,
  hostRecordToMirrorRecord,
  seedWalkForTranscript,
  type DeviceMirrorSyncResult,
  type FetchHostTurnsResult,
  type HostEventRecord,
  type DeviceMirrorTarget,
} from "./device-mirror.js"
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
  postureEnforcement,
  findNativeMode,
  canonicalForModeId,
  normalizeModeId,
  POSTURE_PREAMBLES,
  POSTURE_NATIVE_ALIASES,
} from "./canonical-posture.js"
export type { PostureEnforcement, PostureResolution, SessionMode } from "./canonical-posture.js"
export { parseDuration } from "./heartbeat.js"
export { servingCliCommand, setServingCli } from "./native-hooks-defaults.js"
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
export {
  sweepStaleRuntimeMetas,
  unlinkRuntimeMeta,
  readRuntimeMeta,
  daemonRegistryDir,
  readDaemonRegistry,
  bucketsServedByOtherLiveDaemons,
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
  orchestratorScopesFile,
  adoptLegacyOrchestratorScopes,
  collectReferencedOrchestratorScopeTokens,
  pruneOrchestratorScopesOnBoot,
  type OrchestratorScope,
  type ScopeTokenRegistry,
  type ScopeTokenRegistryOptions,
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

/** Concurrency cap for the boot-time passes (eager resume, continue-on-boot)
 *  so a box-wide restart doesn't spawn every adapter at once (§5
 *  "Resume-storm control"). Default 4; override via
 *  AGENTPROTO_RESUME_CONCURRENCY, mirroring AGENTPROTO_POLICY_CONCURRENCY. */
function bootResumeConcurrency(): number {
  const raw = process.env.AGENTPROTO_RESUME_CONCURRENCY
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4
}

/** Per-row deadline for the boot sandbox reattach pass (connect + daemon
 *  connect + probe) — see `runSandboxReattachPass`'s `timeoutMs`. Default
 *  {@link DEFAULT_REATTACH_TIMEOUT_MS}; override via
 *  AGENTPROTO_REATTACH_TIMEOUT_MS, mirroring AGENTPROTO_RESUME_CONCURRENCY. */
function bootSandboxReattachTimeoutMs(): number {
  const raw = process.env.AGENTPROTO_REATTACH_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REATTACH_TIMEOUT_MS
}

/** Build the dead-session restart hook the routing paths share (PR C).
 *  An ended-but-resumable agent-cli row is revived IN PLACE (same id) via
 *  the registry's resume primitive instead of minting a new row — the
 *  sentinel's re-target then no-ops. The flag splits the callers by INTENT:
 *   - the SENTINEL is an AUTOMATIC path — a deliberate end
 *     (operator-completed / steward-*) is never revived in place; it
 *     falls back to today's new-id restart (and the sentinel's own
 *     sessionInfo guard routes deliberate ends to the parent / parking
 *     before this is ever reached).
 *   - INBOUND (watcher + push router) is a HUMAN writing to the session —
 *     explicit intent, so a deliberate end may still be revived in place. */

/** Env overrides for the workflow runner's run-history bounds. Unset / invalid
 *  values keep the runner's defaults. */
function workflowRunnerEnvOptions(env: NodeJS.ProcessEnv): {
  outputLimits?: Partial<{ stepInlineBytes: number; previewChars: number; runBudgetBytes: number; runOutputInlineBytes: number; errorChars: number }>
  summaryMaxCount?: number
  summaryMaxAgeMs?: number
  approvalTtlMs?: number
} {
  const num = (key: string): number | undefined => {
    const n = Number.parseInt(env[key] ?? "", 10)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const limits = {
    stepInlineBytes: num("AGENTPROTO_WORKFLOW_STEP_OUTPUT_BYTES"),
    previewChars: num("AGENTPROTO_WORKFLOW_OUTPUT_PREVIEW_CHARS"),
    runBudgetBytes: num("AGENTPROTO_WORKFLOW_RUN_OUTPUT_BUDGET_BYTES"),
    runOutputInlineBytes: num("AGENTPROTO_WORKFLOW_RUN_RESULT_BYTES"),
    errorChars: num("AGENTPROTO_WORKFLOW_ERROR_CHARS"),
  }
  const outputLimits = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined))
  const summaryMaxCount = num("AGENTPROTO_WORKFLOW_SUMMARY_MAX")
  const summaryMaxAgeMs = num("AGENTPROTO_WORKFLOW_SUMMARY_MAX_AGE_MS")
  const approvalTtlMs = num("AGENTPROTO_WORKFLOW_APPROVAL_TTL_MS")
  return {
    ...(Object.keys(outputLimits).length > 0 ? { outputLimits } : {}),
    ...(summaryMaxCount !== undefined ? { summaryMaxCount } : {}),
    ...(summaryMaxAgeMs !== undefined ? { summaryMaxAgeMs } : {}),
    ...(approvalTtlMs !== undefined ? { approvalTtlMs } : {}),
  }
}

export function makeRestartForRouting(
  deps: {
    sessions: SessionsRegistry
    resolveAgentAdapter: AgentAdapterResolver | undefined
    /** Daemon's own `/mcp` base URL — threaded into `restartPreferInPlace` so
     *  a new-id restart re-stamps `mcpServers`' `callerSessionId` with the
     *  FRESH session's id instead of either keeping the dead OLD id or (worse)
     *  silently stripping it to no identity at all — see
     *  `RestartAgentSessionOptions.daemonMcpUrl`'s doc (session-restart-core.ts). */
    daemonMcpUrl?: string
  },
  config: { name: string; allowDeliberateEnd: boolean },
): (id: string) => Promise<string> {
  return async (id: string): Promise<string> => {
    const desc = deps.sessions.get(id)
    if (!desc) {
      throw new Error(`${config.name}: no session "${id}"`)
    }
    if (desc.kind === "external") {
      throw new Error(
        `${config.name}: session "${id}" is an external session (no process the daemon can restart)`,
      )
    }
    if (!deps.resolveAgentAdapter) {
      throw new Error(
        `${config.name}: session "${id}" is not alive and agent restart is not enabled (no resolveAgentAdapter)`,
      )
    }
    // A retired row with a successor never restarts: route to the successor
    // (end of the `continuedTo` chain) — alive → use as-is, dead → revive
    // THAT one (unless it is retired itself, which throws below).
    const successorId = resolveSuccessor(sid => deps.sessions.get(sid), id)
    if (successorId) {
      const successor = deps.sessions.get(successorId)
      if (successor && (successor.status === "running" || successor.status === "starting")) {
        return successorId
      }
      if (successor && !isRetired(successor)) {
        const revived = await restartPreferInPlace(deps.sessions, deps.resolveAgentAdapter, successor, {
          forceAgentResume: true,
          allowDeliberateEnd: config.allowDeliberateEnd,
          ...(deps.daemonMcpUrl ? { daemonMcpUrl: deps.daemonMcpUrl } : {}),
        })
        return revived.desc.id
      }
      // The whole chain is retired: reviving the original would resurrect a
      // superseded row, so refuse and name where the conversation went.
      throw new SessionRetiredError(id, desc.status, config.name, successorId)
    }
    // An archived row is never brought back under a NEW id, even for a human
    // (inbound) writer: the new-id fallback of `restartPreferInPlace` would
    // mint a zombie next to whatever replaced it. (In-place resume already
    // excludes archived rows via `isResumable`.)
    if (desc.archived === true) {
      throw new SessionRetiredError(id, desc.status, config.name)
    }
    const restarted = await restartPreferInPlace(deps.sessions, deps.resolveAgentAdapter, desc, {
      forceAgentResume: true,
      allowDeliberateEnd: config.allowDeliberateEnd,
      ...(deps.daemonMcpUrl ? { daemonMcpUrl: deps.daemonMcpUrl } : {}),
    })
    return restarted.desc.id
  }
}

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
  /** Which sessions automatic boot recovery restores; all preserves legacy behavior. */
  bootResumePolicy?: "all" | "keepalive"
  /** Idle cutoff, in minutes, for eagerly resuming a `keepAlive` session after
   *  a daemon restart. Mirrors the
   *  `daemon.bootResumeKeepAliveMaxIdleMinutes` config knob; default 30. A
   *  `keepAlive` row idle longer than this (measured from its last turn-end)
   *  stays dead-but-lazy-resumable instead of being respawned on every boot.
   *  Only explicitly pinned rows are always resumed; an operator label does
   *  not exempt a row. 0 disables the cutoff. */
  bootResumeKeepAliveMaxIdleMinutes?: number
  /** Boot re-ensure of app-service owners. Mirrors the
   *  `daemon.resumeServicesOnBoot` config knob; DEFAULT ON (services are
   *  deterministic processes, so the agent-adapter spawn-storm concerns
   *  behind `resumeSessionsOnBoot`'s default-off do not apply). When
   *  explicitly false, `reensureAppServicesOnBoot()` short-circuits to an
   *  `enabled: false` summary. Surfaced in `daemon_health` / `GET /health`. */
  resumeServicesOnBoot?: boolean
  /** Opt-in continue-on-boot. Mirrors the `daemon.continueInterruptedOnBoot`
   *  config knob; when true, the `continueInterruptedOnBoot()` handle method
   *  runs the boot continue pass (see `continue-interrupted.ts`); when
   *  false/omitted it short-circuits to an `enabled: false` summary. Surfaced
   *  in `daemon_health` / `GET /health`. */
  continueInterruptedOnBoot?: boolean
  /** Idle agent-session reaper threshold in ms (PR-6). Mirrors the
   *  `daemon.idleReapAfterMs` config knob; the CLI resolves it (env >
   *  config > off) and passes it here. When positive, the gateway starts a
   *  periodic sweep that retires agent-cli sessions idle longer than this
   *  (SIGTERM the adapter child, flip to `killed`/`endedReason:"idle-reaped"`,
   *  kept lazy-resumable). Unset / 0 / negative ⇒ the reaper never runs.
   *  Surfaced in `daemon_health` / `GET /health`. */
  idleReapAfterMs?: number
  /** Idle threshold in ms for SANDBOXED sessions. Mirrors the
   *  `daemon.sandboxIdleReapAfterMs` config knob (the CLI resolves env >
   *  config > default). DEFAULT ON, unlike `idleReapAfterMs`: unset applies
   *  {@link DEFAULT_SANDBOX_IDLE_REAP_AFTER_MS} (15 min); an explicit
   *  non-positive value turns it off. A sandboxed session idle this long gets a
   *  final checkpoint, its box torn down and a ledger row; it stays revivable
   *  on a fresh box. Surfaced in `daemon_health` / `GET /health`. */
  sandboxIdleReapAfterMs?: number
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
  /** `daemon.sandboxGoneRestartDefault` — OFF unless set. When true, a BOX
   *  session spawned with no explicit `agent_start.restartPolicy` is stamped
   *  with {@link SANDBOX_GONE_DEFAULT_RESTART_POLICY}, so a box session whose
   *  box is gone is moved to a fresh box by the restart scheduler instead of
   *  staying dead. An explicit per-session `restartPolicy` always wins, and
   *  nothing else changes — classic `crashed`/`error` in-place revival still
   *  needs its own opt-in. Turning this on with `restartSweepIntervalMs`
   *  unset also arms the sweep at 30s (the scheduler only SCHEDULES; the
   *  sweep EXECUTES), so the opt-in works out of the box. */
  sandboxGoneRestartDefault?: boolean
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
  /** Liveness window (ms) of an `external` session after its last MCP request
   *  / inbox poll. Mirrors `daemon.externalSessionLivenessMs`; unset or
   *  non-positive ⇒ the registry default (30 min). */
  externalSessionLivenessMs?: number
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
   * Optional branch-`gc` runner powering `branch_gc` (+ `POST /branches/gc`).
   * Injected for the same reason as `runWorktreeGc`. Omitted → `branch_gc`
   * returns a clear "not enabled" error.
   */
  runBranchGc?: BranchGcRunner
  /**
   * Optional sandbox-checkpoint-`gc` runner powering
   * `sandbox_checkpoint_gc`. Injected for the same reason as `runBranchGc`.
   * Omitted → the tool returns a clear "not enabled" error.
   */
  runSandboxCheckpointGcSweep?: SandboxCheckpointGcRunner
  /** Optional verdict recorder powering `branch_gc_verdict` (+ `POST /branches/gc/verdict`). */
  recordBranchGcVerdict?: BranchGcVerdictRecorder
  /** Optional verdict reader powering `branch_gc_verdict_get`. */
  readBranchGcVerdict?: BranchGcVerdictReader
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
   * Optional best-effort exit-time deletion of one sandboxed session's
   * `agentproto-checkpoint/<branch>` remote ref once its work is provably
   * elsewhere (see `sandbox-checkpoint-gc`, the engine over
   * `@agentproto/worktree`). Injected like `runWorktreeAutoReclaim` because
   * the classify/delete logic runs there. Omitted → nothing is deleted at
   * exit; `agentproto sandbox checkpoint-gc` remains the manual tool.
   */
  runSandboxCheckpointGc?: SandboxCheckpointReclaimer
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
  /**
   * Optional HOST registry (see `createHostRegistry`, DEVICES-PLAN PR-C) —
   * the reverse-pairing "client" half of pair/v2, living daemon-side. When
   * wired alongside `pairingRegistry`, the gateway layers registered hosts
   * into `device_list`/`GET /devices`, and enables the `device_add` MCP tool
   * plus `POST /devices/add` + `POST /devices/:id/exec`. Unlike
   * `pairingRegistry`, this registry keeps no standing connections — every
   * `add`/`forwardHttp` dials fresh — so there is nothing for the gateway to
   * autoconnect or tear down on shutdown.
   */
  hostRegistry?: HostRegistry
  /**
   * Optional JOIN TOKEN registry (see `createJoinTokenRegistry`,
   * SANDBOX-VISIBILITY-JOIN). When wired alongside `pairingRegistry` +
   * `hostRegistry`, the gateway mounts `POST/GET /devices/join-tokens` +
   * `DELETE /devices/join-tokens/:id`, the `join_token_create/list/revoke`
   * MCP tools, and `device_sessions`/`GET /devices/:id/sessions[/…/output]`.
   * Autoconnect is the caller's to start (after this returns), same as
   * `pairingRegistry`.
   */
  joinTokens?: JoinTokenRegistry
  /** Enable the local LLM Endpoint proxy sidecar (route registration,
   *  MCP tools, child-process lifecycle). Default false — the endpoint is
   *  an opt-in feature; when off, the `llm-endpoint` custom route is not
   *  registered and the `llm_endpoint_*` MCP tools are not exposed. */
  llmEndpoint?: boolean
  /** Mirrors `config.features.deviceInferenceShare` (DEVICES-PLAN item 1).
   *  Default false. Only meaningful alongside `llmEndpoint: true` — passed
   *  straight through to `startHttpServer`'s `deviceInferenceShare`, which
   *  gates `/device-inference/*` (see http-server.ts's `HOST_SCOPE_HEADER`
   *  doc comment for the full scope-gate story). */
  deviceInferenceShare?: boolean
  /** Mirrors `config.features.deviceSpawnAllow` (DEVICES-PLAN PR-D). Default
   *  false. Passed straight through to `startHttpServer`'s
   *  `deviceSpawnAllow`, which gates `/device-spawn/*` — this daemon acting
   *  as the RECEIVING end of an `agent_start({ sandbox: "device:<name>" })`
   *  spawn driven from a paired controller. */
  deviceSpawnAllow?: boolean
}

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

/** Sweep interval used when `sandboxGoneRestartDefault` is on and no explicit
 *  `restartSweepIntervalMs` was configured — the opt-in is meaningless while
 *  the sweep that EXECUTES a scheduled fresh-box move is unarmed, so it arms
 *  one rather than silently doing nothing. Same cadence as the crash-detect
 *  sweep: frequent enough to move a dead-box session promptly, cheap enough
 *  to run forever. Never applies to a caller that didn't opt in. */
const DEFAULT_SANDBOX_GONE_RESTART_SWEEP_MS = 30_000

/**
 * Default always-on set when `deferredTools` is enabled without an
 * explicit `alwaysOn` override: the core spawn/drive/observe/report loop
 * most sessions need immediately — including an EXECUTOR (the role
 * `deferredTools` defaults on for, see `role.ts`), which cannot spawn
 * (`agent_start`/`agent_prompt` are stripped for it anyway by
 * `toolPolicy.delegation: "deny"`, so those two names are simply absent
 * from a deny-role's registry and cost nothing) but still needs to report
 * back to its parent (`message_parent`), coordinate over the task ledger
 * (`task_*`), and observe its own session/turn state and capabilities
 * (`session_context_status` / `session_capabilities` alongside the
 * pre-existing `session_list` / `session_monitor` / `session_events_poll`).
 * Everything else (fs_*, directory_*, command_*, remote_*, browser_*, terminal_*, mcp_*,
 * routine_*, workflow_*, policy_*, inbound_watcher_*, session_tree,
 * agent_export, adapter_list, every `app_ui_*` panel tool, ...) starts
 * deferred — reachable via `tool_search`, never removed from `tools/call`.
 */
export const DEFAULT_ALWAYS_ON_TOOLS: readonly string[] = [
  "daemon_health",
  "tool_help",
  "agent_start",
  "agent_prompt",
  "agent_output",
  "agent_kill",
  "session_list",
  "session_commands",
  "session_monitor",
  "session_events_poll",
  "session_context_status",
  "session_capabilities",
  "permissions_list",
  "permissions_respond",
  "app_tool_call",
  "message_parent",
  // Typed messaging (AIP-46 §Session messages): send to a tree neighbour,
  // and the receive side a supervisor loops on instead of ending its turn.
  "message_send",
  "inbox_wait",
  "inbox_list",
  "task_claim",
  "task_create",
  "task_list",
  "task_update",
  "quota_status",
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
  /** HOST registry, when one was wired via `CreateGatewayOptions.hostRegistry`
   *  (DEVICES-PLAN PR-C). Undefined otherwise. No autoconnect/shutdown to
   *  call on it — see that option's doc comment. */
  hosts?: HostRegistry
  /** JOIN TOKEN registry, when one was wired via
   *  `CreateGatewayOptions.joinTokens` (SANDBOX-VISIBILITY-JOIN). Undefined
   *  otherwise. Exposed so the CLI can `startAutoconnect()` after boot and
   *  `shutdown()` it, same as `pairing`. */
  joinTokens?: JoinTokenRegistry
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
  /** Run the opt-in continue-on-boot pass and return its tally — a no-op
   *  returning `{ enabled: false, ... }` when the `continueInterruptedOnBoot`
   *  knob is off. serve.ts invokes this right AFTER `resumeSessionsOnBoot()`
   *  (so a row whose eager resume failed is recognisable and skipped) — and
   *  therefore, like it, after the supervisor was re-armed, so a re-armed
   *  completion policy sees the continue turn's turn-end. Same `isServed`
   *  cross-process gate. */
  continueInterruptedOnBoot(opts?: {
    isServed?: (desc: SessionDescriptor) => boolean
  }): Promise<ContinueOnBootSummary>
  /** Boot re-ensure of app-service owners (Pygmalion phase 1b item 2).
   *  `app_install`'s `ensureServices` runs only on the install path, so a
    *  service whose owner died with the previous daemon stays down until the
    *  next reinstall; this force-replaces every recorded owner at boot. Gated
    *  by its OWN `resumeServicesOnBoot` knob (default ON — services are
    *  deterministic processes, so the agent-adapter spawn-storm concerns
    *  behind resumeSessionsOnBoot's default-off don't apply); a no-op
    *  returning `{ enabled: false, ... }` when it is disabled. serve.ts calls
    *  this AFTER the resume/sandbox passes so it never races them for an owner
    *  session id. */
  reensureAppServicesOnBoot(): Promise<{
    enabled: boolean
    apps: number
    spawned: number
    errors: string[]
  }>
  /** Daemon-startup backfill for the per-session index sidecars
   *  (`session-index.ts`): create a compact `index.json` for every session dir
   *  that lacks one, recovering the last prompt/output from the transcript
   *  tail (never a whole-file parse). Async, batched and best-effort — the
   *  scan yields to the event loop between batches, so a store with
   *  thousands of sessions never blocks boot. serve.ts fires this once at
   *  boot (not awaited) so `agentproto sessions find`/`recap` answer
   *  instantly even for sessions that predate the sidecar. */
  backfillSessionIndexes(): Promise<{ scanned: number; created: number; skipped: number }>
  /** Run the sandbox reattach pass: reconnect to provider boxes whose
   *  sessions the previous daemon process detached from, re-binding each to
   *  its original session id. serve.ts calls this BEFORE
   *  `resumeSessionsOnBoot()` so the eager/continue passes never touch a row
   *  that is about to be re-attached. Always on — it only acts on rows that
   *  were detached. `isServed` is the same cross-process gate. */
  reattachSandboxSessionsOnBoot(opts?: {
    isServed?: (desc: SessionDescriptor) => boolean
  }): Promise<SandboxReattachSummary>
  /** Run the reaction receipt boot reconciliation pass and return the post-pass
   *  tally. Never throws: a failure is logged and reported as zeros. */
  reconcileReactionsOnBoot(): Promise<{
    total: number
    pending: number
    running: number
    failed: number
    dead: number
  }>
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
  // Model lists are user data loaded once at boot; the sync source serves the
  // seed lists before this completes and the persisted file after.
  await loadModelListSource()
  // Effective idle-reap threshold (PR-6): a positive ms value enables the
  // periodic reaper, anything else (unset / 0 / negative) keeps it off. Kept as
  // a plain `0`-means-off number so `daemon_health` / `GET /health` can surface
  // one unambiguous figure.
  const idleReapAfterMs =
    typeof opts.idleReapAfterMs === "number" && opts.idleReapAfterMs > 0
      ? opts.idleReapAfterMs
      : 0
  // Effective sandbox idle-reap threshold: DEFAULT ON (15 min), unlike
  // idleReapAfterMs — an idle box is a billed VM. An explicit non-positive
  // value is the opt-out.
  const sandboxIdleReapAfterMs =
    typeof opts.sandboxIdleReapAfterMs === "number"
      ? opts.sandboxIdleReapAfterMs > 0
        ? opts.sandboxIdleReapAfterMs
        : 0
      : DEFAULT_SANDBOX_IDLE_REAP_AFTER_MS
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
  // positive ms value before the sweep ever runs. The ONE exception is
  // `sandboxGoneRestartDefault`: that opt-in is useless unless the sweep that
  // EXECUTES the scheduled fresh-box move is armed, so it falls back to 30s
  // when no explicit interval was configured. Still off for everyone who
  // hasn't set it.
  const restartSweepIntervalMs =
    typeof opts.restartSweepIntervalMs === "number" && opts.restartSweepIntervalMs > 0
      ? opts.restartSweepIntervalMs
      : opts.sandboxGoneRestartDefault === true
        ? DEFAULT_SANDBOX_GONE_RESTART_SWEEP_MS
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
  // Per-boot bearer token. Required on mutating /sessions/* routes
  // and on the WS upgrade for /sessions/:id/pty. Persisted to
  // runtime.json (mode 0600) so the same-user CLI can read it; a
  // browser-loaded localhost page can't. Hoisted above its original spot
  // (just before `startHttpServer`) so it's already in scope where the
  // llm-endpoint sidecar registry is constructed below, which needs it to
  // reach back into THIS daemon's own `/devices/:id/exec-stream` (device-
  // inference model routing, DEVICES-PLAN item 2).
  const token = opts.token ?? randomUUID()
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
  const baseSandboxProviderResolver: SandboxProviderResolver =
    opts.resolveSandboxProvider ?? makeSandboxResolver(makeSandboxCredsStore())
  // `device:<name>` (DEVICES-PLAN PR-D) resolves to a synthetic handle built
  // fresh per call around `opts.hostRegistry`, rather than living in
  // `sandbox-providers/registry.ts` — that registry is deliberately free of
  // `HostRegistry` coupling (it only knows built-ins + the fixed third-party
  // catalog), and `hostRegistry` is only available here, at the gateway's
  // composition root. `null` when no `hostRegistry` is wired ⇒
  // `bootSandboxAgentSession` reports the existing "provider not found"
  // error, same as any other unresolvable slug.
  const resolveSandboxProviderResolved: SandboxProviderResolver = async (
    slug: string,
  ): Promise<SandboxProviderHandle | null> => {
    if (slug.startsWith("device:")) {
      const deviceName = slug.slice("device:".length)
      if (!opts.hostRegistry || deviceName.length === 0) return null
      return {
        provider: createDeviceSandboxProvider(deviceName, opts.hostRegistry),
        slug,
        name: deviceName,
        version: "builtin",
        description: `Spawns and proxies an agent session on the paired host device "${deviceName}" over its pair/v2 channel.`,
        requiresSetup: false,
        capabilities: {
          networkEgress: true,
          mounts: false,
          lifecyclePause: false,
          readOnly: false,
          sharedSessions: false,
        },
        // See that field's doc — a device's filesystem is disjoint from the
        // driving daemon's; forwarding a HOST-shaped implicit cwd would
        // almost always ENOENT there.
        omitCwdWhenImplicit: true,
        async check(): Promise<boolean> {
          return true
        },
      }
    }
    return baseSandboxProviderResolver(slug)
  }
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
  const { httpOrigin: publicHttpOrigin, wsOrigin: ptyWsBaseUrl } =
    resolvePublicAppOrigins(port)

  const events = createRuntimeEvents()
  const conversations = fileConversationStore({ workspace })
  const workspaceFs = createWorkspaceFs({ workspace })

  // Multi-tunnel registry — independent from RemoteController. Manages
  // the general "create a public URL for any local port" surface
  // (tunnel_create / tunnel_list / tunnel_stop MCP tools + /tunnels HTTP
  // routes). Logs flow through the same events stream.
  // Shared tunnel creds store (~/.agentproto/tunnel-creds/, 0600) — lets the
  // registry rebuild a provider that keeps its secrets off the descriptor
  // (ngrok authtoken, third-party creds) when restoring on boot / creating.
  const tunnelCredsStore = makeTunnelCredsStore()
  // Persistence switch for every store this gateway owns. Production
  // (and any caller that omits it) keeps today's behaviour: persist on,
  // default paths. Tests pass `persist: false` so their fakes never reach
  // the real ~/.agentproto/ — see `CreateGatewayOptions.persist`.
  const persist = opts.persist ?? true
  const tunnels = new TunnelRegistry({
    workspace,
    ...(persist
      ? {}
      : { persistPath: join(workspace, ".agentproto", "tunnels.json") }),
    onLog: line =>
      events.emit({
        type: "remote-log",
        at: new Date().toISOString(),
        line,
      }),
    readCreds: slug => tunnelCredsStore.read(slug),
    // Never publish this gateway guard-less while it doesn't authenticate
    // remote requests (see TunnelRegistryOptions.gatewayGuard). `remote` is
    // created further down; until then only the static auth counts.
    gatewayGuard: {
      port,
      isProtected: () => {
        if (opts.auth?.mode === "bearer") return true
        try {
          return remote.readAuth().mode === "bearer"
        } catch {
          return false
        }
      },
    },
  })
  // Relaunch any `autostart` (named) tunnels that were live before this
  // daemon restarted. Non-blocking — boot must not wait on cloudflared,
  // and a failed restore leaves that one tunnel `error` without gating
  // the rest of the gateway.
  // Relaunch any `autostart` (named) tunnels that were live before this
  // daemon restarted. Non-blocking — boot must not wait on cloudflared,
  // and a failed restore leaves that one tunnel `error` without gating
  // the rest of the gateway. Skipped when persistence is off (tests):
  // a test gateway must not relaunch the user's real tunnels.
  if (persist) {
    void tunnels.restoreOnBoot().catch(() => {
      // restoreOnBoot already logs per-tunnel failures via onLog.
    })
  }

  // Public origin GitHub calls back into for the `webhook` sentinel provider:
  // AGENTPROTO_PUBLIC_URL, else an active tunnel to this daemon's port
  // (stable only when the tunnel provider declares `stableUrl`).
  setSentinelPublicUrlSource(
    makePublicUrlResolver({
      port,
      listTunnels: () => tunnels.list(),
      isStableProvider: provider => builtinProviderCapabilities(provider)?.stableUrl === true,
    }),
  )

  // Single-sidecar registry for the @agentproto/inference-endpoint proxy — gated
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
        // Loopback callback into THIS daemon's own gateway (deterministic —
        // `port` is fixed before the server ever binds) + its per-boot
        // bearer, so the sidecar can reach `/devices/:id/exec-stream` to
        // route a `<endpoint>@<device>` model (DEVICES-PLAN item 2).
        // Injected regardless of `deviceInferenceShare`/`hostRegistry` — an
        // unconfigured/offline device just 404s/502s at request time, same
        // as any other unreachable upstream.
        daemonCallback: { baseUrl: `http://127.0.0.1:${port}`, token },
      })
    : undefined
  // Autostart on daemon boot (daemon-managed-gateway): mirrors
  // `tunnels.restoreOnBoot()` above — non-blocking, boot must never wait on
  // the sidecar. Unlike tunnels there's no persisted "was it running before
  // restart" state to reconcile (the registry is pure in-memory, the child
  // dies with the daemon); when the feature is on, always try to bring it
  // up. A failure here just leaves the descriptor `error` — surfaced via
  // `status()`/`lastError` — until an operator retries (`llm_endpoint_start`,
  // `agentproto llm gateway restart`) or a spawn's lazy self-heal
  // (`ensureLlmEndpointRunning` below) triggers another attempt. Crash
  // recovery AFTER this succeeds is the registry's own internal
  // backoff-restart (`LlmEndpointRegistry.scheduleCrashRestart`).
  if (llmEndpoint) {
    // `LLM_ENDPOINT_PORT` in the daemon's OWN ambient env relocates the
    // autostarted sidecar off the built-in default (18090) — there's no
    // `config.json` port knob for this yet, and autostart (unlike the
    // `llm_endpoint_start` MCP tool) has no per-call argument a caller could
    // set instead. Mirrors `LLM_ENDPOINT_BIN`'s existing ambient-env
    // override for the bin path. Scoped to THIS call only — it does not
    // change `assembleLlmEndpointEnv`'s tested `explicitEnv` > `port` arg >
    // default precedence for any other caller.
    const autostartPort = Number.parseInt(process.env.LLM_ENDPOINT_PORT ?? "", 10)
    void llmEndpoint
      .start(Number.isFinite(autostartPort) && autostartPort > 0 ? { port: autostartPort } : {})
      .catch(() => {
        // start() already records the failure on the descriptor
        // (status:"error", lastError) and logs via onLog — nothing else to do.
      })
  }
  // Self-heal hook for `spawnAgentSession` (session-spawn.ts): a spawn
  // billing through the local llm-endpoint proxy ensures the sidecar is up
  // before the adapter makes its first request, rather than assuming
  // something (autostart above, or an operator) already started it.
  // `start()` is idempotent — a no-op when already running+healthy.
  const ensureLlmEndpointRunning = llmEndpoint
    ? async (): Promise<void> => {
        await llmEndpoint.start()
      }
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
  // What each session's harness actually loaded from this daemon's `/mcp`
  // mount (fed by `startHttpServer`, read by `session_capabilities`).
  const mcpObservations = createMcpObservationStore()
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
  // Headless-browser backstop (`browser-mount.ts`): once a `browser:
  // "headless"` session exits, kill anything still carrying its Chrome
  // marker (an adapter that died without closing its MCP children). No-op
  // for sessions spawned without a browser.
  sessionEvents.on("session:exited", ev => {
    void sweepSessionBrowser(ev.sessionId).catch(() => {})
  })

  // Per-workspace brain: auto-ingest a workspace's conversations when its
  // sessions exit (debounced, fire-and-forget), and expose them queryably
  // via the workspace_brain_* MCP tools. Same wiring discipline as the
  // webhook notifier — a brain failure never throws into the exit path.
  // Limits come from `defaults.reactions.brainIngest`, read once at boot.
  const daemonConfig = await loadConfig()
  const workspaceBrains = createWorkspaceBrains({
    limits: resolveBrainIngestLimits(daemonConfig.defaults?.reactions?.brainIngest),
  })
  // Receipts are scoped to the bucket this daemon serves (same rule as the
  // resume passes in serve.ts), so two daemons on one AGENTPROTO_HOME never
  // rewrite or replay each other's receipts.
  const reactionBucket = await loadWorkspacesConfig()
    .then(cfg =>
      resolveBucketSlug(
        findWorkspaceByPath(cfg, opts.workspace)?.slug,
        new Set(cfg.workspaces.map(w => w.slug)),
      ),
    )
    .catch(() => DEFAULT_BUCKET)
  const reactionReceiptStore = createReactionReceiptStore({
    filePath: reactionReceiptsPathForBucket(reactionBucket),
  })
  const brainIngestReaction = createBrainIngestReaction({
    brains: workspaceBrains,
    ownedWorkspaces: readBrainIngestOwnedWorkspaces,
  })
  const actionRegistry = createActionRegistry()
  const builtinReactionBindings = [brainIngestReaction.binding]
  const clerkReactionBox: { reaction?: ClerkReaction } = {}
  const reactionRunner = createReactionRunner({
    bus: sessionEvents,
    store: reactionReceiptStore,
    bindings: builtinReactionBindings,
  })
  reactionRunner.start()
  const brainSubscriber = createWorkspaceBrainSubscriber({
    bus: sessionEvents,
    brains: workspaceBrains,
    skipWorkspace: workspace => brainIngestReaction.owns(workspace),
  })
  brainSubscriber.start()

  // Opt-in Langfuse session tracer — built once here (shared, pure) from the
  // eval-reporter's stored langfuse creds, same store `setup_eval_reporter`
  // writes to. Absent creds ⇒ undefined, and the registry never gates
  // anything on a tracer that doesn't exist — tracing-off behaviour is
  // unchanged from before this existed.
  const configDefaults = daemonConfig.defaults
  // `config_get`/`config_set` (PR-2) need the config the daemon actually
  // BOOTED with, captured exactly once here — never re-read at call time —
  // so a `restart`-class key's `pendingRestart` compares the live file
  // against what's really running, not against itself. `bootDaemonKnobs`
  // carries the four idle-reap/crash-detect/restart-sweep/turn-stall
  // numbers already resolved (env > config > default) CLI-side before this
  // function ever ran — the same values `daemon_health` reports below —
  // rather than re-implementing that resolution here.
  const configToolsDeps: ConfigToolsDeps = {
    bootConfig: daemonConfig,
    events,
    bootDaemonKnobs: {
      "daemon.idleReapAfterMs": idleReapAfterMs,
      "daemon.sandboxIdleReapAfterMs": sandboxIdleReapAfterMs,
      "daemon.crashDetectIntervalMs": crashDetectIntervalMs,
      "daemon.restartSweepIntervalMs": restartSweepIntervalMs,
      "daemon.turnStallAfterMs": turnStallAfterMs,
    },
  }
  // Per-session transcript root from config (`sessions.eventsDir`). Applied
  // BEFORE the registry is built so the writers AND every no-`baseDir`
  // reader (http-server routes, exports, tool-call/usage logs) resolve off
  // the same configured root. Unset ⇒ no-op (hardcoded default stands).
  if (daemonConfig.sessions?.eventsDir) {
    setDefaultSessionsBaseDir(daemonConfig.sessions.eventsDir)
  }
  // Default AIP-72 memory store root from config (`memory.root`), read by
  // the memory_* tools and the spawn digest. Unset leaves
  // `~/.agentproto/memory`.
  setDefaultMemoryRoot(daemonConfig.memory?.root)
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

  // Sentinel store + provider resolver — hoisted above `sessions` because
  // the auto-link hook (`onOpenedPr`, wired into `createSessionsRegistry`
  // below) needs both and neither depends on `sessions` itself (only
  // `sentinelRuntime`, built later, needs `sessions.sendMessage`).
  const sentinelStore = createSentinelStore({ persist })
  // Session-follow store (`~/.agentproto/follows.json`) — the engine that
  // reads it is wired below, once `sessions` exists.
  const sessionFollowStore = createSessionFollowStore({ persist })
  const sentinelCredsStore = makeSentinelCredsStore()
  const resolveSentinelProviderResolved = async (slug: string) =>
    resolveSentinelProvider(slug, { creds: await sentinelCredsStore.read(slug) })

  // `config.sentinel.autoWatchPrs` resolver — read fresh on every opened PR
  // (never cached), same read-per-call discipline as
  // `resolveMessagingDefaults`. Unset in config ⇒ default true only when
  // `local-gh` (`gh auth status` succeeds) or `agentpush` (API key set) is
  // actually usable, else false
  // with a one-line log so a laptop with no `gh` auth doesn't silently
  // watch nothing without explanation.
  let loggedNoAutoWatchDefault = false
  const resolveAutoWatchPrs = async (): Promise<boolean> => {
    const cfg = await loadConfig().catch((): { sentinel?: { autoWatchPrs?: boolean } } => ({}))
    if (cfg.sentinel?.autoWatchPrs !== undefined) return cfg.sentinel.autoWatchPrs
    const provider = await resolveSentinelProviderResolved(LOCAL_GH_SLUG)
    let ok = provider ? await provider.check() : false
    if (!ok) {
      // agentpush (when set up) can watch PRs without a local `gh`.
      const push = await resolveSentinelProviderResolved(AGENTPUSH_SLUG)
      ok = push ? await push.check().catch(() => false) : false
    }
    if (!ok && !loggedNoAutoWatchDefault) {
      loggedNoAutoWatchDefault = true
      console.warn(
        "[sentinel-autolink] local-gh unavailable (gh not authenticated?) — " +
          "sentinel.autoWatchPrs defaults to false; set it explicitly to override.",
      )
    }
    return ok
  }
  const resolveAutoWatchUrgency = async (): Promise<MessageUrgency> => {
    const cfg = await loadConfig().catch((): { sentinel?: { autoWatchUrgency?: unknown } } => ({}))
    const u = cfg.sentinel?.autoWatchUrgency
    return typeof u === "string" && (MESSAGE_URGENCIES as readonly string[]).includes(u)
      ? (u as MessageUrgency)
      : "next-turn"
  }
  const sentinelAutoLinker = createSentinelAutoLinker({
    store: sentinelStore,
    resolveProvider: resolveSentinelProviderResolved,
    autoWatchPrs: resolveAutoWatchPrs,
    autoWatchUrgency: resolveAutoWatchUrgency,
    // A PR recorded on a row that a restart/continue already superseded
    // (e.g. the old row's own exit-time reconcile) is watched for the live
    // successor — retirement-cleanup only re-points sentinels that existed
    // at retirement time.
    resolveTargetSession: id =>
      (sessionsRef ? resolveSuccessor(sid => sessionsRef?.get(sid), id) : undefined) ?? id,
    // The recorded session's supervisor also watches the PR (live parents only).
    resolveParentSession: id => {
      const parentId = sessionsRef?.get(id)?.parentSessionId
      const parent = parentId ? sessionsRef?.get(parentId) : undefined
      return parent && !isRetired(parent) && (parent.status === "running" || parent.status === "starting")
        ? parent.id
        : undefined
    },
  })

  // Sessions registry — single instance per gateway, captured by
  // the per-request mcpServerFactory closure below + handed to
  // startHttpServer for the /sessions HTTP routes. Declared here
  // (above the factory) so its identifier is visible at closure-
  // build time, even though the factory only invokes later.
  const externalSessionLivenessMs =
    opts.externalSessionLivenessMs ?? daemonConfig.daemon?.externalSessionLivenessMs
  // On-disk session retention (session-retention.ts): review lanes default to
  // 7 days, every other session is off unless configured. Read straight from
  // config, same as externalSessionLivenessMs above.
  const sessionRetention = {
    ...(typeof daemonConfig.daemon?.reviewSessionRetentionDays === "number"
      ? { reviewMaxAgeDays: daemonConfig.daemon.reviewSessionRetentionDays }
      : {}),
    ...(typeof daemonConfig.daemon?.sessionRetentionDays === "number"
      ? { maxAgeDays: daemonConfig.daemon.sessionRetentionDays }
      : {}),
  }
  // Adapter-config cache retention (adapter-config-retention.ts): a dead
  // lineage's cache content goes after 1 quiet day unless configured.
  const adapterCacheRetention =
    typeof daemonConfig.daemon?.adapterCacheRetentionDays === "number"
      ? { maxAgeDays: daemonConfig.daemon.adapterCacheRetentionDays }
      : {}
  // "Box is gone" restart hook (restart-scheduler's `sandbox-gone` policy) —
  // the gateway-wired executor behind `registry.triggerSandboxGoneRestart`.
  // Moves a dead box session to a FRESH box via the SAME `restartAgentSession`
  // path `session_restart` takes (never in-place: the box is gone), then
  // prompts the replacement once to continue the original task. Declared
  // before `sessions` (which the closure needs) via a late-bound ref; the hook
  // only ever runs after the registry exists.
  let sessionsRef: SessionsRegistry | undefined
  /** Transcript provenance for the post-move continuation prompt. */
  const SANDBOX_GONE_PROMPT_SOURCE = "daemon:sandbox-gone-restart"
  /** Move a dead/reaped box session onto a FRESH box through the same
   *  `restartAgentSession` path `session_restart` takes (re-attaches the box if
   *  it still exists, else cold-boots a new one from the checkpoint branch). */
  const moveBoxSessionToFreshBox = async (
    prev: SessionDescriptor,
  ): Promise<
    | { ok: true; restarted: Awaited<ReturnType<typeof restartAgentSession>> }
    | { ok: false; blocker: string }
  > => {
    if (!sessionsRef) return { ok: false, blocker: "sessions registry not ready" }
    if (!opts.resolveAgentAdapter) {
      return { ok: false, blocker: "agent restart is not enabled (no resolveAgentAdapter)" }
    }
    const restarted = await restartAgentSession(sessionsRef, opts.resolveAgentAdapter, prev, {
      forceAgentResume: true,
      resolveSandboxProvider: resolveSandboxProviderResolved,
      daemonMcpUrl,
    })
    return { ok: true, restarted }
  }
  /** Idle-reaped box session, prompted again: fresh box, NO continuation
   *  prompt — the prompt that woke it is the continuation. */
  const moveReapedBoxHook = async (input: {
    sessionId: string
    prev: SessionDescriptor
  }): Promise<{ ok: true; newSessionId: string } | { ok: false; blocker: string }> => {
    const moved = await moveBoxSessionToFreshBox(input.prev)
    return moved.ok ? { ok: true, newSessionId: moved.restarted.desc.id } : moved
  }
  const restartSandboxGoneHook = async (input: {
    sessionId: string
    prev: SessionDescriptor
  }): Promise<{ ok: true; newSessionId: string } | { ok: false; blocker: string }> => {
    const { prev } = input
    const moved = await moveBoxSessionToFreshBox(prev)
    if (!moved.ok) return moved
    const { restarted } = moved
    if (!sessionsRef) return { ok: false, blocker: "sessions registry not ready" }
    // ONE short continuation prompt on the fresh session. The full prior
    // transcript + structured handoff (lane T, `restart-handoff.ts`) rides
    // along as the restart's own `pendingResumeContext`, so this prompt only
    // has to say what the machine-level handoff can't: the box died, what was
    // restored, and to keep going rather than start over.
    const target = prev.sandboxDeliveryTarget
    const pushed = [prev.sandboxCheckpoint, prev.sandboxDelivery].find(
      r => r?.push.status === "pushed",
    )
    const pushedSha = pushed?.key?.split(":")[0]
    const checkpointSha = prev.sandboxCheckpoint?.checkpoint?.sha
    const restored = target
      ? `Work branch \`${target.branch}\` was restored from the workspace remote` +
        (pushedSha ? ` at \`${pushedSha}\`` : "") +
        (checkpointSha ? `, with the checkpoint snapshot \`${checkpointSha}\`` : "") +
        ", so everything already pushed is in the new checkout."
      : "The last saved tarball checkpoint was restored into the new box."
    await sessionsRef
      .enqueuePrompt(
        restarted.desc.id,
        `Your sandbox box died (its provider lifetime cap was reached, or it was ` +
          `reclaimed), and this session was automatically moved to a FRESH box. ` +
          `${restored} Continue the original task from where the pushed work stops — ` +
          `do not redo work that is already committed or checkpointed.`,
        { source: SANDBOX_GONE_PROMPT_SOURCE },
      )
      .catch(() => undefined)
    return { ok: true, newSessionId: restarted.desc.id }
  }

  // Filled once the scope-token registry exists (further down); a revival
  // that runs before that (boot) finds no hooks and leaves scopes as loaded.
  let orchestratorScopeHooks: ReturnType<typeof createOrchestratorScopeHooks> | undefined
  const sessions = createSessionsRegistry({
    sessionEvents,
    persist,
    orchestratorScopes: {
      reinstate: id => orchestratorScopeHooks?.reinstate(id) ?? (() => {}),
      transfer: (from, to) => orchestratorScopeHooks?.transfer(from, to),
    },
    sessionRetention,
    adapterCacheRetention,
    ...(typeof externalSessionLivenessMs === "number" && externalSessionLivenessMs > 0
      ? { externalSessionLivenessMs }
      : {}),
    onOpenedPr: sentinelAutoLinker.onOpenedPr,
    ...(daemonConfig.sessions?.eventsDir
      ? { transcriptDir: defaultTranscriptBaseDir() }
      : {}),
    ...(opts.resolveAgentAdapter ? { resolveAgentAdapter: opts.resolveAgentAdapter } : {}),
    ...(opts.listHarnessCapabilities
      ? { listHarnessCapabilities: opts.listHarnessCapabilities }
      : {}),
    // Inert unless a session's `contextContinuity.handoffAtQuotaRemaining`
    // is set; only then does the live probe (one 1-token call, throttled)
    // ever run.
    quotaWatch: {
      reader: new AnthropicRemainingQuotaReader({ liveProbe: true }),
      resolveProfile: async ref => {
        const profile = await getAuthProfile(ref)
        return profile ? toQuotaReadableProfile(profile) : undefined
      },
    },
    ...(opts.persistPath ? { persistPath: opts.persistPath } : {}),
    ...(opts.spawnPty ? { spawnPty: opts.spawnPty } : {}),
    ...(opts.runWorktreeAutoReclaim ? { runWorktreeAutoReclaim: opts.runWorktreeAutoReclaim } : {}),
    ...(opts.runSandboxCheckpointGc ? { runSandboxCheckpointGc: opts.runSandboxCheckpointGc } : {}),
    ...(langfuseTracer ? { langfuseTracer } : {}),
    langfuseTracingDefault: configDefaults?.langfuseTracing ?? false,
    ...(configDefaults?.backgroundTaskWake
      ? { backgroundTaskWake: configDefaults.backgroundTaskWake }
      : {}),
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
            posture,
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
              // Build the resume's launch config through the SAME builder a
              // fresh spawn and a restart use. The old inline
              // `options: { base_url: resolvedBaseUrl }` ignored the manifest's
              // declared option vocabulary, so an opencode-Go row (route
              // `opencode-go`, `routeSelection: "derived-from-model"`, no
              // `base_url` option) was handed an undeclared option and every
              // eager/lazy resume failed with `unknown_option`. The builder
              // drops a gateway base_url for a derived-from-model adapter and
              // only injects it when the manifest declares the option.
              const launchConfig = buildRouteAwareLaunchConfig({
                adapter: adapterSlug,
                ...(descriptor.model ? { model: descriptor.model } : {}),
                ...(descriptor.route ? { route: descriptor.route } : {}),
                ...(authSpec ? { authSpec } : {}),
                ...(adapter.declaredOptions ? { declaredOptions: adapter.declaredOptions } : {}),
                ...(adapter.routeSelection ? { routeSelection: adapter.routeSelection } : {}),
                ...(adapter.authDescriptor?.provider
                  ? { adapterProvider: adapter.authDescriptor.provider }
                  : {}),
                ...(adapter.authDescriptor?.modelDerivedApiKey !== undefined
                  ? { modelDerivedApiKey: adapter.authDescriptor.modelDerivedApiKey }
                  : {}),
                prefix: "resume",
              })
              // A cloud relay re-attaches with the same meta file and (for a
              // declared workspace remote) clone source as `session_restart`;
              // without them it validates the host cwd, which holds no clone.
              const resumeCloudEnv =
                cloudMetaOf(descriptor) && descriptor.adapterConfigDir
                  ? await cloudRelayEnv({
                      workspaceSlug: descriptor.workspaceSlug,
                      configDir: descriptor.adapterConfigDir,
                    })
                  : {}
              // App boundary survives a lazy resume (fs zones + host-context isolation).
              const resumeBoundary = boundaryFromMeta(descriptor.meta)
              // AIP-72 native-dir inject, recomputed for a lineage whose spawn
              // projected (`meta.memoryInject`); never fails the resume.
              const resumeMemoryProjection = await respawnMemoryProjection(descriptor.meta, {
                sessionId: descriptor.id,
                memoryStoreAt,
                ...(descriptor.cwd !== undefined ? { ground: descriptor.cwd } : {}),
                ...(descriptor.operator !== undefined ? { operator: descriptor.operator } : {}),
                ...(adapter.supportsSystemPrompt !== undefined
                  ? { supportsSystemPrompt: adapter.supportsSystemPrompt }
                  : {}),
                ...(adapter.systemPromptMaxChars !== undefined
                  ? { systemPromptMaxChars: adapter.systemPromptMaxChars }
                  : {}),
              }).catch(err => {
                console.warn(
                  `[resume] native memory not projected for ${descriptor.id}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                )
                return undefined
              })
              const resumePreCompactCommand = preCompactCommandFor(
                (await loadConfig().catch(() => undefined))?.defaults,
                { adapter: adapterSlug },
              )
              return await adapter.startSession({
                cwd,
                resumeSessionId,
                // Clamped to the caller's ceiling by the registry.
                ...(posture !== undefined ? { posture } : {}),
                ...(resumeBoundary
                  ? boundaryRestartOptions(resumeBoundary, {
                      supportsFsZones: adapter.supportsFsZones === true,
                      supportsHostContextIsolation: adapter.supportsHostContextIsolation === true,
                      ...(descriptor.commandSandbox === "off" ? { commandSandbox: "off" as const } : {}),
                    })
                  : {}),
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
                // dropped mcpServers. The persisted list carries no session
                // token; the revived adapter gets a FRESH one for the same
                // id (shadow mode, see `withSessionToken`).
                ...(mcpServers
                  ? {
                      mcpServers: withSessionToken(mcpServers, {
                        mode: (await resolveIdentityDefaults()).sessionTokens,
                        adapter: adapterSlug,
                        daemonMcpUrl,
                        sessionId: descriptor.id,
                      }),
                    }
                  : {}),
                // Re-deliver the persisted imported-skill folders on resume
                // (skill imports) — the same set the original spawn delivered,
                // so a revived session keeps its skills.
                ...(descriptor.sessionSkills ? { sessionSkills: descriptor.sessionSkills } : {}),
                ...(resumeMemoryProjection ? { memoryProjection: resumeMemoryProjection } : {}),
                // Projected PreCompact hook: the resume rewrites the isolated
                // settings.json whole, so the current config decides here too.
                ...(resumePreCompactCommand ? { preCompactCommand: resumePreCompactCommand } : {}),
                ...(authSpec ? { auth: authSpec } : {}),
                ...(launchConfig.options ? { options: launchConfig.options } : {}),
                ...(onActivity ? { onActivity } : {}),
                // Lazy in-place resume (daemon restart / crash): unlike
                // `session_restart` this revives the SAME descriptor row, not
                // a fresh one — `descriptor.id` never changes across this
                // call, so the identity env carries forward unchanged.
                env: {
                  [SESSION_ID_ENV]: descriptor.id,
                  [WORKSPACE_SLUG_ENV]: descriptor.workspaceSlug,
                  ...resumeCloudEnv,
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
    // "Box is gone" policy executor (see `restartSandboxGoneHook` above) —
    // inert unless a session's `restartPolicy.on` lists `"sandbox-gone"`.
    restartSandboxGone: restartSandboxGoneHook,
    moveReapedBox: moveReapedBoxHook,
    // `daemon.sandboxGoneRestartDefault` — OFF unless set, so a caller that
    // never opted in gets today's policy-less box spawn, unchanged. When set,
    // a BOX spawn with no explicit `restartPolicy` is stamped with the
    // sandbox-gone default (an explicit per-session policy always wins).
    ...(opts.sandboxGoneRestartDefault === true
      ? { boxRestartPolicyDefault: SANDBOX_GONE_DEFAULT_RESTART_POLICY }
      : {}),
  })
  sessionsRef = sessions

  // SESSION CREDENTIALS (ts#2165 step 5, shadow): the hashes of the
  // per-session identity tokens persist in `session-credentials.json`, so a
  // daemon restart keeps live sessions verifiable. The boot prune drops
  // tokens of sessions this registry no longer knows or that retired. A
  // retirement revokes the session's tokens. Both are undone by `stop()`.
  const detachSessionCredentials = persist
    ? attachSessionCredentialStore({
        path: sessionCredentialsFile(),
        keep: id => {
          const desc = sessions.get(id)
          return desc !== undefined && desc.retiredAt === undefined
        },
      })
    : undefined
  const unsubscribeSessionCredentials = sessions.onSessionRetired(ev => {
    revokeSessionTokens(ev.sessionId)
  })

  // `agentproto:session-completed` host event: derived after `session:exited`
  // from the descriptor outcome or a recorded `policy:passed`. The bus has no
  // shutdown hook (neither does the brain subscriber), so the unsubscribe the
  // wiring returns is not kept.
  wireSessionCompletion({
    bus: sessionEvents,
    getSession: id => sessions.get(id),
  })

  // Install the real `session` sentinel provider (AIP-60) now that
  // `sessions` exists — see `configureSessionSentinelProvider`'s doc for why
  // this builtin needs a setter instead of the plain `(creds) => handle`
  // every other factory in `BUILTIN_SENTINEL_PROVIDERS` uses. `sessionEvents`
  // was already in scope before `sentinelStore`/`resolveSentinelProviderResolved`
  // (both declared above `sessions`); this is the earliest point `sessions`
  // itself is available for the existence/liveness lookup.
  configureSessionSentinelProvider({
    sessionEvents,
    getSession: sessionId => {
      const desc = sessions.get(sessionId)
      if (!desc) return undefined
      return {
        alive: desc.alive === true,
        status: desc.status,
        ...(desc.label ? { label: desc.label } : {}),
        ...(desc.endedReason ? { endedReason: desc.endedReason } : {}),
        ...(desc.exitCode !== undefined ? { exitCode: desc.exitCode } : {}),
      }
    },
  })

  // Restart scheduler (restart-scheduler PR-2) — the EVENT-driven half only;
  // it subscribes to session:exited and stamps/gives-up a schedule on an
  // eligible, opted-in death. Runs regardless of `restartSweepIntervalMs`:
  // that knob only arms the periodic sweep further below that EXECUTES a
  // landed schedule. Declared right after `sessions` (needs the registry +
  // its own event bus); disposed in stop(). `isSandboxBoxGone` classifies a
  // dead box session whose policy lists `"sandbox-gone"`: descriptor evidence
  // first, then the ledger, then ONE provider liveness probe — no polling.
  const restartScheduler = createRestartScheduler({
    registry: sessions,
    sessionEvents,
    isSandboxBoxGone: desc => isSandboxBoxGone(desc, { resolveSandboxProvider: resolveSandboxProviderResolved }),
  })

  // Turn retry (opt-in per session via `agent_start.turnRetry`) — re-prompts
  // a live session whose turn failed on a 429/5xx or stalled silently while
  // the provider retried. Inert for sessions without the policy. Disposed in
  // stop().
  // `modelCooldowns` is the daemon-wide "this model is rate-limited right now"
  // map (the free-tier limit is per model per IP): the controller fills it and
  // `turnRetry.rotate` reads it for every session; read-only in `daemon_health`.
  const modelCooldowns = createModelCooldowns()
  // `turnRetry.action: "migrate"`'s orchestration arm: PR 2's
  // `migrateSandboxSession`, called in-process (no MCP round-trip) with the
  // same spawn deps the `session_migrate` tool threads. Absent without an
  // adapter resolver — a migrate decision then falls back to a normal retry
  // with a notice (turn-retry.ts's "no migration orchestrator" path).
  // `supervisor` / `taskLedger` / `orchestratorInjector` are declared further
  // down this file, so the closure reads them at CALL time — a turn-retry
  // migration only ever fires long after boot.
  const turnRetryMigrateSession: MigrateSessionFn | undefined = opts.resolveAgentAdapter
    ? prev =>
        migrateSandboxSession(
          {
            registry: sessions,
            resolveAgentAdapter: opts.resolveAgentAdapter!,
            daemonMcpUrl,
            ...(webhookNotifier ? { webhookNotifier } : {}),
            resolveSandboxProvider: resolveSandboxProviderResolved,
            ...(ensureLlmEndpointRunning ? { ensureLlmEndpointRunning } : {}),
            ...(opts.provisionWorktree ? { provisionWorktree: opts.provisionWorktree } : {}),
            ...(opts.listCatalogModels ? { listCatalogModels: opts.listCatalogModels } : {}),
            ...(orchestratorInjector ? { buildOrchestratorMcp: orchestratorInjector } : {}),
          },
          prev,
          {
            sources: createCheckpointSources({
              ...(supervisor ? { supervisor } : {}),
              ...(taskLedger ? { taskLedger } : {}),
            }),
          },
        )
    : undefined
  const rotationTargetCheck = createRotationTargetCheck({
    getProfile: getAuthProfile,
    ...(opts.listCatalogModels ? { listCatalogModels: opts.listCatalogModels } : {}),
  })
  const turnRetryFallbackRestart: FallbackRestartFn | undefined = opts.resolveAgentAdapter
    ? async (prev, overrides) => {
        const restarted = await restartAgentSession(sessions, opts.resolveAgentAdapter!, prev, {
          overrides,
          resolveSandboxProvider: resolveSandboxProviderResolved,
          daemonMcpUrl,
          ...(opts.listCatalogModels ? { listCatalogModels: opts.listCatalogModels } : {}),
        })
        return restarted.desc
      }
    : undefined
  const turnRetryFallbackHandoff: FallbackHandoffFn | undefined = opts.resolveAgentAdapter
    ? async (prev, target) => {
        const result = await continueAgentSessionFresh(
          {
            registry: sessions,
            resolveAgentAdapter: opts.resolveAgentAdapter!,
            daemonMcpUrl,
            resolveSandboxProvider: resolveSandboxProviderResolved,
            ...(opts.listCatalogModels ? { listCatalogModels: opts.listCatalogModels } : {}),
            ...(orchestratorInjector ? { buildOrchestratorMcp: orchestratorInjector } : {}),
          },
          withContextPolicy(prev).source,
          {
            adapter: target.harness,
            harness: target.harness,
            ...(target.model !== undefined ? { model: target.model } : {}),
            ...(target.access !== undefined ? { access: target.access } : {}),
            sources: createCheckpointSources({
              ...(supervisor ? { supervisor } : {}),
              ...(taskLedger ? { taskLedger } : {}),
            }),
            spawn: {
              ...(prev.turnRetry ? { turnRetry: prev.turnRetry } : {}),
            },
          },
        )
        return result.descriptor
      }
    : undefined
  const turnRetryController = createTurnRetryController({
    registry: sessions,
    sessionEvents,
    cooldowns: modelCooldowns,
    checkRotationTarget: rotationTargetCheck,
    ...(turnRetryMigrateSession ? { migrateSession: turnRetryMigrateSession } : {}),
    ...(turnRetryFallbackRestart ? { restartSession: turnRetryFallbackRestart } : {}),
    ...(turnRetryFallbackHandoff ? { handoffSession: turnRetryFallbackHandoff } : {}),
    getAuthProfile,
    isHarnessInstalled: async harness =>
      opts.resolveAgentAdapter ? (await opts.resolveAgentAdapter(harness)) != null : false,
    checkFallbackTarget: async (desc, target) => {
      if (target.model === undefined) return undefined
      return rotationTargetCheck(
        {
          ...desc,
          model: target.model,
          ...(target.harness !== undefined ? { adapterSlug: target.harness } : {}),
          ...(target.accessProfileRef !== undefined
            ? {
                accessProfile: desc.accessProfile
                  ? { ...desc.accessProfile, profileRef: target.accessProfileRef }
                  : ({ profileRef: target.accessProfileRef } as NonNullable<
                      SessionDescriptor["accessProfile"]
                    >),
              }
            : {}),
        },
        { model: target.model },
      )
    },
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
        // A sandboxed session's cwd is a box path: its PR is resolved
        // against the host checkout of the workspace the box was cloned from.
        localRepoCwdFor: async session =>
          session.workspaceSlug
            ? findWorkspace(await loadWorkspacesConfig(), session.workspaceSlug)?.path
            : undefined,
        // The GLOBAL checkpoint ref namespace, a session's own per-spawn
        // override wins over it, so the stamper reads the checkpoint from
        // the namespace that session's delivery actually pushed to.
        ...(configDefaults?.sandbox?.checkpoint?.refPrefix
          ? { checkpointRefPrefix: configDefaults.sandbox.checkpoint.refPrefix }
          : {}),
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
  // AGENT.md `model: role:<name>` → model id, via the same layered resolver
  // the `model_roles` tool serves (active workspace + daemon config + defaults).
  const resolveModelRoleId = async (role: string): Promise<string | undefined> =>
    (await modelRoles({ roles: [role] })).roles[0]?.model
  const dispatchToolBox: { fn?: (name: string, inputs: Record<string, unknown>) => Promise<unknown> } = {}
  const dispatchTool = async (name: string, inputs: Record<string, unknown>): Promise<unknown> => {
    if (!dispatchToolBox.fn) {
      throw new Error(`routine/cron tool dispatch: not ready yet (daemon still booting) — tool "${name}"`)
    }
    return dispatchToolBox.fn(name, inputs)
  }

  // AIP-41 event routines: the registrar resolves them, the wiring converts
  // each one to a reaction binding and swaps the runner's live set on every
  // reconcile. The registrar is created below, so the box breaks the ordering
  // cycle without module-level state. Builtins stay live from runner creation,
  // so an event arriving before the first reconcile still reaches them.
  const routineRegistrarBox: { registrar?: ReturnType<typeof createRoutineRegistrar> } = {}
  const agentOnScanner = createAgentOnScanner({ workspace })
  const reactionWiring = createReactionWiring({
    runner: reactionRunner,
    builtin: builtinReactionBindings,
    eventBindings: () => routineRegistrarBox.registrar?.eventBindings() ?? [],
    agentBindings: () => agentOnScanner.current(),
    conversion: {
      registry: actionRegistry,
      dispatchTool,
      getSessionFacts: id => {
        const desc = sessions.get(id)
        return desc ? sessionFactsOf(desc) : undefined
      },
      workspaceRoot: workspace,
    },
  })

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
  // Agent jobs fire as `agent_start` calls through `dispatchTool`;
  // `resolveAgentAdapter` restarts a dead `prompt-session` target and, at
  // create time, refuses an agent job whose adapter doesn't resolve
  // (`getAuthProfile`/`listAgentAdapters` only word that error). Command
  // jobs need none of them.
  // Follow a cron-spawned session's first turn to a real outcome, reusing the
  // same `monitorSessionWait` core `agentproto sessions wait --until turn-end`
  // / `session_monitor` use. Injected so the scheduler stays unit-testable.
  const observeCronTurn = createSessionTurnObserver({ registry: sessions, sessionEvents, eventRing })
  const cronScheduler = createCronScheduler({
    sessionEvents,
    registry: sessions,
    daemonMcpUrl,
    ...(opts.resolveAgentAdapter
      ? { resolveAgentAdapter: opts.resolveAgentAdapter }
      : {}),
    ...(opts.listAgentAdapters
      ? { listAgentAdapters: opts.listAgentAdapters }
      : {}),
    getAuthProfile,
    dispatchTool,
    workspace,
    persist,
    observeTurn: observeCronTurn,
    observeTimeoutMs: DEFAULT_OBSERVE_TIMEOUT_MS,
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
    onReconciled: async () => {
      await agentOnScanner.rescan()
      return reactionWiring.refresh()
    },
  })
  routineRegistrarBox.registrar = routineRegistrar

  // AIP-68 clerk hook - a daemon subscriber that runs ONE clerk pass
  // (steward/secretary) after a session's turn ends, debounced on the
  // session's idle time (10 min by default), single-flight per session and
  // fire-and-forget: the pass can never slow a turn down. DISABLED unless
  // configured - the three levels (agent > workspace > daemon default) are
  // resolved per session; see `clerk-hook-config.ts`.
  //
  // The controller stays the gate and the debounce. Its firing goes through
  // `clerkReaction.dispatch`: a workspace listed in
  // `defaults.reactions.clerk.workspaces` takes the durable reaction path,
  // every other workspace keeps the legacy pass runner. The runner and the
  // wiring were created above, so a forward box carries the binding back.
  const legacyClerkPassRunner = createClerkPassRunner({
    triggerRoutine: routineId => routineRegistrar.trigger(routineId),
    // The command arm is default-deny: same allowlist as `command_execute`.
    allowCommand: async spec =>
      isCommandAllowed(await loadAllowlistEntries(workspace), spec.command, spec.args),
    anchorCwd: (sessionCwd, cwd) => makeCwdAnchor(sessionCwd)(cwd),
  })
  const resolveClerkConfig = (session: ClerkSessionLike) =>
    resolveClerkHookConfig({
      daemon: loadDaemonClerkHook(daemonConfig),
      workspace: loadWorkspaceClerkHook(workspace),
      agent: session.clerkHook,
    }).config
  const clerkReaction = createClerkReaction({
    sessions,
    resolveConfig: resolveClerkConfig,
    runPass: legacyClerkPassRunner,
    ownedWorkspaces: readClerkReactionOwnedWorkspaces,
    emit: event => sessionEvents.emit(event),
  })
  clerkReactionBox.reaction = clerkReaction
  builtinReactionBindings.push(clerkReaction.binding)
  reactionRunner.replaceBindings(builtinReactionBindings)
  actionRegistry.register(clerkReaction.handler)
  actionRegistry.register(createSessionArchiveAction({ sessions }))
  const clerkTurnEnd = createClerkTurnEndController({
    registry: sessions,
    sessionEvents,
    resolveConfig: resolveClerkConfig,
    runPass: clerkReaction.dispatch,
  })
  // AIP-72 native-dir-diff capture: at each turn end and at exit, a
  // session whose spawn projected its native memory dir gets that dir
  // diffed and the changes written to its store as proposals.
  const nativeMemoryCapture = createNativeMemoryCapture({
    registry: sessions,
    sessionEvents,
    memoryStoreAt,
  })

  // Installed-app registry — singleton per daemon, shared between
  // `registerAppTools` (app_install/app_run/…) and the workflow runner's
  // `compileWorkflow` closure below, so a declarative `kind:"agent"` step's
  // `agent.ref` resolves against every app this daemon has installed (WP-B4).
  // Declared here (not inside `registerAppTools`) purely so both consumers
  // share the one instance — same persistence defaults as before this WP.
  const appRegistry = createAppRegistry({ persist })

  // BOOTSTRAP P7a/P7b closures — the device mirror + id resolution all
  // route through (BUG-1637's two-halves fix):
  //
  //   - `deviceMirrorSync` — the read-time sync hook. Bound to THIS
  //     registry + the daemon's host registry; syncDeviceMirror no-ops for
  //     sessions without a device identity, so it is safe to hand to every
  //     read path unconditionally.
  //   - the `device_prompt` tool's `sessions` slice — controller-session →
  //     host-session resolution (device-registry.ts's `promptDeviceSession`).
  // Note: the scoped-orchestrator SUB-gateway factory shares the same
  // module-level closures (sessions singleton), so a scoped child resolves
  // ids the same way — its own subtree only can't own a device spawn's
  // controller descriptor it didn't mint anyway.
  const deviceMirrorSync = (idOrName: string): Promise<unknown> =>
    syncDeviceMirror(sessions, opts.hostRegistry, idOrName)

  // Whether the `@agentik/session-chat` studio app is installed with a `ui`
  // block — resolved at call time (not boot) so `app_install`/`app_uninstall`
  // of that app is reflected without a daemon restart. Shared by the
  // builtin-panel mount (below, decides whether to mount the loopback-HTTP
  // `agentproto_session_chat` launcher at all) and `registerSessionTools`
  // (decides what `agent_start`'s launch-card binding points at) so the two
  // can never disagree about which surface is live.
  const isSessionChatInstalled = () => {
    try {
      return appRegistry.getApp(SESSION_CHAT_APP_ID)?.ui != null
    } catch {
      return false
    }
  }

  // Singleton controller for "publish to the internet" state. Created
  // disabled — auth stays `mode: "none"` until `remote_enable` is
  // called. Tunnel logs flow through the events stream so `/events`
  // subscribers see cloudflared chatter. `isSessionChatInstalled` decides
  // whether `enable()` emits `EnableResult.phoneUrl`
  // (PHONE-PLAN.md P1.2) — the same call-time check the builtin-panel mount
  // and `registerSessionTools` already share, so all three surfaces agree.
  const remote = new RemoteController({
    workspace,
    port,
    onLog: line =>
      events.emit({
        type: "remote-log",
        at: new Date().toISOString(),
        line,
      }),
    isSessionChatInstalled,
  })

  // HTML cache for installed apps' `ui.path` panels (app-ui-apps.ts) —
  // gateway-scope singleton so a `/mcp` request doesn't re-read an
  // unchanged panel's HTML off disk every time `mcpServerFactory` rebuilds
  // the server. Keyed by (path, app.updatedAt + the file's own mtime/size),
  // so both a re-install AND an in-place rebuild of the file invalidate it.
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
        // Run-history bounds (see workflow-run-store.ts): env overrides for the
        // output ceilings, the in-memory summary window and the stale-approval TTL.
        ...workflowRunnerEnvOptions(process.env),
        // Sandbox-capable agent steps (`AgentStep.sandbox` / workflow_start's
        // step `sandbox`) resolve providers through the same resolver
        // `agent_start.sandbox` uses.
        resolveSandboxProvider: resolveSandboxProviderResolved,
        // Agent-step sessions get this gateway mounted (scoped to the agent's
        // declared tools) — same default `agent_start` applies.
        daemonMcpUrl,
        // Hidden from app-workflow sessions (app-boundary.ts).
        daemonWorkspace: workspace,
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
        //
        // BRIEF-D: `resolveAppToolsForWorkflow` loads the owning app's own
        // AIP-14/30 TOOL.md/DRIVER.md bundles (undefined for a workflow no
        // installed app bundles, or one whose app bundles neither) and
        // `mergeAppAndDaemonToolRegistry` merges them over the daemon
        // passthrough registry — an app tool id wins over a daemon tool of
        // the same id, logged here. F40: `workflowMdPath` (this run's own
        // WORKFLOW.md) takes priority over the `app_install` registry — see
        // `resolveAppToolsForWorkflow`'s doc.
        compileWorkflow: async (handle, workflowMdPath) => {
          const daemonRegistry = createDaemonToolRegistry(handle, dispatchTool)
          const appRegistryEntry = await resolveAppToolsForWorkflow(appRegistry, handle.id, workflowMdPath)
          const merged = mergeAppAndDaemonToolRegistry(daemonRegistry, appRegistryEntry, {
            onOverride: toolId =>
              console.warn(
                `[workflow ${handle.id}] app-bundled tool '${toolId}' overrides the daemon tool of the same id`,
              ),
          })
          return compileWorkflow(handle, {
            ...merged,
            agentRefs: await resolveAgentRefsForWorkflow(
              appRegistry,
              handle.id,
              resolveModelRoleId,
              opts.resolveAgentAdapter,
            ),
          })
        },
        // App state ledger bridge: runs whose workflow belongs to an
        // installed app append stage-started/gate-report/stage-done/blocked
        // events to that app's ledger (see workflow-runner.ts, WP-Q).
        appRegistry,
      })
    : undefined

  // The review host's verdict-recovery config, read per recovery so a config
  // change applies without a restart. Shared with the decision-route
  // workflow tools, which preflight it against the execution profile.
  const getReviewRecovery = () => {
    const presets = (daemonConfig.review?.recoveryPresets ?? []).filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    )
    if (presets.length === 0) return undefined
    const role = resolveModelRoleEntry("review.recovery", { daemon: daemonConfig.models })
    return {
      presets,
      ...(role ? { model: { model: role.model, ...(role.profile ? { profile: role.profile } : {}) } } : {}),
    }
  }

  // Review runner — singleton per daemon (review-runner.ts), shared across
  // all MCP connections like `workflowRunner`. Attestations persist to the
  // review ledger under ~/.agentproto/reviews (a throwaway temp root when
  // `persist` is off, so test gateways never touch the real state dir).
  // Agent lanes spawn child reviewer sessions only when an adapter resolver
  // is wired; without one they report `skipped` (verdict `incomplete`).
  const reviewRunner = createReviewRunner({
    ledger: createReviewLedger(
      persist ? {} : { root: join(tmpdir(), `agentproto-reviews-${process.pid}-${randomUUID()}`) },
    ),
    daemonId: `agentproto-runtime@${hostname()}:${port}`,
    // A test gateway (`persist: false`) signs with a throwaway keypair, same
    // as its ledger — never the real `~/.agentproto/keys`.
    ...(persist
      ? {}
      : { signingKeysDir: join(tmpdir(), `agentproto-review-keys-${process.pid}-${randomUUID()}`) }),
    ...(daemonConfig.review?.principal ? { signingPrincipal: daemonConfig.review.principal } : {}),
    // Display-only settle notice (Goal A item 4, review-session-panel step):
    // a daemon-authored `notice` in the requester's own transcript, never a
    // prompt/inbox delivery — see `SessionsRegistry.recordNotice`'s doc for
    // why this can't wake an idle session or interrupt a busy one.
    notifyRequester: (sessionId, text) => {
      sessions.recordNotice(sessionId, text)
    },
    ...(opts.resolveAgentAdapter
      ? {
          reviewers: createDaemonReviewerHost({
            registry: sessions,
            sessionEvents,
            eventRing,
            resolveAgentAdapter: opts.resolveAgentAdapter,
            ...(daemonConfig.review?.laneRetries !== undefined ? { laneRetries: daemonConfig.review.laneRetries } : {}),
            getRecovery: getReviewRecovery,
            spawnDeps: {
              resolveSandboxProvider: resolveSandboxProviderResolved,
              ...(opts.listCatalogModels ? { listCatalogModels: opts.listCatalogModels } : {}),
            },
          }),
        }
      : {}),
  })

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

  // Approvals engine (approvals/engine.ts) — the daemon's human-approval
  // primitive on AIP-7 signatures (E1a). Always constructed (mirrors every
  // other gateway-owned store): with `persist` off (test gateways), it's
  // pointed at a throwaway tmp dir instead of skipping construction, so
  // `~/.agentproto/approvals` is NEVER touched by a `persist:false`
  // gateway — the same hermetic-tests guarantee `taskLedger` gets from its
  // own `persist` switch, expressed here as a homeDir choice instead of an
  // internal no-op flag (this module has no in-memory-only mode).
  const approvalsHomeDir = persist
    ? undefined
    : mkdtempSync(join(tmpdir(), "agentproto-approvals-"))
  const approvalsEngine: ApprovalsEngine = createApprovalsEngine({
    sessionEvents,
    ...(approvalsHomeDir ? { homeDir: approvalsHomeDir } : {}),
    webOrigins: daemonConfig.approvals?.webOrigins ?? [],
    ...(daemonConfig.approvals?.telegramBotSecret
      ? { telegramBotSecret: daemonConfig.approvals.telegramBotSecret }
      : {}),
  })

  // Supervisor crash-notification (crash-detect PR-4). Opt-in per child
  // (`notifyParentOnCrash`) — delivers a `[child-crashed] …` notice into a
  // crashed child's live parent, without ever interrupting a busy one. See
  // supervisor-notify.ts's header doc for the full contract.
  wireSupervisorNotify({ registry: sessions, sessionEvents })
  // `mcp:degraded`: a session that ended a turn without its harness ever
  // loading (or while it failed to load) the daemon's own `/mcp` tools.
  wireMcpDegradedWarnings({
    sessionEvents,
    getSession: id => sessions.get(id),
    store: mcpObservations,
  })

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

  // MCP proxy — single registry that holds open Client connections
  // to every imported MCP server. The per-request mcpServerFactory
  // captures it so each /mcp request reuses the same upstream
  // sessions instead of re-spawning stdio children.
  const mcpProxy = new McpProxyRegistry()
  // Per-call human approval for imported tools named by a `hold` rule in
  // `.agentproto/hooks.json` (e.g. agentpush `send_message`). No rule, no change.
  mcpProxy.setCallGuard(createImportedCallGuard({ registry: sessions, workspace }))

  // MCP Apps host (mcp-apps-host.ts) — the daemon fetches app UIs for a
  // session's chat. Its own config-keyed client pool: a harness alias is
  // resolved per session (session → project → user → imports), so two
  // sessions can mean different servers by the same name.
  const mcpAppsPool = new McpClientPool()
  const mcpAppsHost = new McpAppsHostService({
    pool: mcpAppsPool,
    resolve: async (sessionId, alias) => {
      const desc = sessions.get(sessionId)
      if (!desc) return undefined
      return resolveMcpServer(desc, sessionId, alias)
    },
    recordToolCall: (sessionId, record) => sessions.recordMcpAppToolCall(sessionId, record),
    lookupToolCallName: (sessionId, toolCallId) => sessions.findToolCallName(sessionId, toolCallId),
  })

  // Same proxy `mcp_imported_call` (session-tools.ts) dispatches through —
  // unwraps `{ok,result}|{ok:false,error}` into a plain return-or-throw for
  // `app_tool_call`'s `imported:<alias>/<toolName>` ids. Hoisted so the MCP
  // verb (registerAppTools below) and the REST twin (startHttpServer's
  // `appToolCallDeps`) share one definition.
  const callImportedAppTool = async (
    alias: string,
    tool: string,
    args: Record<string, unknown>,
    callerSessionId?: string,
  ): Promise<unknown> => {
    const out = await mcpProxy.callTool(alias, tool, args, callerSessionId ? { callerSessionId } : undefined)
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
  // Liveness is decided by STATUS (what `sendMessage` itself checks), with an
  // explicit `processAlive === false` as an extra veto. `processAlive` alone is
  // `undefined` for a pid-less ACP-native/remote row — even a dead one — so it
  // cannot be the sole signal.
  const isSessionAlive = (id: string): boolean => {
    const desc = sessions.get(id)
    if (!desc) return false
    return (desc.status === "running" || desc.status === "starting") && desc.processAlive !== false
  }
  // Shared restart core (PR C): an ended-but-resumable agent-cli row is
  // revived IN PLACE (same id) via the registry's resume primitive instead
  // of minting a new row — the sentinel's re-target below then no-ops.
  // The flag splits the two callers by INTENT:
  //   - the SENTINEL is an AUTOMATIC path — a deliberate end
  //     (operator-completed / steward-*) is never revived in place; it
  //     falls back to today's new-id restart (and the sentinel's own
  //     sessionInfo guard routes deliberate ends to the parent / parking
  //     before this is ever reached).
  //   - INBOUND (watcher + push router) is a HUMAN writing to the session —
  //     explicit intent, so a deliberate end may still be revived in place.
  const restartSentinelSession = makeRestartForRouting(
    { sessions, resolveAgentAdapter: opts.resolveAgentAdapter, daemonMcpUrl },
    { name: "restartSentinelSession", allowDeliberateEnd: false },
  )
  const restartInboundSession = makeRestartForRouting(
    { sessions, resolveAgentAdapter: opts.resolveAgentAdapter, daemonMcpUrl },
    { name: "restartInboundSession", allowDeliberateEnd: true },
  )

  // Sentinel primitive (AIP-60) — poll/delivery engine over the store +
  // resolver already built above (hoisted so the auto-link hook could use
  // them before `sessions` existed). Landing reuses the same dead-session
  // restart hook shape the inbound router uses, above — but with
  // allowDeliberateEnd:false: the sentinel is an AUTOMATIC path and never
  // revives a deliberate end in place (its own sessionInfo guard routes
  // those to the parent / parking first anyway).
  const sentinelRuntime = createSentinelRuntime({
    store: sentinelStore,
    registry: { sendMessage: sessions.sendMessage },
    resolveProvider: resolveSentinelProviderResolved,
    isSessionAlive,
    restartSession: restartSentinelSession,
    sessionInfo: id => {
      const desc = sessions.get(id)
      if (!desc) return undefined
      const successorId = resolveSuccessor(sid => sessions.get(sid), id)
      return {
        endedReason: desc.endedReason,
        parentSessionId: desc.parentSessionId,
        archived: desc.archived,
        continuedTo: desc.continuedTo,
        retiredAt: desc.retiredAt,
        ...(successorId ? { successorId } : {}),
      }
    },
  })

  // A session that registers may be the target of events parked while it was
  // unreachable; redeliver them once (the runtime's tick covers retargets).
  sessionEvents.on("session:spawned", ev => {
    void sentinelRuntime.replayParked(ev.sessionId).catch(() => {})
  })

  // Session-follow — wakes a follower session (no polling) when sessions
  // matching a selector end a turn / await input / exit / get a PR opened or
  // merged. Delivery never interrupts; a dead follower is resumed through the
  // same automatic-path restart core the sentinel uses (never a deliberate
  // end). See session-follow.ts.
  //
  // TRIAGE (off by default): every event is classified wake/fyi/drop by
  // deterministic rules BEFORE a digest may wake the follower; a digest whose
  // events are all fyi/drop lands in the follower's inbox instead of waking
  // it. The daemon-level default comes from `config.follow.triage` (read
  // fresh per digest), a follow's own `triage` block overrides it.
  const sessionFollow = wireSessionFollow({
    registry: sessions,
    sessionEvents,
    store: sessionFollowStore,
    restartSession: restartSentinelSession,
    triage: async () => {
      const cfg = await loadConfig().catch((): { follow?: { triage?: FollowTriageInput } } => ({}))
      return resolveFollowTriageConfig(defaultFollowTriageConfig(), cfg.follow?.triage)
    },
    // A cron command job's successful exit is informational when the job
    // declares `notify: "onFailure"`. Resolved at event time from the
    // descriptor captured then, so a later delete or rename cannot flip it.
    sourceUrgency: desc => {
      if (desc.origin !== "cron" || desc.kind !== "command" || !desc.label) return undefined
      const match = /^cron:(.+)$/.exec(desc.label)
      if (!match) return undefined
      return cronScheduler.get(match[1]!)?.notify === "onFailure" ? "fyi" : undefined
    },
    triageFacts: {
      // "A cron run that finished OK already reported itself" — the cron
      // ledger is the only place that knows the run's real outcome.
      cronOk: (sessionId: string): boolean | undefined => {
        const runs = cronScheduler.runs({ limit: 200 }).runs
        const run = runs.find(r => r.sessionId === sessionId)
        return run ? run.ok : undefined
      },
    },
  })

  // Retirement cleanup — re-point follows/sentinels of a superseded session
  // at its successor; drop those of an archived/forgotten one. A periodic
  // sweep (below) handles orphans from an older daemon and the `expiresAt`
  // backstop, mirroring the cron scheduler's owner lifecycle.
  const wiringCleanupDeps = {
    registry: sessions,
    followStore: sessionFollowStore,
    sentinelStore,
    cancelSentinel: (id: string) =>
      cancelSentinelWatch(
        {
          store: sentinelStore,
          resolveProvider: resolveSentinelProviderResolved,
          tombstones: sentinelRuntime.cancelTombstones,
        },
        id,
      ),
  }
  wireRetirementCleanup(wiringCleanupDeps)

  let wiringSweepTimer: ReturnType<typeof setInterval> | null = null
  const sweepWiring = (): void => {
    void sweepWiringLifecycle(wiringCleanupDeps).catch(err => {
      console.warn(`[retirement-cleanup] wiring sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  sweepWiring()
  wiringSweepTimer = setInterval(sweepWiring, 60_000)
  wiringSweepTimer.unref?.()

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
  // factory below both close over it. Persisted (when `persist` is on) so
  // the `/mcp/orchestrator?scope=` URLs already baked into session
  // descriptors keep authorizing across a daemon restart — the registry
  // loads the file synchronously here, after the sessions registry above
  // has already restored its history.
  const scopeTokens = createScopeTokenRegistry(
    persist ? { persistPath: orchestratorScopesFile() } : undefined,
  )

  // Boot prune: drop scopes that can never be needed again — dead-owner
  // scopes and orphaned unowned tokens no alive/resumable descriptor
  // references — so the file does not grow forever. (The predicate itself
  // lives in `pruneOrchestratorScopesOnBoot` and deliberately KEEPS the
  // killed-but-resumable rows this boot's history load just marked: they
  // are the ones whose persisted `mcpServers` still carry the
  // `/mcp/orchestrator?scope=` URL this persistence exists to keep
  // working.)
  pruneOrchestratorScopesOnBoot(scopeTokens, sessions.list())
  // Legacy migration: tokens minted by an older (pre-persistence) daemon
  // are absent from orchestrator-scopes.json but still baked into live /
  // resumable session descriptors' mcpServers — adopt them so those
  // already-persisted URLs keep authorizing without a session restart.
  // A no-op once the file exists: an unknown token is then a dead one.
  adoptLegacyOrchestratorScopes(scopeTokens, sessions.list())
  // Restart support: a revived row gets its revoked scope back, a restarted
  // row hands its scope to the successor (session-restart-core.ts).
  orchestratorScopeHooks = createOrchestratorScopeHooks(scopeTokens)

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
    // Same workspace allowlist as the root gateway: a nested supervisor
    // spawns through this scoped surface, which is the one the stdio mount
    // gate exists for.
    loadCommandAllowlist: () => loadAllowlistEntries(workspace),
    // No `defaultAgentPromptInterrupt` / `messagingAllowSiblings` /
    // `messagingAgentInterrupt` override here: the factory's own per-call
    // closure (orchestrator-gateway.ts) reads `defaults.agentPromptInterrupt`
    // / `defaults.messaging.*` fresh via `resolveMessagingDefaults` on every
    // `/mcp/orchestrator` request, so a `config_set` change hot-applies with
    // no restart. Passing a static value here would re-freeze it at boot.
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

  /** A session the daemon spawned (an `external` row is a label, not one). */
  const isHostSpawnedSession = (id: string): boolean => {
    const desc = sessions.get(id)
    return desc !== undefined && desc.kind !== "external"
  }
  const mcpServerFactory = async (
    denyTools?: ReadonlySet<string>,
    callerSessionId?: string,
    origin?: string,
    deferredOverride?: boolean,
    allowTools?: ReadonlySet<string>,
    surface?: string,
    credentialSessionId?: string,
  ) => {
    const { server: rawServer } = await createMcpServer({
      specs: opts.specs,
      workspace,
      name: opts.name ?? "agentproto-runtime",
      version: opts.version ?? "0.1.0-alpha",
    })
    // AIP-42 manifest authoring: render a valid `agent/v1` AGENT.md into the
    // caller's workspace `.agents/<id>/AGENT.md` via the shared app
    // renderer (same path `emitApp` and `agentproto agent create` use).
    // Call-time deny gate for the tool deny grants an AGENT manifest recorded
    // on the caller's descriptor at spawn (tool-deny-gate.ts). Applied
    // innermost, ahead of every `register*` pass below, so every built-in
    // registered through `tool()`/`registerTool()` is covered, including the
    // two passes right here. No caller, or a caller with no grants: the raw
    // server, unchanged.
    const callerDenyGrants = callerSessionId ? sessions.get(callerSessionId)?.toolDenyGrants : undefined
    const gatedServer = callerSessionId && callerDenyGrants?.length
      ? withToolDenyGate(rawServer, callerDenyGrants, callerSessionId)
      : rawServer
    registerCreateAgentTool(gatedServer, { workspace })
    // AIP-14/AIP-30 tool authoring (`create_tool` / `delete_tool`). A NEW
    // primitive, gated by the AUTHENTICATED CALLER'S own AIP-42
    // `actions.granted` (default DENY) and bounded by a minimum lifetime + a
    // per-agent/day delete limit. The grant subject is resolved here from the
    // trusted `callerSessionId` (the session's own manifest is recorded on its
    // descriptor `meta` at spawn — see `session-spawn.ts`), NEVER from a
    // caller-supplied tool argument. A caller with no resolvable manifest
    // fails closed.
    const createToolCallerSession = callerSessionId ? sessions.get(callerSessionId) : undefined
    const callerAgentId = createToolCallerSession?.meta?.agentId
    const callerAgentManifestPath = createToolCallerSession?.meta?.agentManifestPath
    registerCreateToolTools(gatedServer, {
      workspace,
      ...(callerSessionId ? { sessionId: callerSessionId } : {}),
      ...(callerAgentId ? { agentId: callerAgentId } : {}),
      ...(callerAgentManifestPath ? { manifestPath: callerAgentManifestPath } : {}),
    })
    // Read `defaults.agentPromptInterrupt` / `defaults.messaging.*` fresh on
    // every call (this factory runs once per `/mcp` request — the SDK's
    // stateless pattern, see `serveMcp` in http-server.ts) instead of the
    // gateway-boot-time `configDefaults` snapshot, so a `config_set` change
    // takes effect on the very next `agent_prompt` / `message_parent` /
    // `message_send` / `message_reply` call, no daemon restart.
    const messagingDefaults = await resolveMessagingDefaults()
    // Same fresh-per-request read for the task ledger's operator delegates,
    // so a `config_set` takes effect on the next task_* call.
    const taskDefaults = await resolveTaskDefaults()
    // Deferred/lazy tool loading (opt-in — see deferred-tools.ts). Wraps
    // every subsequent `registerXTools(server, ...)` pass below so tools
    // outside `alwaysOn` register but start disabled (hidden from the
    // first `tools/list`) until `tool_search` pulls them in. Off →
    // `server` is the raw, fully-eager gateway, today's behaviour.
    //
    // `deferredOverride`, when defined, is the per-request `?deferred=1|0`
    // query (see `handleMcp` in http-server.ts) — it wins over the
    // gateway's own boot-time `opts.deferredTools` default either way (a
    // session-spawn role default or explicit `agent_start.deferredTools`
    // can force deferred ON for a spawn even when the daemon boots eager,
    // or force it OFF for one that needs the full surface even when the
    // daemon boots deferred). Undefined ⇒ fall through to whether the
    // gateway itself was configured with `deferredTools` at all. The
    // always-on set always comes from `opts.deferredTools.alwaysOn` (falling
    // back to `DEFAULT_ALWAYS_ON_TOOLS`) — the per-request query only
    // toggles deferred mode on/off, it never carries its own custom set.
    // The delegation tools are always-on regardless of a custom set: a
    // session told to delegate through `agent_start` must see it on its
    // first `tools/list`, not have to go hunting for it. A deny-role's mount
    // still loses them — the `denyTools` exclusion below wraps outermost.
    const deferredActive = deferredOverride ?? opts.deferredTools !== undefined
    let server = deferredActive
      ? withDeferredTools(gatedServer, {
          alwaysOn: new Set([
            ...(opts.deferredTools?.alwaysOn ?? DEFAULT_ALWAYS_ON_TOOLS),
            ...DELEGATION_TOOL_NAMES,
          ]),
        })
      : gatedServer
    // Spawn-role-profiles tool gate (the hard part of the executor/
    // supervisor primitive — see role.ts). Per-request denylist parsed
    // from `?denyTools=a,b` on THIS `/mcp` call (see `handleMcp` in
    // http-server.ts) — outermost wrap so it wins over deferred-tools
    // unconditionally: an excluded name never reaches registration at
    // all, regardless of `alwaysOn`.
    if (denyTools && denyTools.size > 0) {
      server = withToolExclusion(server, denyTools)
    }
    // Per-request ALLOWLIST from `?allowTools=a,b` — a workflow agent step's
    // mount, scoped to its AGENT.md `tools:` (sessions-registry-agent-host.ts
    // `agentStepMcpServers`). Only the named tools register at all.
    if (allowTools && allowTools.size > 0) {
      server = withToolSubset(server, allowTools)
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
    // App boundary (app-boundary.ts): the caller's fs zones ride on its
    // session descriptor. Recovered here from the trusted callerSessionId so
    // fs tools and command_execute confine an app-spawned session. Raw PTY
    // terminals run unconfined shells, so they are not mounted for it.
    const boundary = callerSessionId
      ? boundaryFromMeta(sessions.get(callerSessionId)?.meta)
      : undefined
    // AIP-34 node scope of THIS request's caller: no id is a host call, an id
    // the daemon does not know is refused by every scoped read below. Derived
    // from the session's own ground, never from server config.
    const callerScope = callerScopes.resolve(callerSessionId, sessions)
    if (boundary) {
      server = withToolExclusion(
        server,
        new Set(["terminal_start", "terminal_input", "terminal_output", "terminal_kill"]),
      )
    }
    // Canonical filesystem tools so remote MCP clients (cloud
    // workspace-providers, IDEs, ad-hoc tooling) can read/write the
    // workspace without each implementing AIP-aware glue. Names match
    // `@modelcontextprotocol/server-filesystem` for drop-in compat.
    registerFsTools(server, { workspace, callerScope, ...(boundary ? { boundary } : {}) })
    // Cheap, read-only liveness probe. Registered early so it is available
    // even when deferred tools hide the rest of the surface.
    registerDaemonHealthTools(server, {
      workspace,
      registered,
      startedAt,
      resumeSessionsOnBoot: opts.resumeSessionsOnBoot === true,
      bootResumePolicy: opts.bootResumePolicy,
      resumeServicesOnBoot: opts.resumeServicesOnBoot !== false,
      continueInterruptedOnBoot: opts.continueInterruptedOnBoot === true,
      idleReapAfterMs,
      sandboxIdleReapAfterMs,
      crashDetectIntervalMs,
      restartSweepIntervalMs,
      turnStallAfterMs,
      appRegistryIssues: () => appRegistry.listIssues(),
      appRegistryRepairs: () => appRegistry.listRepairs(),
      modelCooldowns: () => modelCooldowns.list(),
      sandboxSessions: () => sessions.sandboxSessionStats(),
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.build ? { build: opts.build } : {}),
    })
    // Read-only lookup for a tool's long-form docs (`tool-help.ts`) — the
    // fetch side of the slimmed-description contract every tool's schema
    // now points at. Always-on (see DEFAULT_ALWAYS_ON_TOOLS) and tiny.
    registerToolHelpTool(server)
    // Live provider quota for a named auth profile (AIP-67). Always-on (see
    // DEFAULT_ALWAYS_ON_TOOLS). `currentProfileRef` resolves the CALLING
    // session's own access profile from the trusted `callerSessionId`, the
    // same identity plumbing `boundary` above reads, so a caller that omits
    // `profileRef` gets its own quota rather than inventing a fallback.
    registerQuotaStatusTool(server, {
      currentProfileRef: callerSessionId
        ? () => sessions.get(callerSessionId)?.accessProfile?.profileRef
        : undefined,
    })
    // Occasional/admin tool (deliberately NOT in DEFAULT_ALWAYS_ON_TOOLS):
    // diffs the LLM pricing catalog against the last call's stored baseline
    // and re-records "now" as the new baseline.
    registerCatalogDiffTool(server, {})
    // AIP-72 memory store tools (memory_search/list/read/write/supersede/
    // archive/dismiss). The caller is the trusted `callerSessionId` (none =
    // the operator bearer); a commit needs the operator or a supervisor-role
    // session, everyone else proposes (memory-tools.ts). The store is the
    // one the caller's agent binds (`meta.memoryStoreRoot`, set at spawn),
    // else the daemon default.
    registerMemoryTools(server, {
      caller: resolveMemoryCaller(callerSessionId, id => sessions.get(id)?.meta),
      callerScope,
      store: () =>
        memoryStoreAt(
          (callerSessionId ? sessions.get(callerSessionId)?.meta?.memoryStoreRoot : undefined) ??
            defaultMemoryRoot(),
        ),
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
      ...(boundary ? { boundary } : {}),
      // The GLOBAL checkpoint ref namespace, for the provenance stamp's
      // checkpoint read (a session's own per-spawn override wins over it).
      ...(configDefaults?.sandbox?.checkpoint?.refPrefix
        ? { checkpointRefPrefix: configDefaults.sandbox.checkpoint.refPrefix }
        : {}),
    })
    // Approvals (E1a) — model-visible request/get/wait/consume are safe
    // everywhere (they can request and consume, never decide) and register
    // on every surface. `callerSessionId` mirrors `registerCommandTools`
    // just above: a daemon-spawned session's self-ref connection carries
    // one, so its requests are attributed to that session instead of
    // falling back to the operator.
    registerApprovalTools(server, {
      engine: approvalsEngine,
      ...(callerSessionId ? { callerSessionId } : {}),
    })
    // SECURITY BOUNDARY: `approval_card_decide` and every
    // `ui://agentproto/approval/<id>` card resource are mounted ONLY on the
    // dedicated `?surface=approval-cards` connection, and `handleMcp`
    // (http-server.ts) already refuses that surface outright when a
    // `callerSessionId` is present — the `!callerSessionId` check here is
    // defense in depth for any other caller of this factory. Every other
    // surface (root `/mcp`, any daemon-spawned session's self-ref
    // connection) gets NEITHER: an agent CLI's model can typically
    // `resources/read` and call app-only tools despite
    // `_meta.ui.visibility: ["app"]` (most hosts don't honour it), so
    // mounting the card there would let an agent mint its own ticket and
    // self-approve. Only a human-facing MCP Apps host (Claude Desktop via
    // `install-mcp --app`, configured to dial `/mcp?surface=approval-cards`)
    // is meant to ever see this surface. Re-derived from the engine's own
    // pending set on every build (this factory runs once per stateless
    // `/mcp` connection — see the module docblock — so a resource
    // registered inside a tool handler would vanish before the next
    // connection could `resources/read` it).
    if (surface === "approval-cards" && !callerSessionId) {
      registerApprovalCardDecideTool(server, approvalsEngine)
      for (const pending of approvalsEngine.list({ status: "pending" })) {
        registerUiResource(server, {
          name: `approval-${pending.id}`,
          uri: approvalCardResourceUri(pending.id),
          html: () => renderApprovalCardHtml(approvalsEngine, pending.id),
          description: "Human approval card",
        })
      }
    }
    // Remote-tunnel lifecycle. The controller is a singleton on the
    // gateway, so registering its tools per-request is just rebinding
    // the same closures — the underlying state lives in `remote`.
    registerRemoteTools(server, { controller: remote })
    // E2E daemon-pairing tools (pair_offer / pair_list / pair_revoke) — only
    // when a pairing registry was wired. Same closure-rebind pattern as the
    // remote tools above; the registry singleton lives on the gateway.
    if (opts.pairingRegistry) {
      registerPairingTools(server, { registry: opts.pairingRegistry })
      // Device view over the same registry (DEVICES-PLAN PR-A), plus any
      // registered hosts (PR-C) — role/kind/online layered on top of
      // pair_list's records. device_revoke has the exact effect of
      // pair_revoke; both surfaces stay live.
      registerDeviceTools(server, {
        registry: createDeviceRegistry(opts.pairingRegistry, opts.hostRegistry),
        ...(opts.hostRegistry ? { hosts: opts.hostRegistry } : {}),
        // BOOTSTRAP P7a — controller→host id resolution for `device_prompt`
        // (issue #1637). The gateway-scoped registry, not the caller's scope:
        // a controller descriptor lives daemon-wide.
        ...(sessions ? { sessions: sessions as unknown as DevicePromptSessionsLike } : {}),
        ...(opts.joinTokens ? { joinTokens: opts.joinTokens } : {}),
      })
    }
    // Agent-session orchestration — operators (Mastra agents in
    // cloud Guilde, Claude Code as a sub-agent, …) drive long-running
    // claude/hermes/aider sessions on the user's machine through
    // these MCP tools. The registry + adapter resolver are
    // singletons on the gateway, same closure-rebind pattern.
    registerSessionTools(server, {
      registry: sessions,
      mcpObservations,
      workspace,
      mcpProxy,
      // `session_restart` re-arms the cron jobs that targeted the restarted
      // session (the restart continues the conversation under a NEW id).
      cronScheduler,
      ptyEnabled: opts.spawnPty != null,
      // BOOTSTRAP P7b — read-time device-mirror sync (forwarded to
      // `registerAgentTools`; `agent_output` pulls the device session's
      // host turns in before tailing). No-op for local sessions.
      deviceMirrorSync,
      // Phase 4: lets an `agent_start` carrying `costBudget` auto-attach a
      // windowed cost-budget governance policy on the spawned session.
      supervisor,
      taskLedger,
      buildOrchestratorMcp: orchestratorInjector,
      // Same `?callerSessionId=` query that attributes `command_execute` back
      // to the calling session (above) — here it's the implicit auto-parent so
      // a spawn made by an agent session attaches under it by default (see
      // spawn-attach.ts). Absent on a human/root `/mcp` call → no auto-parent.
      ...(callerSessionId ? { callerSessionId } : {}),
      // The session a valid session token on this request was minted for:
      // the spawn proof gate's credential leg (AIP-46 §Session principals).
      ...(credentialSessionId ? { credentialSessionId } : {}),
      // `?origin=` query (#session-visibility) — the connecting client's source
      // label, used as the default origin for a spawn that doesn't set its own.
      ...(origin ? { mcpBridgeOrigin: origin } : {}),
      webhookNotifier,
      daemonMcpUrl,
      resolveSandboxProvider: resolveSandboxProviderResolved,
      ...(ensureLlmEndpointRunning ? { ensureLlmEndpointRunning } : {}),
      // The stdio mount gate reads the SAME workspace allowlist
      // `command_execute` gates against, so `agent_start` mounts and
      // `command_execute` cannot drift.
      loadCommandAllowlist: () => loadAllowlistEntries(workspace),
      // `messagingDefaults` (resolved fresh above, per call) — the
      // unset-defaults for `interrupt` on agent_prompt/message_parent and
      // for message_send/message_reply's sibling/interrupt gates.
      defaultAgentPromptInterrupt: messagingDefaults.agentPromptInterrupt,
      messagingAllowSiblings: messagingDefaults.allowSiblings,
      messagingAllowSameWorkspace: messagingDefaults.allowSameWorkspace,
      messagingPeerBinding: messagingDefaults.peerBinding,
      messagingPeerGroups: messagingDefaults.peerGroups,
      messagingGrants: messagingDefaults.grants,
      messagingAgentInterrupt: messagingDefaults.agentInterrupt,
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
      ...(opts.runBranchGc ? { runBranchGc: opts.runBranchGc } : {}),
      ...(opts.runSandboxCheckpointGcSweep
        ? { runSandboxCheckpointGcSweep: opts.runSandboxCheckpointGcSweep }
        : {}),
      ...(opts.recordBranchGcVerdict ? { recordBranchGcVerdict: opts.recordBranchGcVerdict } : {}),
      ...(opts.readBranchGcVerdict ? { readBranchGcVerdict: opts.readBranchGcVerdict } : {}),
      isSessionChatInstalled,
      // `session_tree`'s `reviews` badge (review-session-panel step) —
      // the same gateway-singleton runner `registerReviewTools` uses below.
      reviewRunner,
    })
    // Per-workspace brain — query/status/ingest over the shared brain
    // registry declared at gateway boot (workspaceBrains).
    registerBrainTools(server, {
      brains: workspaceBrains,
      registry: sessions,
      callerScope,
      ...(callerSessionId ? { callerSessionId } : {}),
    })
    // Named auth-profile lifecycle (auth_profile_create/delete/list). No
    // host wiring — `@agentproto/auth` reads/writes the fixed
    // `~/.agentproto/auth-profiles.json` + keychain slots directly, same as
    // the profile readers already mounted in session-spawn.ts.
    registerAuthProfileTools(server)
    // `config_get`/`config_set` (PR-2) — the one MCP surface for
    // `~/.agentproto/config.json`, over the `config-schema.ts` key
    // registry. Root /mcp only: deliberately NOT added to
    // `DEFAULT_ORCHESTRATOR_TOOLS` (orchestrator-gateway.ts), so a scoped
    // child orchestrator can never reconfigure the daemon it runs on. The
    // caller lets `config_set` refuse a session an operator-only key
    // (AIP-46 §Operator-only configuration).
    registerConfigTools(server, configToolsDeps, {
      ...(credentialSessionId ? { credentialSessionId } : {}),
      ...(callerSessionId ? { claimedSessionId: callerSessionId } : {}),
      isHostSpawned: isHostSpawnedSession,
    })
    // `model_roles` — read-only role → model listing (model-roles.ts). Same
    // root-only exposure; workflow `tool` steps reach it through dispatchTool.
    registerModelRolesTools(server)
    // `decision_decide` — the DECISION.md decision router (decision.ts).
    // Root-only like `model_roles`; workflows pass policy markdown + evidence
    // from `tool` steps. Classifier = the generic Jev client; no escalation
    // backend is wired at the tool layer.
    registerDecisionTools(server)
    // `decision_*` stage tools — the staged `decision-route` workflow
    // (workflows/decision-route). The escalation host is built per call from
    // the resolved execution profile, which re-checks the live session.
    registerDecisionWorkflowTools(server, {
      reviewRunner,
      getRecovery: getReviewRecovery,
      presetLookups: {
        resolveRole: role => resolveModelRoleEntry(role, { daemon: daemonConfig.models }),
      },
      ...(opts.resolveAgentAdapter
        ? {
            createEscalationHost: profile =>
              createDaemonEscalationHost({
                registry: sessions,
                sessionEvents,
                eventRing,
                resolveAgentAdapter: opts.resolveAgentAdapter!,
                spawnDeps: {
                  resolveSandboxProvider: resolveSandboxProviderResolved,
                  ...(opts.listCatalogModels ? { listCatalogModels: opts.listCatalogModels } : {}),
                },
                profile,
              }),
          }
        : {}),
    })
    // Persisted harness→profile bindings (harness_preset_list/create/delete/
    // set_default). Same no-host-wiring stance as the auth-profile tools —
    // the store reads/writes the fixed `~/.agentproto/harness-presets.json`.
    registerHarnessPresetTools(server)
    // User-owned spawn presets ("favorites") — user_preset_list/save/delete,
    // the MCP twin of the `/user-presets` HTTP routes. `includeRecent` reads
    // the same session registry as every other session-backed tool here.
    registerUserPresetTools(server, { registry: sessions })
    // User-owned model lists — model_list_save/list/delete/resolve. Same
    // no-host-wiring stance: the store reads/writes model-lists.json.
    registerModelListTools(server)
    // Read-only scanner: report locally-present credentials (Claude Code /
    // Codex / Gemini logins, ~/.hermes/config.yaml, provider env keys) with
    // provenance, so onboarding can offer an import. Never returns a value.
    registerCredentialDiscoveryTools(server)
    // Multi-candidate AIP-30 tool: Brave (free tier) + Serper HTTP drivers,
    // resolved by the 6-phase resolver. Key-gated — registers nothing when
    // neither BRAVE_SEARCH_API_KEY nor SERPER_API_KEY is set.
    registerWebSearchTools(server)
    registerBrowserTools(server, {
      registry: sessions,
      ...(opts.resolveBrowserAdapter
        ? { resolveBrowserAdapter: opts.resolveBrowserAdapter }
        : {}),
      ...(opts.listBrowserAdapters
        ? { listBrowserAdapters: opts.listBrowserAdapters }
        : {}),
      // browser_upload_file may attach files from the agent's own workspace
      // (merged over the ~/.pygmalion/data default + the env allowlist).
      uploadAllowDirs: [opts.workspace],
    })
    // MCP Apps host verbs — same root-/mcp-only exposure as mcp_imported_*.
    registerMcpAppHostTools(server, { service: mcpAppsHost })
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
      ...(callerSessionId ? { callerSessionId } : {}),
      ...(credentialSessionId ? { credentialSessionId } : {}),
      operatorDelegates: taskDefaults.operatorDelegates,
    })
    // Review primitive (@agentproto/review) — review_run/status/cancel/
    // ledger/export over the gateway-singleton runner + ledger above. The
    // calling session (if any) parents the agent lanes' reviewer sessions.
    registerReviewTools(server, {
      runner: reviewRunner,
      ...(callerSessionId ? { callerSessionId } : {}),
      // `review_ledger({requesterSessionId, subtree: true})` — expand to the
      // requester's whole subtree via the same BFS session_tree/session_list
      // use, over the full (includeArchived) list so an archived ancestor
      // never severs the parent→child graph the BFS walks.
      resolveSubtree: sessionId => [...collectSubtree(sessionId, sessions.list({ includeArchived: true }))],
    })
    // @agentproto/app app lifecycle — install/list/run/status/stop
    // (app-tools.ts). `resolveAgentAdapter` gates the adapter-resolves check
    // (app_install) and the spawn (app_run) the same way it gates
    // `workflowRunner` above; `listRegisteredToolIds` is always wired (the
    // same lazy internal-server reach-in `dispatchTool` uses).
    registerAppTools(server, {
      registry: sessions,
      listRegisteredToolIds,
      appRegistry,
      dispatchTool,
      callImportedTool: (alias, tool, args) => callImportedAppTool(alias, tool, args, callerSessionId),
      daemonWorkspace: workspace,
      daemonMcpUrl,
      resolveModelRole: resolveModelRoleId,
      persist,
      ...(opts.resolveAgentAdapter ? { resolveAgentAdapter: opts.resolveAgentAdapter } : {}),
      ...(workflowRunner ? { workflowRunner } : {}),
    })
    // App-scoped durable data plane (app-data.ts) — app_data_read/write/list/
    // migrate, anchored to each installed app's own dir with traversal guard.
    registerAppDataTools(server, { appRegistry, callerScope })
    // Read-only external filesystem plane (app-external.ts) —
    // app_external_list/app_external_read, anchored to each installed app's
    // opted-in InstalledApp.externalReadRoots (never the app's own sandbox
    // dir). No write/delete tool exists here by design; binary files are
    // never read into a tool response — see GET /apps/:appId/external-blob
    // in http-server.ts for that.
    registerAppExternalTools(server, { appRegistry, callerScope })
    registerTelegramBotTools(server, { telegramCreds: telegramBotCreds })
    // MCP Apps — agentproto_sessions panel via the AgnoMcpApp adapter.
    // Tool: agentproto_sessions  Resource: ui://agentproto_sessions/view
    const listCatalogRows = async (): Promise<ReadonlyArray<Record<string, unknown>>> => {
      const rows = (await dispatchTool("app_catalog", {})) as unknown
      if (typeof rows !== "string") return []
      try {
        const parsed: unknown = JSON.parse(rows)
        return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
      } catch {
        return []
      }
    }
    const listInstalledRows = (): ReadonlyArray<Record<string, unknown>> => {
      const apps: ReadonlyArray<unknown> = appRegistry.listApps()
      return apps as ReadonlyArray<Record<string, unknown>>
    }
    const listUpdateRows = (): ReadonlyArray<Record<string, unknown>> =>
      appRegistry
        .listApps()
        .filter(a => a.source !== undefined && a.source.kind !== "local" && a.source.catalogId !== undefined)
        .map(a => ({ appId: a.appId, updateAvailable: true, ...(a.version !== undefined ? { version: a.version } : {}) }))
    const listSessionsFiltered = (filter?: "running" | "all") => {
      // `kind:"command"` rows are a shell-execution log, not a resumable
      // session — every consumer of this (sessions/agents-overview/bureau/
      // session-story panels) either wants the live-able agent/PTY set or
      // filters to a specific non-command kind of its own, so they're
      // excluded here too, matching `session_list`'s default-view semantics.
      let rows = sessions.list().filter(s => s.kind !== "command" && s.kind !== "external")
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
    // The daemon-builtin panels — now house-app-quality code in
    // @agentproto/apps, mounted here without an app_install step (see
    // builtin-apps.ts for why they aren't AppHandles).
    const builtinPanelApps = [
      ...makeBuiltinPanelApps({
        listSessions: listSessionsFiltered,
        // httpBaseUrl = this daemon's own origin (SSE stream + bridge
        // fallback for the live-session widget).
        httpBaseUrl: publicHttpOrigin,
        // The session-chat widget is a thin launcher for the installed
        // `@agentik/session-chat` studio app — same call-time-resolved check
        // `registerSessionTools` above gets, so the mount decision here and
        // `agent_start`'s launch-card binding never disagree.
        isSessionChatInstalled,
        // Work-board widget's read path — the root `/mcp` endpoint has no
        // scope, so this mount is always the operator caller (default
        // board `ws:<slug>`); `canAccessBoard` lets the operator read any
        // board (including a `tree:*` one) when an explicit boardId is
        // passed in from the panel's board switcher.
        listTasks: (boardId) => ({
          boardId: taskLedger.resolveBoardId({ kind: "operator" }, boardId),
          tasks: taskLedger.list(
            { ...(boardId ? { boardId } : {}), includeClosed: true },
            { kind: "operator" },
          ),
        }),
        // Reviews widget's initial-snapshot read path — the SAME
        // `reviewLedgerView` function `review_ledger` itself calls
        // (review-tools.ts), so this can never drift from what the tool
        // returns. `includeRunning: true` always on, matching the panel's
        // own live-poll behavior.
        listReviews: (input) =>
          reviewLedgerView(
            reviewRunner,
            { ...input, includeRunning: true },
            { resolveSubtree: (sessionId) => [...collectSubtree(sessionId, sessions.list({ includeArchived: true }))] },
          ),
        // Store widget's read paths — app_catalog's rows (via the SAME
        // `dispatchTool` the panel's own apply verbs will route through, so
        // its snapshot can never disagree with what the tool call returns),
        // and the registry's installed apps.
        listCatalog: listCatalogRows,
        listInstalled: listInstalledRows,
        listUpdates: listUpdateRows,
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
    // Dynamic UI panels for installed `@agentproto/app` apps that ship
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
      // Same source as agent_output — including its terminal-row fallback to
      // the final text, since a finished row's rings are cleared at exit.
      tailLines: (id, lastN) => sessions.readOutputTail(id, lastN),
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
    // App-facing tunnel verb — loads an app manifest (ui.port) and creates its
    // tunnel through the same registry, optionally minting the miniapp session
    // deep link. Same closure-rebind pattern as `registerTunnelTools`.
    registerAppTunnelTools(server, { registry: tunnels })
    // llm-endpoint proxy sidecar lifecycle — only when the feature is on.
    if (llmEndpoint) registerLlmEndpointTools(server, { registry: llmEndpoint })
    // Tunnel adapter introspection/setup, riding on @agentproto/provider-kit
    // (list_tunnel_adapters + setup_tunnel_provider). Stateless wrt the
    // gateway — creds/ledger live under ~/.agentproto.
    await registerTunnelAdapterTools(server, {})
    // Sentinel adapter introspection/setup, riding on @agentproto/provider-kit
    // (list_sentinel_adapters + setup_sentinel_provider) — same resolver
    // `sentinelRuntime` above resolves slugs through.
    await registerSentinelAdapterTools(server, {})
    // Sentinel watch/list/unwatch/poll-now — `sessionId` defaults to the
    // connecting client's `?callerSessionId=` (absent for a human/root call),
    // same pattern registerMessageTools uses below.
    registerSentinelTools(server, {
      store: sentinelStore,
      runtime: sentinelRuntime,
      tombstones: sentinelRuntime.cancelTombstones,
      deliveryStatus: id => sentinelRuntime.webhookOutbox.deliveryStatus(id),
      resolveProvider: resolveSentinelProviderResolved,
      isSessionAlive,
      ...(callerSessionId ? { callerSessionId } : {}),
    })
    // session_follow / session_unfollow / session_follows — `follower`
    // defaults to the connecting client's `?callerSessionId=`.
    registerSessionFollowTools(server, {
      store: sessionFollowStore,
      hasSession: id => sessions.get(id) !== undefined,
      ...(callerSessionId ? { callerSessionId } : {}),
    })
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
    // `sandbox exec` — run ONE command inside a box and get exitCode +
    // stdout/stderr back (ephemeral box when no sandboxId is given,
    // attached-and-left-as-found when one is). Same shared resolver as
    // attach above; the exec capability itself is optional per provider.
    registerSandboxExecTool(server, {
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
    // MCP Events (W-C of .plans/sentinel-mcp-events): the three NATIVE
    // JSON-RPC methods (`events/list|subscribe|unsubscribe`) + the
    // `events:{}` capability in `server/discover`, on this same authenticated
    // `/mcp` surface. The adapter is principal-scoped: the trusted
    // `?callerSessionId=` names a session caller, otherwise the single
    // operator bearer (plan §1 — no per-caller auth-profile principal in v1).
    const eventsPrincipal = callerSessionId ? sessionPrincipal(callerSessionId) : daemonBearerPrincipal()
    registerEventsMethods(server, {
      list: (params) => eventsList(params as EventsListRequest, { principal: eventsPrincipal }),
      subscribe: (params) =>
        eventsSubscribe(params as unknown as EventsSubscribeInput, {
          principal: eventsPrincipal,
          store: sentinelStore,
          resolveProvider: resolveSentinelProviderResolved,
        }),
      unsubscribe: (params) =>
        eventsUnsubscribe(params as unknown as EventsUnsubscribeInput, {
          principal: eventsPrincipal,
          store: sentinelStore,
          resolveProvider: resolveSentinelProviderResolved,
          tombstones: sentinelRuntime.cancelTombstones,
        }),
    })
    return server
  }

  // Public events origin (see RuntimeHttpServerOptions.eventsMcp). Off unless a >= 32 char secret is configured.
  const eventsSecret = process.env.AGENTPROTO_MCP_EVENTS_SECRET ?? ""
  const eventsRepos = (process.env.AGENTPROTO_MCP_EVENTS_REPOS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  const eventsMcp =
    eventsSecret.length >= 32
      ? {
          secret: eventsSecret,
          allowedOrigins: (process.env.AGENTPROTO_MCP_EVENTS_ORIGINS ?? "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean),
          createServer: async () => {
            const principal = sessionPrincipal("mcp-events-origin")
            return createEventsSurfaceServer({
              version: opts.version ?? "0.1.0-alpha",
              repoAllowlist: eventsRepos,
              handlers: {
                list: params => eventsList(params as EventsListRequest, { principal }),
                subscribe: params =>
                  eventsSubscribe(params as unknown as EventsSubscribeInput, {
                    principal,
                    store: sentinelStore,
                    resolveProvider: resolveSentinelProviderResolved,
                  }),
                unsubscribe: params =>
                  eventsUnsubscribe(params as unknown as EventsUnsubscribeInput, {
                    principal,
                    store: sentinelStore,
                    resolveProvider: resolveSentinelProviderResolved,
                    tombstones: sentinelRuntime.cancelTombstones,
                  }),
              },
            })
          },
        }
      : undefined

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
    await routineRegistrar.reconcile()
  } catch (err) {
    events.emit({
      type: "heartbeat-error",
      at: new Date().toISOString(),
      agent: opts.defaultBootAgent,
      error: `routine registrar reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // Re-attach every persisted sentinel to its provider and start the poll
  // loop (AIP-60 §2: "on boot the store re-attaches each active sentinel to
  // its provider"). Best-effort — a provider that fails to re-attach is
  // marked `status:"error"` on its own record, never blocks daemon boot.
  try {
    await sentinelRuntime.start()
  } catch (err) {
    events.emit({
      type: "heartbeat-error",
      at: new Date().toISOString(),
      agent: opts.defaultBootAgent,
      error: `sentinel runtime start failed: ${err instanceof Error ? err.message : String(err)}`,
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

  // Telegram tap-to-approve for pending permissions. Off unless a chat id and
  // at least one allowed user id are configured.
  const permissionTelegramCfg = daemonConfig.approvals
  const permissionTelegram =
    permissionTelegramCfg?.permissionTelegramChatId && (permissionTelegramCfg.permissionTelegramUserIds?.length ?? 0) > 0
      ? createPermissionTelegramBridge({
          events: sessionEvents,
          registry: sessions,
          telegramCreds: telegramBotCreds,
          alias: permissionTelegramCfg.permissionTelegramAlias ?? "default",
          chatId: permissionTelegramCfg.permissionTelegramChatId,
          allowedUserIds: permissionTelegramCfg.permissionTelegramUserIds!,
          ...(permissionTelegramCfg.permissionTelegramTools ? { tools: permissionTelegramCfg.permissionTelegramTools } : {}),
        })
      : undefined
  permissionTelegram?.start()

  const http = await startHttpServer({
    port,
    bind: opts.bind,
    mcpObservations,
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
    loadCommandAllowlist: () => loadAllowlistEntries(workspace),
    ...(eventsMcp ? { eventsMcp } : {}),
    verifyOrchestratorScope: scopeTokens.verify,
    conversations,
    events,
    // REST twin of `config_get`/`config_set` (PR-2) — `GET /config` /
    // `PATCH /config`, same deps and same underlying handlers.
    configTools: configToolsDeps,
    heartbeat,
    sessions,
    brains: workspaceBrains,
    mcpProxy,
    token,
    ptyEnabled: opts.spawnPty != null,
    tunnels,
    sentinels: {
      store: sentinelStore,
      resolveProvider: resolveSentinelProviderResolved,
      isSessionAlive,
      runtime: sentinelRuntime,
      tombstones: sentinelRuntime.cancelTombstones,
      deliveryStatus: id => sentinelRuntime.webhookOutbox.deliveryStatus(id),
    },
    follows: {
      store: sessionFollowStore,
      hasSession: id => sessions.get(id) !== undefined,
    },
    ...(llmEndpoint ? { llmEndpoint } : {}),
    ...(opts.deviceInferenceShare ? { deviceInferenceShare: true } : {}),
    ...(opts.deviceSpawnAllow ? { deviceSpawnAllow: true } : {}),
    remote,
    ...(opts.pairingRegistry ? { pairings: opts.pairingRegistry } : {}),
    ...(opts.hostRegistry ? { hostRegistry: opts.hostRegistry } : {}),
    ...(opts.joinTokens ? { joinTokens: opts.joinTokens } : {}),
    sessionEvents,
    eventRing,
    supervisor,
    activityProjector,
    taskLedger,
    approvals: approvalsEngine,
    approvalsWebOrigins: daemonConfig.approvals?.webOrigins ?? [],
    ...(daemonConfig.approvals?.telegramBotSecret
      ? { approvalsTelegramBotSecret: daemonConfig.approvals.telegramBotSecret }
      : {}),
    ...(workflowRunner ? { workflowRunner } : {}),
    appRegistry,
    performAppInstall: performInstall,
    listRegisteredToolIds,
    // Same dispatch pair registerAppTools gets above — the REST
    // /apps/:appId/tool-call twin must run the exact chain the MCP
    // app_tool_call verb runs.
    appToolCallDeps: { dispatchTool, callImportedTool: callImportedAppTool },
    // AIP-53 link-token scoping: backs `POST /apps/:appId/link-auth`
    // (app-link-auth.ts) — the same store `telegram_bot_token_set`/
    // `registerTelegramBotTools` above read/write.
    telegramCreds: telegramBotCreds,
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
    ...(permissionTelegram
      ? {
          permissionCallbacks: {
            alias: permissionTelegramCfg?.permissionTelegramAlias ?? "default",
            handleUpdate: (update: unknown) => permissionTelegram.handleUpdate(update),
          },
        }
      : {}),
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
    // BOOTSTRAP P7b — read-time device-mirror sync for the session routes
    // (GET /sessions/:id, /output, /export, /events, /conversation).
    deviceMirrorSync,
    // Same notifier `agent_start` registers `notifyUrl` with, so an HTTP
    // spawn's per-session webhook fires too.
    webhookNotifier,
    ...(ensureLlmEndpointRunning ? { ensureLlmEndpointRunning } : {}),
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
      ...(opts.runBranchGc ? { runBranchGc: opts.runBranchGc } : {}),
      ...(opts.runSandboxCheckpointGcSweep
        ? { runSandboxCheckpointGcSweep: opts.runSandboxCheckpointGcSweep }
        : {}),
      ...(opts.recordBranchGcVerdict ? { recordBranchGcVerdict: opts.recordBranchGcVerdict } : {}),
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
      bootResumePolicy: opts.bootResumePolicy,
      resumeServicesOnBoot: opts.resumeServicesOnBoot !== false,
      continueInterruptedOnBoot: opts.continueInterruptedOnBoot === true,
      idleReapAfterMs,
      sandboxIdleReapAfterMs,
      crashDetectIntervalMs,
      restartSweepIntervalMs,
      turnStallAfterMs,
      appRegistryIssues: () => appRegistry.listIssues(),
      appRegistryRepairs: () => appRegistry.listRepairs(),
      modelCooldowns: () => modelCooldowns.list(),
      sandboxSessions: () => sessions.sandboxSessionStats(),
    },
    cronScheduler,
    routineRegistrar,
    reactions: {
      health: () => reactionRunner.health(),
      wiring: () => reactionWiring.current(),
    },
    // Caller identity observation + `GET /identity` (ts#2165 step 5). The
    // mode is re-read from config at most every few seconds (the observer
    // runs on every /mcp call), so a `config_set` of
    // `defaults.identity.sessionTokens` is hot within that window.
    identity: {
      mode: createIdentityModeReader(),
      // Read per request (GET /identity is a read model): the actions that
      // require a proven caller, `defaults.identity.requireProof`. Empty
      // unless the operator lists one.
      resolveRequireProof: async () =>
        (await loadConfig()).defaults?.identity?.requireProof ?? [],
      ...(persist ? { observations: { path: identityObservationsFile() } } : {}),
    },
  })

  heartbeat.start()

  // Idle agent-session reaper (PR-6). Only armed when the knob is on
  // (`idleReapAfterMs > 0`); off by default. Sweeps on a fixed cadence —
  // min(threshold, 60s) so a short threshold still gets a timely sweep and a
  // long one doesn't spin needlessly, overridable via
  // AGENTPROTO_IDLE_REAP_INTERVAL_MS (mirroring AGENTPROTO_RESUME_CONCURRENCY).
  // `.unref()` so the ticker never keeps the process alive on its own.
  let idleReapTimer: ReturnType<typeof setInterval> | null = null
  const reapThresholdMs = Math.min(
    ...[idleReapAfterMs, sandboxIdleReapAfterMs].filter(ms => ms > 0),
  )
  if (Number.isFinite(reapThresholdMs)) {
    const rawInterval = process.env.AGENTPROTO_IDLE_REAP_INTERVAL_MS
    const parsedInterval = rawInterval ? Number.parseInt(rawInterval, 10) : NaN
    const intervalMs =
      Number.isFinite(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : Math.min(reapThresholdMs, 60_000)
    idleReapTimer = setInterval(() => {
      try {
        const summary = runIdleReapPass({
          registry: sessions,
          idleReapAfterMs,
          sandboxIdleReapAfterMs,
        })
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

  // Automatic periodic `sandbox gc` (no-lost-work plan, item (c)): the CLI
  // command stays operator-driven, but a box whose origin session DIED
  // (error/killed/exited) bills/idles on the provider until someone runs
  // `sandbox gc --apply` — and a dead session never will. Reap those rows on
  // the daemon (1 h cadence, AGENTPROTO_SANDBOX_GC_INTERVAL_MS overrides;
  // non-positive disables). Capacity-free: the reaper prefers the provider's
  // `remove` (control-plane destroy, no resume). Unref'd + never overlapped,
  // same shapes as the reaper above. Always armed (unlike the idle-reaper's
  // opt-in): it only ever GRAVES boxes whose session is already dead.
  const sandboxGcIntervalMs = parseSandboxGcInterval(process.env.AGENTPROTO_SANDBOX_GC_INTERVAL_MS)
  let sandboxGcTimer: { stop(): void } | null = null
  if (sandboxGcIntervalMs > 0) {
    sandboxGcTimer = startSandboxGcTimer({
      fetchSessionStatuses: () => {
        const rows = new Map<string, string>()
        for (const desc of sessions.list({ includeArchived: true })) {
          rows.set(desc.id, desc.status)
        }
        return rows
      },
      fetchSessionLineage: () => {
        const rows = new Map<string, SandboxGcSessionLineage>()
        for (const desc of sessions.list({ includeArchived: true })) {
          const links: SandboxGcSessionLineage = {
            ...(desc.resumedFrom ? { resumedFrom: desc.resumedFrom } : {}),
            ...(desc.continuedFrom ? { continuedFrom: desc.continuedFrom } : {}),
            ...(desc.succeeds ? { succeeds: desc.succeeds } : {}),
            ...(desc.sandboxTeardown ? { sandboxTeardown: desc.sandboxTeardown } : {}),
            ...(canResume(desc) ? { resumable: true } : {}),
          }
          if (Object.keys(links).length > 0) rows.set(desc.id, links)
        }
        return rows
      },
      resolveProvider: (slug: string) =>
        (opts.resolveSandboxProvider ?? makeSandboxResolver(makeSandboxCredsStore()))(slug),
      pausedMaxAgeMs: parsePausedBoxMaxAge(
        process.env.AGENTPROTO_SANDBOX_GC_PAUSED_MAX_AGE_MS,
      ),
    })
    console.log(`[sandbox-gc] automatic dead-session box gc every ${sandboxGcIntervalMs}ms`)
  }

  // On-disk session retention sweep (session-retention.ts), followed by the
  // adapter-config cache sweep. Deletes terminal
  // session dirs past their age threshold — review lanes after 7 days by
  // default, regular sessions only when `daemon.sessionRetentionDays` is set.
  // First run 10 min after boot (never competing with boot work), then every
  // 6 h; both overridable via AGENTPROTO_SESSION_RETENTION_BOOT_DELAY_MS /
  // AGENTPROTO_SESSION_RETENTION_INTERVAL_MS (a non-positive interval disables
  // the automatic sweep; `session_gc retention:true` still works). The pass
  // is async + batched, and a sweep still in flight is never overlapped.
  // `.unref()` so neither timer keeps the process alive on its own.
  const envMs = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (raw === undefined || raw.trim() === "") return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const retentionIntervalMs = envMs(
    "AGENTPROTO_SESSION_RETENTION_INTERVAL_MS",
    DEFAULT_SESSION_RETENTION_INTERVAL_MS,
  )
  let retentionBootTimer: ReturnType<typeof setTimeout> | null = null
  let retentionTimer: ReturnType<typeof setInterval> | null = null
  if (retentionIntervalMs > 0) {
    let retentionRunning = false
    const runRetention = (): void => {
      if (retentionRunning) return
      retentionRunning = true
      sessions
        .pruneSessionDirs()
        .then(res => {
          if (res.count > 0 || res.errors > 0) {
            console.log(
              `[session-retention] deleted ${res.count} session dir(s) ` +
                `(scanned ${res.scanned}, errors ${res.errors})`,
            )
          }
        })
        .catch(err => {
          console.warn(
            `[session-retention] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
        // Same cadence: the cache content of dead lineages' adapter-config
        // dirs (pnpm store, opencode snapshot/tool-output/log).
        .then(() => sessions.pruneAdapterConfigCaches())
        .then(res => {
          if (res && (res.count > 0 || res.errors > 0)) {
            console.log(
              `[adapter-cache-retention] pruned ${res.paths} cache path(s) in ${res.count} ` +
                `adapter-config dir(s) (scanned ${res.scanned}, errors ${res.errors})`,
            )
          }
        })
        .catch(err => {
          console.warn(
            `[adapter-cache-retention] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
        .finally(() => {
          retentionRunning = false
        })
    }
    retentionBootTimer = setTimeout(
      () => {
        retentionBootTimer = null
        runRetention()
      },
      Math.max(0, envMs("AGENTPROTO_SESSION_RETENTION_BOOT_DELAY_MS", DEFAULT_SESSION_RETENTION_BOOT_DELAY_MS)),
    )
    retentionBootTimer.unref?.()
    retentionTimer = setInterval(runRetention, retentionIntervalMs)
    retentionTimer.unref?.()
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

  // Pending-prompt sweep: force-delivers prompts past their `deliverWithin`
  // deadline and tells the sender once when a prompt has sat queued behind a
  // running turn past `defaults.messaging.pendingPromptStaleMinutes` (hot —
  // re-read each tick). Cheap and non-destructive unless the caller opted into
  // `deliverWithin`, so default-on. `.unref()` like the sweeps above.
  const pendingPromptSweepMs = (() => {
    const parsed = Number.parseInt(process.env.AGENTPROTO_PENDING_PROMPT_SWEEP_INTERVAL_MS ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000
  })()
  let pendingPromptTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void (async () => {
      try {
        const { pendingPromptStaleMinutes } = await resolveMessagingDefaults()
        const summary = await sessions.sweepPendingPrompts({ staleMs: pendingPromptStaleMinutes * 60_000 })
        if (summary.stale > 0 || summary.forced > 0) {
          console.log(
            `[pending-prompts] ${summary.stale} stale, ${summary.forced} force-delivered: ${summary.ids.join(", ")}`,
          )
        }
      } catch (err) {
        console.warn(`[pending-prompts] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }, pendingPromptSweepMs)
  pendingPromptTimer.unref?.()

  // AIP-58 §2 owner-liveness sweep (P3b): catches the case the boot-time
  // `loadRuns` restart check doesn't — an owner that died WITHOUT the
  // daemon itself restarting (`workflowRunner.sweep()`, `WorkflowRun.lease`)
  // — and the app-run equivalent, a zombie `app_run` whose sessions have
  // all vanished with no owned workflow run left running
  // (`sweepAppRuns`/`reconcileAppRunStatus`, `app-run-liveness.ts`). Both
  // are cheap and idempotent; DEFAULT ON, every 30s — half the runner's own
  // 60s lease TTL (`DEFAULT_LEASE_TTL_MS`), so an orphaned run is caught
  // within one or two ticks of going stale rather than sitting "running"
  // indefinitely (the "~25 app runs stuck for weeks" evidence this exists
  // for). `.unref()` so the ticker never keeps the process alive on its own.
  const livenessSweepIntervalMs = 30_000
  const livenessTickGuard = createLivenessTickGuard(livenessSweepIntervalMs, 5_000)
  const livenessSweepTimer: ReturnType<typeof setInterval> = setInterval(() => {
    // A tick that fires seconds late means the loop was starved, so lease
    // renewals are overdue rather than the owners dead (see the guard's doc).
    if (livenessTickGuard.shouldSkip()) {
      console.warn("[liveness-sweep] tick fired late (event loop starved) — skipping this sweep")
      return
    }
    try {
      const orphanedRuns = workflowRunner?.sweep().orphaned ?? []
      if (orphanedRuns.length > 0) {
        console.log(`[liveness-sweep] orphaned ${orphanedRuns.length} workflow run(s): ${orphanedRuns.join(", ")}`)
      }
      const { swept } = sweepAppRuns({
        appRegistry,
        registry: sessions,
        ...(workflowRunner ? { workflowRuns: workflowRunner.list() } : {}),
      })
      if (swept.length > 0) {
        console.log(`[liveness-sweep] settled ${swept.length} app run(s): ${swept.join(", ")}`)
      }
    } catch (err) {
      // A sweep must never crash the daemon — log and let the next tick retry.
      console.warn(`[liveness-sweep] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, livenessSweepIntervalMs)
  livenessSweepTimer.unref?.()

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
    ...(opts.hostRegistry ? { hosts: opts.hostRegistry } : {}),
    ...(opts.joinTokens ? { joinTokens: opts.joinTokens } : {}),
    token,
    mintOrchestratorScope: scopeTokens.mint,
    async resumeSessionsOnBoot(passOpts) {
      // Off by default (§5 "Opt-in vs automatic") — lazy resume-on-prompt
      // still works regardless; this only controls the automatic boot pass.
      if (!opts.resumeSessionsOnBoot) {
        return { enabled: false, candidates: 0, resumed: 0, failed: 0, skipped: 0 }
      }
      return runEagerResumePass({
        registry: sessions,
        concurrency: bootResumeConcurrency(),
        policy: opts.bootResumePolicy,
        keepAliveMaxIdleMs:
          opts.bootResumeKeepAliveMaxIdleMinutes === undefined
            ? DEFAULT_KEEPALIVE_BOOT_RESUME_MAX_IDLE_MS
            : Math.max(0, opts.bootResumeKeepAliveMaxIdleMinutes) * 60 * 1000,
        ...(passOpts?.isServed ? { isServed: passOpts.isServed } : {}),
      })
    },
    async reattachSandboxSessionsOnBoot(passOpts) {
      return runSandboxReattachPass({
        registry: sessions,
        resolveSandboxProvider: resolveSandboxProviderResolved,
        timeoutMs: bootSandboxReattachTimeoutMs(),
        ...(passOpts?.isServed ? { isServed: passOpts.isServed } : {}),
      })
    },
    async reconcileReactionsOnBoot() {
      try {
        await reactionRunner.reconcileOnBoot()
        let pending = 0
        let running = 0
        let failed = 0
        let dead = 0
        for (const entry of reactionRunner.status()) {
          pending += entry.pending
          running += entry.running
          failed += entry.failed
          dead += entry.dead
        }
        return { total: reactionReceiptStore.rows().length, pending, running, failed, dead }
      } catch (err) {
        console.warn(
          `[reaction-runner] boot reconciliation failed: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        return { total: 0, pending: 0, running: 0, failed: 0, dead: 0 }
      }
    },
    async continueInterruptedOnBoot(passOpts) {
      if (!opts.continueInterruptedOnBoot) {
        return { enabled: false, eligible: 0, sent: 0, skipped: 0, failed: 0 }
      }
      // Same storm control as the eager pass: each send may lazily resume an
      // adapter, so the same concurrency knob bounds it.
      return runContinueOnBootPass({
        registry: sessions,
        concurrency: bootResumeConcurrency(),
        policy: opts.bootResumePolicy,
        ...(passOpts?.isServed ? { isServed: passOpts.isServed } : {}),
      })
    },
    async reensureAppServicesOnBoot() {
      // Own knob, DEFAULT ON (audit F-11): app-service boot recovery is part
      // of the service contract (an installed app's services should be up
      // after a daemon restart) and must not ride the unrelated
      // `daemon.resumeSessionsOnBoot` opt-in (spawn-storm/cost concerns for
      // agent adapters don't apply — services are deterministic processes).
      // Operators can opt out via `daemon.resumeServicesOnBoot: false`.
      if (opts.resumeServicesOnBoot === false) {
        return { enabled: false, apps: 0, spawned: 0, errors: [] as string[] }
      }
      const result = await reensureInstalledAppServicesOnBoot({
        appRegistry,
        serviceStore: createAppServiceStore({
          ...(opts.persist !== undefined ? { persist: opts.persist } : {}),
        }),
        registry: sessions,
        ...(opts.resolveAgentAdapter ? { resolveAgentAdapter: opts.resolveAgentAdapter } : {}),
        ...(daemonMcpUrl !== undefined ? { daemonMcpUrl } : {}),
      })
      return { enabled: true, ...result }
    },
    async backfillSessionIndexes() {
      // Best-effort: a broken sessions store must never gate the daemon being
      // up. The live registry's descriptors enrich each recovered entry.
      // Async + batched so a large store never blocks the event loop.
      try {
        return await backfillSessionIndexesAsync(sessions.transcriptBaseDir, {
          descriptors: sessions.list({ includeArchived: true }),
        })
      } catch {
        return { scanned: 0, created: 0, skipped: 0 }
      }
    },
    async stop() {
      heartbeat.stop()
      // Provider-box sessions are DETACHED, not killed, by a daemon stop: close
      // the host's connection, keep the box + its agent running, persist the
      // re-attach record, and ask each box to outlive the restart gap. Must
      // run before anything below tears down state a detach reads.
      await sessions.detachSandboxSessions().catch(() => undefined)
      // Stop the idle-reaper sweep before sessions shut down (PR-6).
      if (idleReapTimer) clearInterval(idleReapTimer)
      // Stop the automatic dead-session-box gc sweep (no-lost-work plan).
      sandboxGcTimer?.stop()
      if (retentionBootTimer) clearTimeout(retentionBootTimer)
      if (retentionTimer) clearInterval(retentionTimer)
      // Stop the crash-detect sweep before sessions shut down (crash-detect PR-1).
      if (crashDetectTimer) clearInterval(crashDetectTimer)
      // Stop the turn-liveness watchdog sweep before sessions shut down
      // (turn-liveness-watchdog chantier).
      if (turnStallTimer) clearInterval(turnStallTimer)
      // Stop the restart-sweep tick before sessions shut down (restart-scheduler PR-2).
      if (restartSweepTimer) clearInterval(restartSweepTimer)
      if (pendingPromptTimer) clearInterval(pendingPromptTimer)
      if (wiringSweepTimer) clearInterval(wiringSweepTimer)
      // Stop the AIP-58 liveness sweep before sessions shut down (P3b).
      clearInterval(livenessSweepTimer)
      // Detach the restart-scheduler's session:exited subscription.
      restartScheduler.dispose()
      turnRetryController.dispose()
      // Detach the clerk turn-end subscriber + cancel its pending debounce
      // timers (a pending pass must not fire into a shutting-down daemon).
      clerkTurnEnd.dispose()
      nativeMemoryCapture.dispose()
      // Flush inbound-watcher cursor state before sessions shut down.
      inboundWatcher?.shutdown()
      permissionTelegram?.stop()
      // Stop the sentinel poll loop and flush its store before sessions shut
      // down — same ordering reason as inboundWatcher above (delivery reads
      // `sessions`).
      sentinelRuntime.stop()
      sentinelStore.flushSync()
      // Stop the reaction runner and persist its receipts; a `running` row
      // lost in the debounce window is a re-drive the target dedupes anyway.
      reactionRunner.stop()
      reactionReceiptStore.flushSync()
      // Stop revoking session tokens and detach their store.
      unsubscribeSessionCredentials()
      detachSessionCredentials?.()
      // Flush the orchestrator scope-token registry so a token minted /
      // bound / revoked just before a restart isn't lost inside the
      // debounce window — same reasoning as the sentinel flush above.
      scopeTokens.flushSync()
      // Drop pending follow batches (sessions are going away) and persist
      // the follow records.
      sessionFollow.dispose()
      sessionFollowStore.flushSync()
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
      // Clear the approvals engine's pending `approval_wait` timers.
      approvalsEngine.dispose()
      // Kill all live sessions before tearing down HTTP — otherwise
      // long-running children inherit the daemon's listening socket
      // and stay around as zombies after the parent exits.
      sessions.shutdown()
      // Tear down pairing rendezvous connections + served channels before HTTP
      // so no half-open E2E channel outlives the gateway it forwards to.
      if (opts.pairingRegistry) {
        await opts.pairingRegistry.shutdown().catch(() => {})
      }
      // hostRegistry needs no teardown here: unlike pairingRegistry it keeps
      // no standing rendezvous connections — every add()/forwardHttp() dials
      // fresh and closes itself, so there is nothing to shut down.
      // Close upstream MCP clients (their stdio children would
      // otherwise leak the same way).
      await mcpProxy.closeAll()
      await mcpAppsPool.closeAll()
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
