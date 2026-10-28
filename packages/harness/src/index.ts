/**
 * @agentproto/harness: `defineHarness` implementation for AIP-45 AGENT-CLI.md.
 *
 * Spec: https://agentproto.sh/docs/aip-45
 *
 * Authoring paths:
 *   - TS:  `defineHarness({...})` → `AgentCliHandle`
 *   - MD:  `parseAgentCliManifest(src) → agentCliFromManifest({...})` → `AgentCliHandle`
 *
 * Runtime: `createAgentCliRuntime(handle)` → spawn binary, dispatch
 * turns through the protocol arm (acp / mcp / proprietary), normalise
 * events to {@link StreamEvent}.
 *
 * This package implements the AIP-70 registry entry `harness/v1`
 * (AIP-45, layer `drivers`). Its data format is identified by
 * {@link AGENT_CLI_FORMAT}.
 */

/** Internal data-format id (not an AIP registry spec name); see AIP-70. */
export const AGENT_CLI_FORMAT = "agentproto.agent-cli/v1" as const
export const SPEC_VERSION = "0.1.0-alpha" as const

/** AIP-70 registry spec id for this package (`harness/v1`, AIP-45). */
export const SPEC_NAME = "harness/v1" as const

export {
  defineHarness,
  createAgentCliRuntime,
  // Same bin resolution the driver spawns with (`bin: "node"` → this
  // process's execPath, `npx`/`npm` → execPath sibling when present) —
  // exported so a host that spawns a harness outside the runtime (the CLI's
  // ACP smoke probe) resolves argv identically instead of PATH-guessing.
  resolveSpawnBin,
  // Which canonical postures an adapter enforces through its isolated spawn
  // config (claude-code / opencode) — also stamped on each started session.
  spawnEnforcedPostures,
} from "./define-agent-cli.js"
// The live-session control surface (setModel/setSessionMode/setEffort +
// the availableConfigOptions/availableModes/currentModeId read-surface),
// factored out of `createAgentCliRuntime` so a host that builds its OWN
// `AgentCliRuntimeSession` over another transport (sandbox-resident,
// tunnel-resident) delegates to the same implementation instead of
// hand-copying it and drifting on the next interface change.
export {
  createArmSessionControls,
  applyModelCommand,
  promptTurn,
  isModelSwitchAcknowledgement,
  parseModelSwitchCommand,
  type ArmSessionControls,
} from "./session-controls.js"
// Agent CLI → generic model port: one executor backing every prompt→completion
// seam (report writer, corpus distiller, Mastra judgment step) over any AIP-45 CLI.
export {
  makeAgentCliModel,
  resolveCliEnv,
  composePrompt,
  datasetPreamble,
  PROVIDER_KEY_ENV,
} from "./model.js"
export type {
  ModelLike,
  FileReadingOptions,
  AgentCliModelOptions,
} from "./model.js"
// Exposed so callers can build a sandbox-resident `AgentCliRuntime`
// against the same protocol layer the host-spawn factory uses, by
// passing a `ChildProcess`-shaped duck whose stdio is bridged to a
// remote subprocess (e2b sandbox, ssh, etc.). See guilde's
// `cli-session-spawn/sandbox-runtime.ts` for a worked example.
export {
  createAcpProtocolArm,
  autoAllowPermissionHandler,
  planModePermissionHandler,
  type AcpPermissionHandler,
  type AcpPermissionOutcome,
  type AcpPermissionRequestParams,
} from "./protocol/acp-client.js"
export {
  createPrintSession,
  mapMastraEvent,
  createMastraMapperState,
  mapJcodeEvent,
  createJcodeMapperState,
  type PrintArmOptions,
  type MastraMapperState,
  type JcodeMapperState,
} from "./protocol/print-arm.js"
// Generic proprietary-protocol arm loader — dynamically imports the
// manifest's `adapter` package. Exported so proprietary adapter packages
// (and their tests) can drive the same loader `createAgentCliRuntime`
// uses, without duplicating the load-and-validate logic.
export {
  createProprietaryProtocolArm,
  type ProprietaryProtocolOptions,
} from "./protocol/proprietary.js"
export {
  agentCliSupportsHostContextIsolation,
  hostContextExcludes,
} from "./host-context.js"
// Adapter-declared read-only grants a CONFINED spawn needs (its own global
// config dir under $HOME), and the `~/…` expander, exported so adapter
// manifests/tests can resolve the same paths the driver will.
export {
  resolveConfinedReadPaths,
  defaultToolchainReadPaths,
} from "./command-sandbox-wrap.js"
export { CREDENTIAL_DATA_SUBDIR } from "./state-home.js"
// Per-session config dir layout knowledge shared with session GC: the caches
// linked back to the operator's location, and the manifest naming the paths
// GC may delete once the session is dead.
export {
  SHARED_TOOL_CACHES,
  sharedToolCachePaths,
  linkSharedToolCaches,
  type SharedToolCache,
  type LinkSharedToolCachesResult,
} from "./shared-tool-caches.js"
export {
  SESSION_CACHE_MANIFEST,
  readSessionCacheManifest,
  recordSessionCachePaths,
  safeRelativeCachePath,
  type SessionCacheManifest,
} from "./session-cache-manifest.js"
// Whole-tree teardown for a spawned adapter process — exported so hosts that
// spawn a harness themselves (the CLI's ACP smoke probe) tear it down the
// same way `createAgentCliRuntime` does, instead of SIGKILLing only the
// npx/npm wrapper and leaking its descendants.
export {
  terminateChildTree,
  descendantsOf,
  type ProcessRow,
  type TerminateTreeOptions,
  type TerminateTreeResult,
} from "./process-tree.js"
export {
  applySessionSkills,
  readSessionSkillsMetadata,
  SESSION_SKILLS_ABS_DIR,
  type SessionSkillsMetadata,
  type ApplySessionSkillsArgs,
  type ApplySessionSkillsResult,
} from "./session-skills.js"
export {
  agentCliFrontmatterSchema,
  runtimeConfigSchema,
  type AgentCliFrontmatter,
  type RuntimeConfigInput,
} from "./schema.js"
export {
  toFileBasedMcpServers,
  type MastracodeMcpServerConfig,
} from "./mcp-servers.js"
export {
  composeSpawn,
  resolveContinuationStrategy,
  RuntimeConfigError,
  type ComposedSpawn,
} from "./manifest/compose.js"
// Legacy AIP-45 mode-id classification (SPEC §3.4a) — the single source the
// daemon's `decomposeMode` shim reuses so the route/posture id set never drifts.
export {
  LEGACY_GATEWAY_MODE_IDS,
  LEGACY_POSTURE_MODE_IDS,
  inferLegacyModeKind,
  isLegacyExtractedModeId,
} from "./legacy-modes.js"
export {
  registerContinuationStrategy,
  getContinuationStrategy,
  listContinuationStrategies,
} from "./continuation/registry.js"
export {
  configureNativeResume,
  type NativeResumeHooks,
} from "./continuation/strategies/native-resume.js"
export {
  deriveKeyFromScope,
  type ContinuationStrategy,
  type AcquireContext,
  type ReleaseContext,
  type ReleaseOutcome,
} from "./continuation/types.js"
export type {
  SteerOutcome,
  AgentCliDefinition,
  AgentCliHandle,
  AgentCliProtocol,
  AgentCliSessionMode,
  AgentCliClient,
  AgentCliConnectOptions,
  AgentCliRuntime,
  AgentCliRuntimeSession,
  AgentCliStartOptions,
  AgentCliSessionSkill,
  AgentCliFsZones,
  AgentCliStateHome,
  AgentCliSmallModel,
  AgentCliCapabilities,
  NativeHookPath,
  NativeHookHandler,
  NativeHookContext,
  NativeHookCapability,
  MemoryProjectionCapability,
  AgentCliInstallMethod,
  AgentCliVersionCheck,
  AgentCliUpgrade,
  AgentCliAuth,
  AgentCliSetupStep,
  AgentCliSetupSkipIf,
  AgentCliSetupPersist,
  AgentCliSession,
  AgentCliModels,
  AgentCliModelEntry,
  AgentCliMcpBlock,
  AgentCliMode,
  AgentCliRouteSelection,
  AgentCliOption,
  AgentCliOptionType,
  AgentCliPresetDeclaration,
  AgentCliContinuation,
  AgentCliPinnedSessionTuning,
  AgentCliPrintConfig,
  ContinuationStrategyId,
  ContinuationKeyScope,
  RuntimeConfig,
  TurnContext,
  StreamEvent,
  AgentPromptPlanApproval,
  AgentPromptQuestion,
  AgentPromptRequestKind,
  // Result vocabularies for the three mid-session switches, and the two
  // read-surface element types. Exported so a host can name what
  // `AgentCliRuntimeSession`'s members hand back.
  SetModelResult,
  SetSessionModeResult,
  SetEffortResult,
  SessionConfigOption,
  SessionMode,
} from "./types.js"
