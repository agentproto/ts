/**
 * @agentproto/worktree — provision / gate / cleanup a git worktree.
 *
 * The AIP-14 contracts a worktree-agent WORKFLOW (@see examples/worktree-agent)
 * binds an AgentStep's `cwd` to: `worktree.provision` creates the worktree
 * (+ optional deps install + gitignored-secret copy), `worktree.run-gate` runs
 * a check command inside it, `worktree.cleanup` removes it.
 */

export {
  provisionWorktreeTool,
  cleanupWorktreeTool,
  runGateTool,
  runScriptTool,
  startServiceTool,
  stopServiceTool,
  listServicesTool,
  serviceStatusSchema,
  type ServiceStatusOutput,
} from "./tools/index.js"
export { worktreeProvider } from "./provider/index.js"
export { WorktreeNotRemovableError } from "./provider/bodies/cleanup-worktree.body.js"
export {
  salvageWorktree,
  SALVAGE_ROOT,
  type SalvageManifest,
  type SalvageWorktreeInput,
  type SalvageResult,
} from "./salvage.js"
export { execArgv, execShell, execGit, type ExecResult, type ExecOptions } from "./exec.js"
export { expandGlob, globToRegExp } from "./glob.js"
export {
  CONFIG_FILENAME,
  parseConfig,
  normalizeHook,
  loadConfigFromBase,
  listScripts,
  listServices,
  getScript,
  ConfigError,
  type AgentprotoConfig,
  type ScriptConfig,
  type NamedScript,
} from "./config.js"
export {
  ENV_VARS,
  hookEnv,
  peerEnv,
  serviceEnv,
  peerEnvKey,
  serviceEnvToken,
  type WorktreeEnvContext,
  type PeerService,
} from "./env.js"
export { runSetup, runTeardown, HookError, type HookRun } from "./lifecycle.js"
export {
  ServiceSupervisor,
  ProxyTable,
  stripPort,
  createProxyServer,
  startProxy,
  slugify,
  serviceHostname,
  serviceUrl,
  isPortFree,
  ephemeralPort,
  allocatePort,
  repoLabel,
  detectDefaultBranch,
  resolveSupervisor,
  getSupervisor,
  disposeSupervisor,
  sharedProxyTable,
  DEFAULT_PROXY_PORT,
  type ServiceRuntime,
  type ServiceStatus,
  type SupervisorOptions,
  type RunningProxy,
  type HostnameParts,
  type ResolveSupervisorInput,
  type ResolvedWorktreeRuntime,
} from "./services/index.js"
export { worktreeAgentWorkflow, worktreeAgentInputSchema, type WorktreeAgentInput } from "./workflow.js"
export {
  computeTreeState,
  reconcileIntegration,
  computeLiveness,
  classify,
  computeWorktreeStatus,
  listWorktreeStatuses,
  listGitWorktrees,
  VERDICT_MEMO_PATH,
  FileVerdictMemoStore,
  InMemoryVerdictMemoStore,
  type TreeState,
  type IntegrationState,
  type LivenessState,
  type GateState,
  type WorktreeClass,
  type Classification,
  type WorktreeStatusEntry,
  type GitWorktreeRef,
  type VerdictMemoRecord,
  type VerdictMemoStore,
  type ReconcileIntegrationInput,
  type ComputeWorktreeStatusInput,
  type ListWorktreeStatusesInput,
} from "./status.js"
export {
  createForgeClient,
  GhCliForgeClient,
  RestForgeClient,
  UnreachableForgeClient,
  ForgeUnavailableError,
  parseGithubOwnerRepo,
  type ForgeClient,
  type ForgePullRequestRef,
} from "./forge.js"
export {
  computeProvenance,
  readSessionsRegistry,
  readWorktreeMarker,
  writeWorktreeMarker,
  sessionInWorktree,
  SESSIONS_FILE_PATH,
  type ProvenanceInfo,
  type ProvenanceConfidence,
  type SessionRef,
  type WorktreeMarker,
  type ComputeProvenanceOptions,
} from "./provenance.js"
export {
  connectDaemonAgentSessionHost,
  makeDaemonAgentSessionHost,
  type DaemonAgentSessionHost,
  type DaemonClient,
} from "./agent-session-host.js"
