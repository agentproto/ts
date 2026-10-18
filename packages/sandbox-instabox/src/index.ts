/**
 * @agentproto/sandbox-instabox — InstaBox `SandboxProvider` for @agentproto/sandbox.
 *
 * Isolated from `@agentproto/sandbox` so the provider-agnostic schema core
 * never pulls a vendor SDK (there is none here: the API is a plain typed
 * `fetch` client over https://api.instabox.sh) — see AIP-36 (SANDBOX.md).
 */

export {
  InstaboxApiError,
  InstaboxClient,
  isInstaboxQuotaFailure,
  isTransientInstaboxError,
  type InstaboxClientOpts,
  type InstaboxCreateMachineInput,
  type InstaboxExecInput,
  type InstaboxExecResult,
  type InstaboxMachine,
  type InstaboxMachineState,
  type InstaboxOnTimeout,
  type InstaboxOperation,
  type InstaboxPort,
  type InstaboxUsage,
} from "./api.js"
export {
  BACKGROUND_REDIRECT,
  AUTH_TOKEN_ENV_VAR,
  AGENTPROTO_METADATA_KEY,
  DAEMON_UNIT_NAME,
  ENV_FILE_PATH,
  SYSTEMD_UNIT_PATH,
  assertQuotaAvailable,
  buildCliInstallCommand,
  createInstaboxSandboxProvider,
  environmentFileContents,
  instaboxSandboxProvider,
  normalizeQuotaError,
  writeDaemonUnitCommand,
  type InstaboxSandboxSpecConfig,
} from "./provider.js"
