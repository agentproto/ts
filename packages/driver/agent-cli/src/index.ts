/**
 * @agentproto/driver-agent-cli — AIP-45 AGENT-CLI.md `defineAgentCli`
 * reference impl.
 *
 * Spec: https://agentproto.sh/docs/aip-45
 *
 * Authoring paths:
 *   - TS:  `defineAgentCli({...})` → `AgentCliHandle`
 *   - MD:  `parseAgentCliManifest(src) → agentCliFromManifest({...})` → `AgentCliHandle`
 *
 * Runtime: `createAgentCliRuntime(handle)` → spawn binary, dispatch
 * turns through the protocol arm (acp / mcp / proprietary), normalise
 * events to {@link StreamEvent}.
 */

export const SPEC_NAME = "agentcli-interactive/v1" as const
export const SPEC_VERSION = "0.1.0-alpha" as const

export {
  defineAgentCli,
  createAgentCliRuntime,
} from "./define-agent-cli.js"
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
  type PrintArmOptions,
  type MastraMapperState,
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
  AgentCliDefinition,
  AgentCliHandle,
  AgentCliProtocol,
  AgentCliSessionMode,
  AgentCliClient,
  AgentCliConnectOptions,
  AgentCliRuntime,
  AgentCliRuntimeSession,
  AgentCliStartOptions,
  AgentCliCapabilities,
  AgentCliInstallMethod,
  AgentCliVersionCheck,
  AgentCliAuth,
  AgentCliSetupStep,
  AgentCliSetupSkipIf,
  AgentCliSetupPersist,
  AgentCliSession,
  AgentCliModels,
  AgentCliMcpBlock,
  AgentCliMode,
  AgentCliOption,
  AgentCliOptionType,
  AgentCliContinuation,
  AgentCliPinnedSessionTuning,
  AgentCliPrintConfig,
  ContinuationStrategyId,
  ContinuationKeyScope,
  RuntimeConfig,
  TurnContext,
  StreamEvent,
} from "./types.js"
